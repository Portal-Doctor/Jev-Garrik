/**
 * P5 statistics. The kill hurdle of 150 bps is the figure for this run.
 * section1HurdleBps stays available and is not substituted: it depends on the stop.
 * Amendment c makes every 80 percent bound one-sided: U80 is p80 and L80 is p20.
 * The historical Holm family is [A, B] at alpha 0.05. N is the registered 7 and 135.
 */

import { classKill, section1HurdleBps } from "../p3/design-rules";
import { FIRST_UNIVERSE_DATE, OOS_END, OOS_START } from "../p2/universe";
import { foldStartDates } from "../p3/schedule";

export const KILL_HURDLE_BPS = 150;
export const BOOTSTRAP_REPS = 2000;
export const BOOTSTRAP_SEED = 20261011;
/** Kept so the prior diagnostic can be read. The registration governs, so the capped run does not use these. */
export const DSR_TRIALS_REQUESTED = 136;
export const DSR_TRIALS_REGISTERED = 135;
export const N_CUM_SENSITIVITY = 154;
/** v3.1 trial count: the registered 135 plus the 22 historical rows re-run. 135 and 154 stay beside it. */
export const N_CUM_V31 = 157;
export const MAX_OF_N_REQUESTED = 8;
export const MAX_OF_N_REGISTERED = 7;
export const HOLM_ALPHA = 0.05;

export const HOLM_FAMILIES = {
  historical: { streams: 2, firstStep: HOLM_ALPHA / 2, promotes: false },
  classFamily: { streams: 5, firstStep: HOLM_ALPHA / 5, promotes: true },
  jevFamily: { streams: 4, firstStep: HOLM_ALPHA / 4, promotes: true },
  jevGuardFamily: { streams: 2, firstStep: HOLM_ALPHA / 2, promotes: true },
} as const;
/** Mean dollars per week times this factor is mean dollars per month. */
export const WEEKS_PER_MONTH = 365.25 / 12 / 7;

const EULER = 0.5772156649015329;

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

export function daysBetween(earlier: string, later: string): number {
  return Math.round((Date.parse(`${later}T00:00:00.000Z`) - Date.parse(`${earlier}T00:00:00.000Z`)) / 86_400_000);
}

/** Monday (UTC) of the week containing `date`. */
export function weekKey(date: string): string {
  const t = Date.parse(`${date}T00:00:00.000Z`);
  const day = new Date(t).getUTCDay();
  const delta = day === 0 ? 6 : day - 1;
  return new Date(t - delta * 86_400_000).toISOString().slice(0, 10);
}

export interface Fold {
  id: string;
  start: string;
  end: string;
  sample: "IS" | "OOS";
}

export function historicalFolds(): Fold[] {
  const starts = foldStartDates();
  return starts.map((start, index) => {
    const next = starts[index + 1];
    const end = next ? addDays(next, -1) : OOS_END;
    return {
      id: start === FIRST_UNIVERSE_DATE ? "IS" : `OOS-${start}`,
      start,
      end,
      sample: start < OOS_START ? "IS" : "OOS",
    };
  });
}

export function foldOf(entryDate: string): Fold | null {
  return historicalFolds().find((fold) => entryDate >= fold.start && entryDate <= fold.end) ?? null;
}

/** IS trades still open at the OOS boundary are dropped from both samples. */
export function boundaryPurge(entryDate: string, exitDate: string): boolean {
  return entryDate < OOS_START && exitDate >= OOS_START;
}

export interface ExpandingFold {
  id: string;
  isStart: string;
  isEnd: string;
  oosStart: string;
  oosEnd: string;
}

/** Eight anchored folds. IS always starts at 2025-11-10 and ends the day before that fold's OOS month. */
export function expandingFolds(): ExpandingFold[] {
  return historicalFolds()
    .filter((fold) => fold.sample === "OOS")
    .map((fold) => ({
      id: fold.id,
      isStart: FIRST_UNIVERSE_DATE,
      isEnd: addDays(fold.start, -1),
      oosStart: fold.start,
      oosEnd: fold.end,
    }));
}

/** A trade open across `boundary` is dropped from both the IS prefix and that fold's OOS. */
export function purgedAtBoundary(entryDate: string, exitDate: string, boundary: string): boolean {
  return entryDate < boundary && exitDate >= boundary;
}

export function isPrefix<T extends { entryDate: string; exitDate: string }>(trades: readonly T[], fold: ExpandingFold): T[] {
  return trades.filter((trade) => trade.entryDate >= fold.isStart && trade.entryDate <= fold.isEnd && !purgedAtBoundary(trade.entryDate, trade.exitDate, fold.oosStart));
}

