/**
 * One daily-bar path for classes A, C, and D.
 * In-window rows are whatever the caller stored. The scan stores 15m-derived bars there.
 * D1 is never substituted in-window.
 * Pre-window D1 is keyed by the name's group flags:
 * price-group pass: OHLC for every daily lookback, and volume when the volume group also passes.
 * Boundary-saved names: pre-window closes only, for EMA50/200 and the listing proxy.
 * Everyone else: no pre-window D1.
 */

import type { Ohlcv } from "../../vendor/87b35d0/indicators.ts";
import type { DailyBar } from "./classes";
import { WINDOW_START } from "./f5";

export const BOUNDARY_SAVED_NAMES = ["AVNT-USD", "FIL-USD", "IP-USD", "LIGHTER-USD", "TRUMP-USD", "VVV-USD", "WIF-USD"] as const;
export const VOLUME_FALLBACK_NAMES = ["LIGHTER-USD", "WIF-USD"] as const;
/** A boundary-saved name is its own cluster until this many in-window days exist. */
export const CLUSTER_CORR_DAYS = 60;

export interface GroupFlags {
  priceGroupPasses: boolean;
  volumeGroupPasses: boolean;
  /** Failed the price group and was kept by the 10 bp boundary test. */
  boundarySaved: boolean;
}

export interface SourceDay {
  date: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  empty: boolean;
}

export type DailyRead = "ema" | "ohlc" | "closeLookback" | "volume" | "swingHigh";

export interface ReadableDay {
  date: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export function groupFlagsOf(row: {
  priceGroupPasses: boolean;
  volumeGroupPasses: boolean;
  boundarySavesCloses: boolean;
} | null | undefined): GroupFlags {
  if (!row) return { priceGroupPasses: false, volumeGroupPasses: false, boundarySaved: false };
  return {
    priceGroupPasses: row.priceGroupPasses,
    volumeGroupPasses: row.volumeGroupPasses,
    boundarySaved: !row.priceGroupPasses && row.boundarySavesCloses,
  };
}

/** Pre-window D1 fields this read may see. In-window rows are always kept. */
export function prewindowAllowed(flags: GroupFlags, read: DailyRead): boolean {
  if (read === "ema") return flags.priceGroupPasses || flags.boundarySaved;
  if (!flags.priceGroupPasses) return false;
  if (read === "volume") return flags.volumeGroupPasses;
  return true;
}

export function dailyBarsFor(flags: GroupFlags, days: readonly SourceDay[], read: DailyRead): ReadableDay[] {
  const allowPre = prewindowAllowed(flags, read);
  const out: ReadableDay[] = [];
  for (const row of days) {
    if (row.empty) continue;
    const pre = row.date < WINDOW_START;
    if (pre && !allowPre) continue;
    if (pre && read === "ema" && !flags.priceGroupPasses) {
      out.push({ date: row.date, ts: row.ts, open: row.close, high: Number.NaN, low: Number.NaN, close: row.close, volume: Number.NaN });
      continue;
    }
    out.push({ date: row.date, ts: row.ts, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
  }
  out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return out;
}

/**
 * D's swing-high history starts at the first D1 candle, or at the window for names
 * that do not pass the price group (the seven boundary-saved names).
 */
export function dHistoryStart(flags: GroupFlags, firstD1Date: string): string {
  if (!flags.priceGroupPasses) return WINDOW_START;
  return firstD1Date;
}

export function listingProxySource(flags: GroupFlags): "first-d1-candle" | "first-d1-close" | "first-in-window-15m" {
  if (flags.priceGroupPasses) return "first-d1-candle";
  if (flags.boundarySaved) return "first-d1-close";
  return "first-in-window-15m";
}

/**
 * Closes the 60-day correlation and beta may read.
 * A price-group pass keeps pre-window closes. A boundary-saved name does not:
 * rule 3 of the D1 ruling keeps that correlation in-window, including WIF-USD.
 */
export function correlationCloses(flags: GroupFlags, days: readonly SourceDay[]): { date: string; close: number }[] {
  return dailyBarsFor(flags, days, "closeLookback")
    .filter((row) => row.close > 0)
    .map((row) => ({ date: row.date, close: row.close }));
}

/** Boundary-saved names stay in their own cluster until 60 in-window days exist. */
export function clusterKey(flags: GroupFlags, inWindowDays: number, productId: string, assigned: string): string {
  if (flags.boundarySaved && inWindowDays < CLUSTER_CORR_DAYS) return productId;
  return assigned;
}

export interface ClassBarInputs {
  ema: DailyBar[];
  ohlc: DailyBar[];
  closeLookback: DailyBar[];
  volume: DailyBar[];
  classC: DailyBar[];
  swing: Ohlcv[];
  bias: Ohlcv[];
  dHistoryStart: string;
  listingProxySource: "first-d1-candle" | "first-d1-close" | "first-in-window-15m";
  listingProxyDate: string | null;
}

function asDaily(row: ReadableDay): DailyBar {
  return { date: row.date, high: row.high, low: row.low, close: row.close, volume: row.volume };
}

function asOhlcv(row: ReadableDay): Ohlcv {
  return { ts: row.ts * 1000, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume };
}

/**
 * Bars A, C, and D may read. Replay and the forward load both call this.
 * The forward load passes the same stored days and the same first-D1 date,
 * so the swing series starts at `dHistoryStart` and the bias series keeps
 * the pre-window closes the flags allow.
 */
export function classBarInputs(flags: GroupFlags, days: readonly SourceDay[], firstD1Date: string): ClassBarInputs {
  const start = dHistoryStart(flags, firstD1Date);
  const ema = dailyBarsFor(flags, days, "ema").map(asDaily);
  const ohlc = dailyBarsFor(flags, days, "ohlc").map(asDaily);
  const closeLookback = dailyBarsFor(flags, days, "closeLookback").map(asDaily);
  const volume = dailyBarsFor(flags, days, "volume").map(asDaily);
  const closeByDate = new Map(closeLookback.map((row) => [row.date, row.close]));
  const volByDate = new Map(volume.map((row) => [row.date, row.volume]));
  const classC = ohlc
    .filter((row) => closeByDate.has(row.date))
    .map((row) => ({
      date: row.date,
      high: row.high,
      low: row.low,
      close: closeByDate.get(row.date) ?? row.close,
      volume: volByDate.get(row.date) ?? Number.NaN,
    }));
  const swing = dailyBarsFor(flags, days, "swingHigh")
    .filter((row) => row.date >= start)
    .map(asOhlcv);
  const bias = dailyBarsFor(flags, days, "ema")
    .filter((row) => (flags.priceGroupPasses ? row.date >= start : true))
    .map(asOhlcv);
  const listed = days.filter((row) => !row.empty).map((row) => row.date).sort();
  const listingDate = flags.priceGroupPasses || flags.boundarySaved ? (listed[0] ?? null) : (listed.find((date) => date >= WINDOW_START) ?? null);
  return {
    ema,
    ohlc,
    closeLookback,
    volume,
    classC,
    swing,
    bias,
    dHistoryStart: start,
    listingProxySource: listingProxySource(flags),
    listingProxyDate: listingDate,
  };
}
