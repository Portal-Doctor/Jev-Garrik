/**
 * S1 read plan. One Fallback B packet per member plus BTC at each completed 15m bar.
 * position stays 0. This module does not call Jev.
 */

import { percentileLabel } from "../p5/guards";
import { feedProducts } from "./public-ws";

export interface ShadowPacket {
  pair: string;
  position: 0;
  barStartSec: number;
  label: "warming" | "read";
  called: false;
}

const FIFTEEN_SEC = 900;

export function isCompleted15m(startSec: number, nowSec: number): boolean {
  return startSec % FIFTEEN_SEC === 0 && nowSec >= startSec + FIFTEEN_SEC;
}

/** Packets for a completed 15m bar. A forming bar, including one whose start is aligned, returns none. Nothing is called. */
export function shadowPackets(opts: { members: readonly string[]; barStartSec: number; nowSec: number; warming: boolean }): ShadowPacket[] {
  if (!isCompleted15m(opts.barStartSec, opts.nowSec)) return [];
  return feedProducts(opts.members).map((pair) => ({
    pair,
    position: 0 as const,
    barStartSec: opts.barStartSec,
    label: opts.warming ? "warming" as const : "read" as const,
    called: false as const,
  }));
}

export function warmupLabel(day: number): "log-only" | "pooled baseline" | "per-pair" {
  return percentileLabel(day);
}

export const JEV_WINDOW_MINUTES = 15;
export const JEV_CUMULATIVE_CAP_USD = 5;
export const JEV_MONTH_CAP_USD = 100;
/**
 * Held before a shadow call and settled to the real cost after.
 * The spec names no per-call maximum. One million tokens at $0.042/Mtok is $0.042,
 * so the hold is $0.05. A call that cannot hold this amount is not started.
 */
export const JEV_CALL_RESERVE_USD = 0.05;

export interface JevMinute {
  ts: number;
  close: number;
}

export interface JevMinutePacket extends ShadowPacket {
  minutes: JevMinute[];
}

/** One close per minute inside the 15m window. A missing minute is absent, not filled. */
export function minuteCloses(
  mids: readonly { productId: string; ts: number; close: number }[],
  productId: string,
  barStartSec: number,
): JevMinute[] {
  const start = barStartSec * 1000;
  const end = start + JEV_WINDOW_MINUTES * 60_000;
  const byTs = new Map<number, number>();
  for (const bar of mids) {
    if (bar.productId !== productId || bar.ts < start || bar.ts >= end) continue;
    byTs.set(bar.ts, bar.close);
  }
  return [...byTs.entries()].sort((a, b) => a[0] - b[0]).map(([ts, close]) => ({ ts, close }));
}

/**
 * Packets for every member plus BTC, built from that window's 1m closes.
 * `missing` is true when any of those products has fewer than 15 minutes.
 * This does not call Jev.
 */
export function buildJevPackets(opts: {
  members: readonly string[];
  barStartSec: number;
  nowSec: number;
  mids: readonly { productId: string; ts: number; close: number }[];
}): { packets: JevMinutePacket[]; missing: boolean } {
  const ids = feedProducts(opts.members);
  const packets = shadowPackets({
    members: opts.members,
    barStartSec: opts.barStartSec,
    nowSec: opts.nowSec,
    warming: false,
  }).map((packet) => ({ ...packet, minutes: minuteCloses(opts.mids, packet.pair, opts.barStartSec) }));
  const missing = ids.some((id) => minuteCloses(opts.mids, id, opts.barStartSec).length < JEV_WINDOW_MINUTES);
  return { packets, missing };
}

export interface JevMeter {
  cumulativeUsd: number;
  monthUsd: number;
  month: string;
  capUsd: 5;
  monthCapUsd: 100;
  /** Successful shadow calls that committed a charge. */
  calls: number;
  /** Spend whose UTC day is `today`. */
  todayUsd: number;
  /** UTC day `YYYY-MM-DD`, or empty before the first charge. */
  today: string;
}

