/**
 * Swing geometry from the architect decision. These multiples are fixed:
 * stop = max(1h swing-low distance, 2 × 1h ATR14), target in [2.5R, 4R]
 * or the next 4h swing high inside that band. They are not retuned after a run.
 */

import { OVERNIGHT_RISK_CAP_USD, SWING_MAX_HOLD_MS, swingEntryAllowed } from "./config";
import { perTradeFloor, stopBpsOf } from "./fees";

export const SWING_ATR_MULT = 2;
export const SWING_TARGET_R_MIN = 2.5;
export const SWING_TARGET_R_MAX = 4;
export { SWING_MAX_HOLD_MS, OVERNIGHT_RISK_CAP_USD };

export interface SwingStop {
  stop: number;
  stopBps: number;
  swingDist: number;
  atrDist: number;
}

/**
 * Wider of the structural distance and `atrMult` × ATR.
 * The default multiple is 2. The pre-registered search may pass 1.5 or 2.5.
 * No swing low below the entry means no stop.
 */
export function swingStop(entry: number, swingLow: number | null, atr: number, atrMult = SWING_ATR_MULT): SwingStop | null {
  if (!(entry > 0) || !(atr > 0) || !(atrMult > 0) || swingLow == null || !(swingLow < entry)) return null;
  const swingDist = entry - swingLow;
  const atrDist = atrMult * atr;
  const dist = Math.max(swingDist, atrDist);
  const stop = entry - dist;
  if (!(stop > 0) || !(stop < entry)) return null;
  return { stop, stopBps: stopBpsOf(entry, stop), swingDist, atrDist };
}

/**
 * Next 4h swing high if it sits inside (2.5R, 4R]. Above 4R caps at 4R.
 * Anything else, including no swing high, uses 2.5R.
 */
export function swingTarget(entry: number, stop: number, next4hSwingHigh: number | null): number {
  const r = entry - stop;
  const low = entry + SWING_TARGET_R_MIN * r;
  const high = entry + SWING_TARGET_R_MAX * r;
  if (!(r > 0)) return entry;
  if (next4hSwingHigh != null && next4hSwingHigh > low && next4hSwingHigh <= high) return next4hSwingHigh;
  if (next4hSwingHigh != null && next4hSwingHigh > high) return high;
  return low;
}

/**
 * Search target: the registered R multiple, or the next 4h swing high when that
 * high is strictly nearer to the entry. The turn-1 band helper above is unchanged.
 */
export function searchSwingTarget(
  entry: number,
  stop: number,
  targetR: number,
  next4hSwingHigh: number | null,
): number {
  const r = entry - stop;
  if (!(r > 0) || !(targetR > 0)) return entry;
  const planned = entry + targetR * r;
  if (next4hSwingHigh != null && next4hSwingHigh > entry && next4hSwingHigh < planned) return next4hSwingHigh;
  return planned;
}

export function swingFloor(entry: number, stop: number, target: number): { pass: boolean; stopBps: number; targetBps: number } {
  const stopBps = stopBpsOf(entry, stop);
  const targetBps = entry > 0 ? ((target - entry) / entry) * 10_000 : 0;
  return { pass: perTradeFloor(stopBps, targetBps).pass, stopBps, targetBps };
}

export function lossToStopUsd(entry: number, stop: number, units: number): number {
  if (!(units > 0) || !(entry > stop)) return 0;
  return (entry - stop) * units;
}

export function nextUtcMidnight(nowMs: number): number {
  return Math.floor(nowMs / 86_400_000) * 86_400_000 + 86_400_000;
}

export function heldThroughMidnight(openedTs: number, nowMs: number, maxHoldMs = SWING_MAX_HOLD_MS): boolean {
  return openedTs + maxHoldMs > nextUtcMidnight(nowMs);
}

export function overnightRiskUsd(
  positions: Array<{ openedTs: number; entry: number; stop: number; units: number; maxHoldMs?: number }>,
  nowMs: number,
): number {
  let sum = 0;
  for (const pos of positions) {
    if (!heldThroughMidnight(pos.openedTs, nowMs, pos.maxHoldMs ?? SWING_MAX_HOLD_MS)) continue;
    sum += lossToStopUsd(pos.entry, pos.stop, pos.units);
  }
  return sum;
}

export function overnightAllows(openRiskUsd: number, ideaRiskUsd: number): boolean {
  return openRiskUsd + ideaRiskUsd <= OVERNIGHT_RISK_CAP_USD;
}

export { swingEntryAllowed };
