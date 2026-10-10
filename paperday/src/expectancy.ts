/**
 * Setup-class acceptance. p* is the architect's stated breakeven:
 *   p* = (S + 140) / (T + S − 40)
 * and must be <= 45%. Walk-forward expectancy uses only trades that closed
 * strictly earlier, split into three equal time ranges. A split is positive
 * when its mean out-of-sample E is at least +0.15R or at least +25 bps.
 * Two of the three splits must be positive. Nothing here is fitted.
 */

import { perTradeFloor } from "./fees";

export const MAX_P_STAR = 0.45;
export const MIN_E_R = 0.15;
export const MIN_E_BPS = 25;

export interface ClosedSample {
  closeTs: number;
  stopBps: number;
  targetBps: number;
  win: boolean;
  rMultiple: number;
}

export interface SplitResult {
  index: number;
  fromTs: number;
  toTs: number;
  n: number;
  eR: number;
  eBps: number;
  positive: boolean;
}

export interface ExpectancyReport {
  n: number;
  wins: number;
  p: number | null;
  meanStopBps: number | null;
  meanTargetBps: number | null;
  pStar: number | null;
  pStarPass: boolean;
  eR: number | null;
  eBps: number | null;
  positiveSplits: number;
  splits: SplitResult[];
  pass: boolean;
  reasons: string[];
}

/** Architect's formula, including the examples 150/450 → ~52% and 500/1500 → ~33%. */
export function pStar(stopBps: number, targetBps: number): number {
  const den = targetBps + stopBps - 40;
  if (!(den > 0)) return 1;
  return (stopBps + 140) / den;
}

export function pStarAccepts(stopBps: number, targetBps: number): boolean {
  return pStar(stopBps, targetBps) <= MAX_P_STAR;
}

export function tradeExpectancy(p: number, stopBps: number, targetBps: number): { eBps: number; eR: number } {
  const eBps = p * (targetBps - 100) - (1 - p) * (stopBps + 140);
  const eR = stopBps > 0 ? eBps / stopBps : 0;
  return { eBps, eR };
}

export function expectancyMeets(eBps: number, eR: number): boolean {
  return eR >= MIN_E_R || eBps >= MIN_E_BPS;
}

function mean(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function classExpectancy(samples: ClosedSample[]): ExpectancyReport {
  const trades = samples.filter((t) => t.closeTs > 0 && t.stopBps > 0 && t.targetBps > 0).slice().sort((a, b) => a.closeTs - b.closeTs);
  const reasons: string[] = [];
  const n = trades.length;
  const wins = trades.filter((t) => t.win).length;
  const p = n > 0 ? wins / n : null;
  const meanStopBps = mean(trades.map((t) => t.stopBps));
  const meanTargetBps = mean(trades.map((t) => t.targetBps));
  const pStarValue = meanStopBps != null && meanTargetBps != null ? pStar(meanStopBps, meanTargetBps) : null;
  const pStarPass = pStarValue != null && pStarValue <= MAX_P_STAR;
  const full = p != null && meanStopBps != null && meanTargetBps != null ? tradeExpectancy(p, meanStopBps, meanTargetBps) : null;

  const oos: Array<{ closeTs: number; eBps: number; eR: number }> = [];
  for (let i = 1; i < trades.length; i++) {
    const prior = trades.slice(0, i);
    const priorP = prior.filter((t) => t.win).length / prior.length;
    const e = tradeExpectancy(priorP, trades[i]!.stopBps, trades[i]!.targetBps);
    oos.push({ closeTs: trades[i]!.closeTs, eBps: e.eBps, eR: e.eR });
  }

  const splits: SplitResult[] = [];
  if (oos.length > 0) {
    const start = oos[0]!.closeTs;
    const end = oos[oos.length - 1]!.closeTs;
    const span = Math.max(1, end - start);
    for (let k = 0; k < 3; k++) {
      const fromTs = start + (span * k) / 3;
      const toTs = k === 2 ? end + 1 : start + (span * (k + 1)) / 3;
      const bucket = oos.filter((row) => row.closeTs >= fromTs && row.closeTs < toTs);
      const eBps = mean(bucket.map((row) => row.eBps)) ?? 0;
      const eR = mean(bucket.map((row) => row.eR)) ?? 0;
      const positive = bucket.length > 0 && expectancyMeets(eBps, eR);
      splits.push({ index: k, fromTs, toTs, n: bucket.length, eR, eBps, positive });
    }
  } else {
    for (let k = 0; k < 3; k++) splits.push({ index: k, fromTs: 0, toTs: 0, n: 0, eR: 0, eBps: 0, positive: false });
  }

  const positiveSplits = splits.filter((s) => s.positive).length;
  if (!(n > 0)) reasons.push("no closed trades");
  if (pStarValue == null || !pStarPass) reasons.push(`p* ${pStarValue == null ? "n/a" : (pStarValue * 100).toFixed(1)}% > 45%`);
  if (positiveSplits < 2) reasons.push(`walk-forward positive splits ${positiveSplits} < 2`);
  const pass = reasons.length === 0;
  return {
    n,
    wins,
    p,
    meanStopBps,
    meanTargetBps,
    pStar: pStarValue,
    pStarPass,
    eR: full?.eR ?? null,
    eBps: full?.eBps ?? null,
    positiveSplits,
    splits,
    pass,
    reasons,
  };
}

/** Setups that fail this never become candidates. */
export function belowFeeFloor(stopBps: number, targetBps: number | null): boolean {
  return !perTradeFloor(stopBps, targetBps).pass;
}
