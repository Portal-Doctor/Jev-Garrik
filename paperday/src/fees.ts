/**
 * 50/90 fee split and the per-trade floor.
 * Entry is maker 50. A resting target is maker 50, so a winner's round trip is 100 bps.
 * Stop, time, invalidation, rollover, data-gap, and an unfilled target sold at market
 * are taker 90, so a loser's round trip is 140 bps. The 0.5 fill haircut is unchanged.
 * The floor is (T − 100) >= 1.5 × (S + 140). It is not widened to create trades.
 */

import { MAKER_FEE_BPS, TAKER_FEE_BPS } from "./config";

export const F_WIN_BPS = MAKER_FEE_BPS + MAKER_FEE_BPS;
export const F_LOSS_BPS = MAKER_FEE_BPS + TAKER_FEE_BPS;
export const MIN_NET_RR = 1.5;

export type ExitLiquidity = "target" | "stop" | "market";

/** Round trip charged in the gate. The position manager bills each leg on its own. */
export function roundTripBps(exit: ExitLiquidity): number {
  return exit === "target" ? F_WIN_BPS : F_LOSS_BPS;
}

/** Exit-leg fee only. A market sale of a target that never rested is taker. */
export function exitLegBps(exit: ExitLiquidity): number {
  return exit === "target" ? MAKER_FEE_BPS : TAKER_FEE_BPS;
}

export interface Floor {
  stopBps: number;
  targetBps: number;
  winnerBps: number;
  loserBps: number;
  netRR: number;
  pass: boolean;
}

/**
 * Net reward:risk after the fee split. A missing target cannot pass:
 * a trail or a timed market exit is not a resting maker target.
 */
export function perTradeFloor(stopBps: number, targetBps: number | null): Floor {
  const stop = Number.isFinite(stopBps) ? stopBps : 0;
  const target = targetBps != null && Number.isFinite(targetBps) ? targetBps : 0;
  const winnerBps = target - F_WIN_BPS;
  const loserBps = stop + F_LOSS_BPS;
  const netRR = loserBps > 0 ? winnerBps / loserBps : 0;
  const pass = targetBps != null && stop > 0 && target > 0 && loserBps > 0 && winnerBps >= MIN_NET_RR * loserBps;
  return { stopBps: stop, targetBps: target, winnerBps, loserBps, netRR, pass };
}

export function bpsBetween(entry: number, price: number): number {
  if (!(entry > 0) || !Number.isFinite(price)) return 0;
  return ((price - entry) / entry) * 10_000;
}

export function stopBpsOf(entry: number, stop: number): number {
  if (!(entry > stop) || !(entry > 0)) return 0;
  return ((entry - stop) / entry) * 10_000;
}
