/**
 * Production step for the class A paper book.
 * Called from the live 15m bar path. Public candles, quotes, and prints only. No orders.
 * errata 002 item 5: a signal whose close is exactly the book start is evaluated.
 * A maker entry placed at that close is a resting order. A print already in [close, close+4h) does not open it.
 * The bucket replay resolves every resting order once, then applies the cap, then runs stops.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { classAProductsSnapshot } from "./class-a-products";
import { ema, wilderAtr } from "../p2/indicators";
import { isDayCloseBar } from "../p5/book";
import {
  applyStoredClassASignal,
  armClassAHourOpen,
  evaluateSignal,
  onDaily,
  onIntrabar,
  resolveClassAResting,
  resolveListedDays,
  signalCloseMs,
  sizedOrder,
  storeClassASignalDecision,
  walkCostBps,
  type ClassABook,
  type ClassABucketBar,
  type ClassABucketState,
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
  /**
   * First candle or listing instant, ms, per product. A null value is unknown.
   * When this map is set, the coverage file is not consulted.
   */
  listingFirstMs?: Readonly<Record<string, number | null>>;
  /** Mirrors book.bucket. A restart rebuilds it from the saved book. */
  classABucket?: ClassABucketState;
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

function snapshotClassABook(book: ClassABook): ClassABook {
  const { bucket: _bucket, ...rest } = book;
  return JSON.parse(JSON.stringify(rest)) as ClassABook;
}

function applySnapshot(book: ClassABook, image: ClassABook): void {
  const next = JSON.parse(JSON.stringify(image)) as ClassABook;
  for (const key of Object.keys(book)) delete book[key as keyof ClassABook];
  Object.assign(book, next);
}

/**
 * One accepted 15m bar. The bucket is replayed from its saved pre-image.
 * Stored decisions are the signal and the resting order. They do not open a position.
 * One resolve then applies the 3-slot and $60 caps to every resting order, including a print that was already in the window.
 * Stops run after that resolve, so a rejected fill is not scored.
 * The signal check runs once, when that pair's own day-close bar arrives.
 * Replay copies the stored intent. It does not read the quote, the book, or the clock for the check again.
 */
