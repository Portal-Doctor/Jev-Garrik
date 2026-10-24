/**
 * Class A forward paper, config A55-k3.
 * Spec sha256 56fb7543d69a80b536d7ae4d9f9d9240ebde33f1500fde45e6b5235e70a753d0.
 * Paper only. This book does not place orders and does not replace the live X1 class A stream.
 *
 * Errata 001 (sha256 31cba546e426e7c0054202d21e9b3c491d9e4510102d2da0d821336ac6128969) settles the open questions.
 * Spec text still governs where it already answered. Paper only.
 * - errata 001 item 1: start is CLASS_A_PAPER_START_MS, or the first 00:00Z close at or after deploy, whichever is later. No backfill.
 * - errata 001 item 2a/2b: promotion reports a one-sided t against the fee-derived bar, Holm at family alpha 0.05, a 10k bootstrap p, and a buy-and-hold gate.
 * - errata 005 (sha256 31c1e06585d84dba3a8aa0492488e7fa90863c8fef1483be0df01d75cfca6824) sets that bar at 230 bps. Advanced 1 fees apply from the start. Intro 50/90 and bar 290 stay on the sensitivity line only.
 * - errata 001 item 3: this maker book is the scored A record. Live X1 rows are tagged elsewhere and are not scored here.
 * - errata 001 item 5 and item 9: 30-day volume excludes the signal day, and that median then the pair symbol orders same-timestamp signals.
 * - errata 001 item 11: a stop fills at stop − max(5 bps of the stop, 0.1 × 1h ATR), or at the open on a gap.
 * - errata 001 item 12: the spread median needs 20 of the 30 prior days, otherwise skip_spread.
 * - errata 001 item 13: a static exclusion preflight blocks the start. The live Coinbase list is not checked here.
 * - errata 001 item 16: counterfactuals on veto, cap, pair, reentry, and kill skips are not built.
 * - errata 001 item 22: fewer than three winning trades still enter the top-share check.
 * - errata 001 item 27: fill rate is fills divided by maker orders placed.
 *
 * Errata 002 (sha256 c28ec8a69938bdf97d7d69cbdbbedb7fcded5a5eeb401adb1c9b1db508651c54).
 * - errata 002 item 1: the Holm family is an input of eight running forward-paper hypotheses. Missing or empty stays unresolved.
 * - errata 002 item 2: the 5 bps stop slip is off the stop price. The shared design-rule stop fill stays unchanged.
 * - errata 002 item 3: A_x1_unscored rows stay class A and are out of Kelly, the class mean, and the kill statistics now.
 * - errata 002 item 4: bootstrap seed 20261011 and 10,000 resamples are fixed.
 * - errata 002 item 5: the start close and a signal at exactly startMs are included.
 * - errata 002 item 6: the benchmark is the drifted buy-and-hold series below. Drift versus daily rebalancing, and zero rebalance fees, are fixed readings. They are not switches. A change waits on errata 003.
 */

import { classATrigger, type DailyBar } from "../p3/classes";
import { classATenDayExit } from "../p3/design-rules";
import { wilderAtr } from "../p2/indicators";
import { btcVeto, type BtcDay } from "../p3/signals";
import { AGREED_EXCLUSIONS, type ExclusionEntry } from "../p2/exclusion";
import { addDays, BOOTSTRAP_SEED, daysBetween, holmAdjusted, studentTCdf } from "../p5/stats";

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
/**
 * errata 005 item 1. Coinbase Advanced 1, fixed for the whole test.
 * sha256 31c1e06585d84dba3a8aa0492488e7fa90863c8fef1483be0df01d75cfca6824.
 */
export const CLASS_A_ERRATA_005_SHA256 = "31c1e06585d84dba3a8aa0492488e7fa90863c8fef1483be0df01d75cfca6824";
export const CLASS_A_MAKER_FEE_BPS = 35;
export const CLASS_A_TAKER_FEE_BPS = 75;
export const CLASS_A_FILL_WINDOW_MS = 4 * 60 * 60 * 1000;
export const CLASS_A_STALE_MS = 2_000;
export const CLASS_A_KILL_USD = -400;
/** errata 005 item 4. 2 × (maker 35 + taker 75 + s floor 5) = 230. Errata 001 H0 is mean gross <= this. */
export const CLASS_A_PROMOTE_GROSS_BPS = 2 * (CLASS_A_MAKER_FEE_BPS + CLASS_A_TAKER_FEE_BPS + 5);
/** errata 005 item 7. Intro schedule. The sensitivity line only. It does not gate. */
export const CLASS_A_INTRO_MAKER_FEE_BPS = 50;
export const CLASS_A_INTRO_TAKER_FEE_BPS = 90;
export const CLASS_A_INTRO_PROMOTE_GROSS_BPS = 2 * (CLASS_A_INTRO_MAKER_FEE_BPS + CLASS_A_INTRO_TAKER_FEE_BPS + 5);
/**
 * errata 005 items 5 and 6. Shared with errata 003 (#2 maker, #4 taker + s, #5b exit) and errata 004 row 1.
 * Those reports are not built here. The rates are the Advanced 1 schedule so the next run does not fork them.
 */
export const CLASS_A_BH_FEE_MAKER_BPS = CLASS_A_MAKER_FEE_BPS;
export const CLASS_A_BH_FEE_TAKER_BPS = CLASS_A_TAKER_FEE_BPS;
export const CLASS_A_BH_EXIT_FEE_BPS = CLASS_A_MAKER_FEE_BPS;
export const CLASS_A_MARKED_ENTRY_FEE_BPS = CLASS_A_MAKER_FEE_BPS;
export const CLASS_A_MARKED_EXIT_FEE_BPS = CLASS_A_TAKER_FEE_BPS;
/** errata 005 item 8. Stated with every promotion recommendation. It does not choose the tier. */
export const CLASS_A_PROMOTION_PRECONDITION =
  "Any promotion recommendation states Brian's actual Coinbase tier at that time and how he qualifies (30-day spot volume, derivatives volume, or USDC balance), and that the qualification does not depend on A's own volume (A alone produces well under $10K per 30 days). If live A would be his only spot volume, or his tier is below Advanced 1, the recommendation is evaluated at that tier's bar (Intro: 290 bps) using the Intro sensitivity line.";
