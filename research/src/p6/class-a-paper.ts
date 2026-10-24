/**
 * Class A forward paper, config A55-k3.
 * Spec sha256 56fb7543d69a80b536d7ae4d9f9d9240ebde33f1500fde45e6b5235e70a753d0.
 * Paper only. This book does not place orders and does not replace the live X1 class A stream.
 *
 * Errata, not resolved here:
 * - Start date is still TBD. A null start records nothing.
 * - Holm's test and the buy-and-hold comparison used for promotion are not defined, so a pass is never recommended.
 * - The live class A path is still the X1 taker. This book is separate.
 * - s here is max(5 bps, 0.5 × the median the caller supplies), with no 15 bps cap.
 * - The 30-day volume window includes the signal day. "Before the signal close" can be read the other way.
 * - Logged R is PnL / $20. The 30-day rule uses price versus the initial stop.
 * - skip_pair, skip_reentry, and skip_kill are labels for rules the spec states without a code.
 * - A one-pair book fails the best-pair removal check because the remainder is 0.
 * - Same-timestamp signals are ordered by product id. The spec says timestamp order only.
 * - The 4h window is [close, close+4h). A print at exactly 04:00 does not fill.
 * - Stop slippage of 5 bps is taken off the entry price.
 * - A missing quoted-spread median uses the 5 bps floor.
 * - The agreed exclusion list is still marked unconfirmed in code. This book applies that list.
 */

import { classATrigger, type DailyBar } from "../p3/classes";
import { classATenDayExit } from "../p3/design-rules";
import { AGREED_EXCLUSIONS } from "../p2/exclusion";
import { wilderAtr } from "../p2/indicators";
import { btcVeto, type BtcDay } from "../p3/signals";
import { addDays, daysBetween } from "../p5/stats";

export const CLASS_A_SPEC_SHA256 = "56fb7543d69a80b536d7ae4d9f9d9240ebde33f1500fde45e6b5235e70a753d0";
export const CLASS_A_CONFIG = "A55-k3" as const;
export const CLASS_A_LOOKBACK = 55 as const;
export const CLASS_A_K = 3;
export const CLASS_A_RISK_USD = 20;
export const CLASS_A_NOTIONAL_CAP_USD = 2_000;
export const CLASS_A_MAX_OPEN = 3;
export const CLASS_A_MAX_OPEN_RISK_USD = 60;
export const CLASS_A_BOOK_USD = 6_000;
export const CLASS_A_VOLUME_FLOOR_USD = 5_000_000;
export const CLASS_A_VOLUME_TIGHT_USD = 20_000_000;
export const CLASS_A_MAKER_FEE_BPS = 50;
export const CLASS_A_TAKER_FEE_BPS = 90;
export const CLASS_A_FILL_WINDOW_MS = 4 * 60 * 60 * 1000;
export const CLASS_A_STALE_MS = 2_000;
export const CLASS_A_KILL_USD = -400;
export const CLASS_A_PROMOTE_GROSS_BPS = 290;
export const CLASS_A_PROMOTE_MIN_N = 30;
export const CLASS_A_NO_REENTRY_MS = 24 * 60 * 60 * 1000;
const LISTED_DAYS = 90;

export const CLASS_A_SKIP_REASONS = [
  "skip_volume",
  "skip_btcveto",
  "skip_nofill",
  "skip_spread",
  "skip_depth",
  "skip_stale",
  "skip_minsize",
  "skip_cap",
  "skip_pair",
  "skip_reentry",
  "skip_kill",
] as const;

export type ClassASkip = (typeof CLASS_A_SKIP_REASONS)[number];
export type ClassARegime = "BULL" | "BEAR" | "CHOP";
const EXCLUDED = new Set(AGREED_EXCLUSIONS.map((row) => row.productId));

export interface ClassADay {
  date: string;
  high: number;
  low: number;
  close: number;
  /** Base units traded that day. USD volume is this times the close. */
  baseVolume: number;
}

export interface ClassASignal {
  pair: string;
  listedDays: number;
  days: readonly ClassADay[];
  index: number;
  btcClose: number | null;
  btcEma50: number | null;
  btcDailyMove: number | null;
  btcSma200: number | null;
  btcSma50: number | null;
  btcSma50TenAgo: number | null;
  spreadBps: number | null;
  depthCostBps: number | null;
  quoteAgeMs: number | null;
  minOrderBase: number | null;
  tick: number | null;
  medianSpreadBps: number | null;
  nextHourOpen: number | null;
  hourAtr14: number | null;
  prints: readonly { tsMs: number; price: number }[];
}

