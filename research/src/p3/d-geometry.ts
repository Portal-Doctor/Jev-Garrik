/**
 * Geometry from 87b35d093710e3683d5910ee81bf7b1a46276bbc paperday/src/swing.ts
 * and paperday/src/fees.ts.
 * Wiring: config and fees imports are inlined from that commit.
 * MAKER_FEE_BPS = 50, TAKER_FEE_BPS = 90, SWING_MAX_HOLD_MS = 48h,
 * OVERNIGHT_RISK_CAP_USD = 500.
 * Historical D fills are not simulated. Candidates are geometry only.
 * The agreed v3 config is k = 1.5 and targetR = 4. The 87b35d0 function
 * default when targetR is omitted is 3; that default is not used here.
 */

export const D_STOP_ATR_MULT = 1.5;
export const D_TARGET_R = 4;
const F_WIN_BPS = 100;
const F_LOSS_BPS = 140;
const MIN_NET_RR = 1.5;

export interface SwingStop {
  stop: number;
  stopBps: number;
  swingDist: number;
  atrDist: number;
}

export function swingStop(entry: number, swingLow: number | null, atr: number, atrMult = D_STOP_ATR_MULT): SwingStop | null {
  if (!(entry > 0) || !(atr > 0) || !(atrMult > 0) || swingLow == null || !(swingLow < entry)) return null;
  const swingDist = entry - swingLow;
  const atrDist = atrMult * atr;
  const dist = Math.max(swingDist, atrDist);
  const stop = entry - dist;
  if (!(stop > 0) || !(stop < entry)) return null;
  return { stop, stopBps: stopBpsOf(entry, stop), swingDist, atrDist };
}

export function searchSwingTarget(entry: number, stop: number, targetR: number, nextSwingHigh: number | null): number {
  const r = entry - stop;
  if (!(r > 0) || !(targetR > 0)) return entry;
  const planned = entry + targetR * r;
  if (nextSwingHigh != null && nextSwingHigh > entry && nextSwingHigh < planned) return nextSwingHigh;
  return planned;
}

export function swingFloor(entry: number, stop: number, target: number): { pass: boolean; stopBps: number; targetBps: number } {
  const stopBps = stopBpsOf(entry, stop);
  const targetBps = entry > 0 ? ((target - entry) / entry) * 10_000 : 0;
  const winnerBps = targetBps - F_WIN_BPS;
  const loserBps = stopBps + F_LOSS_BPS;
  const pass = stopBps > 0 && targetBps > 0 && loserBps > 0 && winnerBps >= MIN_NET_RR * loserBps;
  return { pass, stopBps, targetBps };
}

function stopBpsOf(entry: number, stop: number): number {
  if (!(entry > stop) || !(entry > 0)) return 0;
  return ((entry - stop) / entry) * 10_000;
}

export interface DCandidate {
  entry: number;
  stop: number;
  target: number;
  stopBps: number;
  targetBps: number;
}

/** One geometry candidate. No fill is simulated. */
export function dCandidate(entry: number, swingLow: number | null, atr: number, nextSwingHigh: number | null): DCandidate | null {
  const geom = swingStop(entry, swingLow, atr, D_STOP_ATR_MULT);
  if (!geom) return null;
  const target = searchSwingTarget(entry, geom.stop, D_TARGET_R, nextSwingHigh);
  const floor = swingFloor(entry, geom.stop, target);
  if (!floor.pass) return null;
  return { entry, stop: geom.stop, target, stopBps: floor.stopBps, targetBps: floor.targetBps };
}