export const CLASS_A_PROMOTE_MIN_N = 30;
export const CLASS_A_NO_REENTRY_MS = 24 * 60 * 60 * 1000;
/** errata 001 item 1. Committed daily close. Not an environment variable. */
export const CLASS_A_PAPER_START_MS = Date.parse("2026-10-26T00:00:00.000Z");
/** errata 001 item 2a. Holm family-wise alpha. Equality does not pass. */
export const CLASS_A_HOLM_ALPHA = 0.05;
/** errata 001 item 2a and errata 002 item 4. Reported beside the t-test. Not the gate. Neither constant may change after start. */
export const CLASS_A_BOOTSTRAP_REPS = 10_000;
/** errata 002 item 4. The house bootstrap seed. Fixed. */
export const CLASS_A_BOOTSTRAP_SEED = BOOTSTRAP_SEED;
/**
 * errata 002 item 1. Every preregistered forward-paper hypothesis whose tracker is running on A's review date.
 * The five ETF-venue ids are not named in the errata or this repo. These placeholders fail closed until a review record names them.
 */
export const CLASS_A_HOLM_FAMILY = ["A", "capitulation", "access-event", "etf-venue-1", "etf-venue-2", "etf-venue-3", "etf-venue-4", "etf-venue-5"] as const;
/** errata 001 item 12. Spread samples required inside the 30 days before the signal. */
export const CLASS_A_SPREAD_MIN_DAYS = 20;
const DAY_MS = 86_400_000;
const LISTED_DAYS = 90;
const EXCLUSION_RULES = new Set<ExclusionEntry["rule"]>(["fiat-or-fx", "commodity", "wrapped-or-bridged", "staking-receipt"]);