/** The cumulative P6 cap stays $5. The month cap is the soak's $100. No call is made here. */
export function freshJevMeter(cumulativeUsd = 0): JevMeter {
  if (cumulativeUsd < 0 || cumulativeUsd > JEV_CUMULATIVE_CAP_USD) throw new Error("jev spend cap");
  return { cumulativeUsd, monthUsd: 0, month: "", capUsd: 5, monthCapUsd: JEV_MONTH_CAP_USD, calls: 0, todayUsd: 0, today: "" };
}

/** True when a positive charge still fits both caps. Does not modify `meter`. */
export function jevSpendFits(meter: JevMeter, month: string): boolean {
  try {
    noteJevSpend(meter, 1e-9, month);
    return true;
  } catch {
    return false;
  }
}

/** Commit one call. `todayUsd` resets when the UTC day changes. Throws when a cap would be passed. */
export function chargeJevCall(meter: JevMeter, costUsd: number, nowMs: number): JevMeter {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const base: JevMeter = meter.today === day ? meter : { ...meter, today: day, todayUsd: 0 };
  const next = noteJevSpend(base, costUsd, month);
  return { ...next, calls: (base.calls ?? 0) + 1, today: day, todayUsd: (base.todayUsd ?? 0) + costUsd };
}

function roundUsd(value: number): number {
  return Math.round(value * 1e9) / 1e9;
}

/** Hold `JEV_CALL_RESERVE_USD` against both caps. Throws when the hold does not fit. The meter is not modified on throw. */
export function reserveJevCall(meter: JevMeter, nowMs: number, reserveUsd = JEV_CALL_RESERVE_USD): JevMeter {
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const base: JevMeter = meter.today === day ? meter : { ...meter, today: day, todayUsd: 0 };
  const next = noteJevSpend(base, reserveUsd, month);
  return { ...next, today: day, todayUsd: roundUsd((base.todayUsd ?? 0) + reserveUsd), calls: base.calls ?? 0 };
}

/**
 * Move a hold to the actual cost. Refunds the difference when the call cost less.
 * Throws when the actual cost is above the hold and the extra does not fit. The hold stays on the caller.
 */
export function adjustJevReserve(meter: JevMeter, reservedUsd: number, actualUsd: number): JevMeter {
  if (!(actualUsd >= 0) || !Number.isFinite(actualUsd)) throw new Error("jev spend must be positive");
  const delta = actualUsd - reservedUsd;
  if (delta > 1e-12) {
    const next = noteJevSpend(meter, delta, meter.month);
    return { ...next, todayUsd: roundUsd((meter.todayUsd ?? 0) + delta) };
  }
  if (delta < -1e-12) {
    const refund = -delta;
    return {
      ...meter,
      cumulativeUsd: roundUsd(meter.cumulativeUsd - refund),
      monthUsd: roundUsd(meter.monthUsd - refund),
      todayUsd: roundUsd(Math.max(0, (meter.todayUsd ?? 0) - refund)),
    };
  }
  return meter;
}

/** Refuse a charge that would pass either cap. The shadow drain holds a reserve before a call and settles after. */
export function noteJevSpend(meter: JevMeter, costUsd: number, month: string): JevMeter {
  if (!(costUsd > 0)) throw new Error("jev spend must be positive");
  const monthUsd = meter.month === month ? meter.monthUsd : 0;
  if (meter.cumulativeUsd + costUsd > meter.capUsd) throw new Error("jev spend cap");
  if (monthUsd + costUsd > meter.monthCapUsd) throw new Error("jev monthly cap");
  return {
    ...meter,
    cumulativeUsd: meter.cumulativeUsd + costUsd,
    monthUsd: monthUsd + costUsd,
    month,
    capUsd: 5,
    monthCapUsd: JEV_MONTH_CAP_USD,
    calls: meter.calls ?? 0,
    todayUsd: meter.todayUsd ?? 0,
    today: meter.today ?? "",
  };
}