export interface ClassACounterfactual {
  status: "chase" | "open" | "closed" | "unavailable";
  entry: number | null;
  grossBps: number | null;
  netBps: number | null;
  netR: number | null;
  exitReason: string | null;
}

export interface ClassARow {
  id: string;
  signalMs: number;
  pair: string;
  medianVolumeUsd: number | null;
  signalClose: number | null;
  atr: number | null;
  stop: number | null;
  notionalUsd: number | null;
  fill: "fill" | "nofill" | "skip";
  skipReason: ClassASkip | null;
  check: string | null;
  measured: number | null;
  threshold: number | null;
  regime: ClassARegime | null;
  btcVeto: boolean;
  exitReason: string | null;
  exitMs: number | null;
  exitPrice: number | null;
  grossBps: number | null;
  netBps: number | null;
  grossR: number | null;
  netR: number | null;
  counterfactual: ClassACounterfactual | null;
}

interface Sim {
  rowId: string;
  pair: string;
  scored: boolean;
  entry: number;
  entryMs: number;
  entryDate: string;
  stop: number;
  initialStop: number;
  notionalUsd: number;
  units: number;
  feeEntryBps: number;
  sBps: number;
  highestClose: number;
  priorCloses: number[];
  pending: "rule" | null;
}

export interface ClassAScored {
  pair: string;
  grossUsd: number;
  netUsd: number;
  grossBps: number;
  netBps: number;
  netR: number;
  regime: ClassARegime;
}

export interface ClassABook {
  startMs: number | null;
  killed: boolean;
  cumNetUsd: number;
  open: Sim[];
  shadows: Sim[];
  reentryUntil: Record<string, number>;
  rows: ClassARow[];
  scored: ClassAScored[];
}

export interface ClassAPaperView {
  specSha256: string;
  config: "A55-k3";
  lookback: 55;
  k: 3;
  start: string | null;
  status: "awaiting-start" | "running" | "killed" | "redacted";
  paper: true;
  n: number;
  fills: number;
  fillRate: number | null;
  skips: Partial<Record<ClassASkip, number>>;
  meanGrossBps: number | null;
  meanNetBps: number | null;
  meanNetR: number | null;
  cumNetUsd: number;
  open: number;
  kill: boolean;
  promotion: "not-considered" | "blocked" | "unresolved" | "redacted";
  regimes: Record<ClassARegime, number>;
  healthDue: ("90d" | "6m")[];
}

