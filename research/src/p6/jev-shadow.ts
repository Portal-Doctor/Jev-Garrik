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
}

/** The cumulative P6 cap stays $5. The month cap is the soak's $100. No call is made here. */
export function freshJevMeter(cumulativeUsd = 0): JevMeter {
  if (cumulativeUsd < 0 || cumulativeUsd > JEV_CUMULATIVE_CAP_USD) throw new Error("jev spend cap");
  return { cumulativeUsd, monthUsd: 0, month: "", capUsd: 5, monthCapUsd: JEV_MONTH_CAP_USD };
}

/** Refuse a charge that would pass either cap. The host does not call this until a live Jev call exists. */
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
  };
}