export function oosSlice<T extends { entryDate: string; exitDate: string }>(trades: readonly T[], fold: ExpandingFold): T[] {
  return trades.filter((trade) => trade.entryDate >= fold.oosStart && trade.entryDate <= fold.oosEnd && !purgedAtBoundary(trade.entryDate, trade.exitDate, fold.oosStart));
}

/** One config per fold, in fold order. Configs stay in registration order for the tie-break. */
export function selectByFold<T>(configs: readonly T[], folds: readonly ExpandingFold[], tradesOf: (config: T) => readonly { entryDate: string; exitDate: string; netUsd: number }[], l80Of: (trades: readonly { entryDate: string; exitDate: string; netUsd: number }[], fold: ExpandingFold) => number, totalOf: (trades: readonly { entryDate: string; exitDate: string; netUsd: number }[]) => number): { fold: ExpandingFold; chosen: T }[] {
  return folds.map((fold) => {
    const rows = configs.map((config) => ({ config, trades: isPrefix(tradesOf(config), fold) }));
    const chosen = selectInSample(rows, (row) => l80Of(row.trades, fold), (row) => totalOf(row.trades));
    return { fold, chosen: chosen.config };
  });
}

export function netR(netUsd: number, riskUsd: number): number | null {
  if (!(riskUsd > 0) || !Number.isFinite(netUsd)) return null;
  return netUsd / riskUsd;
}

/** Realized net R. n below 30 enters at p = 1. */
export function netRStreamP(values: readonly number[]): { p: number; status: "testable" | "not testable"; n: number } {
  const n = values.length;
  if (n < 30) return { p: 1, status: "not testable", n };
  return { ...forwardStreamP(n, meanAboveZeroP(values)), n };
}

/** Mean of C + max(25, 0.15 S) over the class's own trades. The v3 constant 150 is not used. */
export function meanHurdleBps(trades: readonly { costBps: number; stopBps: number }[]): number | null {
  if (trades.length === 0) return null;
  return trades.reduce((sum, trade) => sum + section1HurdleBps(trade.costBps, trade.stopBps), 0) / trades.length;
}

export function killVerdict(n: number, meanGrossBps: number, upper80Bps: number): "insufficient" | "kill" | "keep" {
  return classKill({ n, meanGrossBps, upper80Bps, hurdleBps: KILL_HURDLE_BPS });
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

/**
 * Prior diagnostic bound: the 90th percentile of a weekly block bootstrap of the trade mean.
 * Amendment c replaces this for the registered run. The uncapped report was not recomputed.
 */
export function upper80Mean(values: readonly number[], weekKeys: readonly string[], reps = BOOTSTRAP_REPS, seed = BOOTSTRAP_SEED): number | null {
  if (values.length === 0) return null;
  if (values.length !== weekKeys.length) throw new Error("weekly block bootstrap needs one key per value");
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const groups = new Map<string, number[]>();
  for (let i = 0; i < values.length; i += 1) {
    const key = weekKeys[i]!;
    const block = groups.get(key) ?? [];
    block.push(values[i]!);
    groups.set(key, block);
  }
  const weeks = [...groups.keys()].sort();
  if (weeks.length < 2) return mean;
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let rep = 0; rep < reps; rep += 1) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < weeks.length; i += 1) {
      const pick = weeks[Math.floor(rand() * weeks.length)]!;
      for (const value of groups.get(pick)!) {
        sum += value;
        n += 1;
      }
    }
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  const index = Math.min(means.length - 1, Math.max(0, Math.ceil(0.9 * means.length) - 1));
  return means[index] ?? null;
}

function logGamma(z: number): number {
  const p = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - logGamma(1 - z);
  let x = 0.99999999999980993;
  const base = z - 1;
  for (let i = 0; i < p.length; i += 1) x += p[i]! / (base + i + 1);
  const t = base + p.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (base + 0.5) * Math.log(t) - t + Math.log(x);
}

function betacf(a: number, b: number, x: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 200; m += 1) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < 1e-30) d = 1e-30;
    c = 1 + aa / c;
    if (Math.abs(c) < 1e-30) c = 1e-30;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < 3e-12) break;
  }
  return h;
}

function regularizedBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lnBeta = logGamma(a) + logGamma(b) - logGamma(a + b);
  if (x < (a + 1) / (a + b + 2)) {
    const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a;
    return front * betacf(a, b, x);
  }
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / b;
  return 1 - front * betacf(b, a, 1 - x);
}

export function studentTCdf(t: number, df: number): number {
  if (!(df > 0) || !Number.isFinite(t)) return Number.NaN;
  const x = df / (df + t * t);
  const ib = regularizedBeta(x, df / 2, 0.5);
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib;
}

