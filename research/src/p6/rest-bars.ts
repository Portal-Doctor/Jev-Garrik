/**
 * Strategy bars are public REST 15-minute candles. The first fetch is the bar
 * close plus 15 seconds. Retries are every 10 seconds for 120 seconds. After
 * that the bar is built from public trades and the miss is an incident.
 * Nothing here fetches.
 */

import { candlesUrl } from "../data/public";
import { assertMarketDataUrl } from "./public-ws";

export const REST_GRANULARITY_15M = 900;
export const REST_SETTLE_DELAY_MS = 15_000;
export const REST_RETRY_MS = 10_000;
export const REST_RETRY_BUDGET_MS = 120_000;
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

/** First attempt, retry spacing, and the deadline after which the trades bar is used. */
export function restSettleSchedule(barEndMs: number): { firstMs: number; intervalMs: number; deadlineMs: number } {
  const firstMs = barEndMs + REST_SETTLE_DELAY_MS;
  return { firstMs, intervalMs: REST_RETRY_MS, deadlineMs: firstMs + REST_RETRY_BUDGET_MS };
}

/**
 * A successful REST read wins. Once the budget is spent with no read, the bar
 * is the trades-built bar and the miss is an incident.
 */
export function restOrTrades(opts: { restOk: boolean; deadlinePassed: boolean }): { source: "rest" | "trades"; incident: boolean } {
  if (opts.restOk) return { source: "rest", incident: false };
  if (opts.deadlinePassed) return { source: "trades", incident: true };
  return { source: "rest", incident: false };
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

/** Public candles for daily or 1h warmup. Vercel has no local store. */
export function historyCandleUrl(productId: string, startSec: number, endSecInclusive: number, granularitySec: number): string {
  const url = candlesUrl(productId, startSec, endSecInclusive, granularitySec);
  assertMarketDataUrl(url);
  return url;
}

/** Public level-1 product book. One snapshot when the L2 book is older than the staleness limit. */
export function productBookUrl(productId: string): string {
  const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/book?level=1`;
  assertMarketDataUrl(url);
  return url;
}

/** Public trades. Used only to rebuild a tape hole of at most two minutes. */
export function productTradesUrl(productId: string, limit = 1000): string {
  const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/trades?limit=${limit}`;
  assertMarketDataUrl(url);
  return url;
}

/** Public level-2 book. A takeover rebuilds the full price ladder from this, then resyncs. */
export function productBookLevel2Url(productId: string): string {
  const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(productId)}/book?level=2`;
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
  side?: string;
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

/**
 * Exchange candle rows are [time, low, high, open, close, volume].
 * The row whose time is the 15m start is the strategy bar. Nothing is fetched.
 */
/** Every 15m row in an exchange candle response. Rows that are not 15m starts are dropped. */
export function barsFromExchangeCandles(productId: string, rows: readonly number[][]): OhlcvBar[] {
  const out: OhlcvBar[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6 || typeof row[0] !== "number") continue;
    const bar = barFromExchangeCandles(productId, row[0], [row]);
    if (bar) out.push(bar);
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/** Candle spans of at most `spanBars` from the day after the daily store through the last closed bar. */
export function planHistorySpans(fromSec: number, throughSec: number, spanBars = 300): { startSec: number; endSec: number }[] {
  if (!(fromSec >= 0) || throughSec < fromSec) return [];
  const out: { startSec: number; endSec: number }[] = [];
  const width = Math.max(1, spanBars) * REST_GRANULARITY_15M;
  for (let start = fromSec; start <= throughSec; start += width) {
    const end = Math.min(throughSec, start + width - REST_GRANULARITY_15M);
    out.push({ startSec: start, endSec: end });
  }
  return out;
}

export function barFromExchangeCandles(productId: string, startSec: number, rows: readonly number[][]): OhlcvBar | null {
  const row = rows.find((item) => item[0] === startSec);
  if (!row || row.length < 6) return null;
  const open = row[3]!;
  const high = row[2]!;
  const low = row[1]!;
  const close = row[4]!;
  const volume = row[5]!;
  if (!(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) return null;
  return { productId, startSec, open, high, low, close, volume };
}

/** Close-to-close divergence in bps. Null when either close is not positive. */
export function closeDivergenceBps(restClose: number, tradeClose: number): number | null {
  if (!(restClose > 0) || !(tradeClose > 0)) return null;
  return (Math.abs(restClose - tradeClose) / restClose) * 10_000;
}
