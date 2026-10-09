/**
 * Position manager for an open paper long.
 * Exit reasons: stop, breakeven, trail, t2, time_stop, vwap_invalidation, rollover_flat, data_gap.
 * T1 sells half at 1.5R and moves the stop to entry. The stop never widens.
 */

import { DATA_GAP_EXIT_SEC, MAKER_FEE_BPS, TAKER_FEE_BPS, TIME_STOP_MS } from "./config";
import { barEndsAtUtcMidnight } from "./clock";
import { feeOnNotional, type MinuteBar } from "./fill";

export type ExitReason =
  | "stop"
  | "breakeven"
  | "trail"
  | "t2"
  | "time_stop"
  | "vwap_invalidation"
  | "rollover_flat"
  | "data_gap";

export interface Position {
  id: string;
  pair: string;
  entry: number;
  units: number;
  initialUnits: number;
  initialStop: number;
  stop: number;
  openedTs: number;
  entryFeeUsd: number;
  t1Done: boolean;
  lastTs: number;
}

export interface PosEvent {
  kind: "t1" | "exit";
  reason: ExitReason | "t1";
  price: number;
  units: number;
  feeUsd: number;
  feeBps: number;
  netUsd: number;
  rMultiple: number;
}

export interface StepContext {
  /** Seconds since the previous price. Above 120 forces a data-gap exit. */
  gapSec: number;
  fiveMinComplete: boolean;
  fiveMinClose: number | null;
  vwap: number | null;
  /** Confirmed 5-minute swing low. Applied only after T1, and only if it tightens the stop. */
  confirmedSwingLow: number | null;
}

export interface StepResult {
  position: Position | null;
  events: PosEvent[];
}

export function rDistance(entry: number, stop: number): number {
  return entry - stop;
}

export function target(entry: number, stop: number, multiple: number): number {
  return entry + (entry - stop) * multiple;
}

export function rMultiple(netUsd: number, entry: number, initialStop: number, initialUnits: number): number {
  const risk = (entry - initialStop) * initialUnits;
  if (!(risk > 0)) return 0;
  return netUsd / risk;
}

function pnl(units: number, entry: number, price: number, feeUsd: number, entryFeeAlloc: number): number {
  return units * price - feeUsd - units * entry - entryFeeAlloc;
}

function entryFeeAlloc(pos: Position, units: number): number {
  if (!(pos.initialUnits > 0)) return 0;
  return pos.entryFeeUsd * (units / pos.initialUnits);
}

export function openPosition(opts: {
  id: string;
  pair: string;
  entry: number;
  units: number;
  stop: number;
  openedTs: number;
  entryFeeUsd: number;
}): Position {
  return {
    id: opts.id,
    pair: opts.pair,
    entry: opts.entry,
    units: opts.units,
    initialUnits: opts.units,
    initialStop: opts.stop,
    stop: opts.stop,
    openedTs: opts.openedTs,
    entryFeeUsd: opts.entryFeeUsd,
    t1Done: false,
    lastTs: opts.openedTs,
  };
}

/** A long stop may only move up. */
export function tightenStop(current: number, proposed: number): { stop: number; widened: boolean } {
  if (proposed < current) return { stop: current, widened: true };
  return { stop: proposed, widened: false };
}

function closeAll(pos: Position, price: number, feeBps: number, reason: ExitReason): { position: null; events: PosEvent[] } {
  const units = pos.units;
  const feeUsd = feeOnNotional(units * price, feeBps);
  const netUsd = pnl(units, pos.entry, price, feeUsd, entryFeeAlloc(pos, units));
  return {
    position: null,
    events: [
      {
        kind: "exit",
        reason,
        price,
        units,
        feeUsd,
        feeBps,
        netUsd,
        rMultiple: rMultiple(netUsd, pos.entry, pos.initialStop, pos.initialUnits),
      },
    ],
  };
}

function stopReason(pos: Position): ExitReason {
  if (pos.t1Done && pos.stop === pos.entry) return "breakeven";
  if (pos.t1Done && pos.stop > pos.initialStop) return "trail";
  return "stop";
}

export function stepPosition(pos: Position, bar: MinuteBar, ctx: StepContext): StepResult {
  if (ctx.gapSec > DATA_GAP_EXIT_SEC) {
    return closeAll(pos, bar.open, TAKER_FEE_BPS, "data_gap");
  }
  if (barEndsAtUtcMidnight(bar.ts)) {
    return closeAll(pos, bar.open, TAKER_FEE_BPS, "rollover_flat");
  }

  let next: Position = { ...pos, lastTs: bar.ts };
  const events: PosEvent[] = [];

  if (bar.low <= next.stop) {
    const price = bar.open < next.stop ? bar.open : next.stop;
    return closeAll(next, price, TAKER_FEE_BPS, stopReason(next));
  }

  const t1 = target(next.entry, next.initialStop, 1.5);
  const t2 = target(next.entry, next.initialStop, 3);

  if (bar.high >= t2) {
    return closeAll(next, t2, MAKER_FEE_BPS, "t2");
  }

  if (!next.t1Done && bar.high >= t1) {
    const units = next.initialUnits / 2;
    const sell = Math.min(next.units, units);
    if (sell > 0) {
      const feeUsd = feeOnNotional(sell * t1, MAKER_FEE_BPS);
      const netUsd = pnl(sell, next.entry, t1, feeUsd, entryFeeAlloc(next, sell));
      events.push({
        kind: "t1",
        reason: "t1",
        price: t1,
        units: sell,
        feeUsd,
        feeBps: MAKER_FEE_BPS,
        netUsd,
        rMultiple: rMultiple(netUsd, next.entry, next.initialStop, next.initialUnits),
      });
      const tightened = tightenStop(next.stop, next.entry);
      next = { ...next, units: next.units - sell, t1Done: true, stop: tightened.stop };
    }
  }

  if (next.t1Done && ctx.confirmedSwingLow != null && ctx.confirmedSwingLow < bar.close) {
    const tightened = tightenStop(next.stop, ctx.confirmedSwingLow);
    next = { ...next, stop: tightened.stop };
  }

  if (ctx.fiveMinComplete && ctx.fiveMinClose != null && ctx.vwap != null && ctx.fiveMinClose < ctx.vwap) {
    const closed = closeAll(next, ctx.fiveMinClose, TAKER_FEE_BPS, "vwap_invalidation");
    return { position: null, events: [...events, ...closed.events] };
  }

  if (bar.ts + 60_000 >= next.openedTs + TIME_STOP_MS && bar.ts > next.openedTs) {
    const closed = closeAll(next, bar.close, TAKER_FEE_BPS, "time_stop");
    return { position: null, events: [...events, ...closed.events] };
  }

  return { position: next, events };
}