export function normCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const density = 0.3989422804014327 * Math.exp(-0.5 * z * z);
  const tail = density * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - tail : tail;
}

/** Acklam's inverse normal. */
export function normInv(p: number): number {
  if (!(p > 0) || !(p < 1)) throw new Error("probability must be in (0, 1)");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - plow) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** One-sided p-value for a mean above zero. Null when fewer than two observations. */
export function meanAboveZeroP(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const n = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return mean > 0 ? 0 : 1;
  const t = mean / (sd / Math.sqrt(n));
  const cdf = studentTCdf(t, n - 1);
  if (!Number.isFinite(cdf)) return null;
  return Math.min(1, Math.max(0, 1 - cdf));
}

export interface PValue {
  id: string;
  p: number;
}

export function holmAdjusted(rows: readonly PValue[]): { id: string; p: number; adjusted: number }[] {
  const sorted = rows.slice().sort((a, b) => a.p - b.p || (a.id < b.id ? -1 : 1));
  const m = sorted.length;
  let running = 0;
  return sorted.map((row, index) => {
    running = Math.max(running, Math.min(1, (m - index) * row.p));
    return { id: row.id, p: row.p, adjusted: running };
  });
}

export function bhAdjusted(rows: readonly PValue[]): { id: string; p: number; adjusted: number }[] {
  const sorted = rows.slice().sort((a, b) => a.p - b.p || (a.id < b.id ? -1 : 1));
  const m = sorted.length;
  const adjusted = sorted.map((row, index) => Math.min(1, (row.p * m) / (index + 1)));
  for (let i = adjusted.length - 2; i >= 0; i -= 1) adjusted[i] = Math.min(adjusted[i]!, adjusted[i + 1]!);
  return sorted.map((row, index) => ({ id: row.id, p: row.p, adjusted: adjusted[index]! }));
}

export interface TradeMoments {
  n: number;
  mean: number;
  sharpe: number;
  skew: number;
  kurtosis: number;
}

/** Per-trade Sharpe uses the sample standard deviation. Skew and kurtosis use divisor n. Kurtosis is Pearson, not excess. */
export function tradeMoments(values: readonly number[]): TradeMoments | null {
  if (values.length < 2) return null;
  const n = values.length;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const value of values) {
    const d = value - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  const variance = m2 / (n - 1);
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return { n, mean, sharpe: 0, skew: 0, kurtosis: 0 };
  const pop = m2 / n;
  return {
    n,
    mean,
    sharpe: mean / sd,
    skew: m3 / n / pop ** 1.5,
    kurtosis: m4 / n / pop ** 2,
  };
}

/** Expected maximum Sharpe under a null of N independent trials, variance 1. */
export function expectedMaxSharpe(nTrials: number): number | null {
  if (!(nTrials >= 2)) return null;
  const z1 = normInv(1 - 1 / nTrials);
  const z2 = normInv(1 - 1 / (nTrials * Math.E));
  return (1 - EULER) * z1 + EULER * z2;
}

/** Monday-aligned weeks from the week containing `start` through the week containing `end`. */
export function mondayWeeks(start: string, end: string): string[] {
  const out: string[] = [];
  let cursor = weekKey(start);
  const last = weekKey(end);
  while (cursor <= last) {
    out.push(cursor);
    cursor = addDays(cursor, 7);
  }
  return out;
}

/** Hyndman-Fan type 7. The index is (n − 1) times p, with linear interpolation. */
export function percentileLinear(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) throw new Error("percentile of an empty sample");
  if (!(p >= 0) || !(p <= 1)) throw new Error("percentile must be in [0, 1]");
  if (sorted.length === 1) return sorted[0]!;
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo]!;
  const weight = h - lo;
  return sorted[lo]! * (1 - weight) + sorted[hi]! * weight;
}

export interface BoundDraw {
  l80: number;
  u80: number;
  seed: number;
  reps: number;
  drawsUsed: number;
  weeks: number;
  zeroWeeks: number;
  interpolation: "linear, index (n-1)*p";
}

function boundsOf(stats: number[], weeks: number, zeroWeeks: number, seed: number, reps: number): BoundDraw {
  const sorted = stats.slice().sort((a, b) => a - b);
  return {
    l80: percentileLinear(sorted, 0.2),
    u80: percentileLinear(sorted, 0.8),
    seed,
    reps,
    drawsUsed: sorted.length,
    weeks,
    zeroWeeks,
    interpolation: "linear, index (n-1)*p",
  };
}