export function emptyClassABook(startMs: number | null = null): ClassABook {
  return { startMs, killed: false, cumNetUsd: 0, open: [], shadows: [], reentryUntil: {}, rows: [], scored: [] };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** Thirty completed days ending at the signal day, inclusive. Null when a day is missing. */
export function medianVolumeUsd(days: readonly { baseVolume: number; close: number }[], index: number): number | null {
  if (index < 29) return null;
  const usd: number[] = [];
  for (let i = index - 29; i <= index; i += 1) {
    const day = days[i];
    if (!day || !(day.close > 0) || !Number.isFinite(day.baseVolume) || day.baseVolume < 0) return null;
    usd.push(day.baseVolume * day.close);
  }
  return median(usd);
}

export function regimeOf(close: number | null, sma200: number | null, sma50: number | null, sma50TenAgo: number | null): ClassARegime {
  if (close == null || sma200 == null || sma50 == null || sma50TenAgo == null) return "CHOP";
  const slope = sma50 - sma50TenAgo;
  if (close > sma200 && slope > 0) return "BULL";
  if (close < sma200 && slope < 0) return "BEAR";
  return "CHOP";
}

/** Spec s. No 15 bps cap. A missing median uses the 5 bps floor. */
export function takerSpreadBps(medianQuotedSpreadBps: number | null): number {
  if (medianQuotedSpreadBps == null || !Number.isFinite(medianQuotedSpreadBps) || medianQuotedSpreadBps < 0) return 5;
  return Math.max(5, 0.5 * medianQuotedSpreadBps);
}

/** Buy-side walk of `baseNeeded`. Infinity when the shown book cannot fill it. */
export function walkCostBps(mid: number, levels: readonly { price: number; size: number }[], baseNeeded: number): number | null {
  if (!(mid > 0) || !(baseNeeded > 0)) return null;
  let left = baseNeeded;
  let spent = 0;
  for (const level of levels) {
    if (!(level.price > 0) || !(level.size > 0)) continue;
    const take = Math.min(left, level.size);
    spent += take * level.price;
    left -= take;
    if (left <= 1e-12) break;
  }
  if (left > 1e-8) return Number.POSITIVE_INFINITY;
  return ((spent / baseNeeded - mid) / mid) * 10_000;
}

export function signalCloseMs(openDated: string): number {
  return Date.parse(`${addDays(openDated, 1)}T00:00:00.000Z`);
}

export function stopFillPx(stop: number, entry: number, hourAtr: number, open: number): number {
  if (open <= stop) return open;
  const five = entry > 0 ? (entry * 5) / 10_000 : 0;
  const atrSlip = Number.isFinite(hourAtr) && hourAtr > 0 ? 0.1 * hourAtr : 0;
  return stop - Math.max(five, atrSlip);
}

export function classARuleExit(close: number, priorCloses: readonly number[], heldDays: number, unrealizedR: number): boolean {
  if (classATenDayExit(close, priorCloses)) return true;
  return heldDays >= 30 && unrealizedR < 1;
}

export function sizedOrder(entry: number, atr: number): { notionalUsd: number; stop: number; riskUsd: number; units: number } | null {
  if (!(entry > 0) || !(atr > 0)) return null;
  const stop = entry - CLASS_A_K * atr;
  if (!(stop > 0) || !(stop < entry)) return null;
  const fraction = (CLASS_A_K * atr) / entry;
  const notionalUsd = Math.min(CLASS_A_RISK_USD / fraction, CLASS_A_NOTIONAL_CAP_USD);
  return { notionalUsd, stop, riskUsd: notionalUsd * fraction, units: notionalUsd / entry };
}

export function healthCheckpoints(startMs: number | null, asOfMs: number): ("90d" | "6m")[] {
  if (startMs == null || !Number.isFinite(asOfMs)) return [];
  const due: ("90d" | "6m")[] = [];
  if (asOfMs >= startMs + 90 * 86_400_000) due.push("90d");
  const start = new Date(startMs);
  const six = Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 6, start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes(), start.getUTCSeconds(), start.getUTCMilliseconds());
  if (asOfMs >= six) due.push("6m");
  return due;
}

export interface BhDay {
  members: readonly string[];
  close: Readonly<Record<string, number>>;
}

/** Equal-weight buy and hold, rebalanced to equal weight when the member set changes. Return is the fraction. */
export function equalWeightBuyHold(days: readonly BhDay[]): number | null {
  if (days.length < 2 || days[0]!.members.length === 0) return null;
  const key = (members: readonly string[]) => members.slice().sort().join(",");
  let held = new Map(days[0]!.members.map((id) => [id, 1 / days[0]!.members.length]));
  let value = 1;
  for (let t = 1; t < days.length; t += 1) {
    const prev = days[t - 1]!;
    const day = days[t]!;
    if (day.members.length === 0) return null;
    if (key(day.members) !== key(prev.members)) held = new Map(day.members.map((id) => [id, 1 / day.members.length]));
    let growth = 0;
    let base = 0;
    const next = new Map<string, number>();
    for (const [id, weight] of held) {
      const before = prev.close[id];
      const after = day.close[id];
      if (before == null || after == null || !(before > 0) || !(after > 0)) return null;
      const step = after / before;
      growth += weight * step;
      base += weight;
      next.set(id, weight * step);
    }
    if (!(base > 0)) return null;
    value *= growth / base;
    const sum = [...next.values()].reduce((total, weight) => total + weight, 0);
    held = new Map([...next.entries()].map(([id, weight]) => [id, weight / sum]));
  }
  return value - 1;
}

/** Book return divided by the average fraction of the $6,000 book that was deployed. */
export function exposureAdjusted(bookReturn: number, deployedFraction: readonly number[]): number | null {
  if (deployedFraction.length === 0 || !Number.isFinite(bookReturn)) return null;
  const avg = deployedFraction.reduce((total, value) => total + value, 0) / deployedFraction.length;
  if (!(avg > 0)) return null;
  return bookReturn / avg;
}

export function deployedFraction(openNotionalUsd: number): number {
  if (!(CLASS_A_BOOK_USD > 0) || !Number.isFinite(openNotionalUsd) || openNotionalUsd < 0) return 0;
  return openNotionalUsd / CLASS_A_BOOK_USD;
}

export interface Concentration {
  top3Share: number | null;
  top3Kill: boolean;
  bestPair: string | null;
  exBestNetR: number | null;
  pairKill: boolean;
}

