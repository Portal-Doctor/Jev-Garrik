/**
 * Open-position rows for /p6. Built into p6:lastRun at flush. The page does not recompute marks.
 *
 * Identity, post entry-fee fix:
 * cost basis = qty * fill + entry fee
 * cash = start + realized - sum(cost basis)
 * active = sum(qty * mark)
 * est. exit cost = openExitCostUsd, the term markedPnl subtracts
 * row unrealized = notional - exit cost - cost basis, which already includes the entry fee
 * equity = cash + active - est. exit costs
 * That equals start + realized + sum(row unrealized), the engine equity.
 * The exit-cost line is one deduction in that tie. It is not subtracted from unrealized again.
 */

import { CLUSTER_MAX_OPEN, OPEN_RISK_CAP_USD } from "../p3/design-rules";
import { markedPnl, openExitCostUsd, type Book } from "./engine";
import { endIsStale, PNL_START_USD } from "./pnl-block";

export const POSITIONS_IDENTITY =
  "equity = cash + total active investment - est. exit costs; cash = start + realized - sum(cost basis); cost basis = qty * fill + entry fee; active = sum(qty * mark); est. exit costs = sum(notional * (taker + live slippage) / 10000), already inside row unrealized";

export const CASH_LABEL = "USD (paper, derived)";
export const STABLECOIN_NOTE = "book holds no stablecoins";
export const ENTRY_FEE_NOTE = "unrealized includes the entry fee";
export const MARK_FALLBACK = "entry (no mark)";
export const EMPTY_POSITIONS = "No open positions";
export const POSITIONS_UNREPORTED = "positions not yet reported";
export const CHECKS_SKIPPED = "checks skipped";
export const POSITION_ROW_CAP = 64;
export const POSITION_FIELD_CAP = 32;

/**
 * Slim lastRun row. One per open position.
 * p product, c class, t entry ts, u units, f fill, m mark, n notional, s stop,
 * ur unrealized, x exit cost, e entry fee, r initial risk, k cluster, tg target.
 * src is "entry" only when the fill price stands in for a missing mark.
 */
export interface PositionSnap {
  id: string;
  p: string;
  c: string;
  t: number;
  u: number;
  f: number;
  m: number;
  src?: "entry";
  n: number;
  s: number;
  ur: number;
  x: number;
  e: number;
  r: number;
  k: string;
  tg?: number;
  side?: string;
}

export interface PositionLine {
  id: string;
  product: string;
  classId: string;
  units: number;
  fill: number;
  mark: number;
  markSrc?: "entry";
  notional: number;
  stop: number;
  unrealized: number;
  exitCost: number;
  entryFee: number;
  risk: number;
  cluster: string;
  target: number | null;
  costBasisUsd: number;
  unrealizedPct: number | null;
  netR: number | null;
  stopDistancePct: number | null;
  ageMs: number;
  side: string;
}