/**
 * One-sided bounds of the mean of weekly values.
 * A week with no trades is already 0 in `weekValues`. Draws resample weeks with replacement.
 * `scale` turns a weekly mean into the reported mean. Use 1 for a weekly mean and WEEKS_PER_MONTH for $/month.
 */
export function oneSided80(weekValues: readonly number[], opts?: { reps?: number; seed?: number; scale?: number }): BoundDraw | null {
  if (weekValues.length === 0) return null;
  const reps = opts?.reps ?? BOOTSTRAP_REPS;
  const seed = opts?.seed ?? BOOTSTRAP_SEED;
  const scale = opts?.scale ?? 1;
  const rand = mulberry32(seed);
  const stats: number[] = [];
  const n = weekValues.length;
  for (let rep = 0; rep < reps; rep += 1) {
    let sum = 0;
    for (let i = 0; i < n; i += 1) sum += weekValues[Math.floor(rand() * n)]!;
    stats.push((sum / n) * scale);
  }
  return boundsOf(stats, n, weekValues.filter((value) => value === 0).length, seed, reps);
}

/**
 * One-sided bounds of the mean of trade values, with whole weeks kept together.
 * An empty week adds no trades. A draw that picks no trades is omitted.
 */
export function oneSided80TradeMean(weekTrades: readonly (readonly number[])[], opts?: { reps?: number; seed?: number }): BoundDraw | null {
  if (weekTrades.length === 0 || weekTrades.every((week) => week.length === 0)) return null;
  const reps = opts?.reps ?? BOOTSTRAP_REPS;
  const seed = opts?.seed ?? BOOTSTRAP_SEED;
  const rand = mulberry32(seed);
  const stats: number[] = [];
  const n = weekTrades.length;
  for (let rep = 0; rep < reps; rep += 1) {
    let sum = 0;
    let count = 0;
    for (let i = 0; i < n; i += 1) {
      const week = weekTrades[Math.floor(rand() * n)]!;
      for (const value of week) {
        sum += value;
        count += 1;
      }
    }
    if (count > 0) stats.push(sum / count);
  }
  if (stats.length === 0) return null;
  return boundsOf(stats, n, weekTrades.filter((week) => week.length === 0).length, seed, reps);
}

export function weeklyValues(entries: readonly { week: string; value: number }[], weeks: readonly string[]): number[] {
  const sums = new Map(weeks.map((week) => [week, 0]));
  for (const entry of entries) {
    if (!sums.has(entry.week)) continue;
    sums.set(entry.week, (sums.get(entry.week) ?? 0) + entry.value);
  }
  return weeks.map((week) => sums.get(week) ?? 0);
}

export function weeklyGroups(entries: readonly { week: string; value: number }[], weeks: readonly string[]): number[][] {
  const groups = new Map(weeks.map((week) => [week, [] as number[]]));
  for (const entry of entries) groups.get(entry.week)?.push(entry.value);
  return weeks.map((week) => groups.get(week) ?? []);
}

/** Integer cents. Amendment a calls two amounts tied when these are equal. */
export function cents(value: number): number {
  return Math.round(value * 100);
}

export function selectInSample<T>(rows: readonly T[], l80Of: (row: T) => number, totalOf: (row: T) => number): T {
  if (rows.length === 0) throw new Error("in-sample selection needs a config");
  let best = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const l80 = cents(l80Of(rows[i]!)) - cents(l80Of(rows[best]!));
    if (l80 > 0) {
      best = i;
      continue;
    }
    if (l80 < 0) continue;
    const total = cents(totalOf(rows[i]!)) - cents(totalOf(rows[best]!));
    if (total > 0) best = i;
  }
  return rows[best]!;
}

/** Amendment b. A forward stream with n below 30 enters at p = 1 and is not testable. */
export function forwardStreamP(n: number, p: number | null): { p: number; status: "testable" | "not testable" } {
  if (!(n >= 30) || p == null || !Number.isFinite(p)) return { p: 1, status: "not testable" };
  return { p, status: "testable" };
}

/** Bailey and López de Prado deflated Sharpe, as a probability. */
export function deflatedSharpe(opts: { sharpe: number; nObs: number; skew: number; kurtosis: number; nTrials: number }): number | null {
  const sr0 = expectedMaxSharpe(opts.nTrials);
  if (sr0 == null || opts.nObs < 2 || !Number.isFinite(opts.sharpe)) return null;
  const sr = opts.sharpe;
  const inside = (1 - opts.skew * sr + ((opts.kurtosis - 1) / 4) * sr * sr) / (opts.nObs - 1);
  if (!(inside > 0)) return null;
  return normCdf((sr - sr0) / Math.sqrt(inside));
}
