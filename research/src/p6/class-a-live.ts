/**
 * Production step for the class A paper book.
 * Called from the live 15m bar path. Public candles, quotes, and prints only. No orders.
 * errata 002 item 5: a signal whose close is exactly the book start is evaluated.
 * A maker entry placed at that close stays pending until a later bar or print inside [close, close+4h), or the window ends.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ema, wilderAtr } from "../p2/indicators";
import { isDayCloseBar } from "../p5/book";
import {
  armClassAHourOpen,
  evaluateSignal,
  onDaily,
  onIntrabar,
  resolveClassAResting,
  resolveListedDays,
  signalCloseMs,
  sizedOrder,
  walkCostBps,
  type ClassABook,
  type ClassADay,
  type ClassAResting,
  type ClassARow,
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
  /** Bars of the 15m bucket currently being settled together. Not part of the saved book. */
  classABucket?: ClassABucket;
}

interface ClassABucketBar {
  productId: string;
  startSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

interface ClassARowSnap {
  fill: ClassARow["fill"];
  skipReason: ClassARow["skipReason"];
  check: string | null;
  notionalUsd: number | null;
  feesUsd: number | null;
  measured: number | null;
  stop: number | null;
}

interface ClassABucket {
  startSec: number;
  bars: ClassABucketBar[];
  resting: ClassAResting[];
  rows: Map<string, ClassARowSnap>;
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

function cloneResting(orders: readonly ClassAResting[]): ClassAResting[] {
  return orders.map((order) => ({ ...order, priorCloses: order.priorCloses.slice() }));
}

function snapshotBucket(book: ClassABook, startSec: number): ClassABucket {
  const rows = new Map<string, ClassARowSnap>();
  for (const order of book.resting ?? []) {
    const row = book.rows.find((item) => item.id === order.rowId);
    if (!row) continue;
    rows.set(row.id, {
      fill: row.fill,
      skipReason: row.skipReason,
      check: row.check,
      notionalUsd: row.notionalUsd,
      feesUsd: row.feesUsd,
      measured: row.measured,
      stop: row.stop,
    });
  }
  return { startSec, bars: [], resting: cloneResting(book.resting ?? []), rows };
}

/** Put this bucket's cap and fill decisions back, so a later pair in the same 15m bar can be ordered with the rest. */
function revertBucket(book: ClassABook, snap: ClassABucket): void {
  const ids = new Set(snap.rows.keys());
  book.open = book.open.filter((sim) => !ids.has(sim.rowId));
  for (const row of book.rows) {
    const saved = snap.rows.get(row.id);
    if (!saved) continue;
    row.fill = saved.fill;
    row.skipReason = saved.skipReason;
    row.check = saved.check;
    row.notionalUsd = saved.notionalUsd;
    row.feesUsd = saved.feesUsd;
    row.measured = saved.measured;
    row.stop = saved.stop;
  }
  const added = (book.resting ?? []).filter((order) => !ids.has(order.rowId));
  book.resting = [...cloneResting(snap.resting), ...added];
}

/**
 * One 15m bucket, all pairs together. Placement time, then pair A→Z, then row id.
 * Push order does not choose which orders fill.
 */
function settleClassABucket(host: ClassALiveHost, bar: ClassABucketBar): void {
  const book = host.classAPaper;
  if (!book) return;
  if (!host.classABucket || host.classABucket.startSec !== bar.startSec) host.classABucket = snapshotBucket(book, bar.startSec);
  else revertBucket(book, host.classABucket);
  host.classABucket.bars.push(bar);
  const closeMs = (bar.startSec + 900) * 1000;
  const nowMs = Math.max(closeMs, host.clock());
  resolveClassAResting(book, nowMs, {
    events: host.classABucket.bars.map((item) => ({
      pair: item.productId,
      prints: printsOf(host, item.productId),
      bar: { startMs: item.startSec * 1000, endMs: (item.startSec + 900) * 1000, low: item.low },
    })),
  });
}

/**
 * One accepted 15m bar. Resting maker orders for that 15m bucket resolve together, not one pair per push.
 * Intrabar stops run on every bar. The day-close bar (23:45Z) updates the daily rule and, when that close is the signal time, evaluates the pair.
 */
export function stepClassAFromHost(host: ClassALiveHost, bar: { productId: string; startSec: number; open: number; high: number; low: number; close: number }): void {
  const book = host.classAPaper;
  if (!book || book.exclusionOk === false || book.startMs == null) return;
  const closeMs = (bar.startSec + 900) * 1000;
  const nowMs = Math.max(closeMs, host.clock());
  settleClassABucket(host, bar);
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
