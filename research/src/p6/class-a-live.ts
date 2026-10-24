/**
 * Production step for the class A paper book.
 * Called from the live 15m bar path. Public candles, quotes, and prints only. No orders.
 * errata 002 item 5: a signal whose close is exactly the book start is evaluated.
 * A maker entry placed at that close stays pending until a later bar or print inside [close, close+4h), or the window ends.
 */

import { readFileSync } from "node:fs";
import { ema, wilderAtr } from "../p2/indicators";
import { isDayCloseBar } from "../p5/book";
import {
  evaluateSignal,
  onDaily,
  onIntrabar,
  resolveClassAResting,
  signalCloseMs,
  sizedOrder,
  walkCostBps,
  type ClassABook,
  type ClassADay,
} from "./class-a-paper";
import { hourAtrAt } from "./generate";
import { dataFile } from "./live-data";

interface Ohlc {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface ClassALiveHost {
  classAPaper?: ClassABook;
  clock: () => number;
  dailyBars: ReadonlyMap<string, readonly Ohlc[]>;
  hourWarm: ReadonlyMap<string, readonly Ohlc[]>;
  ticks: ReadonlyMap<string, number>;
  trades: readonly { productId: string; tsSec: number; price: number }[];
  books: ReadonlyMap<string, { asks: ReadonlyMap<string, number> }>;
  book: { quotes: Record<string, { bid: number; ask: number; tsMs: number } | undefined> };
}

function asDays(bars: readonly Ohlc[]): { days: ClassADay[]; opens: number[] } {
  const ordered = bars.filter((bar) => bar.close > 0 && bar.ts > 0).slice().sort((a, b) => a.ts - b.ts);
  return {
    opens: ordered.map((bar) => bar.open),
    days: ordered.map((bar) => ({
      date: new Date(bar.ts * 1000).toISOString().slice(0, 10),
      high: bar.high,
      low: bar.low,
      close: bar.close,
      baseVolume: bar.volume,
    })),
  };
}

function smaAt(values: readonly number[], length: number, index: number): number | null {
  if (index + 1 < length) return null;
  let sum = 0;
  for (let i = index - length + 1; i <= index; i += 1) sum += values[i] ?? 0;
  return sum / length;
}

function quotedSpreadBps(bid: number, ask: number): number | null {
  if (!(bid > 0) || !(ask >= bid)) return null;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return ((ask - bid) / mid) * 10_000;
}

/**
 * One accepted 15m bar. Resting maker orders resolve on every bar. Intrabar stops run on every bar.
 * The day-close bar (23:45Z) updates the daily rule and, when that close is the signal time, evaluates the pair.
 */
export function stepClassAFromHost(host: ClassALiveHost, bar: { productId: string; startSec: number; open: number; high: number; low: number; close: number }): void {
  const book = host.classAPaper;
  if (!book || book.exclusionOk === false || book.startMs == null) return;
  const closeMs = (bar.startSec + 900) * 1000;
  const nowMs = Math.max(closeMs, host.clock());
  resolveClassAResting(book, nowMs, {
    pair: bar.productId,
    prints: printsOf(host, bar.productId),
    bar: { startMs: bar.startSec * 1000, endMs: closeMs, low: bar.low },
  });
  const hourAtr = hourAtrAt(host.hourWarm.get(bar.productId) ?? [], closeMs / 1000);
  onIntrabar(book, { pair: bar.productId, tsMs: closeMs, open: bar.open, low: bar.low, hourAtr });
  if (!isDayCloseBar(bar.startSec)) return;
  const series = asDays(host.dailyBars.get(bar.productId) ?? []);
  const days = series.days;
  const index = days.length - 1;
  const day = index >= 0 ? days[index] : undefined;
  if (!day) return;
  const atrSeries = wilderAtr(
    days.map((row) => row.high),
    days.map((row) => row.low),
    days.map((row) => row.close),
    14,
  );
  const atr = atrSeries[index] ?? 0;
  onDaily(book, { pair: bar.productId, date: day.date, open: series.opens[index] ?? day.close, low: day.low, close: day.close, atr: atr > 0 ? atr : 0, hourAtr });
  const signalMs = signalCloseMs(day.date);
  if (signalMs !== closeMs || signalMs < book.startMs) return;
  const btcDays = asDays(host.dailyBars.get("BTC-USD") ?? []).days;
  const btcIndex = btcDays.length - 1;
  const btcCloses = btcDays.map((row) => row.close);
  const btcClose = btcIndex >= 0 ? (btcCloses[btcIndex] ?? null) : null;
  const btcPrev = btcIndex > 0 ? (btcCloses[btcIndex - 1] ?? null) : null;
  const quote = host.book.quotes[bar.productId];
  const spread = quote ? quotedSpreadBps(quote.bid, quote.ask) : null;
  const log = book.spreadLog ?? {};
  book.spreadLog = log;
  const samples = (log[bar.productId] ?? []).slice(-30);
  const sized = atr > 0 ? sizedOrder(day.close, atr) : null;
  let depth: number | null = null;
  if (quote && sized && quote.bid > 0 && quote.ask >= quote.bid) {
    const mid = (quote.bid + quote.ask) / 2;
    const levels = [...(host.books.get(bar.productId)?.asks.entries() ?? [])]
      .map(([price, size]) => ({ price: Number(price), size }))
      .filter((level) => level.price > 0 && level.size > 0)
      .sort((a, b) => a.price - b.price);
    depth = levels.length > 0 ? walkCostBps(mid, levels, sized.units) : null;
  }
  evaluateSignal(book, {
    pair: bar.productId,
    listedDays: days.length,
    days,
    index,
    btcClose,
    btcEma50: btcIndex >= 0 ? (ema(btcCloses, 50)[btcIndex] ?? null) : null,
    btcDailyMove: btcClose != null && btcPrev != null && btcPrev > 0 ? (btcClose - btcPrev) / btcPrev : null,
    btcSma200: btcIndex >= 0 ? smaAt(btcCloses, 200, btcIndex) : null,
    btcSma50: btcIndex >= 0 ? smaAt(btcCloses, 50, btcIndex) : null,
    btcSma50TenAgo: btcIndex >= 10 ? smaAt(btcCloses, 50, btcIndex - 10) : null,
    spreadBps: spread,
    depthCostBps: depth,
    quoteAgeMs: quote ? host.clock() - quote.tsMs : null,
    minOrderBase: classAMinOrderBase(bar.productId),
    tick: host.ticks.get(bar.productId) ?? null,
    medianSpreadBps: null,
    spreadSamples: samples,
    nextHourOpen: null,
    hourAtr14: hourAtr > 0 ? hourAtr : null,
    prints: printsOf(host, bar.productId),
    asOfMs: nowMs,
  });
  if (spread != null && Number.isFinite(spread) && spread >= 0) log[bar.productId] = [...(log[bar.productId] ?? []), spread].slice(-30);
}

function printsOf(host: ClassALiveHost, productId: string): { tsMs: number; price: number }[] {
  return host.trades.filter((trade) => trade.productId === productId).map((trade) => ({ tsMs: trade.tsSec * 1000, price: trade.price }));
}

let minSizes: Map<string, number> | null = null;

function sizeOf(row: { base_min_size?: unknown; base_increment?: unknown }): number | null {
  const minSize = Number(row.base_min_size);
  if (minSize > 0) return minSize;
  const increment = Number(row.base_increment);
  return increment > 0 ? increment : null;
}

/**
 * Coinbase minimum base size. base_min_size when the payload has it, otherwise base_increment.
 * The snapshot the repo already stores is the public products list. If that file is missing, the public unauthenticated products endpoint is read once. No key and no environment variable.
 */
export function classAMinOrderBase(productId: string): number | null {
  return loadClassAMinSizes().get(productId) ?? null;
}

function loadClassAMinSizes(): Map<string, number> {
  if (minSizes) return minSizes;
  const map = new Map<string, number>();
  const path = dataFile("products", "exchange-products.raw.json");
  if (path) {
    try {
      const body = JSON.parse(readFileSync(path, "utf8")) as { id?: string; base_min_size?: unknown; base_increment?: unknown }[];
      if (Array.isArray(body)) {
        for (const row of body) {
          const min = sizeOf(row);
          if (row.id && min != null) map.set(row.id, min);
        }
      }
    } catch {
      map.clear();
    }
  }
  if (map.size === 0) {
    try {
      const proc = Bun.spawnSync(["curl", "-fsS", "--max-time", "8", "https://api.exchange.coinbase.com/products"], { stdout: "pipe", stderr: "ignore" });
      if (proc.exitCode === 0) {
        const body = JSON.parse(new TextDecoder().decode(proc.stdout)) as { id?: string; base_min_size?: unknown; base_increment?: unknown }[];
        if (Array.isArray(body)) {
          for (const row of body) {
            const min = sizeOf(row);
            if (row.id && min != null) map.set(row.id, min);
          }
        }
      }
    } catch {
      /* The minimum stays unknown. The entry fails closed. */
    }
  }
  minSizes = map;
  return map;
}