export const CLASS_A_SKIP_REASONS = [
  "skip_volume",
  "skip_btcveto",
  "skip_nofill",
  "skip_spread",
  "skip_depth",
  "skip_stale",
  "skip_minsize",
  "skip_minsize_unknown",
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
  /** Kept for callers. The entry gate uses spreadSamples (errata 001 item 12). */
  medianSpreadBps: number | null;
  /**
   * Quoted spread, bps, on the 30 completed days before the signal day.
   * The signal day is not included. errata 001 item 12.
   */
  spreadSamples?: readonly (number | null)[];
  nextHourOpen: number | null;
  hourAtr14: number | null;
  prints: readonly { tsMs: number; price: number }[];
  /**
   * Clock at evaluation. Inside [close, close+4h) with no through-print yet, the maker order stays pending.
   * Omitted means the print list already covers the window, so a miss is nofill.
   */
  asOfMs?: number;
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
  fill: "fill" | "nofill" | "pending" | "skip";
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
  /** Spec A11. Null on a skip, a no-fill, or a maker order that is still pending. Entry fee while open, entry plus exit once closed. */
  feesUsd: number | null;
  /** s = max(5 bps, 0.5 × median quoted spread), frozen when the maker order is placed. */
  sBps?: number;
  counterfactual: ClassACounterfactual | null;
  /** errata 001 item 11. True when a stop exit fills at the bar open. */
  gap?: boolean;
  /** Out of timestamp order, or the same pair and signal time again. Not applied. Not a skip reason. */
  signalOrder?: "out-of-order" | "duplicate";
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

/** A maker order placed at the signal close and not yet filled or expired. Spec A4. Persists with the book. */
export interface ClassAResting {
  rowId: string;
  pair: string;
  signalMs: number;
  windowEndMs: number;
  limit: number;
  tick: number;
  notionalUsd: number;
  units: number;
  stop: number;
  sBps: number;
  priorCloses: number[];
  entryDate: string;
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
  /** errata 001 item 13. False blocks recording. Absent on an old snapshot means the check had not been stored. */
  exclusionOk?: boolean;
  /** Latest applied signal close. An older close is flagged and not applied. Absent on an old snapshot means none. */
  lastSignalMs?: number | null;
  /** Quoted spread bps at prior day closes, per pair. The signal day is not in this list. */
  spreadLog?: Record<string, number[]>;
  /** Maker orders waiting on [close, close+4h). Absent on a snapshot from before pending orders means none. */
  resting?: ClassAResting[];
}

export interface ClassAIntroSensitivity {
  /** Net USD rebilled at Intro maker 50 / taker 90. */
  netUsd: number | null;
  meanNetBps: number | null;
  /** Intro bar. 2 × (50 + 90 + 5) = 290. */
  barBps: typeof CLASS_A_INTRO_PROMOTE_GROSS_BPS;
  meanGrossBps: number | null;
  /** One-sided p that mean gross is above 290. Null when fewer than two closes. */
  tP: number | null;
  /** True when mean gross is above 290. Does not gate. */
  aboveBar: boolean;
}

export interface ClassASHeadroom {
  /** Median s charged on scored closes. Null when none have closed. */
  medianSBps: number | null;
  /** 2 × (35 + 75 + median s). Null when median s is unknown. Does not gate. */
  barBps: number | null;
}

export interface ClassAPaperView {
  specSha256: string;
  config: "A55-k3";
  lookback: 55;
  k: 3;
  start: string | null;
  status: "awaiting-start" | "pending" | "running" | "killed" | "redacted";
  paper: true;
  n: number;
  fills: number;
  fillRate: number | null;
  /** errata 001 item 27. Fills divided by every logged row. Reported beside fillRate. */
  perSignalRate: number | null;
  skips: Partial<Record<ClassASkip, number>>;
  meanGrossBps: number | null;
  meanNetBps: number | null;
  meanNetR: number | null;
  cumNetUsd: number;
  open: number;
  kill: boolean;
  promotion: "not-considered" | "blocked" | "unresolved" | "pass" | "redacted";
  /** errata 001 item 2a. Holm-adjusted one-sided t. The gate is adjusted p < 0.05. */
  holmP: number | null;
  tP: number | null;
  /** errata 001 item 2a. 10k iid bootstrap. Reported, not the gate. */
  bootstrapP: number | null;
  /** errata 001 item 2b. Cumulative net USD / $6,000. */
  bookReturn: number | null;
  bhReturn: number | null;
  beatsBh: boolean | null;
  /** errata 001 item 2b and item 21. Reported. Does not gate. */
  exposureAdjustedReturn: number | null;
  regimes: Record<ClassARegime, number>;
  healthDue: ("90d" | "6m")[];
  /** errata 005 item 7. At every health check and review. Does not gate. */
  introSensitivity: ClassAIntroSensitivity;
  /** errata 005 item 10. Beside the fixed 230 bps bar. Does not gate. */
  sHeadroom: ClassASHeadroom;
  /** errata 005 item 8. */
  promotionPrecondition: string;
}

/**
 * errata 001 item 1. A deploy exactly on 00:00Z uses that close. Any later instant uses the next 00:00Z.
 * The committed start is the floor, so an earlier deploy does not backfill.
 */
export function classAStartMs(deployedAtMs: number): number {
  if (!Number.isFinite(deployedAtMs)) return CLASS_A_PAPER_START_MS;
  const close = Math.ceil(deployedAtMs / DAY_MS) * DAY_MS;
  return Math.max(CLASS_A_PAPER_START_MS, close);
}

/**
 * errata 001 item 13. Static check only: non-empty, unique USD product ids, known category.
 * `confirmed` stays false. A live Coinbase catalog diff is not run here.
 */
export function exclusionPreflight(entries: readonly ExclusionEntry[] = AGREED_EXCLUSIONS): { ok: boolean; reason: string | null } {
  if (entries.length === 0) return { ok: false, reason: "empty" };
  const seen = new Set<string>();
  for (const row of entries) {
    if (!/^[A-Z0-9]{2,12}-USD$/.test(row.productId)) return { ok: false, reason: "shape" };
    if (seen.has(row.productId)) return { ok: false, reason: "duplicate" };
    seen.add(row.productId);
    if (!EXCLUSION_RULES.has(row.rule)) return { ok: false, reason: "rule" };
  }
  return { ok: true, reason: null };
}

export function emptyClassABook(startMs: number | null = null, preflight: { ok: boolean; reason: string | null } = exclusionPreflight()): ClassABook {
  return {
    startMs: preflight.ok ? startMs : null,
    killed: false,
    cumNetUsd: 0,
    open: [],
    shadows: [],
    reentryUntil: {},
    rows: [],
    scored: [],
    exclusionOk: preflight.ok,
    lastSignalMs: null,
    spreadLog: {},
    resting: [],
  };
}

/** errata 001 item 1. Production constructor. An explicit test start stays on emptyClassABook. */
export function openClassABook(deployedAtMs: number): ClassABook {
  return emptyClassABook(classAStartMs(deployedAtMs));
}

/** errata 001 item 1. First attach uses the host clock. A book already on the host is left alone. */
export function ensureClassAPaper(host: { clock: () => number; classAPaper?: ClassABook }): void {
  if (host.classAPaper) return;
  host.classAPaper = openClassABook(host.clock());
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** errata 001 item 5. Thirty completed days ending the day before the signal bar. Null when a day is missing. */
export function medianVolumeUsd(days: readonly { baseVolume: number; close: number }[], index: number): number | null {
  if (index < 30) return null;
  const usd: number[] = [];
  for (let i = index - 30; i <= index - 1; i += 1) {
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

/** Spec s. No 15 bps cap (errata 001 item 4). A missing median still floors at 5 for this helper. The entry gate does not use that floor (errata 001 item 12). */
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

/**
 * errata 001 item 11 and errata 002 item 2. Spec formula is stop − max(5 bps, 0.1 × 1h ATR), or the open on a gap.
 * The 5 bps term is measured off the stop. The shared design-rule stop fill, which uses s_bt of the entry, is unchanged.
 */
export function stopFillPx(stop: number, hourAtr: number, open: number): number {
  if (open <= stop) return open;
  const five = stop > 0 ? (stop * 5) / 10_000 : 0;
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

/**
 * Equal-weight buy and hold on a caller-built member list, rebalanced when that list changes.
 * The promotion benchmark uses classABuyHoldSeries (errata 002 item 6). This helper stays for the older day interface.
 */
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

export interface ClassABhPair {
  pair: string;
  /** Index of the listing day. Membership needs t - listedIndex >= 90. */
  listedIndex: number;
  closes: readonly (number | null)[];
  /** Base volume. USD volume is close times this. */
  volumes: readonly (number | null)[];
}

export interface ClassABhInput {
  /** First window close, inclusive. */
  t0: number;
  /** Review close, inclusive. */
  t1: number;
  excluded: readonly string[];
  candles: readonly ClassABhPair[];
}

export interface ClassABhPoint {
  t: number;
  V: number;
  members: string[];
}

/**
 * errata 002 item 6. Equal-weight buy-and-hold of the A2 eligible set.
 * Weights reset to 1/N at the first window close and when membership changes, and drift with price in between.
 * No rebalance fee. A missing candle carries the last positive close (a 0% day) and counts 0 volume.
 * The pair stays until the 30-day median of those carried days falls below $5M. A zero-volume day is a day, not a hole.
 */
export function classABuyHoldSeries(input: ClassABhInput): ClassABhPoint[] {
  const excluded = new Set(input.excluded);
  const carried = (values: readonly (number | null)[], index: number): number | null => {
    for (let i = index; i >= 0; i -= 1) {
      const value = values[i];
      if (value != null && Number.isFinite(value) && value > 0) return value;
    }
    return null;
  };
  const membership = (t: number): string[] => {
    const names: string[] = [];
    for (const candle of input.candles) {
      if (excluded.has(candle.pair) || t - candle.listedIndex < 90 || t < 30) continue;
      const days = candle.closes.map((close, index) => {
        const quoted = close != null && Number.isFinite(close) && close > 0 ? close : carried(candle.closes, index);
        const volume = candle.volumes[index];
        return {
          close: quoted != null && quoted > 0 ? quoted : 0,
          baseVolume: volume != null && Number.isFinite(volume) && volume >= 0 ? volume : 0,
        };
      });
      const usd = medianVolumeUsd(days, t);
      if (usd != null && usd >= CLASS_A_VOLUME_FLOOR_USD) names.push(candle.pair);
    }
    names.sort();
    return names;
  };
  const byPair = new Map(input.candles.map((candle) => [candle.pair, candle]));
  const ratio = (pair: string, t: number): number => {
    const candle = byPair.get(pair);
    if (!candle) return 1;
    const now = carried(candle.closes, t);
    const prev = carried(candle.closes, t - 1);
    if (now == null || prev == null || !(prev > 0)) return 1;
    return now / prev;
  };
  const out: ClassABhPoint[] = [];
  if (!(input.t1 >= input.t0)) return out;
  let mem = membership(input.t0);
  let weights = new Map(mem.map((pair) => [pair, mem.length > 0 ? 1 / mem.length : 0]));
  let value = 1;
  out.push({ t: input.t0, V: value, members: mem });
  for (let t = input.t0 + 1; t <= input.t1; t += 1) {
    let growth = 0;
    if (weights.size === 0) growth = 1;
    else {
      for (const [pair, weight] of weights) growth += weight * ratio(pair, t);
    }
    if (!(growth > 0)) growth = 1;
    value *= growth;
    if (weights.size > 0) {
      const next = new Map<string, number>();
      for (const [pair, weight] of weights) next.set(pair, (weight * ratio(pair, t)) / growth);
      weights = next;
    }
    const nextMem = membership(t);
    if (nextMem.join(",") !== mem.join(",")) {
      mem = nextMem;
      weights = new Map(mem.map((pair) => [pair, mem.length > 0 ? 1 / mem.length : 0]));
    }
    out.push({ t, V: value, members: mem.slice() });
  }
  return out;
}

/** V at the review close, minus 1. Null when the window is empty. errata 002 item 6. */
export function classABuyHoldReturn(input: ClassABhInput): number | null {
  const series = classABuyHoldSeries(input);
  const last = series[series.length - 1];
  return last ? last.V - 1 : null;
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
  // errata 001 item 22. Fewer than three winners use every winner. Exactly 50% does not kill.
  const top3Kill = top3Share != null && top3Share > 0.5;
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

export interface ClassAPromotion {
  status: "not-considered" | "blocked" | "unresolved" | "pass";
  holmP: number | null;
  tP: number | null;
  bootstrapP: number | null;
  bookReturn: number | null;
  bhReturn: number | null;
  beatsBh: boolean | null;
  exposureAdjustedReturn: number | null;
}

export interface PromotionOpts {
  /**
   * errata 002 item 1. Every name in CLASS_A_HOLM_FAMILY, each with a finite p in [0, 1].
   * A's p in this list is ignored. The gate uses the computed one-sided t. Missing or empty stays unresolved.
   */
  family?: readonly { id: string; p: number }[];
  /** Precomputed buy-and-hold return, V_review − 1. errata 001 item 2b. */
  bhReturn?: number | null;
  /** errata 002 item 6. The drifted series. Used when bhReturn is omitted. */
  bhCandles?: ClassABhInput;
  /** Older day interface. Used only when bhReturn and bhCandles are omitted. */
  bhDays?: readonly BhDay[];
  /** Average deployed fraction series. Reported only. errata 001 item 2b. */
  deployedFraction?: readonly number[];
}

/** One-sided p for a mean above `bar`. Null when fewer than two observations. */
function meanAboveBarP(values: readonly number[], bar: number): number | null {
  if (values.length < 2) return null;
  const n = values.length;
  const avg = values.reduce((total, value) => total + value, 0) / n;
  const variance = values.reduce((total, value) => total + (value - avg) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return avg > bar ? 0 : 1;
  const t = (avg - bar) / (sd / Math.sqrt(n));
  const cdf = studentTCdf(t, n - 1);
  if (!Number.isFinite(cdf)) return null;
  return Math.min(1, Math.max(0, 1 - cdf));
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fraction of iid resample means at or below `bar`. errata 001 item 2a. */
function bootstrapMeanP(values: readonly number[], bar: number, reps: number, seed: number): number | null {
  if (values.length === 0) return null;
  const rand = mulberry32(seed);
  let atOrBelow = 0;
  for (let i = 0; i < reps; i += 1) {
    let sum = 0;
    for (let j = 0; j < values.length; j += 1) {
      const pick = values[Math.floor(rand() * values.length)];
      sum += pick ?? 0;
    }
    if (sum / values.length <= bar) atOrBelow += 1;
  }
  return atOrBelow / reps;
}

/** errata 002 item 1. Null when any of the eight names is missing or its p is not a probability. A's listed p is replaced. */
function holmFamily(rows: readonly { id: string; p: number }[] | undefined, tP: number | null): { id: string; p: number }[] | null {
  if (!rows || rows.length === 0 || tP == null) return null;
  const byId = new Map<string, number>();
  for (const row of rows) {
    if (!Number.isFinite(row.p) || row.p < 0 || row.p > 1) return null;
    byId.set(row.id, row.p);
  }
  const family: { id: string; p: number }[] = [];
  for (const id of CLASS_A_HOLM_FAMILY) {
    if (id === "A") {
      family.push({ id, p: tP });
      continue;
    }
    const p = byId.get(id);
    if (p == null) return null;
    family.push({ id, p });
  }
  return family;
}

/**
 * errata 001 item 2a and item 2b, errata 002 item 1 and item 6.
 * Pass means the numeric gates cleared. It does not change live trading.
 * A missing family or a missing buy-and-hold series stays unresolved. The family does not default to class A alone.
 */
export function promotionOf(scored: readonly ClassAScored[], opts: PromotionOpts = {}): ClassAPromotion {
  const grossValues = scored.map((row) => row.grossBps);
  const gross = mean(grossValues);
  const bookReturn = scored.length > 0 ? scored.reduce((total, row) => total + row.netUsd, 0) / CLASS_A_BOOK_USD : null;
  const tP = meanAboveBarP(grossValues, CLASS_A_PROMOTE_GROSS_BPS);
  const bootstrapP = bootstrapMeanP(grossValues, CLASS_A_PROMOTE_GROSS_BPS, CLASS_A_BOOTSTRAP_REPS, CLASS_A_BOOTSTRAP_SEED);
  const family = holmFamily(opts.family, tP);
  let holmP: number | null = null;
  if (family) {
    const adjusted = holmAdjusted(family);
    holmP = adjusted.find((row) => row.id === "A")?.adjusted ?? null;
  }
  const bhReturn = opts.bhReturn != null && Number.isFinite(opts.bhReturn) ? opts.bhReturn : opts.bhCandles != null ? classABuyHoldReturn(opts.bhCandles) : opts.bhDays != null ? equalWeightBuyHold(opts.bhDays) : null;
  const beatsBh = bookReturn != null && bhReturn != null ? bookReturn > bhReturn : null;
  const exposureAdjustedReturn = bookReturn != null && opts.deployedFraction != null ? exposureAdjusted(bookReturn, opts.deployedFraction) : null;
  const report: ClassAPromotion = { status: "unresolved", holmP, tP, bootstrapP, bookReturn, bhReturn, beatsBh, exposureAdjustedReturn };
  if (scored.length < CLASS_A_PROMOTE_MIN_N) return { ...report, status: "not-considered" };
  const concentration = concentrationOf(scored);
  if (gross == null || gross < CLASS_A_PROMOTE_GROSS_BPS || concentration.top3Kill || concentration.pairKill) return { ...report, status: "blocked" };
  if (!family) return { ...report, status: "unresolved" };
  if (holmP == null || !(holmP < CLASS_A_HOLM_ALPHA)) return { ...report, status: "blocked" };
  if (bhReturn == null || bookReturn == null) return { ...report, status: "unresolved" };
  if (!(bookReturn > bhReturn)) return { ...report, status: "blocked" };
  return { ...report, status: "pass" };
}

function finiteNonNeg(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function emptyIntroSensitivity(): ClassAIntroSensitivity {
  return { netUsd: null, meanNetBps: null, barBps: CLASS_A_INTRO_PROMOTE_GROSS_BPS, meanGrossBps: null, tP: null, aboveBar: false };
}

function emptySHeadroom(): ClassASHeadroom {
  return { medianSBps: null, barBps: null };
}

/** errata 005 item 7. Rebills each scored close at Intro 50/90. Gross is unchanged, so the 290 bar test uses the same gross. */
export function introSensitivityOf(rows: readonly ClassARow[]): ClassAIntroSensitivity {
  const closed = rows.filter((row) => row.fill === "fill" && row.exitPrice != null && row.notionalUsd != null && row.signalClose != null && row.grossBps != null && row.sBps != null && row.notionalUsd > 0 && row.signalClose > 0);
  if (closed.length === 0) return emptyIntroSensitivity();
  let netUsd = 0;
  const netBps: number[] = [];
  const grossBps: number[] = [];
  for (const row of closed) {
    const notional = row.notionalUsd!;
    const entry = row.signalClose!;
    const units = notional / entry;
    const grossUsd = (row.grossBps! / 10_000) * notional;
    const entryFee = (notional * CLASS_A_INTRO_MAKER_FEE_BPS) / 10_000;
    const exitFee = (units * row.exitPrice! * (CLASS_A_INTRO_TAKER_FEE_BPS + row.sBps!)) / 10_000;
    const net = grossUsd - entryFee - exitFee;
    netUsd += net;
    netBps.push((net / notional) * 10_000);
    grossBps.push(row.grossBps!);
  }
  const meanGross = mean(grossBps);
  return {
    netUsd,
    meanNetBps: mean(netBps),
    barBps: CLASS_A_INTRO_PROMOTE_GROSS_BPS,
    meanGrossBps: meanGross,
    tP: meanAboveBarP(grossBps, CLASS_A_INTRO_PROMOTE_GROSS_BPS),
    aboveBar: meanGross != null && meanGross > CLASS_A_INTRO_PROMOTE_GROSS_BPS,
  };
}

/** errata 005 item 10. Median s on scored closes. The fixed bar still uses s = 5. */
export function sHeadroomOf(rows: readonly ClassARow[]): ClassASHeadroom {
  const samples = rows.filter((row) => row.fill === "fill" && row.exitPrice != null && row.sBps != null && row.sBps >= 0).map((row) => row.sBps!);
  const medianSBps = median(samples);
  if (medianSBps == null) return emptySHeadroom();
  return { medianSBps, barBps: 2 * (CLASS_A_MAKER_FEE_BPS + CLASS_A_TAKER_FEE_BPS + medianSBps) };
}

export function emptyClassAPaperView(): ClassAPaperView {
  return {
    specSha256: CLASS_A_SPEC_SHA256,
    config: CLASS_A_CONFIG,
    lookback: 55,
    k: 3,
    start: new Date(CLASS_A_PAPER_START_MS).toISOString(),
    status: Date.now() < CLASS_A_PAPER_START_MS ? "pending" : "running",
    paper: true,
    n: 0,
    fills: 0,
    fillRate: null,
    perSignalRate: null,
    skips: {},
    meanGrossBps: null,
    meanNetBps: null,
    meanNetR: null,
    cumNetUsd: 0,
    open: 0,
    kill: false,
    promotion: "not-considered",
    holmP: null,
    tP: null,
    bootstrapP: null,
    bookReturn: null,
    bhReturn: null,
    beatsBh: null,
    exposureAdjustedReturn: null,
    regimes: { BULL: 0, BEAR: 0, CHOP: 0 },
    healthDue: [],
    introSensitivity: emptyIntroSensitivity(),
    sHeadroom: emptySHeadroom(),
    promotionPrecondition: CLASS_A_PROMOTION_PRECONDITION,
  };
}

export function classAPaperView(book: ClassABook, asOfMs = Date.now()): ClassAPaperView {
  const skips: ClassAPaperView["skips"] = {};
  let fills = 0;
  let placed = 0;
  for (const row of book.rows) {
    if (!row || typeof row !== "object") continue;
    if (row.fill === "fill") fills += 1;
    // errata 001 item 27. Maker orders placed are the rows that passed every check.
    if (row.fill === "fill" || row.skipReason === "skip_nofill") placed += 1;
    if (!row.skipReason || !(CLASS_A_SKIP_REASONS as readonly string[]).includes(row.skipReason)) continue;
    skips[row.skipReason] = (skips[row.skipReason] ?? 0) + 1;
  }
  const promotion = promotionOf(book.scored);
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
    status: book.startMs == null ? "awaiting-start" : book.killed ? "killed" : asOfMs < book.startMs ? "pending" : "running",
    paper: true,
    n: book.scored.length,
    fills,
    fillRate: placed > 0 ? fills / placed : null,
    perSignalRate: book.rows.length > 0 ? fills / book.rows.length : null,
    skips,
    meanGrossBps: mean(book.scored.map((row) => row.grossBps)),
    meanNetBps: mean(book.scored.map((row) => row.netBps)),
    meanNetR: mean(book.scored.map((row) => row.netR)),
    cumNetUsd: book.cumNetUsd,
    open: book.open.length,
    kill: book.killed,
    promotion: promotion.status,
    holmP: promotion.holmP,
    tP: promotion.tP,
    bootstrapP: promotion.bootstrapP,
    bookReturn: promotion.bookReturn,
    bhReturn: promotion.bhReturn,
    beatsBh: promotion.beatsBh,
    exposureAdjustedReturn: promotion.exposureAdjustedReturn,
    regimes,
    healthDue: healthCheckpoints(book.startMs, asOfMs),
    introSensitivity: introSensitivityOf(book.rows),
    sHeadroom: sHeadroomOf(book.rows),
    promotionPrecondition: CLASS_A_PROMOTION_PRECONDITION,
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
  const status = row.status === "awaiting-start" || row.status === "pending" || row.status === "running" || row.status === "killed" ? row.status : "redacted";
  const promotion = row.promotion === "not-considered" || row.promotion === "blocked" || row.promotion === "unresolved" || row.promotion === "pass" ? row.promotion : "redacted";
  const beatsBh = row.beatsBh === true ? true : row.beatsBh === false ? false : null;
  const start = typeof row.start === "string" && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(row.start) ? row.start : null;
  return {
    ...base,
    specSha256: row.specSha256 === CLASS_A_SPEC_SHA256 ? CLASS_A_SPEC_SHA256 : "redacted",
    start,
    status,
    n: finiteNonNeg(row.n) ?? 0,
    fills: finiteNonNeg(row.fills) ?? 0,
    fillRate: finiteOrNull(row.fillRate),
    perSignalRate: finiteOrNull(row.perSignalRate),
    skips,
    meanGrossBps: finiteOrNull(row.meanGrossBps),
    meanNetBps: finiteOrNull(row.meanNetBps),
    meanNetR: finiteOrNull(row.meanNetR),
    cumNetUsd: finiteOrNull(row.cumNetUsd) ?? 0,
    open: finiteNonNeg(row.open) ?? 0,
    kill: row.kill === true,
    promotion,
    holmP: finiteOrNull(row.holmP),
    tP: finiteOrNull(row.tP),
    bootstrapP: finiteOrNull(row.bootstrapP),
    bookReturn: finiteOrNull(row.bookReturn),
    bhReturn: finiteOrNull(row.bhReturn),
    beatsBh,
    exposureAdjustedReturn: finiteOrNull(row.exposureAdjustedReturn),
    regimes,
    healthDue,
    introSensitivity: scrubIntro(row.introSensitivity),
    sHeadroom: scrubHeadroom(row.sHeadroom),
    promotionPrecondition: CLASS_A_PROMOTION_PRECONDITION,
  };
}

function scrubIntro(value: unknown): ClassAIntroSensitivity {
  const empty = emptyIntroSensitivity();
  if (!value || typeof value !== "object" || Array.isArray(value)) return empty;
  const row = value as Record<string, unknown>;
  if (row.barBps !== CLASS_A_INTRO_PROMOTE_GROSS_BPS) return empty;
  return {
    netUsd: finiteOrNull(row.netUsd),
    meanNetBps: finiteOrNull(row.meanNetBps),
    barBps: CLASS_A_INTRO_PROMOTE_GROSS_BPS,
    meanGrossBps: finiteOrNull(row.meanGrossBps),
    tP: finiteOrNull(row.tP),
    aboveBar: row.aboveBar === true,
  };
}

function scrubHeadroom(value: unknown): ClassASHeadroom {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptySHeadroom();
  const row = value as Record<string, unknown>;
  const medianSBps = finiteOrNull(row.medianSBps);
  if (medianSBps == null || medianSBps < 0) return emptySHeadroom();
  return { medianSBps, barBps: 2 * (CLASS_A_MAKER_FEE_BPS + CLASS_A_TAKER_FEE_BPS + medianSBps) };
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
    feesUsd: null,
    counterfactual,
  };
  pushRow(book, row);
  if (book.lastSignalMs == null || signalMs >= book.lastSignalMs) book.lastSignalMs = signalMs;
  return row;
}

function orderRow(book: ClassABook, input: ClassASignal, signalMs: number, close: number, atr: number, order: "out-of-order" | "duplicate"): ClassARow {
  const row: ClassARow = {
    id: `${input.pair}:${signalMs}:${order}`,
    signalMs,
    pair: input.pair,
    medianVolumeUsd: medianVolumeUsd(input.days, input.index),
    signalClose: close,
    atr,
    stop: null,
    notionalUsd: null,
    fill: "skip",
    skipReason: null,
    check: "order",
    measured: signalMs,
    threshold: book.lastSignalMs ?? null,
    regime: regimeOf(input.btcClose, input.btcSma200, input.btcSma50, input.btcSma50TenAgo),
    btcVeto: false,
    exitReason: null,
    exitMs: null,
    exitPrice: null,
    grossBps: null,
    netBps: null,
    grossR: null,
    netR: null,
    feesUsd: null,
    counterfactual: null,
    signalOrder: order,
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

/** errata 001 item 9. Timestamp, then higher 30-day median volume, then pair A→Z. */
export function orderClassASignals(signals: readonly ClassASignal[]): ClassASignal[] {
  const stamp = (signal: ClassASignal): number => {
    const day = signal.days[signal.index];
    return day ? signalCloseMs(day.date) : 0;
  };
  return signals.slice().sort((a, b) => {
    const delta = stamp(a) - stamp(b);
    if (delta !== 0) return delta;
    const av = medianVolumeUsd(a.days, a.index) ?? Number.NEGATIVE_INFINITY;
    const bv = medianVolumeUsd(b.days, b.index) ?? Number.NEGATIVE_INFINITY;
    if (av !== bv) return bv - av;
    if (a.pair === b.pair) return 0;
    return a.pair < b.pair ? -1 : 1;
  });
}

/** errata 001 item 9. Evaluates in timestamp order with the volume then A→Z tie-break. */
export function evaluateSignals(book: ClassABook, signals: readonly ClassASignal[]): (ClassARow | null)[] {
  return orderClassASignals(signals).map((signal) => evaluateSignal(book, signal));
}

export function evaluateSignal(book: ClassABook, input: ClassASignal): ClassARow | null {
  const day = input.days[input.index];
  if (!day) return null;
  const signalMs = signalCloseMs(day.date);
  // errata 001 item 1 and item 13. A failed exclusion preflight or a start in the future records nothing.
  if (book.exclusionOk === false || book.startMs == null || signalMs < book.startMs) return null;
  if (EXCLUDED.has(input.pair) || input.listedDays < LISTED_DAYS) return null;
  const history = input.index + 1;
  const triggered = classATrigger(barsOf(input.days), input.index, CLASS_A_LOOKBACK, history < 200);
  if (!triggered) return null;
  const atr = atrAt(input.days, input.index);
  if (atr == null) return null;
  if (book.lastSignalMs != null && signalMs < book.lastSignalMs) return orderRow(book, input, signalMs, day.close, atr, "out-of-order");
  if (book.rows.some((row) => row.pair === input.pair && row.signalMs === signalMs)) return orderRow(book, input, signalMs, day.close, atr, "duplicate");
  const volume = medianVolumeUsd(input.days, input.index);
  const regime = regimeOf(input.btcClose, input.btcSma200, input.btcSma50, input.btcSma50TenAgo);
  if (volume == null || volume < CLASS_A_VOLUME_FLOOR_USD) {
    return skipRow(book, input, signalMs, day.close, atr, "skip_volume", "volume", volume, CLASS_A_VOLUME_FLOOR_USD, false, null);
  }
  const btcKnown = input.btcClose != null && Number.isFinite(input.btcClose) && input.btcEma50 != null && Number.isFinite(input.btcEma50) && input.btcDailyMove != null && Number.isFinite(input.btcDailyMove);
  const vetoDay: BtcDay = {
    date: day.date,
    close: input.btcClose ?? Number.NaN,
    ema50: input.btcEma50,
    dailyMove: input.btcDailyMove,
    below4hEma: false,
  };
  const veto = !btcKnown || btcVeto(vetoDay);
  // errata 001 item 16. A counterfactual on a veto skip is optional and is not built. Missing BTC fails closed the same way.
  if (veto) return skipRow(book, input, signalMs, day.close, atr, "skip_btcveto", "btc", input.btcDailyMove, -0.03, true, null);
  const counterfactual = counterfactualOf(input.nextHourOpen, day.close, atr);
  if (book.killed) return skipRow(book, input, signalMs, day.close, atr, "skip_kill", "kill", book.cumNetUsd, CLASS_A_KILL_USD, false, null);
  const spreadSamples = (input.spreadSamples ?? []).filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const sBps = takerSpreadBps(median(spreadSamples));
  const prior = input.days.slice(Math.max(0, input.index - 9), input.index + 1).map((item) => item.close);
  const liveSkip = (reason: ClassASkip, check: string, measured: number | null, threshold: number | null): ClassARow => {
    const row = skipRow(book, input, signalMs, day.close, atr, reason, check, measured, threshold, false, counterfactual);
    // Spec A4 and A5. A live-check skip still runs the counterfactual taker. errata 001 item 16 does not cover these four.
    liveShadow(book, row, input, input.nextHourOpen ?? day.close, sBps, prior);
    return row;
  };
  // errata 001 item 12. Twenty of the thirty days before the signal. Nineteen skips. The 5 bps floor is not used.
  if (spreadSamples.length < CLASS_A_SPREAD_MIN_DAYS) {
    return liveSkip("skip_spread", "spread-days", spreadSamples.length, CLASS_A_SPREAD_MIN_DAYS);
  }
  const spreadLimit = volume > CLASS_A_VOLUME_TIGHT_USD ? 5 : 10;
  if (input.spreadBps == null || input.spreadBps > spreadLimit) {
    return liveSkip("skip_spread", "spread", input.spreadBps, spreadLimit);
  }
  if (input.depthCostBps == null || input.depthCostBps > 15) {
    return liveSkip("skip_depth", "depth", input.depthCostBps, 15);
  }
  if (input.quoteAgeMs == null || input.quoteAgeMs > CLASS_A_STALE_MS) {
    return liveSkip("skip_stale", "quote", input.quoteAgeMs, CLASS_A_STALE_MS);
  }
  const sized = sizedOrder(day.close, atr);
  if (!sized) return null;
  if (input.minOrderBase == null) {
    return liveSkip("skip_minsize_unknown", "minsize", sized.units, null);
  }
  if (sized.units < input.minOrderBase) {
    return liveSkip("skip_minsize", "minsize", sized.units, input.minOrderBase);
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
  const seen = input.asOfMs == null ? input.prints : input.prints.filter((print) => print.tsMs <= input.asOfMs!);
  const through = tick != null && tick > 0 ? seen.find((print) => print.tsMs >= window.startMs && print.tsMs < window.endMs && print.price <= day.close - tick) : undefined;
  const observed = input.asOfMs == null || input.asOfMs >= window.endMs;
  const pending = !through && !observed && tick != null && tick > 0;
  const row: ClassARow = {
    id: `${input.pair}:${signalMs}`,
    signalMs,
    pair: input.pair,
    medianVolumeUsd: volume,
    signalClose: day.close,
    atr,
    stop: sized.stop,
    notionalUsd: through || pending ? sized.notionalUsd : null,
    fill: through ? "fill" : pending ? "pending" : "nofill",
    skipReason: through || pending ? null : "skip_nofill",
    check: through || pending ? null : "fill",
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
    feesUsd: through ? (sized.notionalUsd * CLASS_A_MAKER_FEE_BPS) / 10_000 : null,
    sBps,
    counterfactual,
  };
  if (through) openMaker(book, row, input.pair, day.close, through.tsMs, addDays(day.date, 1), sized, sBps, prior, through.price);
  if (pending) {
    const resting = book.resting ?? [];
    book.resting = resting;
    resting.push({
      rowId: row.id,
      pair: input.pair,
      signalMs,
      windowEndMs: window.endMs,
      limit: day.close,
      tick,
      notionalUsd: sized.notionalUsd,
      units: sized.units,
      stop: sized.stop,
      sBps,
      priorCloses: prior,
      entryDate: addDays(day.date, 1),
    });
  }
  liveShadow(book, row, input, input.nextHourOpen ?? day.close, sBps, prior);
  pushRow(book, row);
  if (book.lastSignalMs == null || signalMs >= book.lastSignalMs) book.lastSignalMs = signalMs;
  return row;
}

function openMaker(book: ClassABook, row: ClassARow, pair: string, limit: number, fillMs: number, entryDate: string, sized: { notionalUsd: number; units: number; stop: number }, sBps: number, prior: number[], measured: number): void {
  row.fill = "fill";
  row.skipReason = null;
  row.check = null;
  row.notionalUsd = sized.notionalUsd;
  row.stop = sized.stop;
  row.feesUsd = (sized.notionalUsd * CLASS_A_MAKER_FEE_BPS) / 10_000;
  row.measured = measured;
  book.open.push({
    rowId: row.id,
    pair,
    scored: true,
    entry: limit,
    entryMs: fillMs,
    entryDate,
    stop: sized.stop,
    initialStop: sized.stop,
    notionalUsd: sized.notionalUsd,
    units: sized.units,
    feeEntryBps: CLASS_A_MAKER_FEE_BPS,
    sBps,
    highestClose: limit,
    priorCloses: prior,
    pending: null,
  });
}

/**
 * Spec A4. A pending maker order fills on a print, or on an intrabar low, inside [close, close+4h).
 * nofill is recorded only once that window has ended with neither.
 */
export function resolveClassAResting(
  book: ClassABook,
  nowMs: number,
  event: { pair?: string; prints?: readonly { tsMs: number; price: number }[]; bar?: { startMs: number; endMs: number; low: number } } = {},
): void {
  const resting = book.resting ?? [];
  book.resting = resting;
  if (!Number.isFinite(nowMs)) return;
  for (const order of [...resting]) {
    const row = book.rows.find((item) => item.id === order.rowId && item.fill === "pending");
    if (!row) {
      book.resting = resting.filter((item) => item !== order);
      continue;
    }
    let fillMs: number | null = null;
    if (event.pair == null || event.pair === order.pair) {
      const print = (event.prints ?? []).find((item) => item.tsMs >= order.signalMs && item.tsMs < order.windowEndMs && item.tsMs <= nowMs && item.price <= order.limit - order.tick);
      if (print) {
        fillMs = print.tsMs;
        row.measured = print.price;
      }
      const bar = event.bar;
      if (fillMs == null && bar && bar.startMs >= order.signalMs && bar.startMs < order.windowEndMs && bar.low <= order.limit - order.tick) {
        fillMs = bar.startMs;
        row.measured = bar.low;
      }
    }
    if (fillMs != null) {
      openMaker(book, row, order.pair, order.limit, fillMs, order.entryDate, order, order.sBps, order.priorCloses, row.measured ?? order.limit);
      book.resting = (book.resting ?? []).filter((item) => item !== order);
      continue;
    }
    if (nowMs >= order.windowEndMs) {
      row.fill = "nofill";
      row.skipReason = "skip_nofill";
      row.check = "fill";
      row.notionalUsd = null;
      row.feesUsd = null;
      book.resting = (book.resting ?? []).filter((item) => item !== order);
    }
  }
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

function closeSim(book: ClassABook, sim: Sim, exitMs: number, exitPx: number, reason: "stop" | "rule", gap = false): void {
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
      row.feesUsd = (sim.notionalUsd * sim.feeEntryBps) / 10_000 + (sim.units * exitPx * (CLASS_A_TAKER_FEE_BPS + sim.sBps)) / 10_000;
      if (gap) row.gap = true;
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
  // errata 001 item 11. The open at or through the stop is a gap. A later touch keeps the slipped stop.
  const gap = open <= sim.stop;
  closeSim(book, sim, tsMs, stopFillPx(sim.stop, hourAtr, open), "stop", gap);
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
    // errata 001 item 13. An old snapshot without the flag keeps trading. An explicit false stays false.
    exclusionOk: row.exclusionOk === false ? false : true,
    lastSignalMs: typeof row.lastSignalMs === "number" && Number.isFinite(row.lastSignalMs) ? row.lastSignalMs : null,
    spreadLog: spreadLogOf(row.spreadLog),
    resting: Array.isArray(row.resting) ? row.resting.filter(restingOk) : [],
  };
}

function restingOk(value: unknown): value is ClassAResting {
  if (!value || typeof value !== "object") return false;
  const row = value as ClassAResting;
  return typeof row.rowId === "string"
    && typeof row.pair === "string"
    && typeof row.signalMs === "number"
    && Number.isFinite(row.signalMs)
    && typeof row.windowEndMs === "number"
    && row.windowEndMs > row.signalMs
    && typeof row.limit === "number"
    && row.limit > 0
    && typeof row.tick === "number"
    && row.tick > 0
    && typeof row.notionalUsd === "number"
    && row.notionalUsd > 0
    && typeof row.units === "number"
    && row.units > 0
    && typeof row.stop === "number"
    && typeof row.sBps === "number"
    && row.sBps >= 0
    && Array.isArray(row.priorCloses)
    && typeof row.entryDate === "string";
}

function spreadLogOf(value: unknown): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [pair, samples] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Z0-9]{2,12}-[A-Z]{2,5}$/.test(pair) || !Array.isArray(samples)) continue;
    const nums = samples.filter((item): item is number => typeof item === "number" && Number.isFinite(item) && item >= 0).slice(-30);
    if (nums.length > 0) out[pair] = nums;
  }
  return out;
}
