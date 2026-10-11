/**
 * P5 statistics. The kill hurdle of 150 bps is the figure for this run.
 * section1HurdleBps stays available and is not substituted: it depends on the stop.
 * Holm and BH adjusted p-values are reported without an alpha cut. The registration
 * does not name an alpha.
 */

import { classKill } from "../p3/design-rules";
import { FIRST_UNIVERSE_DATE, OOS_END, OOS_START } from "../p2/universe";
import { foldStartDates } from "../p3/schedule";

export const KILL_HURDLE_BPS = 150;
export const BOOTSTRAP_REPS = 2000;
export const BOOTSTRAP_SEED = 20261011;
export const DSR_TRIALS_REQUESTED = 136;
export const DSR_TRIALS_REGISTERED = 135;
export const MAX_OF_N_REQUESTED = 8;
export const MAX_OF_N_REGISTERED = 7;

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
 * Upper end of a central 80 percent interval for the mean.
 * Weeks are resampled together. Fewer than two weeks returns the sample mean.
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

/** Bailey and López de Prado deflated Sharpe, as a probability. */
export function deflatedSharpe(opts: { sharpe: number; nObs: number; skew: number; kurtosis: number; nTrials: number }): number | null {
  const sr0 = expectedMaxSharpe(opts.nTrials);
  if (sr0 == null || opts.nObs < 2 || !Number.isFinite(opts.sharpe)) return null;
  const sr = opts.sharpe;
  const inside = (1 - opts.skew * sr + ((opts.kurtosis - 1) / 4) * sr * sr) / (opts.nObs - 1);
  if (!(inside > 0)) return null;
  return normCdf((sr - sr0) / Math.sqrt(inside));
}
