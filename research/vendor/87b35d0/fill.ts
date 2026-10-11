/**
 * Maker-limit paper fill. 120s cancel, 0.5 haircut, 50 bps maker.
 * A limit that would cross is canceled. Missed entries cost nothing.
 */

import { ENTRY_TIMEOUT_MS, FILL_HAIRCUT, MAKER_FEE_BPS } from "./config";

export interface RestingOrder {
  id: string;
  pair: string;
  limit: number;
  unitsRemaining: number;
  placedTs: number;
  expireTs: number;
}

export interface MinuteBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FillEvent {
  status: "partial" | "filled" | "cancel" | "none";
  units: number;
  price: number;
  feeUsd: number;
  feeBps: number;
  reason: string;
}

export function newEntryOrder(id: string, pair: string, limit: number, units: number, placedTs: number): RestingOrder {
  return {
    id,
    pair,
    limit,
    unitsRemaining: units,
    placedTs,
    expireTs: placedTs + ENTRY_TIMEOUT_MS,
  };
}

export function feeOnNotional(notional: number, bps: number): number {
  return (Math.max(0, notional) * bps) / 10_000;
}

/**
 * Try to fill a resting buy on one completed 1-minute bar.
 * The signal bar itself is not eligible: `bar.ts` must be >= placedTs and < expireTs.
 */
export function fillRestingBuy(order: RestingOrder, bar: MinuteBar, haircut = FILL_HAIRCUT): { order: RestingOrder; event: FillEvent } {
  if (bar.ts < order.placedTs || bar.ts >= order.expireTs || !(order.unitsRemaining > 0)) {
    return {
      order,
      event: { status: "cancel", units: 0, price: order.limit, feeUsd: 0, feeBps: MAKER_FEE_BPS, reason: "timeout" },
    };
  }
  if (!(bar.open > order.limit)) {
    return {
      order: { ...order, unitsRemaining: 0 },
      event: { status: "cancel", units: 0, price: order.limit, feeUsd: 0, feeBps: MAKER_FEE_BPS, reason: "would_cross" },
    };
  }
  const traded = bar.low <= order.limit && bar.high >= order.limit;
  if (!traded) {
    return {
      order,
      event: { status: "none", units: 0, price: order.limit, feeUsd: 0, feeBps: MAKER_FEE_BPS, reason: "not_touched" },
    };
  }
  const available = Math.max(0, bar.volume) * haircut;
  const units = Math.min(order.unitsRemaining, available);
  if (!(units > 0)) {
    return {
      order,
      event: { status: "none", units: 0, price: order.limit, feeUsd: 0, feeBps: MAKER_FEE_BPS, reason: "no_size_after_haircut" },
    };
  }
  const notional = units * order.limit;
  const feeUsd = feeOnNotional(notional, MAKER_FEE_BPS);
  const left = order.unitsRemaining - units;
  return {
    order: { ...order, unitsRemaining: left },
    event: {
      status: left <= 1e-12 ? "filled" : "partial",
      units,
      price: order.limit,
      feeUsd,
      feeBps: MAKER_FEE_BPS,
      reason: "maker",
    },
  };
}
