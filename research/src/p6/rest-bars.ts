/**
 * Strategy bars are public REST 15-minute candles, fetched at the completed
 * bar plus a settle delay. The delay in seconds is not specified. Callers pass
 * it. Nothing here fetches.
 */

import { candlesUrl } from "../data/public";
import { assertMarketDataUrl } from "./public-ws";

export const REST_GRANULARITY_15M = 900;
export const HOUR_SEC = 3_600;
export const FOUR_HOUR_SEC = 14_400;
export const DAY_SEC = 86_400;

export interface OhlcvBar {
  productId: string;
  startSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** The moment a completed 15m bar may be requested. `settleDelaySec` is required. */
export function strategyFetchAt(barEndMs: number, settleDelaySec: number): number {
  if (!(settleDelaySec >= 0)) throw new Error("settle delay must be non-negative");
  return barEndMs + settleDelaySec * 1000;
}

export function fifteenMinuteUrl(productId: string, startSec: number, endSecInclusive: number): string {
  const url = candlesUrl(productId, startSec, endSecInclusive, REST_GRANULARITY_15M);
  assertMarketDataUrl(url);
  return url;
}

/** Fold completed child bars into a higher bar. A partial span is not emitted. */
export function aggregateBars(bars: readonly OhlcvBar[], spanSec: number): OhlcvBar[] {
  if (!(spanSec > 0)) throw new Error("span must be positive");
  const groups = new Map<string, OhlcvBar[]>();
  for (const bar of bars) {
    const start = Math.floor(bar.startSec / spanSec) * spanSec;
    const key = `${bar.productId}:${start}`;
    const list = groups.get(key) ?? [];
    list.push(bar);
    groups.set(key, list);
  }
  const out: OhlcvBar[] = [];
  for (const [key, list] of groups) {
    const start = Number(key.split(":")[1]);
    const ordered = list.slice().sort((a, b) => a.startSec - b.startSec);
    const spanBars = spanSec / REST_GRANULARITY_15M;
    if (ordered.length < spanBars) continue;
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    if (first.startSec !== start || last.startSec !== start + spanSec - REST_GRANULARITY_15M) continue;
    out.push({
      productId: first.productId,
      startSec: start,
      open: first.open,
      high: Math.max(...ordered.map((bar) => bar.high)),
      low: Math.min(...ordered.map((bar) => bar.low)),
      close: last.close,
      volume: ordered.reduce((sum, bar) => sum + bar.volume, 0),
    });
  }
  return out.sort((a, b) => a.startSec - b.startSec || a.productId.localeCompare(b.productId));
}

export interface TradePrint {
  productId: string;
  tsSec: number;
  price: number;
  size: number;
}

/** 15m bars built from trades. A cross-check and a fallback, not the signal source. */
export function tradesBuilt15m(trades: readonly TradePrint[], bucketSec = REST_GRANULARITY_15M): OhlcvBar[] {
  const groups = new Map<string, TradePrint[]>();
  for (const trade of trades) {
    const start = Math.floor(trade.tsSec / bucketSec) * bucketSec;
    const key = `${trade.productId}:${start}`;
    const list = groups.get(key) ?? [];
    list.push(trade);
    groups.set(key, list);
  }
  const out: OhlcvBar[] = [];
  for (const [key, list] of groups) {
    const ordered = list.slice().sort((a, b) => a.tsSec - b.tsSec);
    const first = ordered[0]!;
    const last = ordered[ordered.length - 1]!;
    out.push({
      productId: first.productId,
      startSec: Number(key.split(":")[1]),
      open: first.price,
      high: Math.max(...ordered.map((trade) => trade.price)),
      low: Math.min(...ordered.map((trade) => trade.price)),
      close: last.price,
      volume: ordered.reduce((sum, trade) => sum + trade.size, 0),
    });
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Close-to-close divergence in bps. Null when either close is not positive. */
export function closeDivergenceBps(restClose: number, tradeClose: number): number | null {
  if (!(restClose > 0) || !(tradeClose > 0)) return null;
  return (Math.abs(restClose - tradeClose) / restClose) * 10_000;
}
