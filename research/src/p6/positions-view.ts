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
import { endIsStale, PNL_START_USD, signedUsd } from "./pnl-block";

export const POSITIONS_IDENTITY =
  "equity = cash + total active investment - est. exit costs; cash = start + realized - sum(cost basis); cost basis = qty * fill + entry fee; active = sum(qty * mark); est. exit costs = sum(notional * (taker + live slippage) / 10000), already inside row unrealized";

export const CASH_LABEL = "USD (paper, derived)";
export const STABLECOIN_NOTE = "book holds no stablecoins";
export const ENTRY_FEE_NOTE = "unrealized includes the entry fee";
export const MARK_FALLBACK = "entry (no mark)";
export const EMPTY_POSITIONS = "No open positions";
export const POSITIONS_UNREPORTED = "positions not yet reported";
export const CHECKS_SKIPPED = "checks skipped";
export const CHECKS_INCOMPLETE = "checks incomplete";
export const POSITION_ROW_CAP = 64;
export const POSITION_FIELD_CAP = 32;
/** A printed cent can land 2e-13 over 0.01. 1.1 cents stays outside. */
const CENT_SLACK = 1e-9;

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
  /** Omitted when the cluster text is the same as the product. */
  k?: string;
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
  /** Rows dropped because the book was longer than POSITION_ROW_CAP. */
  omitted: number;
  /** Rows dropped because product or class was missing. Checks stay incomplete. */
  skipped: number;
}

function round8(value: number): number {
  return Math.round(value * 1e8) / 1e8;
}

function withinCent(gap: number): boolean {
  return Math.abs(gap) <= 0.01 + CENT_SLACK;
}

function clipText(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.length > POSITION_FIELD_CAP ? text.slice(0, POSITION_FIELD_CAP) : text;
}

function clipSnap(snap: PositionSnap): PositionSnap {
  const id = clipText(snap.id);
  const p = clipText(snap.p);
  const c = clipText(snap.c);
  const next: PositionSnap = { ...snap, id, p, c };
  const k = clipText(typeof snap.k === "string" ? snap.k : p);
  if (k !== p) next.k = k;
  else delete next.k;
  return next;
}

