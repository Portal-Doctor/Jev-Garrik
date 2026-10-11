/**
 * v3.1 sizing, beta, clusters, and the class R kill.
 * Historical pauses and Jev guards are not applied here.
 */

import { TAKER_FEE_BPS } from "../../vendor/87b35d0/config.ts";

interface ClosePoint {
  date: string;
  close: number;
}

export const CLASS_R_KILL = 20;
export const CLASS_DOLLAR_BACKSTOP_USD = 1_200;
export const CLUSTER_RHO = 0.8;
export const CLUSTER_DAYS = 60;

/** C = 2 × (90 + s_bt). Base s_bt 5 is 190. Stress s_bt 10 is 200. */
export function sizingCostBps(sBtBps: number): number {
  return 2 * (TAKER_FEE_BPS + sBtBps);
}

/** One exit leg, 90 + s_bt. */
export function exitLegBps(sBtBps: number): number {
  return TAKER_FEE_BPS + sBtBps;
}

export function entryOpenRiskUsd(notional: number, stopBps: number, costBps: number): number {
  return (notional * (stopBps + costBps)) / 10_000;
}

/** After the stop moves: price distance from the entry fill, plus one exit leg on units times the current stop. */
export function openRiskAfterMove(units: number, entry: number, stop: number, sBtBps: number): number {
  const price = units * Math.max(0, entry - stop);
  const exitCost = (units * Math.max(0, stop) * exitLegBps(sBtBps)) / 10_000;
  return price + exitCost;
}

/** Negative beta does not offset a long book. */
export function betaWeight(beta: number): number {
  return Math.max(beta, 0);
}

export function olsBeta(asset: readonly number[], benchmark: readonly number[]): number | null {
  if (asset.length !== benchmark.length || asset.length < CLUSTER_DAYS) return null;
  const n = asset.length;
  let assetSum = 0;
  let benchSum = 0;
  for (let i = 0; i < n; i += 1) {
    assetSum += asset[i]!;
    benchSum += benchmark[i]!;
  }
  const assetMean = assetSum / n;
  const benchMean = benchSum / n;
  let cov = 0;
  let benchVar = 0;
  for (let i = 0; i < n; i += 1) {
    const assetDelta = asset[i]! - assetMean;
    const benchDelta = benchmark[i]! - benchMean;
    cov += assetDelta * benchDelta;
    benchVar += benchDelta * benchDelta;
  }
  if (!(benchVar > 0)) return null;
  return cov / benchVar;
}

export function alignedBeta(asset: readonly ClosePoint[], benchmark: readonly ClosePoint[], asOf: string, series: (days: readonly ClosePoint[], at: string) => Map<string, number>): number | null {
  const left = series(asset, asOf);
  const right = series(benchmark, asOf);
  const dates = [...left.keys()].filter((date) => right.has(date)).sort().slice(-CLUSTER_DAYS);
  if (dates.length < CLUSTER_DAYS) return null;
  return olsBeta(dates.map((date) => left.get(date)!), dates.map((date) => right.get(date)!));
}

/** A missing beta takes the highest signed member beta. None defined falls back to 1. */
export function assignBetas(rows: readonly { id: string; beta: number | null }[]): Map<string, number> {
  const defined = rows.map((row) => row.beta).filter((beta): beta is number => beta != null);
  const highest = defined.length === 0 ? 1 : Math.max(...defined);
  const out = new Map<string, number>();
  for (const row of rows) out.set(row.id, row.beta ?? highest);
  return out;
}

/**
 * UPGMA. Two clusters merge only when every member pair has a rho and the mean is at least 0.80.
 * Equal means merge the lexicographically earliest pair of cluster ids.
 */
export function averageLinkage(ids: readonly string[], rhoOf: (left: string, right: string) => number | null): Map<string, string> {
  let groups = ids.map((id) => [id]);
  const meanRho = (left: readonly string[], right: readonly string[]): number | null => {
    let sum = 0;
    let n = 0;
    for (const a of left) {
      for (const b of right) {
        const value = rhoOf(a, b);
        if (value == null) return null;
        sum += value;
        n += 1;
      }
    }
    return n === 0 ? null : sum / n;
  };
  const label = (group: readonly string[]) => group.slice().sort()[0]!;
  for (;;) {
    let bestI = -1;
    let bestJ = -1;
    let best = CLUSTER_RHO;
    let bestLabel = "";
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const value = meanRho(groups[i]!, groups[j]!);
        if (value == null || value < CLUSTER_RHO) continue;
        const pairLabel = [label(groups[i]!), label(groups[j]!)].sort().join("\0");
        if (bestI < 0 || value > best || (value === best && pairLabel < bestLabel)) {
          best = value;
          bestI = i;
          bestJ = j;
          bestLabel = pairLabel;
        }
      }
    }
    if (bestI < 0) break;
    const merged = [...groups[bestI]!, ...groups[bestJ]!];
    groups = groups.filter((_, index) => index !== bestI && index !== bestJ);
    groups.push(merged);
  }
  const out = new Map<string, string>();
  for (const group of groups) {
    const id = label(group);
    for (const name of group) out.set(name, id);
  }
  return out;
}

/** 20R from the class peak, or $1,200 from the class peak cumulative net dollars. */
export function classKillTripped(peakR: number, cumR: number, peakUsd: number, cumUsd: number): boolean {
  return peakR - cumR >= CLASS_R_KILL || peakUsd - cumUsd >= CLASS_DOLLAR_BACKSTOP_USD;
}
