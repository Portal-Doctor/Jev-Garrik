/**
 * Class D geometry calls the vendored 87b35d0 functions.
 * It does not reimplement swing stops, targets, findSetups, or the fee floor.
 * The v3 target multiple is passed as 4. The omitted-argument default in
 * swing4h.ts is 3 and is not used.
 * Daily bias is the swing_4h gate: EMA200 exists, close > EMA50, close > prior
 * close, using emaSeries from that commit. biasFromFourHour is a different gate
 * and is not the one recordStops uses.
 */

import { belowFeeFloor } from "../../vendor/87b35d0/expectancy.ts";
import { emaSeries, indicatorSeries, latestSwingLow, nearestSwingHighAbove, type Ohlcv } from "../../vendor/87b35d0/indicators.ts";
import { findSetups, type DecisionSnapshot } from "../../vendor/87b35d0/rules.ts";
import { searchSwingTarget, swingFloor, swingStop, type SwingStop } from "../../vendor/87b35d0/swing.ts";

export const D_STOP_ATR_MULT = 1.5;
export const D_TARGET_R = 4;
const H4_MS = 14_400_000;
const D1_MS = 86_400_000;

export interface DSignal {
  /** Close time of the 4h bar, unix milliseconds. */
  barTs: number;
  setup: string;
  entry: number;
  stop: number;
  target: number;
  stopBps: number;
  targetBps: number;
}

export { searchSwingTarget, swingFloor, swingStop, type SwingStop };

/** swing_4h prepare(): index i is up only when EMA200 exists, close > EMA50, and close > the prior close. */
export function dailyBiasUp(days: readonly Ohlcv[]): boolean[] {
  const ema50 = emaSeries(days.map((bar) => bar.close), 50);
  const ema200 = emaSeries(days.map((bar) => bar.close), 200);
  return days.map((bar, i) => {
    const prev = i > 0 ? days[i - 1] : undefined;
    const e50 = ema50[i];
    const e200 = ema200[i];
    return i >= 199 && e200 != null && e50 != null && prev != null && bar.close > e50 && bar.close > prev.close;
  });
}

function lastClosed(bars: readonly Ohlcv[], tfMs: number, atMs: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.ts + tfMs <= atMs) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function snapshot4(pair: string, h4: readonly Ohlcv[], ind4: ReturnType<typeof indicatorSeries>, h4i: number, biasUp: boolean): DecisionSnapshot | null {
  const bar = h4[h4i];
  const ind = ind4[h4i];
  if (!bar || !ind) return null;
  const prev = h4i > 0 ? h4[h4i - 1] : undefined;
  const prevInd = h4i > 0 ? ind4[h4i - 1] : undefined;
  let recentLow3 = bar.low;
  for (let k = 1; k <= 2 && h4i - k >= 0; k++) recentLow3 = Math.min(recentLow3, h4[h4i - k]!.low);
  return {
    pair,
    barTs: bar.ts,
    close: bar.close,
    low: bar.low,
    high: bar.high,
    prevClose: prev?.close ?? null,
    prevVwap: prevInd?.vwap ?? null,
    vwap: ind.vwap,
    ema9: ind.ema9,
    ema20: ind.ema20,
    ema50: ind.ema50,
    ema200: ind.ema200,
    rsi: ind.rsi14,
    macd: ind.macd,
    macdSignal: ind.macdSignal,
    atr: ind.atr14,
    volume: bar.volume,
    volSma20: ind.volSma20,
    recentLow3,
    donchian5mPriorHigh: ind.donchian20PriorHigh,
    close4h: bar.close,
    donchian4hPriorHigh: ind.donchian20PriorHigh,
    biasKnown: biasUp,
    biasUp,
  };
}

/**
 * One decision bar, matching swing4h recordStops.
 * The swing high is nearestSwingHighAbove confirmed at or before d1i.
 * A high that still needs a future bar is not a target.
 */
export function dGeometryAt(
  entry: number,
  atr: number,
  h4: Ohlcv[],
  h4i: number,
  d1: Ohlcv[],
  d1i: number,
): { stop: number; target: number; stopBps: number; targetBps: number } | null {
  const geom = swingStop(entry, latestSwingLow(h4, h4i), atr, D_STOP_ATR_MULT);
  if (!geom) return null;
  const nextHigh = d1i >= 0 ? nearestSwingHighAbove(d1, d1i, entry) : null;
  const target = searchSwingTarget(entry, geom.stop, D_TARGET_R, nextHigh);
  const floor = swingFloor(entry, geom.stop, target);
  if (!floor.pass || belowFeeFloor(floor.stopBps, floor.targetBps)) return null;
  return { stop: geom.stop, target, stopBps: floor.stopBps, targetBps: floor.targetBps };
}

/** Geometry candidates only. No fill is simulated. */
export function classDCandidates(pair: string, h4: readonly Ohlcv[], d1: readonly Ohlcv[]): DSignal[] {
  if (h4.length === 0 || d1.length === 0) return [];
  const four = h4.slice();
  const days = d1.slice();
  const bias = dailyBiasUp(days);
  const ind4 = indicatorSeries(four);
  const out: DSignal[] = [];
  for (let h4i = 0; h4i < h4.length; h4i++) {
    const bar = h4[h4i]!;
    const decisionTs = bar.ts + H4_MS;
    const d1i = lastClosed(d1, D1_MS, decisionTs);
    const snap = snapshot4(pair, four, ind4, h4i, d1i >= 0 && bias[d1i] === true);
    if (!snap || snap.atr == null || !(snap.atr > 0) || !snap.biasUp) continue;
    for (const setup of findSetups(snap, "clear", "combined")) {
      const geom = dGeometryAt(setup.entry, snap.atr, four, h4i, days, d1i);
      if (!geom) continue;
      out.push({
        barTs: decisionTs,
        setup: setup.setup,
        entry: setup.entry,
        stop: geom.stop,
        target: geom.target,
        stopBps: geom.stopBps,
        targetBps: geom.targetBps,
      });
    }
  }
  return out;
}