/** Signed dollars with a thousands separator. Negative cash is `-$2,121.60`, never `$-2121.60`. */
export function formatUsd(value: number): string {
  const abs = Math.abs(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return value < 0 ? `-$${abs}` : `$${abs}`;
}

export function clipSnaps(snaps: readonly PositionSnap[]): { snaps: PositionSnap[]; capped: boolean; omitted: number } {
  const omitted = Math.max(0, snaps.length - POSITION_ROW_CAP);
  return {
    capped: omitted > 0,
    omitted,
    snaps: snaps.slice(0, POSITION_ROW_CAP).map(clipSnap),
  };
}

function positionUsable(position: Book["positions"][number] | null | undefined): position is Book["positions"][number] {
  if (position == null || typeof position !== "object") return false;
  if (typeof position.id !== "string" || position.id.length === 0) return false;
  if (typeof position.productId !== "string" || position.productId.length === 0) return false;
  if (typeof position.classId !== "string" || position.classId.length === 0) return false;
  if (typeof position.clusterId !== "string") return false;
  const nums = [position.units, position.fillPrice, position.stop, position.entryFeeUsd, position.riskUsd, position.entryTs, position.sLiveBps];
  return nums.every((value) => typeof value === "number" && Number.isFinite(value));
}

export function positionSnapBuild(book: Book): { snaps: PositionSnap[]; omitted: number; skipped: number } {
  const built: PositionSnap[] = [];
  let skipped = 0;
  for (const position of book.positions) {
    if (!positionUsable(position)) {
      skipped += 1;
      continue;
    }
    const known = Object.prototype.hasOwnProperty.call(book.marks, position.productId) && Number.isFinite(book.marks[position.productId]);
    const mark = known ? book.marks[position.productId]! : position.fillPrice;
    let unrealized = Number.NaN;
    let exitCost = Number.NaN;
    try {
      unrealized = markedPnl(book, position, mark);
      exitCost = openExitCostUsd(book, position, mark);
    } catch {
      skipped += 1;
      continue;
    }
    if (!Number.isFinite(unrealized) || !Number.isFinite(exitCost) || !Number.isFinite(mark)) {
      skipped += 1;
      continue;
    }
    const snap: PositionSnap = {
      id: position.id,
      p: position.productId,
      c: position.classId,
      t: position.entryTs,
      u: round8(position.units),
      f: round8(position.fillPrice),
      m: round8(mark),
      n: round8(mark * position.units),
      s: round8(position.stop),
      ur: round8(unrealized),
      x: round8(exitCost),
      e: round8(position.entryFeeUsd),
      r: round8(position.riskUsd),
    };
    if (position.clusterId !== position.productId) snap.k = position.clusterId;
    if (!known) snap.src = "entry";
    if (position.target != null && Number.isFinite(position.target)) snap.tg = round8(position.target);
    built.push(snap);
  }
  const omitted = Math.max(0, built.length - POSITION_ROW_CAP);
  return { snaps: built.slice(0, POSITION_ROW_CAP).map(clipSnap), omitted, skipped };
}

export function positionSnaps(book: Book): PositionSnap[] {
  return positionSnapBuild(book).snaps;
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
  /** Rows already removed before this array was stored. */
  omitted?: number;
  /** Malformed rows dropped at flush. */
  skipped?: number;
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
      omitted: 0,
      skipped: 0,
    };
  }
  const clipped = clipSnaps(input.snaps);
  const snaps = clipped.snaps;
  const omitted = Math.max(input.omitted ?? 0, clipped.omitted);
  const skipped = input.skipped ?? 0;
  const incomplete = omitted > 0 || skipped > 0;
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
      cluster: snap.k ?? snap.p,
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
  const reconciled = !incomplete && withinCent(gapUsd);
  const rowUnrealizedUsd = rows.reduce((sum, row) => sum + row.unrealized, 0);
  const unrealizedMatch = !incomplete && withinCent(rowUnrealizedUsd - input.unrealizedUsd);
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
    checkText: incomplete ? CHECKS_INCOMPLETE : reconciled ? "reconciled" : `NOT RECONCILED by ${moneyGap(gapUsd)}`,
    rowUnrealizedUsd,
    openUnrealizedUsd: input.unrealizedUsd,
    unrealizedMatch,
    unrealizedText: incomplete ? CHECKS_INCOMPLETE : unrealizedMatch ? "row unrealized matches open now" : "row unrealized does not match open now",
    stale: endIsStale(input.nowMs, input.markTs),
    markTs: input.markTs,
    riskUsd,
    riskText: `open risk $${riskUsd.toFixed(2)} of $${OPEN_RISK_CAP_USD} cap`,
    clusters,
    problems,
    empty: rows.length === 0,
    reported: true,
    omitted,
    skipped,
  };
}

/** Visible lines of the positions section. The page prints these strings. */
export function positionsSectionCopy(view: PositionsView): {
  grey: boolean;
  body: string;
  cash: string;
  equity: string;
  active: string;
  atCost: string;
  exit: string;
  check: string;
  omittedNote: string | null;
} {
  if (!view.reported) {
    return {
      grey: view.stale || !view.reported,
      body: POSITIONS_UNREPORTED,
      cash: "—",
      equity: "—",
      active: "—",
      atCost: "—",
      exit: "—",
      check: CHECKS_SKIPPED,
      omittedNote: null,
    };
  }
  const problems = view.problems.length > 0 ? ` · ${view.problems.join(" · ")}` : "";
  const second = view.unrealizedText === view.checkText ? "" : ` · ${view.unrealizedText}`;
  return {
    grey: view.stale,
    body: view.empty ? EMPTY_POSITIONS : "",
    cash: formatUsd(view.cashUsd),
    equity: formatUsd(view.equityUsd),
    active: formatUsd(view.activeUsd),
    atCost: formatUsd(view.atCostUsd),
    exit: signedUsd(-view.exitCostUsd),
    check: `${view.checkText}${problems}${second}`,
    omittedNote: view.omitted > 0 ? `${view.omitted} positions not shown` : null,
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