export interface PositionsView {
  rows: PositionLine[];
  activeUsd: number;
  atCostUsd: number;
  exitCostUsd: number;
  cashUsd: number;
  equityUsd: number;
  tieUsd: number;
  gapUsd: number;
  reconciled: boolean;
  checkText: string;
  rowUnrealizedUsd: number;
  openUnrealizedUsd: number;
  unrealizedMatch: boolean;
  unrealizedText: string;
  stale: boolean;
  markTs: number | null;
  riskUsd: number;
  riskText: string;
  clusters: { id: string; n: number; text: string }[];
  problems: string[];
  empty: boolean;
  /** False when lastRun has no positions array yet. Checks are skipped. */
  reported: boolean;
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function clipText(value: string): string {
  return value.length > POSITION_FIELD_CAP ? value.slice(0, POSITION_FIELD_CAP) : value;
}

export function clipSnaps(snaps: readonly PositionSnap[]): { snaps: PositionSnap[]; capped: boolean } {
  const capped = snaps.length > POSITION_ROW_CAP;
  return {
    capped,
    snaps: snaps.slice(0, POSITION_ROW_CAP).map((snap) => ({ ...snap, p: clipText(snap.p), c: clipText(snap.c) })),
  };
}

export function positionSnaps(book: Book): PositionSnap[] {
  return book.positions.map((position) => {
    const known = Object.prototype.hasOwnProperty.call(book.marks, position.productId) && Number.isFinite(book.marks[position.productId]);
    const mark = known ? book.marks[position.productId]! : position.fillPrice;
    const notional = mark * position.units;
    const unrealized = markedPnl(book, position, mark);
    const exitCost = openExitCostUsd(book, position, mark);
    const snap: PositionSnap = {
      id: position.id,
      p: position.productId,
      c: position.classId,
      t: position.entryTs,
      u: round8(position.units),
      f: round8(position.fillPrice),
      m: round8(mark),
      n: round8(notional),
      s: round8(position.stop),
      ur: round8(unrealized),
      x: exitCost,
      e: round8(position.entryFeeUsd),
      r: round8(position.riskUsd),
      k: position.clusterId,
    };
    if (!known) snap.src = "entry";
    if (position.target != null) snap.tg = round8(position.target);
    return snap;
  }).slice(0, POSITION_ROW_CAP).map((snap) => ({ ...snap, p: clipText(snap.p), c: clipText(snap.c) }));
}

function moneyGap(value: number): string {
  return `$${Math.abs(Math.round(value * 100) / 100).toFixed(2)}`;
}

export function positionsFooter(input: {
  /** Null means the positions array is absent. An empty array is a flat book. */
  snaps: readonly PositionSnap[] | null;
  nowMs: number;
  markTs: number | null;
  equityUsd: number;
  realizedUsd: number;
  unrealizedUsd: number;
  startingUsd?: number;
  currency?: string;
}): PositionsView {
  const starting = input.startingUsd ?? PNL_START_USD;
  if (input.snaps == null) {
    return {
      rows: [],
      activeUsd: 0,
      atCostUsd: 0,
      exitCostUsd: 0,
      cashUsd: 0,
      equityUsd: input.equityUsd,
      tieUsd: 0,
      gapUsd: 0,
      reconciled: false,
      checkText: CHECKS_SKIPPED,
      rowUnrealizedUsd: 0,
      openUnrealizedUsd: input.unrealizedUsd,
      unrealizedMatch: false,
      unrealizedText: CHECKS_SKIPPED,
      stale: endIsStale(input.nowMs, input.markTs),
      markTs: input.markTs,
      riskUsd: 0,
      riskText: `open risk $0.00 of $${OPEN_RISK_CAP_USD} cap`,
      clusters: [],
      problems: [],
      empty: false,
      reported: false,
    };
  }
  const snaps = clipSnaps(input.snaps).snaps;
  const rows: PositionLine[] = snaps.map((snap) => {
    const costBasisUsd = snap.u * snap.f + snap.e;
    const side = snap.side ?? "long";
    return {
      id: snap.id,
      product: snap.p,
      classId: snap.c,
      units: snap.u,
      fill: snap.f,
      mark: snap.m,
      markSrc: snap.src,
      notional: snap.n,
      stop: snap.s,
      unrealized: snap.ur,
      exitCost: snap.x,
      entryFee: snap.e,
      risk: snap.r,
      cluster: snap.k,
      target: snap.tg ?? null,
      costBasisUsd,
      unrealizedPct: costBasisUsd !== 0 ? (snap.ur / costBasisUsd) * 100 : null,
      netR: snap.r > 0 ? snap.ur / snap.r : null,
      stopDistancePct: snap.m > 0 ? ((snap.m - snap.s) / snap.m) * 100 : null,
      ageMs: Math.max(0, input.nowMs - snap.t),
      side,
    };
  });
  const activeUsd = rows.reduce((sum, row) => sum + row.notional, 0);
  const atCostUsd = rows.reduce((sum, row) => sum + row.costBasisUsd, 0);
  const exitCostUsd = rows.reduce((sum, row) => sum + row.exitCost, 0);
  const cashUsd = starting + input.realizedUsd - atCostUsd;
  const tieUsd = cashUsd + activeUsd - exitCostUsd;
  const gapUsd = tieUsd - input.equityUsd;
  const reconciled = Math.abs(gapUsd) <= 0.01;
  const rowUnrealizedUsd = rows.reduce((sum, row) => sum + row.unrealized, 0);
  const unrealizedMatch = Math.abs(rowUnrealizedUsd - input.unrealizedUsd) <= 0.01;
  const problems: string[] = [];
  if ((input.currency ?? "USD") !== "USD" || rows.some((row) => row.side !== "long")) problems.push("unsupported balance/side");
  if (cashUsd < 0) problems.push("negative cash");
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.cluster, (counts.get(row.cluster) ?? 0) + 1);
  const clusters = [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([id, n]) => ({ id, n, text: `${id}: ${n} of max ${CLUSTER_MAX_OPEN}` }));
  const riskUsd = rows.reduce((sum, row) => sum + row.risk, 0);
  return {
    rows,
    activeUsd,
    atCostUsd,
    exitCostUsd,
    cashUsd,
    equityUsd: input.equityUsd,
    tieUsd,
    gapUsd,
    reconciled,
    checkText: reconciled ? "reconciled" : `NOT RECONCILED by ${moneyGap(gapUsd)}`,
    rowUnrealizedUsd,
    openUnrealizedUsd: input.unrealizedUsd,
    unrealizedMatch,
    unrealizedText: unrealizedMatch ? "row unrealized matches open now" : "row unrealized does not match open now",
    stale: endIsStale(input.nowMs, input.markTs),
    markTs: input.markTs,
    riskUsd,
    riskText: `open risk $${riskUsd.toFixed(2)} of $${OPEN_RISK_CAP_USD} cap`,
    clusters,
    problems,
    empty: rows.length === 0,
    reported: true,
  };
}

export function ageText(ageMs: number): string {
  const hours = Math.floor(ageMs / 3_600_000);
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  if (days > 0) return `${days}d ${rem}h`;
  const mins = Math.floor((ageMs % 3_600_000) / 60_000);
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

export function snapBytes(snaps: readonly PositionSnap[]): number {
  return Buffer.byteLength(JSON.stringify(snaps));
}