export function stepClassAFromHost(host: ClassALiveHost, bar: ClassABucketBar): void {
  const book = host.classAPaper;
  if (!book || book.exclusionOk === false || book.startMs == null) return;
  if (book.bucket && host.classABucket !== book.bucket) host.classABucket = book.bucket;
  if (!host.classABucket || host.classABucket.startSec !== bar.startSec) {
    const image = snapshotClassABook(book);
    const bucket: ClassABucketState = { startSec: bar.startSec, bars: [], image, decisions: [] };
    book.bucket = bucket;
    host.classABucket = bucket;
  }
  const bucket = host.classABucket;
  if (!bucket.bars.some((item) => item.productId === bar.productId && item.startSec === bar.startSec)) {
    bucket.bars.push({ productId: bar.productId, startSec: bar.startSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
  }
  const decided = bucket.decisions?.some((item) => item.productId === bar.productId) === true;
  if (isDayCloseBar(bar.startSec) && !decided) {
    replayClassABucket(host, book, bar.productId);
    const before = snapshotClassABook(book);
    applyClassASignal(host, book, bar);
    storeClassASignalDecision(bucket, bar.productId, before, snapshotClassABook(book));
  }
  replayClassABucket(host, book);
}

/** `pauseAtProduct` stops after that pair's exits, before later pairs, so the one-time check sees those exits. The final replay applies every stored intent, resolves the cap once, then runs exits. */
function replayClassABucket(host: ClassALiveHost, book: ClassABook, pauseAtProduct?: string): void {
  const bucket = host.classABucket ?? book.bucket;
  if (!bucket) return;
  applySnapshot(book, bucket.image);
  book.bucket = bucket;
  host.classABucket = bucket;
  if (bucket.bars.length === 0) return;
  const ordered = bucket.bars.slice().sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
  if (pauseAtProduct != null) {
    for (const item of ordered) {
      applyClassAExits(host, book, item);
      if (pauseAtProduct != null && item.productId === pauseAtProduct) return;
      applyStoredClassASignal(book, item.productId);
    }
    return;
  }
  for (const item of ordered) applyStoredClassASignal(book, item.productId);
  const closeOf = (item: ClassABucketBar) => (item.startSec + 900) * 1000;
  const nowMs = Math.max(closeOf(bucket.bars[bucket.bars.length - 1]!), host.clock());
  resolveClassAResting(book, nowMs, {
    events: host.classABucket.bars.map((item) => ({
      pair: item.productId,
      prints: printsOf(host, item.productId),
      bar: { startMs: item.startSec * 1000, endMs: (item.startSec + 900) * 1000, low: item.low },
    })),
  });
  for (const item of ordered) applyClassAExits(host, book, item);
}

function applyClassAExits(host: ClassALiveHost, book: ClassABook, bar: ClassABucketBar): void {
  const closeMs = (bar.startSec + 900) * 1000;
  const hourAtr = hourAtrAt(host.hourWarm.get(bar.productId) ?? [], closeMs / 1000);
  armClassAHourOpen(book, bar.productId, bar.startSec * 1000, bar.open);
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
}

function applyClassASignal(host: ClassALiveHost, book: ClassABook, bar: ClassABucketBar): void {
  const closeMs = (bar.startSec + 900) * 1000;
  const nowMs = Math.max(closeMs, host.clock());
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
  const hourAtr = hourAtrAt(host.hourWarm.get(bar.productId) ?? [], closeMs / 1000);
  const signalMs = signalCloseMs(day.date);
  if (book.startMs == null) return;
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
  const age = resolveListedDays(listingFirstOf(host, bar.productId), signalMs);
  evaluateSignal(book, {
    pair: bar.productId,
    listedDays: age.listedDays,
    listedDaysEstimated: age.estimated,
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
    deferEntry: true,
  });
  if (spread != null && Number.isFinite(spread) && spread >= 0) log[bar.productId] = [...(log[bar.productId] ?? []), spread].slice(-30);
}

let listingCache: Map<string, number> | null = null;

/** First nonempty candle from the coverage report. Listing dates are not in the products payload. */
function loadListingFirst(): Map<string, number> {
  if (listingCache) return listingCache;
  const map = new Map<string, number>();
  const path = dataFile("reports", "coverage.json");
  if (path) {
    try {
      const body = JSON.parse(readFileSync(path, "utf8")) as { products?: { productId?: string; firstNonemptyBar?: unknown }[] };
      for (const row of body.products ?? []) {
        if (!row.productId || typeof row.firstNonemptyBar !== "string") continue;
        const ms = Date.parse(row.firstNonemptyBar);
        if (Number.isFinite(ms)) map.set(row.productId, ms);
      }
    } catch {
      map.clear();
    }
  }
  listingCache = map;
  return map;
}

function listingFirstOf(host: ClassALiveHost, productId: string): number | null {
  if (host.listingFirstMs) {
    const value = host.listingFirstMs[productId];
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }
  return loadListingFirst().get(productId) ?? null;
}

function printsOf(host: ClassALiveHost, productId: string): { tsMs: number; price: number }[] {
  return host.trades.filter((trade) => trade.productId === productId).map((trade) => ({ tsMs: trade.tsSec * 1000, price: trade.price }));
}

let minSizes: Map<string, number> | null = null;

/** base_min_size when it is present and positive. Otherwise base_increment. Unknown stays null, never zero. */
export function classAMinSizeOf(row: { base_min_size?: unknown; base_increment?: unknown }): number | null {
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
  classAProductsSnapshot();
  const map = new Map<string, number>();
  const path = dataFile("products", "exchange-products.raw.json");
  if (path) {
    try {
      const body = JSON.parse(readFileSync(path, "utf8")) as { id?: string; base_min_size?: unknown; base_increment?: unknown }[];
      if (Array.isArray(body)) {
        for (const row of body) {
          const min = classAMinSizeOf(row);
          if (row.id && min != null) map.set(row.id, min);
        }
      }
    } catch {
      map.clear();
    }
  }
  if (map.size === 0) {
    try {
      const proc = spawnSync("curl", ["-fsS", "--max-time", "8", "https://api.exchange.coinbase.com/products"], { encoding: "utf8" });
      if (proc.status === 0 && proc.stdout) {
        const body = JSON.parse(proc.stdout) as { id?: string; base_min_size?: unknown; base_increment?: unknown }[];
        if (Array.isArray(body)) {
          for (const row of body) {
            const min = classAMinSizeOf(row);
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
