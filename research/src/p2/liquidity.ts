/**
 * Point-in-time 15m liquidity legs with entry/exit hysteresis.
 * Trailing 30 days. These sit on top of the volume tier.
 * (a) non-empty share >= 99% to enter, exit below 97%
 * (b) median 15m USD volume, empty bars as $0, >= $10_000 to enter, exit below $6_000
 * (c) CS15m 30-day median <= 20 bps to enter, exit above 25 bps
 */

export interface LiquiditySample {
  nonemptyShare: number;
  medianUsd: number;
  csMedianBps: number;
}

export interface LiquidityState {
  nonempty: boolean;
  volume: boolean;
  spread: boolean;
}

export const EMPTY_LIQUIDITY: LiquidityState = { nonempty: false, volume: false, spread: false };

export function stepLiquidity(state: LiquidityState, sample: LiquiditySample): LiquidityState {
  return {
    nonempty: hysteresis(state.nonempty, sample.nonemptyShare >= 0.99, sample.nonemptyShare < 0.97),
    volume: hysteresis(state.volume, sample.medianUsd >= 10_000, sample.medianUsd < 6_000),
    spread: hysteresis(state.spread, sample.csMedianBps <= 20, sample.csMedianBps > 25),
  };
}

export function liquidityPasses(state: LiquidityState): boolean {
  return state.nonempty && state.volume && state.spread;
}

function hysteresis(inside: boolean, enter: boolean, exit: boolean): boolean {
  if (!inside && enter) return true;
  if (inside && exit) return false;
  return inside;
}

/** Corwin-Schultz two-bar estimate, floored at 0. Returned in bps. */
export function corwinSchultzBps(h1: number, l1: number, h2: number, l2: number): number {
  if (!(h1 > 0) || !(l1 > 0) || !(h2 > 0) || !(l2 > 0) || h1 < l1 || h2 < l2) return 0;
  const beta = Math.log(h1 / l1) ** 2 + Math.log(h2 / l2) ** 2;
  const high = Math.max(h1, h2);
  const low = Math.min(l1, l2);
  if (!(low > 0) || high < low) return 0;
  const gamma = Math.log(high / low) ** 2;
  const den = 3 - 2 * Math.SQRT2;
  const alpha = (Math.sqrt(2 * beta) - Math.sqrt(beta)) / den - Math.sqrt(gamma / den);
  if (!Number.isFinite(alpha)) return 0;
  const spread = (2 * (Math.exp(alpha) - 1)) / (1 + Math.exp(alpha));
  if (!Number.isFinite(spread) || spread <= 0) return 0;
  return spread * 10_000;
}

/** Median of the observed prints, with a zero for each bar the window is missing. */
export function medianUsdWithGaps(observedUsd: readonly number[], expectedBars: number): number {
  const missing = Math.max(0, expectedBars - observedUsd.length);
  const all = [...observedUsd, ...Array<number>(missing).fill(0)];
  if (all.length === 0) return 0;
  const sorted = all.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** 30-day median of two-bar estimates, then a 2 bp floor. */
export function csMedianBps(estimates: readonly number[]): number | null {
  if (estimates.length === 0) return null;
  const sorted = estimates.map((value) => (Number.isFinite(value) && value > 0 ? value : 0)).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.max(2, median);
}
