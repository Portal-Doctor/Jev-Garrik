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