export function concentrationOf(scored: readonly ClassAScored[]): Concentration {
  if (scored.length === 0) return { top3Share: null, top3Kill: false, bestPair: null, exBestNetR: null, pairKill: false };
  const positive = scored.map((row) => row.grossUsd).filter((value) => value > 0).sort((a, b) => b - a);
  const posSum = positive.reduce((total, value) => total + value, 0);
  const topSum = positive.slice(0, 3).reduce((total, value) => total + value, 0);
  const top3Share = posSum > 0 ? topSum / posSum : null;
  const top3Kill = top3Share != null && positive.length >= 3 && top3Share > 0.5;
  const byPair = new Map<string, number>();
  for (const row of scored) byPair.set(row.pair, (byPair.get(row.pair) ?? 0) + row.netUsd);
  let bestPair: string | null = null;
  let bestNet = Number.NEGATIVE_INFINITY;
  for (const [pair, net] of byPair) {
    if (net > bestNet || (net === bestNet && (bestPair == null || pair < bestPair))) {
      bestPair = pair;
      bestNet = net;
    }
  }
  let exBestNetR = 0;
  let remainder = false;
  for (const row of scored) {
    if (row.pair === bestPair) continue;
    exBestNetR += row.netR;
    remainder = true;
  }
  if (!remainder) exBestNetR = 0;
  return { top3Share, top3Kill, bestPair, exBestNetR, pairKill: exBestNetR <= 0 };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

export function promotionOf(scored: readonly ClassAScored[]): "not-considered" | "blocked" | "unresolved" {
  if (scored.length < CLASS_A_PROMOTE_MIN_N) return "not-considered";
  const gross = mean(scored.map((row) => row.grossBps));
  const concentration = concentrationOf(scored);
  if (gross == null || gross < CLASS_A_PROMOTE_GROSS_BPS || concentration.top3Kill || concentration.pairKill) return "blocked";
  return "unresolved";
}

function finiteNonNeg(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function emptyClassAPaperView(): ClassAPaperView {
  return {
    specSha256: CLASS_A_SPEC_SHA256,
    config: CLASS_A_CONFIG,
    lookback: 55,
    k: 3,
    start: null,
    status: "awaiting-start",
    paper: true,
    n: 0,
    fills: 0,
    fillRate: null,
    skips: {},
    meanGrossBps: null,
    meanNetBps: null,
    meanNetR: null,
    cumNetUsd: 0,
    open: 0,
    kill: false,
    promotion: "not-considered",
    regimes: { BULL: 0, BEAR: 0, CHOP: 0 },
    healthDue: [],
  };
}

export function classAPaperView(book: ClassABook, asOfMs = 0): ClassAPaperView {
  const skips: ClassAPaperView["skips"] = {};
  let fills = 0;
  for (const row of book.rows) {
    if (!row || typeof row !== "object") continue;
    if (row.fill === "fill") fills += 1;
    if (!row.skipReason || !(CLASS_A_SKIP_REASONS as readonly string[]).includes(row.skipReason)) continue;
    skips[row.skipReason] = (skips[row.skipReason] ?? 0) + 1;
  }
  const regimes: Record<ClassARegime, number> = { BULL: 0, BEAR: 0, CHOP: 0 };
  for (const row of book.scored) {
    if (row.regime === "BULL" || row.regime === "BEAR" || row.regime === "CHOP") regimes[row.regime] += 1;
  }
  return {
    specSha256: CLASS_A_SPEC_SHA256,
    config: CLASS_A_CONFIG,
    lookback: 55,
    k: CLASS_A_K,
    start: book.startMs == null ? null : new Date(book.startMs).toISOString(),
    status: book.startMs == null ? "awaiting-start" : book.killed ? "killed" : "running",
    paper: true,
    n: book.scored.length,
    fills,
    fillRate: book.rows.length > 0 ? fills / book.rows.length : null,
    skips,
    meanGrossBps: mean(book.scored.map((row) => row.grossBps)),
    meanNetBps: mean(book.scored.map((row) => row.netBps)),
    meanNetR: mean(book.scored.map((row) => row.netR)),
    cumNetUsd: book.cumNetUsd,
    open: book.open.length,
    kill: book.killed,
    promotion: promotionOf(book.scored),
    regimes,
    healthDue: healthCheckpoints(book.startMs, asOfMs),
  };
}

/** Public /p6 shape. A stored book is reduced to the view, then unknown strings are dropped. */
export function scrubClassAPaper(value: unknown): ClassAPaperView {
  const restored = restoreClassABook(value);
  const source = restored ? classAPaperView(restored) : value;
  return scrubClassAView(source);
}

function scrubClassAView(value: unknown): ClassAPaperView {
  const base = emptyClassAPaperView();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const row = value as Record<string, unknown>;
  const skips: ClassAPaperView["skips"] = {};
  if (row.skips && typeof row.skips === "object" && !Array.isArray(row.skips)) {
    const raw = row.skips as Record<string, unknown>;
    for (const key of CLASS_A_SKIP_REASONS) {
      const count = finiteNonNeg(raw[key]);
      if (count != null) skips[key] = count;
    }
  }
  const regimes: Record<ClassARegime, number> = { BULL: 0, BEAR: 0, CHOP: 0 };
  if (row.regimes && typeof row.regimes === "object" && !Array.isArray(row.regimes)) {
    const raw = row.regimes as Record<string, unknown>;
    for (const key of ["BULL", "BEAR", "CHOP"] as const) {
      const count = finiteNonNeg(raw[key]);
      if (count != null) regimes[key] = count;
    }
  }
  const healthDue: ("90d" | "6m")[] = [];
  if (Array.isArray(row.healthDue)) {
    for (const item of row.healthDue) if ((item === "90d" || item === "6m") && !healthDue.includes(item)) healthDue.push(item);
  }
  const status = row.status === "awaiting-start" || row.status === "running" || row.status === "killed" ? row.status : "redacted";
  const promotion = row.promotion === "not-considered" || row.promotion === "blocked" || row.promotion === "unresolved" ? row.promotion : "redacted";
  const start = typeof row.start === "string" && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(row.start) ? row.start : null;
  return {
    ...base,
    specSha256: row.specSha256 === CLASS_A_SPEC_SHA256 ? CLASS_A_SPEC_SHA256 : "redacted",
    start,
    status,
    n: finiteNonNeg(row.n) ?? 0,
    fills: finiteNonNeg(row.fills) ?? 0,
    fillRate: finiteOrNull(row.fillRate),
    skips,
    meanGrossBps: finiteOrNull(row.meanGrossBps),
    meanNetBps: finiteOrNull(row.meanNetBps),
    meanNetR: finiteOrNull(row.meanNetR),
    cumNetUsd: finiteOrNull(row.cumNetUsd) ?? 0,
    open: finiteNonNeg(row.open) ?? 0,
    kill: row.kill === true,
    promotion,
    regimes,
    healthDue,
  };
}

function barsOf(days: readonly ClassADay[]): DailyBar[] {
  return days.map((day) => ({ date: day.date, high: day.high, low: day.low, close: day.close, volume: day.baseVolume }));
}

function atrAt(days: readonly ClassADay[], index: number): number | null {
  const value = wilderAtr(days.map((day) => day.high), days.map((day) => day.low), days.map((day) => day.close), 14)[index];
  return value != null && value > 0 ? value : null;
}

function chaseSkip(entry: number, signalClose: number, atr: number): boolean {
  return atr > 0 && entry > signalClose + 0.5 * atr;
}

function counterfactualOf(nextHourOpen: number | null, signalClose: number, atr: number): ClassACounterfactual {
  if (nextHourOpen == null || !(nextHourOpen > 0)) return { status: "unavailable", entry: null, grossBps: null, netBps: null, netR: null, exitReason: null };
  if (chaseSkip(nextHourOpen, signalClose, atr)) return { status: "chase", entry: nextHourOpen, grossBps: null, netBps: null, netR: null, exitReason: "chase" };
  return { status: "open", entry: nextHourOpen, grossBps: null, netBps: null, netR: null, exitReason: null };
}

function pushRow(book: ClassABook, row: ClassARow): void {
  book.rows.push(row);
  const openIds = new Set([...book.open, ...book.shadows].map((sim) => sim.rowId));
  const closed = book.rows.filter((item) => !openIds.has(item.id));
  const kept = closed.slice(-80);
  book.rows = [...kept, ...book.rows.filter((item) => openIds.has(item.id))];
}

function skipRow(book: ClassABook, input: ClassASignal, signalMs: number, close: number, atr: number | null, reason: ClassASkip, check: string, measured: number | null, threshold: number | null, veto: boolean, counterfactual: ClassACounterfactual | null): ClassARow {
  const regime = regimeOf(input.btcClose, input.btcSma200, input.btcSma50, input.btcSma50TenAgo);
  const row: ClassARow = {
    id: `${input.pair}:${signalMs}:${reason}`,
    signalMs,
    pair: input.pair,
    medianVolumeUsd: atr == null ? medianVolumeUsd(input.days, input.index) : medianVolumeUsd(input.days, input.index),
    signalClose: close,
    atr,
    stop: null,
    notionalUsd: null,
    fill: "skip",
    skipReason: reason,
    check,
    measured,
    threshold,
    regime,
    btcVeto: veto,
    exitReason: null,
    exitMs: null,
    exitPrice: null,
    grossBps: null,
    netBps: null,
    grossR: null,
    netR: null,
    counterfactual,
  };
  pushRow(book, row);
  return row;
}

function liveShadow(book: ClassABook, row: ClassARow, input: ClassASignal, entry: number, sBps: number, prior: number[]): void {
  if (!row.counterfactual || row.counterfactual.status !== "open") return;
  const sized = sizedOrder(entry, row.atr ?? 0);
  if (!sized) {
    row.counterfactual = { status: "unavailable", entry, grossBps: null, netBps: null, netR: null, exitReason: null };
    return;
  }
  const stop = entry - CLASS_A_K * (row.atr ?? 0);
  book.shadows.push({
    rowId: row.id,
    pair: input.pair,
    scored: false,
    entry,
    entryMs: row.signalMs + 3_600_000,
    entryDate: addDays(input.days[input.index]!.date, 1),
    stop,
    initialStop: stop,
    notionalUsd: sized.notionalUsd,
    units: sized.units,
    feeEntryBps: CLASS_A_TAKER_FEE_BPS + sBps,
    sBps,
    highestClose: entry,
    priorCloses: prior,
    pending: null,
  });
}

export function evaluateSignal(book: ClassABook, input: ClassASignal): ClassARow | null {
  const day = input.days[input.index];
  if (!day) return null;
  const signalMs = signalCloseMs(day.date);
  if (book.startMs == null || signalMs < book.startMs) return null;
  if (EXCLUDED.has(input.pair) || input.listedDays < LISTED_DAYS) return null;
  const history = input.index + 1;
  const triggered = classATrigger(barsOf(input.days), input.index, CLASS_A_LOOKBACK, history < 200);
  if (!triggered) return null;
  const atr = atrAt(input.days, input.index);
  if (atr == null) return null;
  const volume = medianVolumeUsd(input.days, input.index);
  const regime = regimeOf(input.btcClose, input.btcSma200, input.btcSma50, input.btcSma50TenAgo);
  if (volume == null || volume < CLASS_A_VOLUME_FLOOR_USD) {
    return skipRow(book, input, signalMs, day.close, atr, "skip_volume", "volume", volume, CLASS_A_VOLUME_FLOOR_USD, false, null);
  }
  const vetoDay: BtcDay = {
    date: day.date,
    close: input.btcClose ?? Number.NaN,
    ema50: input.btcEma50,
    dailyMove: input.btcDailyMove,
    below4hEma: false,
  };
  const veto = input.btcClose != null && btcVeto(vetoDay);
  if (veto) return skipRow(book, input, signalMs, day.close, atr, "skip_btcveto", "btc", input.btcDailyMove, -0.03, true, null);
  const sBps = takerSpreadBps(input.medianSpreadBps);
  const counterfactual = counterfactualOf(input.nextHourOpen, day.close, atr);
  if (book.killed) return skipRow(book, input, signalMs, day.close, atr, "skip_kill", "kill", book.cumNetUsd, CLASS_A_KILL_USD, false, null);
  const spreadLimit = volume > CLASS_A_VOLUME_TIGHT_USD ? 5 : 10;
  if (input.spreadBps == null || input.spreadBps > spreadLimit) {
    return skipRow(book, input, signalMs, day.close, atr, "skip_spread", "spread", input.spreadBps, spreadLimit, false, counterfactual);
  }
  if (input.depthCostBps == null || input.depthCostBps > 15) {
    return skipRow(book, input, signalMs, day.close, atr, "skip_depth", "depth", input.depthCostBps, 15, false, counterfactual);
  }
  if (input.quoteAgeMs == null || input.quoteAgeMs > CLASS_A_STALE_MS) {
    return skipRow(book, input, signalMs, day.close, atr, "skip_stale", "quote", input.quoteAgeMs, CLASS_A_STALE_MS, false, counterfactual);
  }
  const sized = sizedOrder(day.close, atr);
  if (!sized) return null;
  if (input.minOrderBase == null || sized.units < input.minOrderBase) {
    return skipRow(book, input, signalMs, day.close, atr, "skip_minsize", "minsize", sized.units, input.minOrderBase, false, counterfactual);
  }
  if (book.open.some((sim) => sim.pair === input.pair)) {
    return skipRow(book, input, signalMs, day.close, atr, "skip_pair", "pair", 1, 1, false, null);
  }
  const until = book.reentryUntil[input.pair];
  if (until != null && signalMs < until) return skipRow(book, input, signalMs, day.close, atr, "skip_reentry", "reentry", signalMs, until, false, null);
  const openRisk = book.open.reduce((total, sim) => total + sim.notionalUsd * ((sim.entry - sim.initialStop) / sim.entry), 0);
  if (book.open.length >= CLASS_A_MAX_OPEN || openRisk + sized.riskUsd > CLASS_A_MAX_OPEN_RISK_USD) {
    return skipRow(book, input, signalMs, day.close, atr, "skip_cap", "cap", book.open.length, CLASS_A_MAX_OPEN, false, null);
  }
  const window = { startMs: signalMs, endMs: signalMs + CLASS_A_FILL_WINDOW_MS };
  const tick = input.tick;
  const through = tick != null && tick > 0 ? input.prints.find((print) => print.tsMs >= window.startMs && print.tsMs < window.endMs && print.price <= day.close - tick) : undefined;
  const prior = input.days.slice(Math.max(0, input.index - 9), input.index + 1).map((item) => item.close);
  const row: ClassARow = {
    id: `${input.pair}:${signalMs}`,
    signalMs,
    pair: input.pair,
    medianVolumeUsd: volume,
    signalClose: day.close,
    atr,
    stop: sized.stop,
    notionalUsd: through ? sized.notionalUsd : null,
    fill: through ? "fill" : "nofill",
    skipReason: through ? null : "skip_nofill",
    check: through ? null : "fill",
    measured: through ? through.price : null,
    threshold: tick != null && tick > 0 ? day.close - tick : null,
    regime,
    btcVeto: false,
    exitReason: null,
    exitMs: null,
    exitPrice: null,
    grossBps: null,
    netBps: null,
    grossR: null,
    netR: null,
    counterfactual,
  };
  if (through) {
    book.open.push({
      rowId: row.id,
      pair: input.pair,
      scored: true,
      entry: day.close,
      entryMs: through.tsMs,
      entryDate: addDays(day.date, 1),
      stop: sized.stop,
      initialStop: sized.stop,
      notionalUsd: sized.notionalUsd,
      units: sized.units,
      feeEntryBps: CLASS_A_MAKER_FEE_BPS,
      sBps,
      highestClose: day.close,
      priorCloses: prior,
      pending: null,
    });
  }
  liveShadow(book, row, input, input.nextHourOpen ?? day.close, sBps, prior);
  pushRow(book, row);
  return row;
}

function pnlOf(sim: Sim, exitPx: number): { grossUsd: number; netUsd: number; grossBps: number; netBps: number; grossR: number; netR: number } {
  const grossUsd = sim.units * (exitPx - sim.entry);
  const entryFee = (sim.notionalUsd * sim.feeEntryBps) / 10_000;
  const exitFee = (sim.units * exitPx * (CLASS_A_TAKER_FEE_BPS + sim.sBps)) / 10_000;
  const netUsd = grossUsd - entryFee - exitFee;
  const grossBps = sim.notionalUsd > 0 ? (grossUsd / sim.notionalUsd) * 10_000 : 0;
  const netBps = sim.notionalUsd > 0 ? (netUsd / sim.notionalUsd) * 10_000 : 0;
  return { grossUsd, netUsd, grossBps, netBps, grossR: grossUsd / CLASS_A_RISK_USD, netR: netUsd / CLASS_A_RISK_USD };
}

function closeSim(book: ClassABook, sim: Sim, exitMs: number, exitPx: number, reason: "stop" | "rule"): void {
  const pnl = pnlOf(sim, exitPx);
  const row = book.rows.find((item) => item.id === sim.rowId);
  if (sim.scored) {
    book.cumNetUsd += pnl.netUsd;
    if (book.cumNetUsd <= CLASS_A_KILL_USD) book.killed = true;
    book.scored.push({
      pair: sim.pair,
      grossUsd: pnl.grossUsd,
      netUsd: pnl.netUsd,
      grossBps: pnl.grossBps,
      netBps: pnl.netBps,
      netR: pnl.netR,
      regime: row?.regime ?? "CHOP",
    });
    if (reason === "stop") book.reentryUntil[sim.pair] = exitMs + CLASS_A_NO_REENTRY_MS;
    book.open = book.open.filter((item) => item !== sim);
    if (row) {
      row.exitReason = reason;
      row.exitMs = exitMs;
      row.exitPrice = exitPx;
      row.grossBps = pnl.grossBps;
      row.netBps = pnl.netBps;
      row.grossR = pnl.grossR;
      row.netR = pnl.netR;
    }
    return;
  }
  book.shadows = book.shadows.filter((item) => item !== sim);
  if (row?.counterfactual) {
    row.counterfactual = { status: "closed", entry: sim.entry, grossBps: pnl.grossBps, netBps: pnl.netBps, netR: pnl.netR, exitReason: reason };
  }
}

function hitStop(sim: Sim, open: number, low: number, hourAtr: number, tsMs: number, book: ClassABook): boolean {
  if (!(open <= sim.stop) && !(low <= sim.stop)) return false;
  closeSim(book, sim, tsMs, stopFillPx(sim.stop, sim.entry, hourAtr, open), "stop");
  return true;
}

export function onIntrabar(book: ClassABook, bar: { pair: string; tsMs: number; open: number; low: number; hourAtr: number }): void {
  for (const sim of [...book.open, ...book.shadows]) {
    if (sim.pair !== bar.pair || bar.tsMs < sim.entryMs) continue;
    if (sim.pending) {
      closeSim(book, sim, bar.tsMs, bar.open, "rule");
      continue;
    }
    hitStop(sim, bar.open, bar.low, bar.hourAtr, bar.tsMs, book);
  }
}

export function onDaily(book: ClassABook, bar: { pair: string; date: string; open: number; low: number; close: number; atr: number; hourAtr: number }): void {
  const closeMs = signalCloseMs(bar.date);
  const closeDate = addDays(bar.date, 1);
  for (const sim of [...book.open, ...book.shadows]) {
    if (sim.pair !== bar.pair || closeMs <= sim.entryMs) continue;
    if (sim.pending) {
      closeSim(book, sim, closeMs - 86_400_000, bar.open, "rule");
      continue;
    }
    if (hitStop(sim, bar.open, bar.low, bar.hourAtr, Date.parse(`${bar.date}T00:00:00.000Z`), book)) continue;
    const held = daysBetween(sim.entryDate, closeDate);
    const distance = sim.entry - sim.initialStop;
    const unrealizedR = distance > 0 ? (bar.close - sim.entry) / distance : 0;
    if (held > 0 && classARuleExit(bar.close, sim.priorCloses, held, unrealizedR)) sim.pending = "rule";
    if (bar.close > sim.highestClose) sim.highestClose = bar.close;
    if (bar.atr > 0) sim.stop = Math.max(sim.stop, sim.highestClose - CLASS_A_K * bar.atr);
    sim.priorCloses = [...sim.priorCloses, bar.close].slice(-10);
  }
}

function simOk(value: unknown): value is Sim {
  if (!value || typeof value !== "object") return false;
  const row = value as Sim;
  return typeof row.rowId === "string" && typeof row.pair === "string" && typeof row.scored === "boolean" && typeof row.entry === "number" && row.entry > 0 && typeof row.stop === "number";
}

export function restoreClassABook(value: unknown): ClassABook | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<ClassABook>;
  if (row.startMs != null && (typeof row.startMs !== "number" || !Number.isFinite(row.startMs))) return null;
  if (typeof row.killed !== "boolean" || typeof row.cumNetUsd !== "number" || !Number.isFinite(row.cumNetUsd)) return null;
  if (!Array.isArray(row.open) || !Array.isArray(row.shadows) || !Array.isArray(row.rows) || !Array.isArray(row.scored)) return null;
  if (!row.open.every(simOk) || !row.shadows.every(simOk)) return null;
  const reentry: Record<string, number> = {};
  if (row.reentryUntil && typeof row.reentryUntil === "object") {
    for (const [pair, until] of Object.entries(row.reentryUntil)) {
      if (/^[A-Z0-9]{2,12}-[A-Z]{2,5}$/.test(pair) && typeof until === "number" && Number.isFinite(until)) reentry[pair] = until;
    }
  }
  return {
    startMs: row.startMs ?? null,
    killed: row.killed,
    cumNetUsd: row.cumNetUsd,
    open: row.open,
    shadows: row.shadows,
    reentryUntil: reentry,
    rows: row.rows,
    scored: row.scored.filter((item): item is ClassAScored => !!item && typeof item.pair === "string" && typeof item.netUsd === "number"),
  };
}
