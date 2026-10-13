/**
 * Long-running public paper process. Brian runs it on an always-on host.
 * Level2, market_trades, and heartbeats only. At most 10 products per socket.
 * A missed first heartbeat reconnects, and a socket that stays silent reconnects
 * again. Strategy bars are public REST 15-minute candles. Daily, 1h, and 4h
 * series are derived from those bars plus the daily warmup. One bar step is
 * accept or fallback, then a save. The socket loop is a driver for that step,
 * not a requirement of the book. Status and the book are files under
 * data/runtime. Nothing here opens a port.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GroupFlags, SourceDay } from "../p3/bar-access";
import type { ClassBRow } from "../p3/design-rules";
import { dataFile } from "./live-data";
import { registeredFlags, type RegistrationFlagSource } from "../p5/flags";
import { isDayCloseBar } from "../p5/book";
import { assertSafeToStart } from "../safety";
import { readPairMonth } from "../data/store";
import { readDailyHistory } from "./daily";
import { applyForward, freshBook, forwardBookPanel, noteMemberDay, type Book } from "./engine";
import { parsePublicMessage, type PublicEvent } from "./feed";
import type { BarOHLC } from "../p3/signals";
import { completedDays, deriveForwardBook, forwardBarAnnotation, generateForward, hourAtrAt, vetoFromBtc, withExplicitGaps, type FifteenBar, type GeneratedEntry, type GenerateResult } from "./generate";
import { buildJevPackets, freshJevMeter, type JevMeter } from "./jev-shadow";
import type { Kv } from "./relay";
import { kickDurable } from "./hot-store";
import { foldHours } from "../data/derive";
import { budgetStopLabel, coinbaseGet, createRestRun, isCold, markCold, type RestRun } from "./rest-limit";
import { FOUR_KEEP, HOUR_KEEP, hourPagesForKeep, WARM } from "./warm-caps";
import { MISSED_SEND_STALE_QUOTE, STALE_QUOTE_MS } from "./legs";
import type { VolHour } from "./amendment-v6";
import { HEARTBEAT_GAP_MS, heartbeatMustReconnect, type MidBar } from "./mid-feed";
import { PUBLIC_CHANNELS, PUBLIC_WS_URL, subscribeFrames } from "./public-ws";
import {
  barFromExchangeCandles,
  barsFromExchangeCandles,
  fifteenMinuteUrl,
  historyCandleUrl,
  planHistorySpans,
  productBookUrl,
  productBookLevel2Url,
  productTradesUrl,
  restOrTrades,
  restSettleSchedule,
  tradesBuilt15m,
  type OhlcvBar,
  type TradePrint,
} from "./rest-bars";

const MAX_TRADES = 50_000;
const MAX_MIDS = 10_000;
const MAX_INCIDENTS = 1_000;
const MAX_REST_SLOTS = 64;
const MAX_SEEN_TRADES = 100_000;
export const REST_BACKFILL_BARS = 8;
export const REST_PACE_MS = 200;
/** Lower bound of the 60–120s save heartbeat. Crash gaps start at this save, not at the previous bar. */
export const SAVE_HEARTBEAT_MS = 60_000;
/**
 * 15m bars cover the B weekly window (7 days) plus one day. Class D's 4h EMA200
 * is a rolled 4h series, not a longer 15m book. No other registered 15m lookback
 * exceeds 7 days: 1h ATR14 is 14 hours and class E's follow-through is 6 hours.
 */
export const FOUR_HOUR_EMA_BARS = 200;
export const FOUR_HOUR_BARS_PER_DAY = 6;
export const FIFTEEN_RETAIN_DAYS = 8;
/** Rolled series. Daily history is not capped. See warm-caps.ts. */
export { FOUR_KEEP, HOUR_KEEP, WARM };
/** Overlap buffer. A longer watch cannot prove a sub-second handover, so it stops here. */
export const FEED_BUFFER_MAX = 32;
export const FEED_BUFFER_MAX_BYTES = 256 * 1024;

export interface DailyClose {
  date: string;
  close: number;
}

export interface FeedCursor {
  l2: number | null;
  tradeId: number | null;
}

export interface FeedFrame {
  sequence: number | null;
  events: PublicEvent[];
}

export function retainFifteens<T extends { startSec: number }>(bars: readonly T[], nowSec: number): T[] {
  const today = Math.floor(nowSec / 86400) * 86400;
  const keepFrom = today - (FIFTEEN_RETAIN_DAYS - 1) * 86400;
  return bars.filter((bar) => bar.startSec >= keepFrom);
}

/** Full daily history, the same series offline loads. Nothing is dropped for age. */
export function retainDailyCloses(rows: readonly DailyClose[]): DailyClose[] {
  return rows.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function rollDailyClose(rows: readonly DailyClose[], date: string, close: number): DailyClose[] {
  return retainDailyCloses([...rows.filter((row) => row.date !== date), { date, close }]);
}

export interface RestSlot {
  productId: string;
  barStartSec: number;
  attempts: number;
  done: boolean;
  fallback: boolean;
  /** Wall-clock budget added when the exchange answers 429. A 429 is not a failed read. */
  deferredMs: number;
  notBeforeMs: number;
  inflight: boolean;
}

interface HostContext {
  flags: GroupFlags;
  byProduct: Map<string, GroupFlags>;
  memberOn: (productId: string, date: string) => boolean;
}

export interface PaperHost {
  products: string[];
  shards: string[][];
  frames: string[];
  book: Book;
  lastHeartbeatMs: (number | null)[];
  /** When the socket opened. A shard with no heartbeat uses this as the last beat. */
  openedMs: (number | null)[];
  gapOpen: boolean[];
  needsReconnect: boolean[];
  replacing: boolean[];
  /** Messages from an older socket are ignored after a reconnect. */
  socketGen: number[];
  reconnects: number;
  gapEvents: number;
  l2Gaps: number;
  restAccepted: number;
  restFallback: number;
  lastL2Seq: Map<string, number>;
  trades: TradePrint[];
  /** REST product-book snapshots used when the live book is stale. V6 flags the leg. */
  restQuotes: Map<string, { bid: number; ask: number; tsMs: number }>;
  rest: Map<string, RestSlot>;
  restCursor: Map<string, number>;
  /** Highest applied 15m start per product. The resume point is this plus 900. */
  appliedThrough: Map<string, number>;
  /** Bars already pushed, bounded to the backfill window. A second apply is a no-op. */
  applied: Set<string>;
  nextRestMs: number;
  books: Map<string, { bids: Map<string, number>; asks: Map<string, number> }>;
  fifteen: FifteenBar[];
  /** First 15m open after the last daily-store day. Catch-up starts here. */
  historyFrom: Map<string, number>;
  /** Hour bars from the candle store, used only to warm 1h ATR. */
  hourWarm: Map<string, BarOHLC[]>;
  ticks: Map<string, number>;
  queued: Map<string, GeneratedEntry>;
  seenTrades: Set<string>;
  clock: () => number;
  generatedSec: number;
  generated: GenerateResult | null;
  warmup: Map<string, SourceDay[]>;
  weeks: Map<string, { date: string; rows: ClassBRow[] }[]>;
  emitted: Set<string>;
  context: HostContext | null;
  status: "live" | "reconnecting";
  /** Set when this instance is leaving at the function deadline. The socket close is not a gap. */
  deadlineRelease: boolean;
  lastBar: { productId: string; atr1h: number; dailyAtr: number; dailyClose: boolean; bScores: number } | null;
  /** Wall-clock time of the last L2 touch. Staleness uses this, not the signal time. */
  l2Ts: Map<string, number>;
  /** Logged feed gaps: handover, missed cron, and crash. */
  gaps: { startMs: number; endMs: number; cause: string }[];
  /** Vercel has no sqlite. REST warmup fills daily and 1h history into this host. */
  restWarm: boolean;
  /** Bar keys already written. A later save does not repeat them. */
  persistedBars: Set<string>;
  /** Legs that already took their one REST product-book snapshot. */
  quoteTried: Set<string>;
  /** Do not call the product book again until this time. A 429 sets it. */
  quoteNotBefore: Map<string, number>;
  /** Sockets opened by an overlapping warmup. The lease holder reuses them. */
  openSockets?: WebSocket[];
  /** Daily closes. Clusters and betas read this, not the 15m bars. */
  dailyCloses: Map<string, DailyClose[]>;
  /** Full daily bars rolled at 00:00 UTC. The close series is the date and close of these. */
  dailyBars: Map<string, BarOHLC[]>;
  /** 4h bars rolled from settled 15m bars, seeded from REST or research history. */
  fourBars: Map<string, BarOHLC[]>;
  /** True after p6:warmup was loaded or written. Saves do not re-read that key. */
  warmupStored: boolean;
  /** Last level2 sequence and trade id, checked by the next holder. */
  feedCursor: FeedCursor;
  /** Messages received before this instance owns the lease. */
  feedBuffer: FeedFrame[];
  /** Set when the overlap buffer hits its cap. The handover cannot be proved contiguous. */
  feedBufferCapped: boolean;
  /** While true, socket messages are buffered instead of applied. */
  bufferFeeds: boolean;
  /** Cumulative and monthly Jev spend. Live calls are not made. */
  jevMeter: JevMeter;
  /** Lease token this process acquired. A save without it does not claim the lease. */
  leaseToken: string | null;
  /** Set when the lease renew fails. The holder stops and does not write again. */
  stopped: boolean;
  /** ws after a live snapshot. rest_snapshot after a takeover rebuild, until the socket snapshots. */
  l2BookSrc: Map<string, "ws" | "rest_snapshot">;
  /** Buffer overflows per UTC day. One increment when the cap is first hit. */
  overflowByDay: Map<string, number>;
  /** research when the candle store had 200 contiguous 4h bars. rest_1h when folded from REST 1h candles. */
  fourSeedSrc: Map<string, "research" | "rest_1h">;
  /** seeded until 200 4h bars have been built live. Nothing is gated on this. */
  ema200: Map<string, "seeded" | "live">;
  /** Newest seeded 4h timestamp. A later bar with a greater ts counts as live. */
  fourSeedThrough: Map<string, number>;
  /** The incoming socket saw a sequence_num hole. A reconnect while buffering counts. */
  socketHole: boolean;
  /** When this instance's socket opened. Coverage is measured on this socket alone. */
  socketOpenedMs: number | null;
  /** Last trade the writer applied. The next holder cuts the incoming stream here. */
  feedCut: FeedCut | null;
  /** True when a buffered event is timestamped before feedCut.atMs. It does not change coverage. */
  overlapSeen: boolean;
  /** One append at a time for each product. A second save of the same product waits. */
  productLocks: Map<string, Promise<void>>;
  /** Commands this process sent to store the book. */
  saveCommands: number;
  /** Payload bytes of those commands. */
  saveBytes: number;
  /** Appends sent for a row that was already stored. The target is 0. */
  duplicateAppends: number;
  /** Serializes flushes so two heartbeats cannot append the same bar. */
  flushChain: Promise<void>;
  /** In-flight fill and ledger writes. */
  durableChain: Promise<void>;
  /** Set by the cron holder. Fills write through this before the next event. */
  kv: Kv | null;
  fillStored: number;
  ledgerStored: number;
  /** Closed tape minutes already stored. */
  tapeWritten: Set<number>;
  /** Warmup keys written once. */
  warmupDone: Set<string>;
  seedChecked: boolean;
  /** Short or rate-limited products. Left out of signals until the next run warms them. */
  cold: Set<string>;
  /** REST book fetched once per product this run. */
  bookOnce: Set<string>;
  bookFlight: Map<string, Promise<"l2" | "rest_fallback" | "stale">>;
  /** A crash with no watcher. The next holder may REST-backfill the tape hole. */
  tapeHole: boolean;
  /** This process has seen the window on its own socket. */
  wsTape: boolean;
  /** Bars retainFifteens is about to drop. Their markers still go out in the flush. */
  closingMarks: { productId: string; startSec: number }[];
  /** This invocation's REST lane. Not shared with a watcher in the same process. */
  restRun: RestRun;
  /** Bars accepted during this invocation. The route reports these. */
  runApplied: string[];
  runStartedMs: number;
  deadlineMs: number;
  maxValueBytes: number;
  seedCursor: SeedCursor;
  seedMarks: Map<string, SeedMark>;
  /** Start of a crash hole, in seconds. Backfill covers this through now. */
  tapeHoleFromSec: number | null;
  /** running until the deadline release, then handover or crash. */
  runOutcome: string;
  /** Leg and decision counts at the start of sampling. The flush stores the delta. */
  runBaseFills: number;
  runBaseDecisions: number;
  /** Last run that reached a final outcome. Month and health read this, not a partial flush. */
  completedRun: { end: number; cmds: number; outcome: string } | null;
  /** Products whose 4h bars were stored in a successful flush. A warm mark needs this or the same payload. */
  fourFlushed: Set<string>;
}

export interface SeedCursor {
  order: string[];
  idx: number;
  runId: string;
}

export interface SeedMark {
  oldestTs: number;
  newestTs: number;
  status: "warm" | "cold" | "short";
  reason: string;
}

export interface FeedCutTrade {
  productId: string;
  tradeId: string | null;
  time: string | null;
  price: number;
  size: number;
}

export interface FeedCut {
  atMs: number;
  wallMs: number;
  trade: FeedCutTrade | null;
}

export interface StatusPublisher {
  publish(snapshot: { status: Record<string, unknown>; book: unknown }): void;
}

export interface RestRead {
  bar: OhlcvBar | null;
  status: number;
  retryAfterMs: number;
  /** Limiter reserve. This is not an exchange 429. */
  budgetStop?: boolean;
}

function emptySlot(productId: string, barStartSec: number): RestSlot {
  return { productId, barStartSec, attempts: 0, done: false, fallback: false, deferredMs: 0, notBeforeMs: 0, inflight: false };
}

function memberOn(rows: readonly { date: string; names: string[] }[]): (productId: string, date: string) => boolean {
  const dates = rows.map((row) => row.date).slice().sort();
  const sets = new Map(rows.map((row) => [row.date, new Set(row.names)]));
  return (productId, date) => {
    let prior: string | null = null;
    for (const item of dates) {
      if (item <= date) prior = item;
      else break;
    }
    if (!prior) return false;
    return sets.get(prior)?.has(productId) ?? false;
  };
}

/** First 15m bar of the day after the last completed daily-store day. */
export function historyOriginSec(days: readonly SourceDay[]): number | null {
  let last = "";
  for (const row of days) if (!row.empty && row.date > last) last = row.date;
  if (!last) return null;
  const next = new Date(`${last}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() / 1000;
}

function loadTicks(): Map<string, number> {
  const ticks = new Map<string, number>();
  const path = dataFile("products", "usd-spot.json");
  if (!path) return ticks;
  const body = JSON.parse(readFileSync(path, "utf8")) as { products?: { productId?: string; tickSize?: string | null }[] };
  for (const product of body.products ?? []) {
    const tick = Number(product.tickSize);
    if (product.productId && tick > 0) ticks.set(product.productId, tick);
  }
  return ticks;
}

function loadContext(): HostContext | null {
  const registrationPath = dataFile("reports", "p4-registration.json");
  const membershipPath = dataFile("reports", "universe-membership.json");
  if (!registrationPath || !membershipPath) return null;
  const registration = JSON.parse(readFileSync(registrationPath, "utf8")) as RegistrationFlagSource;
  const membership = JSON.parse(readFileSync(membershipPath, "utf8")) as { members: { date: string; names: string[] }[] };
  const ids = [...new Set(membership.members.flatMap((row) => row.names))];
  const flags = registeredFlags(registration, ids);
  return {
    flags: { priceGroupPasses: false, volumeGroupPasses: false, boundarySaved: false },
    byProduct: flags.byId,
    memberOn: memberOn(membership.members),
  };
}

function boundHost(host: PaperHost): void {
  trimSeries(host);
  if (host.trades.length > MAX_TRADES) host.trades.splice(0, host.trades.length - MAX_TRADES);
  if (host.book.mids.completed.length > MAX_MIDS) host.book.mids.completed.splice(0, host.book.mids.completed.length - MAX_MIDS);
  if (host.book.incidents.length > MAX_INCIDENTS) host.book.incidents.splice(0, host.book.incidents.length - MAX_INCIDENTS);
  if (host.seenTrades.size > MAX_SEEN_TRADES) {
    const drop = host.seenTrades.size - MAX_SEEN_TRADES;
    let left = drop;
    for (const key of host.seenTrades) {
      host.seenTrades.delete(key);
      left -= 1;
      if (left <= 0) break;
    }
  }
  if (host.rest.size <= MAX_REST_SLOTS) return;
  for (const [key, slot] of host.rest) {
    if (!slot.done) continue;
    host.rest.delete(key);
    if (host.rest.size <= MAX_REST_SLOTS) return;
  }
}

export function startPaperHost(products: readonly string[], env: Record<string, string | undefined> = process.env): PaperHost {
  const safety = assertSafeToStart(env);
  if (!safety.ok) throw new Error(safety.reason);
  if (products.length === 0) throw new Error("public paper needs a product");
  const frames = subscribeFrames(products, PUBLIC_CHANNELS, env);
  const shards = frames.length > 0 ? shardOf(products) : [];
  if (shards.some((shard) => shard.length > 10)) throw new Error("more than 10 products on one socket");
  for (const frame of frames) {
    const body = JSON.parse(frame) as { channel?: string };
    if (body.channel === "user" || body.channel === "orders" || body.channel === "full") throw new Error("refusing an order channel");
  }
  const context = loadContext();
  const dailyDir = dataFile("daily");
  const warmup = new Map<string, SourceDay[]>();
  const watched = [...new Set([...products, "BTC-USD"])];
  if (!dailyDir || !existsSync(join(dailyDir, "candles"))) {
    // The book still starts. Entries that need daily ATR wait for a store.
  } else {
    for (const productId of watched) warmup.set(productId, readDailyHistory(dailyDir, productId));
  }
  const memberCloses = context
    ? [...warmup.entries()]
        .filter(([, days]) => days.length > 0)
        .flatMap(([productId, days]) => {
          const flags = context.byProduct.get(productId);
          return flags ? [{ productId, flags, days }] : [];
        })
    : [];
  const btcCloses = (warmup.get("BTC-USD") ?? []).filter((row) => !row.empty && row.close > 0).map((row) => ({ date: row.date, close: row.close }));
  const book = freshBook({
    members: [...products],
    ...(memberCloses.length > 0 ? { memberCloses, btcCloses, clusterMemberOn: context?.memberOn } : {}),
  });
  book.config.liveQuotes = true;
  if (!context) book.incidents.push("registration flags unavailable");
  if (!dailyDir || !existsSync(join(dailyDir, "candles"))) book.incidents.push("daily warmup unavailable");
  else {
    for (const productId of products) {
      if ((warmup.get(productId)?.length ?? 0) === 0) book.incidents.push(`daily warmup missing ${productId}`);
    }
  }
  const host: PaperHost = {
    products: [...products],
    shards,
    frames,
    book,
    lastHeartbeatMs: shards.map(() => null),
    openedMs: shards.map(() => null),
    gapOpen: shards.map(() => false),
    needsReconnect: shards.map(() => false),
    replacing: shards.map(() => false),
    socketGen: shards.map(() => 0),
    reconnects: 0,
    gapEvents: 0,
    l2Gaps: 0,
    restAccepted: 0,
    restFallback: 0,
    lastL2Seq: new Map(),
    trades: [],
    restQuotes: new Map(),
    rest: new Map(),
    restCursor: new Map(),
    appliedThrough: new Map(),
    applied: new Set(),
    nextRestMs: 0,
    books: new Map(),
    fifteen: [],
    historyFrom: new Map([...warmup.entries()].flatMap(([id, days]) => {
      const origin = historyOriginSec(days);
      return origin == null ? [] : [[id, origin] as const];
    })),
    hourWarm: new Map(),
    ticks: loadTicks(),
    queued: new Map(),
    seenTrades: new Set(),
    clock: () => Date.now(),
    generatedSec: -1,
    generated: null,
    warmup,
    weeks: new Map(),
    emitted: new Set(),
    context,
    status: "live",
    lastBar: null,
    deadlineRelease: false,
    l2Ts: new Map(),
    gaps: [],
    restWarm: false,
    persistedBars: new Set(),
    quoteTried: new Set(),
    quoteNotBefore: new Map(),
    dailyCloses: new Map(),
    dailyBars: new Map(),
    fourBars: new Map(),
    warmupStored: false,
    feedCursor: { l2: null, tradeId: null },
    feedBuffer: [],
    feedBufferCapped: false,
    bufferFeeds: false,
    jevMeter: loadJevMeter(),
    leaseToken: null,
    stopped: false,
    l2BookSrc: new Map(),
    overflowByDay: new Map(),
    fourSeedSrc: new Map(),
    ema200: new Map(),
    fourSeedThrough: new Map(),
    socketHole: false,
    socketOpenedMs: null,
    feedCut: null,
    overlapSeen: false,
    productLocks: new Map(),
    saveCommands: 0,
    saveBytes: 0,
    duplicateAppends: 0,
    flushChain: Promise.resolve(),
    durableChain: Promise.resolve(),
    kv: null,
    fillStored: 0,
    ledgerStored: 0,
    tapeWritten: new Set(),
    warmupDone: new Set(),
    seedChecked: false,
    cold: new Set(),
    bookOnce: new Set(),
    bookFlight: new Map(),
    tapeHole: false,
    wsTape: false,
    closingMarks: [],
    restRun: createRestRun(Number.POSITIVE_INFINITY),
    runApplied: [],
    runStartedMs: 0,
    deadlineMs: 0,
    maxValueBytes: 0,
    seedCursor: { order: [], idx: 0, runId: "" },
    seedMarks: new Map(),
    tapeHoleFromSec: null,
    runOutcome: "running",
    runBaseFills: 0,
    runBaseDecisions: 0,
    completedRun: null,
    fourFlushed: new Set(),
  };
  host.restRun = createRestRun(Number.POSITIVE_INFINITY, {}, (id, reason) => {
    host.cold.add(id);
    const prev = host.seedMarks.get(id);
    host.seedMarks.set(id, { oldestTs: prev?.oldestTs ?? 0, newestTs: prev?.newestTs ?? 0, status: "cold", reason });
  });
  return host;
}

function loadJevMeter(): JevMeter {
  try {
    const path = dataFile("reports", "p6-jev-spend.json");
    if (!path) return freshJevMeter();
    const body = JSON.parse(readFileSync(path, "utf8")) as { costUsd?: number };
    return freshJevMeter(body.costUsd ?? 0);
  } catch {
    return freshJevMeter();
  }
}

export function mergeRolled<T extends { ts: number }>(existing: readonly T[], derived: readonly T[], keep: number): T[] {
  const byTs = new Map<number, T>();
  for (const bar of existing) byTs.set(bar.ts, bar);
  for (const bar of derived) byTs.set(bar.ts, bar);
  const merged = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  return merged.length > keep ? merged.slice(merged.length - keep) : merged;
}

function trimSeries(host: PaperHost): void {
  const nowSec = Math.floor(host.clock() / 1000);
  host.fifteen = retainFifteens(host.fifteen, nowSec);
  for (const [id, rows] of host.dailyCloses) host.dailyCloses.set(id, retainDailyCloses(rows));
  for (const [id, rows] of host.fourBars) host.fourBars.set(id, rows.slice(-FOUR_KEEP));
  for (const [id, rows] of host.hourWarm) host.hourWarm.set(id, rows.slice(-HOUR_KEEP));
}

function seedDailyCloses(host: PaperHost): void {
  for (const [productId, days] of host.warmup) {
    const filled = days.filter((row) => !row.empty && row.close > 0);
    if ((host.dailyBars.get(productId)?.length ?? 0) === 0 && filled.length > 0) {
      host.dailyBars.set(
        productId,
        filled.map((row) => ({
          ts: row.ts,
          open: row.open,
          high: row.high,
          low: row.low,
          close: row.close,
          volume: row.volume,
        })),
      );
    }
    if ((host.dailyCloses.get(productId)?.length ?? 0) > 0) continue;
    const seeded = filled.map((row) => ({ date: row.date, close: row.close }));
    if (seeded.length > 0) host.dailyCloses.set(productId, retainDailyCloses(seeded));
  }
}

function statusNote(response: { status?: number; headers?: { get(name: string): string | null } }): string {
  return budgetStopLabel(response.headers) ?? String(response.status ?? 0);
}

function closeSource(row: DailyClose): SourceDay {
  const ts = Date.parse(`${row.date}T00:00:00.000Z`) / 1000;
  return { date: row.date, ts, open: row.close, high: row.close, low: row.close, close: row.close, volume: 0, empty: false };
}

function shardOf(products: readonly string[]): string[][] {
  const shards: string[][] = [];
  for (let i = 0; i < products.length; i += 10) shards.push([...products.slice(i, i + 10)]);
  return shards;
}

function emitGaps(host: PaperHost, shard: readonly string[], cause: string): void {
  host.reconnects += 1;
  host.status = "reconnecting";
  host.book.incidents.push(`socket reconnect ${host.reconnects} ${cause}: ${shard.join(",")}`);
  for (const productId of shard) {
    host.gapEvents += 1;
    applyForward(host.book, { kind: "gap", productId });
  }
}

/** The socket is open. The first heartbeat is due HEARTBEAT_GAP_MS later. */
export function armShard(host: PaperHost, shardIndex: number, nowMs: number): void {
  host.openedMs[shardIndex] = nowMs;
  host.lastHeartbeatMs[shardIndex] = null;
  host.gapOpen[shardIndex] = false;
  if (host.socketOpenedMs == null) host.socketOpenedMs = nowMs;
}

/** Timer path. A shard that never heartbeats, or that misses another beat, reconnects. */
export function considerHeartbeatGap(host: PaperHost, shardIndex: number, nowMs: number): boolean {
  if (host.needsReconnect[shardIndex]) {
    host.needsReconnect[shardIndex] = false;
    host.gapOpen[shardIndex] = false;
    host.lastHeartbeatMs[shardIndex] = null;
    host.openedMs[shardIndex] = nowMs;
    emitGaps(host, host.shards[shardIndex] ?? [], "closed");
    return true;
  }
  const last = host.lastHeartbeatMs[shardIndex] ?? host.openedMs[shardIndex];
  if (last == null || !heartbeatMustReconnect(last, nowMs, HEARTBEAT_GAP_MS)) return false;
  host.gapOpen[shardIndex] = false;
  host.lastHeartbeatMs[shardIndex] = null;
  host.openedMs[shardIndex] = nowMs;
  emitGaps(host, host.shards[shardIndex] ?? [], "heartbeat");
  return true;
}

export function onSocketClosed(host: PaperHost, shardIndex: number): void {
  if (host.replacing[shardIndex]) {
    host.replacing[shardIndex] = false;
    return;
  }
  host.gapOpen[shardIndex] = false;
  host.needsReconnect[shardIndex] = true;
  host.book.incidents.push(`socket ${shardIndex} closed`);
}

export function onSocketError(host: PaperHost, shardIndex: number): void {
  host.gapOpen[shardIndex] = false;
  host.needsReconnect[shardIndex] = true;
  host.book.incidents.push(`socket ${shardIndex} error`);
}

/**
 * sequence_num is per connection and counts every channel: subscriptions,
 * heartbeats, level2, and market_trades. A snapshot does not reset it.
 * One message carries one number and many price levels, so the same number
 * again is that message, not a gap. The next message is the previous plus one.
 */
export function l2SequenceOk(last: number | null, next: number): boolean {
  if (last == null) return true;
  return next === last || next === last + 1;
}

/** Subscribe frames whose product_ids are exactly this shard. The socket sends these strings. */
export function framesForShard(host: PaperHost, shardIndex: number): string[] {
  const shard = host.shards[shardIndex] ?? [];
  const key = JSON.stringify([...shard].sort());
  const matched = host.frames.filter((frame) => {
    const body = JSON.parse(frame) as { product_ids?: string[] };
    return JSON.stringify([...(body.product_ids ?? [])].sort()) === key;
  });
  if (matched.length === 0) throw new Error(`no checked frame for shard ${shardIndex}`);
  return matched;
}

/** A late heartbeat is itself a gap: reconnect, then record the beat. */
export function observeHeartbeat(host: PaperHost, shardIndex: number, nowMs: number): { reconnect: boolean } {
  const last = host.lastHeartbeatMs[shardIndex];
  const reconnect = last != null && heartbeatMustReconnect(last, nowMs) && !host.gapOpen[shardIndex];
  if (reconnect) emitGaps(host, host.shards[shardIndex] ?? [], "late-heartbeat");
  applyForward(host.book, { kind: "heartbeat", tsMs: nowMs });
  host.lastHeartbeatMs[shardIndex] = nowMs;
  host.gapOpen[shardIndex] = false;
  host.status = "live";
  return { reconnect };
}

function levelsOf(host: PaperHost, productId: string): { bids: Map<string, number>; asks: Map<string, number> } {
  let book = host.books.get(productId);
  if (!book) {
    book = { bids: new Map(), asks: new Map() };
    host.books.set(productId, book);
  }
  return book;
}

function touch(book: { bids: Map<string, number>; asks: Map<string, number> }): { bid: number; ask: number } | null {
  let bid = 0;
  let ask = Number.POSITIVE_INFINITY;
  for (const [price, size] of book.bids) if (size > 0) bid = Math.max(bid, Number(price));
  for (const [price, size] of book.asks) if (size > 0) ask = Math.min(ask, Number(price));
  if (!(bid > 0) || !Number.isFinite(ask)) return null;
  return { bid, ask };
}

function applyLevel(book: { bids: Map<string, number>; asks: Map<string, number> }, side: "bid" | "ask", price: string, size: string): void {
  const levels = side === "bid" ? book.bids : book.asks;
  const qty = Number(size);
  if (!(qty > 0)) levels.delete(price);
  else levels.set(price, qty);
}

function noteSequence(host: PaperHost, shardIndex: number, sequence: number | undefined, reset: boolean): void {
  if (sequence == null) return;
  const key = String(shardIndex);
  const last = host.lastL2Seq.get(key) ?? null;
  if (!reset && !l2SequenceOk(last, sequence)) {
    host.l2Gaps += 1;
    host.book.incidents.push(`l2 sequence shard ${shardIndex} ${String(last)} -> ${sequence}`);
    host.needsReconnect[shardIndex] = true;
  }
  host.lastL2Seq.set(key, sequence);
  host.feedCursor.l2 = sequence;
}

/** Public messages for one socket. Trade time and maker side come from the exchange. */
export function applyPublic(host: PaperHost, shardIndex: number, events: readonly PublicEvent[], nowMs: number, opts?: { handoverMicro?: boolean }): void {
  const sequenced = events.find((event) => (event.kind === "l2-snapshot" || event.kind === "l2-update") && event.sequence != null);
  if (sequenced && (sequenced.kind === "l2-snapshot" || sequenced.kind === "l2-update")) {
    noteSequence(host, shardIndex, sequenced.sequence, false);
  }
  const dirty = new Set<string>();
  for (const event of events) {
    if (event.kind === "heartbeat") {
      observeHeartbeat(host, shardIndex, nowMs);
      continue;
    }
    if (event.kind === "trade") {
      const exchangeMs = event.time ? Date.parse(event.time) : Number.NaN;
      const tsMs = Number.isFinite(exchangeMs) ? exchangeMs : nowMs;
      const key = event.tradeId ?? `${event.productId}|${event.time ?? tsMs}|${event.price}|${event.size}|${event.side ?? ""}`;
      if (host.seenTrades.has(key)) continue;
      host.seenTrades.add(key);
      const tradeId = event.tradeId != null ? Number(event.tradeId) : Number.NaN;
      if (Number.isInteger(tradeId)) host.feedCursor.tradeId = tradeId;
      if (!host.bufferFeeds) host.wsTape = true;
      host.trades.push({
        productId: event.productId,
        tsSec: Math.floor(tsMs / 1000),
        price: event.price,
        size: event.size,
        ...(event.side ? { side: event.side } : {}),
      });
      if (!host.bufferFeeds) {
        host.feedCut = {
          atMs: tsMs,
          wallMs: nowMs,
          trade: {
            productId: event.productId,
            tradeId: event.tradeId ?? null,
            time: event.time ?? null,
            price: event.price,
            size: event.size,
          },
        };
      }
      if (event.side === "BUY" || event.side === "SELL" || opts?.handoverMicro) {
        applyForward(host.book, {
          kind: "trade",
          productId: event.productId,
          price: event.price,
          size: event.size,
          makerSide: event.side ?? "",
          tsMs,
          ...(opts?.handoverMicro ? { handoverMicro: true } : {}),
        });
      }
      continue;
    }
    if (event.kind === "l2-snapshot") {
      const book = { bids: new Map<string, number>(), asks: new Map<string, number>() };
      for (const [price, size] of event.bids) applyLevel(book, "bid", price, size);
      for (const [price, size] of event.asks) applyLevel(book, "ask", price, size);
      host.books.set(event.productId, book);
      host.l2BookSrc.set(event.productId, "ws");
      host.l2Ts.set(event.productId, nowMs);
      dirty.add(event.productId);
      continue;
    }
    if (event.kind === "l2-update") {
      const book = levelsOf(host, event.productId);
      const resync = host.l2BookSrc.get(event.productId) === "rest_snapshot";
      applyLevel(book, event.side, event.price, event.size);
      if (resync && !host.book.incidents.includes(`l2 resync ${event.productId}`)) {
        host.book.incidents.push(`l2 resync ${event.productId}`);
      }
      host.l2Ts.set(event.productId, nowMs);
      dirty.add(event.productId);
    }
  }
  for (const productId of dirty) {
    const book = host.books.get(productId);
    const top = book ? touch(book) : null;
    if (top) {
      host.book.quotes[productId] = { bid: top.bid, ask: top.ask, tsMs: nowMs, quoteSrc: "l2" };
      applyForward(host.book, { kind: "mid", tsMs: nowMs, productId, bid: top.bid, ask: top.ask });
    }
  }
  kickDurable(host);
  boundHost(host);
}

export function scheduleRest(host: PaperHost, nowMs: number): void {
  const nowSec = Math.floor(nowMs / 1000);
  const current = Math.floor(nowSec / 900) * 900;
  const newestClosed = current - 900;
  if (newestClosed < 0) return;
  for (const productId of host.products) {
    let cursor = host.restCursor.get(productId);
    const origin = host.historyFrom.get(productId);
    if (cursor == null) cursor = origin != null && origin <= newestClosed ? origin : newestClosed;
    const end = Math.min(newestClosed, cursor + (REST_BACKFILL_BARS - 1) * 900);
    for (let start = cursor; start <= end; start += 900) {
      const key = `${productId}:${start}`;
      if (!host.rest.has(key)) host.rest.set(key, emptySlot(productId, start));
    }
    if (end >= cursor) host.restCursor.set(productId, end + 900);
  }
  boundHost(host);
}

export function restAction(slot: RestSlot, nowMs: number): "wait" | "fetch" | "fallback" {
  if (slot.done || slot.inflight) return "wait";
  const deferred = slot.deferredMs ?? 0;
  const barEndMs = (slot.barStartSec + 900) * 1000;
  const schedule = restSettleSchedule(barEndMs);
  const first = schedule.firstMs + deferred;
  const deadline = schedule.deadlineMs + deferred;
  if (nowMs < (slot.notBeforeMs ?? 0) || nowMs < first) return "wait";
  const tried = slot.attempts > 0 || (slot.deferredMs ?? 0) > 0;
  if (nowMs >= deadline && tried) return "fallback";
  const index = Math.floor((Math.max(nowMs, first) - first) / schedule.intervalMs);
  if (slot.attempts === 0 || index >= slot.attempts) return "fetch";
  return "wait";
}

export function dueRest(host: PaperHost, nowMs: number): { slot: RestSlot; action: "fetch" | "fallback" }[] {
  scheduleRest(host, nowMs);
  const out: { slot: RestSlot; action: "fetch" | "fallback" }[] = [];
  for (const slot of host.rest.values()) {
    const action = restAction(slot, nowMs);
    if (action === "wait") continue;
    out.push({ slot, action });
  }
  return out;
}

/** One REST action. Fetches are paced. A 429 does not consume a retry. */
export function nextRest(host: PaperHost, nowMs: number, paceMs = REST_PACE_MS): { slot: RestSlot; action: "fetch" | "fallback" } | null {
  const due = dueRest(host, nowMs);
  const fallback = due.find((row) => row.action === "fallback");
  if (fallback) return fallback;
  if (nowMs < host.nextRestMs) return null;
  return due.find((row) => row.action === "fetch") ?? null;
}

export function retryAfterMs(header: string | null): number {
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
  return 1_000;
}

export function noteRest429(slot: RestSlot, nowMs: number, waitMs: number): void {
  const wait = waitMs > 0 ? waitMs : 1_000;
  slot.notBeforeMs = Math.max(slot.notBeforeMs, nowMs + wait);
  slot.deferredMs += wait;
  slot.inflight = false;
}

function mergedScores(host: PaperHost, date: string): ClassBRow[] | undefined {
  const rows: ClassBRow[] = [];
  let any = false;
  for (const weeks of host.weeks.values()) {
    let chosen: (typeof weeks)[number] | null = null;
    for (const week of weeks) if (week.date <= date) chosen = week;
    if (!chosen) continue;
    any = true;
    rows.push(...chosen.rows);
  }
  return any ? rows : undefined;
}

/** The same generator the offline book uses: every member, the registered flags, and the BTC veto. */
export function universeEntries(host: PaperHost, nowSec: number): ReturnType<typeof generateForward> | null {
  if (!host.context || !host.book.aPick) return null;
  for (const id of host.restRun.cold.keys()) host.cold.add(id);
  const btcBars = host.fifteen.filter((bar) => bar.productId === "BTC-USD");
  const btcDays = completedDays(host.warmup.get("BTC-USD") ?? [], btcBars, nowSec);
  const btcFour = deriveForwardBook(btcBars, nowSec)?.four ?? [];
  const generated = generateForward({
    bars: host.fifteen.filter((bar) => bar.productId === "BTC-USD" || !host.cold.has(bar.productId)),
    nowSec,
    flags: host.context.flags,
    flagsByProduct: host.context.byProduct,
    memberOn: host.context.memberOn,
    warmupDays: host.warmup,
    veto: vetoFromBtc(btcDays, btcFour),
    pick: { lookback: host.book.aPick.lookback, k: host.book.aPick.k },
    seededBars: { four: host.fourBars, hour: host.hourWarm },
  });
  host.weeks.set("*", generated.weeks);
  return generated;
}

function hourSeries(host: PaperHost, productId: string, derived: readonly BarOHLC[]): BarOHLC[] {
  return mergeRolled(host.hourWarm.get(productId) ?? [], derived, HOUR_KEEP);
}

/** Keep the seeded series and let a newly closed bar replace the same timestamp. */
export function rollSettled(host: PaperHost, productId: string, nowSec: number): void {
  const derived = deriveForwardBook(host.fifteen.filter((bar) => bar.productId === productId), nowSec);
  if (!derived) return;
  host.hourWarm.set(productId, mergeRolled(host.hourWarm.get(productId) ?? [], derived.hour, HOUR_KEEP));
  host.fourBars.set(productId, mergeRolled(host.fourBars.get(productId) ?? [], derived.four, FOUR_KEEP));
  const through = host.fourSeedThrough.get(productId);
  if (through != null) {
    const live = (host.fourBars.get(productId) ?? []).filter((bar) => bar.ts > through).length;
    host.ema200.set(productId, live >= FOUR_HOUR_EMA_BARS ? "live" : "seeded");
  }
  const daily = derived.days
    .filter((row) => !row.empty && row.close > 0)
    .map((row) => ({ ts: row.ts, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume }));
  host.dailyBars.set(productId, mergeRolled(host.dailyBars.get(productId) ?? [], daily, Number.MAX_SAFE_INTEGER));
  const closes = new Map((host.dailyCloses.get(productId) ?? []).map((row) => [row.date, row]));
  for (const row of derived.days) {
    if (row.empty || !(row.close > 0)) continue;
    closes.set(row.date, { date: row.date, close: row.close });
  }
  host.dailyCloses.set(productId, retainDailyCloses([...closes.values()]));
}

function ensureHourWarm(host: PaperHost, productId: string): void {
  if (host.hourWarm.has(productId)) return;
  const dir = dataFile("candles", productId);
  if (!dir) {
    host.hourWarm.set(productId, []);
    return;
  }
  const months = readdirSync(dir).filter((name) => name.endsWith(".sqlite")).sort();
  const last = months[months.length - 1];
  if (!last) {
    host.hourWarm.set(productId, []);
    return;
  }
  const rows = readPairMonth(join(dir, last)).rows;
  const bars: FifteenBar[] = [];
  for (const row of rows) {
    if (row.empty || row.open == null || row.high == null || row.low == null || row.close == null) continue;
    bars.push({
      productId,
      startSec: row.minuteSec,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume ?? 0),
    });
  }
  const end = bars.length > 0 ? bars[bars.length - 1]!.startSec + 900 : 0;
  host.hourWarm.set(productId, deriveForwardBook(bars, end)?.hour.slice(-HOUR_KEEP) ?? []);
}

function entryId(entry: GeneratedEntry): string {
  return `${entry.classId}-${entry.productId}-${entry.tsMs}`;
}

/**
 * Put the send-time book on the host. L2 wins when it is within 15s.
 * Otherwise the one REST snapshot already taken, flagged rest_fallback.
 * p6-staleness-ruling.md, 2026-10-12 11:25 AM CT.
 */
export function publishLiveQuote(host: PaperHost, productId: string, nowMs: number): "l2" | "rest_fallback" | "stale" {
  const l2At = host.l2Ts.get(productId);
  const stored = host.books.get(productId);
  const top = stored ? touch(stored) : null;
  if (top && l2At != null && nowMs - l2At <= STALE_QUOTE_MS) {
    host.book.quotes[productId] = { bid: top.bid, ask: top.ask, tsMs: l2At, quoteSrc: "l2" };
    return "l2";
  }
  const rest = host.restQuotes.get(productId);
  if (rest && nowMs - rest.tsMs <= STALE_QUOTE_MS) {
    host.book.quotes[productId] = { bid: rest.bid, ask: rest.ask, tsMs: rest.tsMs, quoteSrc: "rest_fallback" };
    return "rest_fallback";
  }
  return "stale";
}

type BookFetch = (url: string) => Promise<Pick<Response, "status" | "ok" | "json"> & { headers?: { get(name: string): string | null } }>;

async function readSendQuote(
  host: PaperHost,
  productId: string,
  nowMs: number,
  fetchImpl: BookFetch,
): Promise<"l2" | "rest_fallback" | "stale"> {
  const ready = publishLiveQuote(host, productId, nowMs);
  if (ready !== "stale") return ready;
  if (nowMs < (host.quoteNotBefore.get(productId) ?? 0)) return "stale";
  try {
    const response = await fetchImpl(productBookUrl(productId));
    if (response.status === 429) {
      const wait = retryAfterMs(response.headers?.get("retry-after") ?? null);
      host.quoteNotBefore.set(productId, nowMs + wait);
      host.book.incidents.push(budgetStopLabel(response.headers) ? `rest book ${productId} budget-stop` : `rest book ${productId} 429`);
      return "stale";
    }
    if (response.ok) {
      const body = (await response.json()) as { bids?: [string, string][]; asks?: [string, string][]; time?: string };
      const bid = Number(body.bids?.[0]?.[0]);
      const ask = Number(body.asks?.[0]?.[0]);
      const stamped = body.time ? Date.parse(body.time) : nowMs;
      const tsMs = Number.isFinite(stamped) ? stamped : nowMs;
      if (bid > 0 && ask > 0 && nowMs - tsMs <= STALE_QUOTE_MS) {
        host.restQuotes.set(productId, { bid, ask, tsMs });
        return publishLiveQuote(host, productId, nowMs);
      }
    }
  } catch (error) {
    host.book.incidents.push(`rest book ${productId} ${error instanceof Error ? error.message : "failed"}`);
  }
  return "stale";
}

/**
 * WS first. REST only when that book is stale, and at most once per product per run.
 * A caller-supplied fetch is the test double and is not cached.
 */
export async function ensureSendQuote(
  host: PaperHost,
  productId: string,
  nowMs: number,
  fetchImpl?: BookFetch,
): Promise<"l2" | "rest_fallback" | "stale"> {
  if (fetchImpl) return readSendQuote(host, productId, nowMs, fetchImpl);
  if (publishLiveQuote(host, productId, nowMs) === "l2") return "l2";
  if (host.bookOnce.has(productId)) return publishLiveQuote(host, productId, nowMs);
  const inflight = host.bookFlight.get(productId);
  if (inflight) return inflight;
  const job = readSendQuote(host, productId, nowMs, hostGet(host)).finally(() => {
    host.bookFlight.delete(productId);
    host.bookOnce.add(productId);
  });
  host.bookFlight.set(productId, job);
  return job;
}

/**
 * After an uncovered takeover the socket book is only the updates that arrived
 * since the snapshot was dropped. Replace it with the REST level-2 ladder and
 * let later level2 updates resync on top. The book stays flagged until a live snapshot.
 */
export async function resyncBooksFromRest(
  host: PaperHost,
  fetchImpl?: BookFetch,
): Promise<void> {
  const impl = fetchImpl ?? hostGet(host);
  for (const productId of host.products) {
    if (!fetchImpl && host.bookOnce.has(productId)) continue;
    try {
      const response = await impl(productBookLevel2Url(productId));
      if (!fetchImpl) host.bookOnce.add(productId);
      if (response.status === 429) {
        const wait = retryAfterMs(response.headers?.get("retry-after") ?? null);
        host.quoteNotBefore.set(productId, host.clock() + wait);
        host.book.incidents.push(budgetStopLabel(response.headers) ? `l2 rest snapshot ${productId} budget-stop` : `l2 rest snapshot ${productId} 429`);
        continue;
      }
      if (!response.ok) {
        host.book.incidents.push(`l2 rest snapshot ${productId} ${statusNote(response)}`);
        continue;
      }
      const body = (await response.json()) as { bids?: [string, string][]; asks?: [string, string][] };
      const book = { bids: new Map<string, number>(), asks: new Map<string, number>() };
      for (const level of body.bids ?? []) applyLevel(book, "bid", level[0], level[1]);
      for (const level of body.asks ?? []) applyLevel(book, "ask", level[0], level[1]);
      host.books.set(productId, book);
      host.l2BookSrc.set(productId, "rest_snapshot");
      host.l2Ts.set(productId, host.clock());
      const top = touch(book);
      if (top) host.book.quotes[productId] = { bid: top.bid, ask: top.ask, tsMs: host.clock(), quoteSrc: "rest_fallback" };
      host.book.incidents.push(`l2 rest snapshot ${productId}`);
    } catch (error) {
      host.book.incidents.push(`l2 rest snapshot ${productId} ${error instanceof Error ? error.message : "failed"}`);
    }
  }
}

/** One snapshot for this leg. A 429 does not consume it and is not retried until the backoff ends. */
export async function ensureSendQuoteOnce(
  host: PaperHost,
  productId: string,
  nowMs: number,
  legId: string,
  fetchImpl?: BookFetch,
): Promise<"l2" | "rest_fallback" | "stale"> {
  if (host.quoteTried.has(legId)) return publishLiveQuote(host, productId, nowMs);
  const kind = await ensureSendQuote(host, productId, nowMs, fetchImpl);
  if (nowMs < (host.quoteNotBefore.get(productId) ?? 0)) return kind;
  host.quoteTried.add(legId);
  return kind;
}

/** Await the send-time book, then flush. Entries still waiting on a 429 stay queued. */
export async function sendDueEntries(host: PaperHost, nowMs: number, fetchImpl?: BookFetch): Promise<void> {
  for (const [id, entry] of host.queued) {
    if (entry.tsMs > nowMs) continue;
    await ensureSendQuoteOnce(host, entry.productId, nowMs, id, fetchImpl);
  }
  flushEntries(host, nowMs, { keepUntried: true });
}

/** One snapshot for an exit on this bar. Not called on the idle tick. */
export async function prepareExitQuotes(
  host: PaperHost,
  productId: string,
  barStartSec: number,
  nowMs: number,
  fetchImpl?: BookFetch,
): Promise<void> {
  for (const position of host.book.positions) {
    if (position.productId !== productId) continue;
    await ensureSendQuoteOnce(host, productId, nowMs, `${position.id}:exit:${barStartSec}`, fetchImpl);
  }
}

/** Send a queued entry at the fill open. The book is the one at send, never the one stored at the decision. */
export function flushEntries(host: PaperHost, nowMs: number, opts?: { keepUntried?: boolean }): void {
  for (const [id, entry] of host.queued) {
    if (entry.tsMs > nowMs) continue;
    const quoteKind = publishLiveQuote(host, entry.productId, nowMs);
    const quoted = host.book.quotes[entry.productId];
    if (quoteKind === "stale" || !quoted || nowMs - quoted.tsMs > STALE_QUOTE_MS) {
      if (opts?.keepUntried && !host.quoteTried.has(id)) continue;
      host.queued.delete(id);
      host.emitted.add(id);
      host.book.rejected.push({ id, reason: MISSED_SEND_STALE_QUOTE });
      host.book.incidents.push(`${MISSED_SEND_STALE_QUOTE} ${id}`);
      continue;
    }
    host.queued.delete(id);
    const top = { bid: quoted.bid, ask: quoted.ask };
    const quoteFallback = quoted.quoteSrc === "rest_fallback";
    const tick = host.ticks.get(entry.productId);
    if (entry.kind === "d-order" && !(tick && tick > 0)) {
      host.emitted.add(id);
      host.book.incidents.push(`tick missing ${entry.productId}`);
      host.book.rejected.push({ id, reason: "tick" });
      continue;
    }
    let nextOpen = entry.nextOpen;
    let stop = entry.stop;
    if (entry.fillAtOpen || !(nextOpen > 0)) {
      nextOpen = (top.bid + top.ask) / 2;
      const k = host.book.aPick?.k ?? 0;
      if (entry.classId === "A" && k > 0 && entry.dailyAtr > 0) stop = nextOpen - k * entry.dailyAtr;
    }
    host.emitted.add(id);
    const hours = hourSeries(host, entry.productId, deriveForwardBook(host.fifteen.filter((bar) => bar.productId === entry.productId), Math.floor(nowMs / 1000))?.hour ?? []);
    const atr1h = hourAtrAt(hours, Math.floor(entry.tsMs / 1000));
    if (entry.kind === "d-order") {
      applyForward(host.book, {
        kind: "d-order",
        id,
        productId: entry.productId,
        limit: nextOpen,
        units: 1,
        placedTs: entry.tsMs,
        stop,
        bid: top.bid,
        ask: top.ask,
        bookTsMs: quoted.tsMs,
        sendTsMs: nowMs,
        decisionMid: nextOpen,
        tick,
        target: entry.target ?? undefined,
        quoteFallback,
        decisionTs: entry.decisionTs ?? entry.tsMs,
        barCloseTs: entry.barCloseTs ?? entry.tsMs,
      });
      continue;
    }
    applyForward(host.book, {
      kind: "x1",
      id,
      classId: entry.classId,
      productId: entry.productId,
      tsMs: entry.tsMs,
      nextOpen,
      stop,
      atr1h,
      bid: top.bid,
      ask: top.ask,
      bookTsMs: quoted.tsMs,
      sendTsMs: nowMs,
      decisionMid: nextOpen,
      target: entry.target ?? undefined,
      dailyAtr: entry.dailyAtr,
      priorDailyCloses: entry.priorDailyCloses,
      ...(entry.aConfig ? { aConfig: entry.aConfig } : {}),
      quoteFallback,
      decisionTs: entry.decisionTs ?? entry.tsMs,
      barCloseTs: entry.barCloseTs ?? entry.tsMs,
    });
  }
  kickDurable(host);
}

function queueEntries(host: PaperHost, entries: readonly GeneratedEntry[], nowMs: number): void {
  for (const entry of entries) {
    const id = entryId(entry);
    if (host.emitted.has(id) || host.queued.has(id)) continue;
    if (entry.tsMs < nowMs - 86_400_000) continue;
    if (host.cold.has(entry.productId) || isCold(entry.productId, host.restRun)) continue;
    host.queued.set(id, entry);
  }
  flushEntries(host, nowMs, { keepUntried: true });
}

function pushBar(host: PaperHost, bar: OhlcvBar): void {
  host.fifteen.push({ productId: bar.productId, startSec: bar.startSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
  const nowSec = bar.startSec + 900;
  let atr1h = 0;
  let dailyAtr = 0;
  let bScores: ClassBRow[] | undefined;
  let missing1m = false;
  const dailyClose = isDayCloseBar(bar.startSec);
  const liveBar = host.clock() >= nowSec * 1000 && host.clock() - nowSec * 1000 < 180_000;
  const live = liveBar;
  publishLiveQuote(host, bar.productId, host.clock());
  try {
    ensureHourWarm(host, bar.productId);
    const derived = deriveForwardBook(host.fifteen.filter((row) => row.productId === bar.productId), nowSec);
    if (dailyClose) {
      const date = new Date(bar.startSec * 1000).toISOString().slice(0, 10);
      const series = rollDailyClose(host.dailyCloses.get(bar.productId) ?? [], date, bar.close);
      host.dailyCloses.set(bar.productId, series);
      noteMemberDay(host.book, bar.productId, closeSource({ date, close: bar.close }));
    }
    const jev = buildJevPackets({ members: host.products, barStartSec: bar.startSec, nowSec, mids: host.book.mids.completed });
    missing1m = liveBar && jev.missing;
    rollSettled(host, bar.productId, nowSec);
    if ((live || dailyClose) && host.generatedSec !== nowSec) {
      host.generated = universeEntries(host, nowSec);
      host.generatedSec = nowSec;
    }
    const generated = host.generated;
    const note = forwardBarAnnotation(
      generated ?? { entries: [], weeks: host.weeks.get("*") ?? [], atrByProduct: new Map() },
      hourSeries(host, bar.productId, derived?.hour ?? []),
      bar.productId,
      bar.startSec,
    );
    atr1h = note.atr1h;
    dailyAtr = note.dailyAtr;
    bScores = note.bScores ?? mergedScores(host, new Date(bar.startSec * 1000).toISOString().slice(0, 10));
    if (generated && live) queueEntries(host, generated.entries, host.clock());
  } catch (error) {
    host.book.incidents.push(`generator ${bar.productId} ${error instanceof Error ? error.message : "failed"}`);
  }
  host.lastBar = { productId: bar.productId, atr1h, dailyAtr, dailyClose, bScores: bScores?.length ?? 0 };
  const fields = {
    kind: "bar15" as const,
    productId: bar.productId,
    startSec: bar.startSec,
    nowSec,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    atr1h,
    dailyAtr,
    ...(bScores ? { bScores } : {}),
    dailyClose,
    missing1m,
    countJev: liveBar,
  };
  applyForward(host.book, { ...fields, phase: "gap" });
  applyForward(host.book, { ...fields, phase: "rest" });
  kickDurable(host);
  boundHost(host);
}

function barKey(productId: string, startSec: number): string {
  return `${productId}:${startSec}`;
}

function noteApplied(host: PaperHost, productId: string, startSec: number): void {
  host.applied.add(barKey(productId, startSec));
  const appliedId = barKey(productId, startSec);
  if (!host.runApplied.includes(appliedId)) host.runApplied.push(appliedId);
  const prev = host.appliedThrough.get(productId) ?? -1;
  if (startSec > prev) host.appliedThrough.set(productId, startSec);
  const keepFrom = startSec - (REST_BACKFILL_BARS - 1) * 900;
  for (const key of host.applied) {
    if (!key.startsWith(`${productId}:`)) continue;
    const start = Number(key.slice(productId.length + 1));
    if (start < keepFrom) host.applied.delete(key);
  }
}

function alreadyApplied(host: PaperHost, productId: string, startSec: number): boolean {
  if (host.applied.has(barKey(productId, startSec))) return true;
  return host.fifteen.some((row) => row.productId === productId && row.startSec === startSec);
}

/**
 * Where to read next after a restart. Unapplied bars inside the backfill
 * window are retried. An older snapshot with no appliedThrough is left as saved.
 */
export function resumeRestCursor(cursor: number | undefined, appliedThrough: number | undefined): number | undefined {
  if (cursor == null && appliedThrough == null) return undefined;
  if (cursor == null) return appliedThrough! + 900;
  const earliest = Math.max(0, cursor - REST_BACKFILL_BARS * 900);
  if (appliedThrough == null) return earliest;
  const next = appliedThrough + 900;
  if (next >= cursor) return cursor;
  return Math.max(earliest, next);
}

export function acceptRestBar(host: PaperHost, bar: OhlcvBar): "accepted" | "already" | "drop-late" {
  const slot = host.rest.get(barKey(bar.productId, bar.startSec));
  if (slot?.done && slot.fallback) return "drop-late";
  if (alreadyApplied(host, bar.productId, bar.startSec)) return "already";
  if (slot) {
    slot.done = true;
    slot.inflight = false;
    slot.fallback = false;
  }
  host.restAccepted += 1;
  pushBar(host, bar);
  noteApplied(host, bar.productId, bar.startSec);
  return "accepted";
}

export function noteRestMiss(host: PaperHost, slot: RestSlot): void {
  slot.attempts += 1;
  slot.inflight = false;
  void host;
}

export function fallbackTradesBar(host: PaperHost, slot: RestSlot): OhlcvBar | null {
  slot.done = true;
  slot.fallback = true;
  slot.inflight = false;
  host.restFallback += 1;
  const prints = host.trades.filter((trade) => trade.productId === slot.productId && trade.tsSec >= slot.barStartSec && trade.tsSec < slot.barStartSec + 900);
  const built = tradesBuilt15m(prints).find((bar) => bar.startSec === slot.barStartSec) ?? null;
  const decision = restOrTrades({ restOk: false, deadlinePassed: true });
  if (decision.incident) {
    host.book.incidents.push(`rest 15m missed ${slot.productId} ${slot.barStartSec} after 120s; ${built ? "trades-built bar" : "no trades"}`);
  }
  if (built && !alreadyApplied(host, slot.productId, slot.barStartSec)) {
    pushBar(host, built);
    noteApplied(host, slot.productId, slot.barStartSec);
  }
  return built;
}

export function hostStatus(host: PaperHost): Record<string, unknown> {
  return {
    status: host.status,
    products: host.products,
    sockets: host.shards.length,
    maxProductsPerSocket: Math.max(...host.shards.map((shard) => shard.length), 0),
    channels: [...PUBLIC_CHANNELS],
    orderChannel: false,
    reconnects: host.reconnects,
    heartbeatGaps: host.book.heartbeatGaps,
    gapEvents: host.gapEvents,
    l2Gaps: host.l2Gaps,
    incidents: host.book.incidents.length,
    incidentLines: host.book.incidents.slice(-20),
    completedMidBars: host.book.mids.completed.length,
    quotedProducts: Object.keys(host.book.quotes).length,
    restAccepted: host.restAccepted,
    restFallback: host.restFallback,
    trades: host.trades.length,
    lastBar: host.lastBar,
    open: host.book.positions.length,
    closed: host.book.closed.length,
  };
}

export function hostPanel(host: PaperHost): ReturnType<typeof forwardBookPanel> {
  return forwardBookPanel(host.book, null);
}

export function readOnlyResponse(host: PaperHost, method: string, path: string): { status: number; body: string } {
  if (method !== "GET") return { status: 405, body: "" };
  if (path === "/status") return { status: 200, body: JSON.stringify(hostStatus(host)) };
  if (path === "/book") return { status: 200, body: JSON.stringify(hostPanel(host)) };
  return { status: 404, body: "" };
}

/** Runtime output stays under data/runtime. A later store or read-only route can wrap the same publisher. */
export function assertRuntimeDir(dir: string): void {
  const parts = dir.replace(/\\/g, "/").split("/");
  if (parts.includes("..")) throw new Error("runtime dir must stay under data/runtime");
  const at = parts.findIndex((part, index) => part === "data" && parts[index + 1] === "runtime");
  if (at < 0) throw new Error("runtime output must be under data/runtime");
}

export function runtimeFilePublisher(dir: string): StatusPublisher {
  assertRuntimeDir(dir);
  return {
    publish(snapshot) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "status.json"), `${JSON.stringify(snapshot.status, null, 2)}\n`);
      writeFileSync(join(dir, "book.json"), `${JSON.stringify(snapshot.book, null, 2)}\n`);
    },
  };
}

export function writeHostFiles(dir: string, host: PaperHost): void {
  runtimeFilePublisher(dir).publish({ status: hostStatus(host), book: hostPanel(host) });
}

/** Book and cursor snapshot. A file store writes it today. A later store can keep the same body. */
export interface PaperStateBody {
  positions: Book["positions"];
  closed: Book["closed"];
  kelly: Book["kelly"];
  pairs: Book["pairs"];
  realizedUsd: number;
  incidents: string[];
  aPickConfig: string | null;
  classes: Book["classes"];
  day: string | null;
  week: string | null;
  dayStartEquity: number;
  weekStartEquity: number;
  peakEquity: number;
  killSwitch: boolean;
  rejected: Book["rejected"];
  haltWeeks: string[];
  momentumDates: string[];
  restCursor: [string, number][];
  appliedThrough: [string, number][];
  applied: string[];
  emitted: string[];
  fifteen: FifteenBar[];
  hourWarm: [string, BarOHLC[]][];
  weeks: [string, { date: string; rows: ClassBRow[] }[]][];
  queued: GeneratedEntry[];
  rings: MidBar[];
  tape: TradePrint[];
  legs?: Book["legs"];
  working?: Book["working"];
  jevPackets: number;
  jevSkipped: number;
  gapFills: number;
  memberCloses?: Book["config"]["memberCloses"];
  btcCloses?: Book["config"]["btcCloses"];
  warmup?: [string, SourceDay[]][];
  gaps?: { startMs: number; endMs: number; cause: string }[];
  volHours?: VolHour[];
  dSubmitted?: number;
  dIndeterminate?: number;
  dailyCloses?: [string, DailyClose[]][];
  dailyBars?: [string, BarOHLC[]][];
  fourBars?: [string, BarOHLC[]][];
  feedCursor?: FeedCursor;
  jevMeter?: JevMeter;
  feedCut?: FeedCut | null;
  overflowByDay?: [string, number][];
  fourSeedSrc?: [string, "research" | "rest_1h"][];
  ema200?: [string, "seeded" | "live"][];
  fourSeedThrough?: [string, number][];
  overlapSeen?: boolean;
}

/** Persistence for the book and the last processed bar. The driver does not choose the store. */
export interface PaperStore {
  load(): PaperStateBody | null;
  save(body: PaperStateBody): void;
}

function hoursOfOneProduct(
  bars: readonly { startSec: number; close: number }[],
  gaps: readonly { startMs: number; endMs: number }[],
  productId?: string,
): VolHour[] {
  const byHour = new Map<number, number[]>();
  for (const bar of bars) {
    if (!(bar.close > 0)) continue;
    const hour = Math.floor(bar.startSec / 3600) * 3600 * 1000;
    const list = byHour.get(hour) ?? [];
    list.push(bar.close);
    byHour.set(hour, list);
  }
  const hours: VolHour[] = [];
  for (const [hour, closes] of [...byHour.entries()].sort((a, b) => a[0] - b[0])) {
    let sq = 0;
    let n = 0;
    for (let i = 1; i < closes.length; i += 1) {
      const prev = closes[i - 1]!;
      const next = closes[i]!;
      if (!(prev > 0) || !(next > 0)) continue;
      const ret = Math.log(next / prev);
      sq += ret * ret;
      n += 1;
    }
    const end = hour + 3_600_000;
    let gappedMs = 0;
    for (const gap of gaps) {
      const width = Math.min(end, gap.endMs) - Math.max(hour, gap.startMs);
      if (width > 0) gappedMs += width;
    }
    hours.push({ rv: n > 0 ? sq / n : 0, gappedMs, hourMs: 3_600_000, ...(productId ? { productId } : {}) });
  }
  return hours;
}

/** Hour buckets for the V6 vol-hour cap. Each product is its own series. rv is that product's mean squared 15m log return. */
export function volHoursFromFifteens(
  bars: readonly { startSec: number; close: number; productId?: string }[],
  gaps: readonly { startMs: number; endMs: number }[],
): VolHour[] {
  const groups = new Map<string, { startSec: number; close: number }[]>();
  for (const bar of bars) {
    const id = bar.productId ?? "";
    const list = groups.get(id) ?? [];
    list.push(bar);
    groups.set(id, list);
  }
  const hours: VolHour[] = [];
  for (const [productId, group] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    hours.push(...hoursOfOneProduct(group, gaps, productId || undefined));
  }
  return hours;
}

/** Point clusters at the daily-close series. Fifteen-minute bars are not an input. */
export function attachMemberCloses(host: PaperHost): void {
  seedDailyCloses(host);
  if (!host.context) return;
  const rows = [...host.dailyCloses.entries()].flatMap(([productId, days]) => {
    const flags = host.context?.byProduct.get(productId);
    if (!flags || days.length === 0) return [];
    return [{ productId, flags, days: days.map(closeSource) }];
  });
  if (rows.length > 0) host.book.config.memberCloses = rows;
  const btc = host.dailyCloses.get("BTC-USD") ?? [];
  if (btc.length > 0) host.book.config.btcCloses = btc.map((row) => ({ date: row.date, close: row.close }));
}

export function capturePaperState(host: PaperHost): PaperStateBody {
  const book = host.book;
  return {
    positions: book.positions,
    closed: book.closed,
    kelly: book.kelly,
    pairs: book.pairs,
    realizedUsd: book.realizedUsd,
    incidents: book.incidents,
    aPickConfig: book.aPick?.config ?? null,
    classes: book.classes,
    day: book.day,
    week: book.week,
    dayStartEquity: book.dayStartEquity,
    weekStartEquity: book.weekStartEquity,
    peakEquity: book.peakEquity,
    killSwitch: book.killSwitch,
    rejected: book.rejected,
    haltWeeks: book.haltWeeks,
    momentumDates: book.momentumDates,
    restCursor: [...host.restCursor.entries()],
    appliedThrough: [...host.appliedThrough.entries()],
    applied: [...host.applied],
    emitted: [...host.emitted],
    fifteen: host.fifteen,
    hourWarm: [...host.hourWarm.entries()],
    weeks: [...host.weeks.entries()],
    queued: [...host.queued.values()],
    rings: host.book.mids.completed,
    tape: host.trades,
    jevPackets: host.book.jevPackets,
    jevSkipped: host.book.jevSkipped,
    gapFills: host.book.gapFills,
    memberCloses: book.config.memberCloses,
    btcCloses: book.config.btcCloses,
    warmup: [...host.warmup.entries()],
    gaps: host.gaps,
    volHours: volHoursFromFifteens(host.fifteen, host.gaps),
    dSubmitted: book.submittedByClass.D,
    dIndeterminate: book.indeterminateByClass.D,
    dailyCloses: [...host.dailyCloses.entries()],
    dailyBars: [...host.dailyBars.entries()],
    fourBars: [...host.fourBars.entries()],
    feedCursor: { ...host.feedCursor },
    jevMeter: { ...host.jevMeter },
    feedCut: host.feedCut ? { ...host.feedCut, trade: host.feedCut.trade ? { ...host.feedCut.trade } : null } : null,
    overflowByDay: [...host.overflowByDay.entries()],
    fourSeedSrc: [...host.fourSeedSrc.entries()],
    ema200: [...host.ema200.entries()],
    fourSeedThrough: [...host.fourSeedThrough.entries()],
    overlapSeen: host.overlapSeen,
  };
}

export function installPaperState(host: PaperHost, body: Partial<PaperStateBody> & { aPickConfig?: string | null }): void {
  host.book.positions = body.positions ?? [];
  host.book.closed = body.closed ?? [];
  if (body.kelly) host.book.kelly = body.kelly;
  host.book.pairs = body.pairs ?? {};
  host.book.realizedUsd = body.realizedUsd ?? 0;
  host.book.incidents = body.incidents ?? host.book.incidents;
  if (body.aPickConfig && body.aPickConfig !== host.book.aPick?.config) {
    host.book.incidents.push(`saved A pick ${body.aPickConfig} ignored`);
  }
  if (body.classes) host.book.classes = body.classes;
  host.book.day = body.day ?? null;
  host.book.week = body.week ?? null;
  host.book.dayStartEquity = body.dayStartEquity ?? 0;
  host.book.weekStartEquity = body.weekStartEquity ?? 0;
  host.book.peakEquity = body.peakEquity ?? 0;
  host.book.killSwitch = body.killSwitch ?? false;
  host.book.rejected = body.rejected ?? [];
  host.book.haltWeeks = body.haltWeeks ?? [];
  host.book.momentumDates = body.momentumDates ?? [];
  host.restCursor = new Map(body.restCursor ?? []);
  host.appliedThrough = new Map(body.appliedThrough ?? []);
  host.applied = new Set(body.applied ?? []);
  host.emitted = new Set(body.emitted ?? []);
  if (body.fifteen) host.fifteen = body.fifteen;
  if (body.hourWarm) host.hourWarm = new Map(body.hourWarm);
  if (body.weeks) host.weeks = new Map(body.weeks);
  if (body.queued) host.queued = new Map(body.queued.map((entry) => [entryId(entry), entry]));
  if (body.rings) host.book.mids.completed = body.rings;
  if (body.tape) host.trades = body.tape;
  if (body.legs) {
    host.book.legs = body.legs;
    host.fillStored = body.legs.length;
  }
  if (body.working) host.book.working = body.working;
  if (body.closed) host.ledgerStored = body.closed.length;
  if (body.jevPackets != null) host.book.jevPackets = body.jevPackets;
  if (body.jevSkipped != null) host.book.jevSkipped = body.jevSkipped;
  if (body.gapFills != null) host.book.gapFills = body.gapFills;
  if (body.memberCloses) {
    host.book.config.memberCloses = body.memberCloses.map((row) => ({ ...row, days: [...row.days] }));
  }
  if (body.btcCloses) host.book.config.btcCloses = [...body.btcCloses];
  if (body.warmup) {
    host.warmup = new Map(body.warmup.map(([id, days]) => [id, [...days]]));
    host.warmupStored = true;
  }
  if (body.dailyCloses) host.dailyCloses = new Map(body.dailyCloses.map(([id, rows]) => [id, rows.map((row) => ({ ...row }))]));
  if (body.dailyBars) host.dailyBars = new Map(body.dailyBars.map(([id, rows]) => [id, rows.map((row) => ({ ...row }))]));
  if (body.fourBars) host.fourBars = new Map(body.fourBars.map(([id, rows]) => [id, rows.map((row) => ({ ...row }))]));
  if (body.feedCursor) host.feedCursor = { l2: body.feedCursor.l2 ?? null, tradeId: body.feedCursor.tradeId ?? null };
  if (body.jevMeter) host.jevMeter = { ...body.jevMeter };
  if (body.gaps) host.gaps = body.gaps.map((gap) => ({ ...gap }));
  if (body.dSubmitted != null) host.book.submittedByClass.D = body.dSubmitted;
  if (body.dIndeterminate != null) host.book.indeterminateByClass.D = body.dIndeterminate;
  if (body.feedCut !== undefined) host.feedCut = body.feedCut ? { ...body.feedCut, trade: body.feedCut.trade ? { ...body.feedCut.trade } : null } : null;
  if (body.overflowByDay) host.overflowByDay = new Map(body.overflowByDay);
  if (body.fourSeedSrc) host.fourSeedSrc = new Map(body.fourSeedSrc);
  if (body.ema200) host.ema200 = new Map(body.ema200);
  if (body.fourSeedThrough) host.fourSeedThrough = new Map(body.fourSeedThrough);
  if (body.overlapSeen != null) host.overlapSeen = body.overlapSeen;
  if (body.appliedThrough) {
    for (const productId of host.products) {
      const resumed = resumeRestCursor(host.restCursor.get(productId), host.appliedThrough.get(productId));
      if (resumed == null) host.restCursor.delete(productId);
      else host.restCursor.set(productId, resumed);
    }
  }
}

/** File-backed book store under data/runtime. */
export function filePaperStore(dir: string): PaperStore {
  assertRuntimeDir(dir);
  const path = join(dir, "state.json");
  return {
    load() {
      if (!existsSync(path)) return null;
      return JSON.parse(readFileSync(path, "utf8")) as PaperStateBody;
    },
    save(body) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(body));
    },
  };
}

export function savePaperState(dir: string, host: PaperHost, store: PaperStore = filePaperStore(dir)): void {
  store.save(capturePaperState(host));
}

export function loadPaperState(dir: string, host: PaperHost, store: PaperStore = filePaperStore(dir)): boolean {
  const body = store.load();
  if (!body) return false;
  installPaperState(host, body);
  return true;
}

/** REST catch-up from the daily-store end. A missing candle stays a hole; the day is marked empty. No trades fallback. */
export async function catchUpHistory(
  host: PaperHost,
  fetchImpl?: (url: string) => Promise<Pick<Response, "status" | "ok" | "json">>,
): Promise<void> {
  const get = fetchImpl ?? hostGet(host);
  const nowSec = Math.floor(host.clock() / 1000);
  const newest = Math.floor(nowSec / 900) * 900 - 900;
  for (const productId of host.products) {
    const origin = host.historyFrom.get(productId);
    const cursor = host.restCursor.get(productId) ?? origin;
    if (cursor == null || cursor > newest) continue;
    for (const span of planHistorySpans(cursor, newest)) {
      try {
        const response = await get(fifteenMinuteUrl(productId, span.startSec, span.endSec));
        if (budgetHit(response)) break;
        if (response.status === 429 || !response.ok) {
          host.book.incidents.push(`history rest ${productId} ${span.startSec} ${statusNote(response)}`);
          markCold(productId, host.restRun, response.status === 429 ? "retries" : `http-${response.status}`);
          break;
        }
        const rows = (await response.json()) as number[][];
        const bars = barsFromExchangeCandles(productId, Array.isArray(rows) ? rows : []);
        const got = new Set(bars.map((bar) => bar.startSec));
        for (const bar of bars) {
          if (!alreadyApplied(host, bar.productId, bar.startSec)) acceptRestBar(host, bar);
        }
        let missing = 0;
        for (let start = span.startSec; start <= span.endSec; start += 900) if (!got.has(start)) missing += 1;
        if (missing > 0) host.book.incidents.push(`history missing ${productId} ${span.startSec} bars ${missing}`);
        host.restCursor.set(productId, span.endSec + 900);
      } catch (error) {
        host.book.incidents.push(`history rest ${productId} ${span.startSec} ${error instanceof Error ? error.message : "failed"}`);
        markCold(productId, host.restRun, "retries");
        break;
      }
    }
  }
}

export async function fetchRestBar(productId: string, startSec: number, run?: RestRun): Promise<RestRead> {
  try {
    const response = await coinbaseGet(fifteenMinuteUrl(productId, startSec, startSec), run, { live: true });
    if (budgetStopLabel(response.headers)) return { bar: null, status: 429, retryAfterMs: 0, budgetStop: true };
    if (response.status === 429) return { bar: null, status: 429, retryAfterMs: retryAfterMs(response.headers.get("retry-after")) };
    if (!response.ok) return { bar: null, status: response.status, retryAfterMs: 0 };
    const rows = (await response.json()) as number[][];
    if (!Array.isArray(rows)) return { bar: null, status: response.status, retryAfterMs: 0 };
    return { bar: barFromExchangeCandles(productId, startSec, rows), status: response.status, retryAfterMs: 0 };
  } catch {
    return { bar: null, status: 0, retryAfterMs: 0 };
  }
}

function envelopeSequence(raw: unknown): number | null {
  if (raw == null || typeof raw !== "object") return null;
  const value = (raw as { sequence_num?: unknown }).sequence_num;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function noteBufferSequence(host: PaperHost, shardIndex: number, sequence: number): void {
  const key = `buf:${shardIndex}`;
  const last = host.lastL2Seq.get(key) ?? null;
  if (!l2SequenceOk(last, sequence)) host.socketHole = true;
  host.lastL2Seq.set(key, sequence);
}

function noteOverflow(host: PaperHost, shardIndex: number, nowMs: number): void {
  if (host.feedBufferCapped) return;
  host.feedBufferCapped = true;
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const count = (host.overflowByDay.get(day) ?? 0) + 1;
  host.overflowByDay.set(day, count);
  host.book.incidents.push(`buffer overflow ${day} ${count}`);
  for (const productId of host.shards[shardIndex] ?? []) {
    host.gaps.push({ startMs: nowMs, endMs: nowMs, cause: `uncovered ${productId}` });
  }
}

/** One socket frame. The envelope sequence covers every channel, then the book updates. */
export function ingestSocketMessage(host: PaperHost, shardIndex: number, raw: unknown, nowMs: number): void {
  if (host.bufferFeeds) {
    if (host.socketOpenedMs == null) host.socketOpenedMs = nowMs;
    const frame = { sequence: envelopeSequence(raw), events: parsePublicMessage(raw) };
    const nextBytes = Buffer.byteLength(JSON.stringify(frame));
    if (host.feedBuffer.length >= FEED_BUFFER_MAX || nextBytes > FEED_BUFFER_MAX_BYTES) {
      noteOverflow(host, shardIndex, nowMs);
      return;
    }
    if (frame.sequence != null) noteBufferSequence(host, shardIndex, frame.sequence);
    host.feedBuffer.push(frame);
    return;
  }
  const sequence = envelopeSequence(raw);
  if (sequence != null) noteSequence(host, shardIndex, sequence, false);
  applyPublic(host, shardIndex, parsePublicMessage(raw), nowMs);
}

/**
 * V6.1. The buffer continues the saved cursor with no hole, and every trade has
 * an exchange timestamp. Otherwise the handover is uncovered and nothing is applied.
 */
export function feedFramesContiguous(cursor: FeedCursor, frames: readonly FeedFrame[]): boolean {
  if (cursor.l2 == null) return false;
  if (frames.length === 0) return true;
  if (frames.some((frame) => frame.sequence == null)) return false;
  const ordered = frames.slice().sort((a, b) => a.sequence! - b.sequence!);
  let prev = cursor.l2;
  for (const frame of ordered) {
    const sequence = frame.sequence!;
    if (sequence !== prev && sequence !== prev + 1) return false;
    prev = sequence;
  }
  let tradePrev = cursor.tradeId;
  for (const frame of ordered) {
    for (const event of frame.events) {
      if (event.kind !== "trade") continue;
      const id = event.tradeId != null ? Number(event.tradeId) : Number.NaN;
      const ts = event.time ? Date.parse(event.time) : Number.NaN;
      if (!Number.isInteger(id) || !Number.isFinite(ts)) return false;
      if (tradePrev == null || id !== tradePrev + 1) return false;
      tradePrev = id;
    }
  }
  return true;
}

function sameCut(cut: FeedCutTrade, event: { productId: string; tradeId?: string; time?: string; price: number; size: number }): boolean {
  if (cut.productId !== event.productId) return false;
  if (cut.tradeId && event.tradeId) return cut.tradeId === event.tradeId;
  return cut.time === (event.time ?? null) && cut.price === event.price && cut.size === event.size;
}

/**
 * Resume on the incoming stream at the first event after the outgoing writer's last trade.
 * The cut is an exchange trade id, or exchange time plus price plus size. Sequence numbers are not compared.
 * Zero matches or more than one match leaves the handover uncovered and applies nothing.
 */
export function replayHandover(host: PaperHost): boolean {
  const capped = host.feedBufferCapped;
  const hole = host.socketHole;
  const frames = host.feedBuffer.splice(0, host.feedBuffer.length);
  host.bufferFeeds = false;
  host.feedBufferCapped = false;
  const cut = host.feedCut;
  if (capped || hole || cut?.wallMs == null || !cut.trade) return false;
  if (host.socketOpenedMs == null || host.socketOpenedMs > cut.wallMs - 60_000) return false;
  const flat: PublicEvent[] = [];
  for (const frame of frames) flat.push(...frame.events);
  const matches: number[] = [];
  for (let index = 0; index < flat.length; index += 1) {
    const event = flat[index]!;
    if (event.kind !== "trade") continue;
    const exchangeMs = event.time ? Date.parse(event.time) : Number.NaN;
    if (Number.isFinite(exchangeMs) && exchangeMs < cut.atMs) host.overlapSeen = true;
    if (sameCut(cut.trade, event)) matches.push(index);
  }
  if (matches.length !== 1) return false;
  const cutAt = matches[0]!;
  for (let index = cutAt + 1; index < flat.length; index += 1) {
    applyPublic(host, 0, [flat[index]!], host.clock(), { handoverMicro: true });
  }
  return true;
}

/** The function deadline is closing the socket. That close is not a reconnect and not a gap. */
export function releaseForDeadline(host: PaperHost): void {
  if (host.runOutcome === "running" || host.runOutcome === "") host.runOutcome = "handover";
  host.deadlineRelease = true;
  host.replacing = host.replacing.map(() => true);
}

/** A close from the socket we just replaced clears the flag and does not reconnect. */
export function noteSocketClose(host: PaperHost, shardIndex: number, gen: number): void {
  if (host.socketGen[shardIndex] !== gen) {
    host.replacing[shardIndex] = false;
    return;
  }
  onSocketClosed(host, shardIndex);
}

function openShard(host: PaperHost, shardIndex: number, url: string): WebSocket {
  host.socketGen[shardIndex] = (host.socketGen[shardIndex] ?? 0) + 1;
  const gen = host.socketGen[shardIndex]!;
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => {
    if (host.socketGen[shardIndex] !== gen) return;
    if (host.bufferFeeds && host.socketOpenedMs != null) host.socketHole = true;
    host.lastL2Seq.delete(String(shardIndex));
    armShard(host, shardIndex, Date.now());
    for (const frame of framesForShard(host, shardIndex)) ws.send(frame);
  });
  ws.addEventListener("message", (event) => {
    if (host.socketGen[shardIndex] !== gen) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return;
    }
    ingestSocketMessage(host, shardIndex, parsed, Date.now());
  });
  ws.addEventListener("close", () => {
    noteSocketClose(host, shardIndex, gen);
  });
  ws.addEventListener("error", () => {
    if (host.socketGen[shardIndex] !== gen) return;
    onSocketError(host, shardIndex);
  });
  return ws;
}

function replaceShard(host: PaperHost, sockets: WebSocket[], index: number, url: string): void {
  const dead = sockets[index];
  host.replacing[index] = true;
  if (dead) dead.close();
  sockets[index] = openShard(host, index, url);
}

/**
 * Connects the public sockets and stays up. Status, the book panel, and the
 * saved book are files. Pass forMs to stop after a bounded public run.
 */
export async function runPublicPaper(opts: {
  products: readonly string[];
  statusDir: string;
  env?: Record<string, string | undefined>;
  listen?: string | null;
  port?: number;
  forMs?: number;
  /** Wall-clock deadline. The socket close at this time is a handover, not a gap. */
  untilMs?: number;
  logPath?: string;
}): Promise<void> {
  if (opts.listen) throw new Error("monitoring is files under data/runtime");
  const host = startPaperHost(opts.products, opts.env ?? process.env);
  if (existsSync(join(opts.statusDir, "state.json"))) loadPaperState(opts.statusDir, host);
  host.shards.forEach((_, index) => armShard(host, index, Date.now()));
  const line = (event: string) => {
    if (!opts.logPath) return;
    appendFileSync(opts.logPath, `${JSON.stringify({ t: new Date().toISOString(), event, ...hostStatus(host) })}\n`);
  };
  line("start");
  await catchUpHistory(host);
  const publish = () => {
    writeHostFiles(opts.statusDir, host);
    savePaperState(opts.statusDir, host);
  };
  publish();
  const sockets = host.shards.map((_, index) => openShard(host, index, PUBLIC_WS_URL));
  let lastLog = Date.now();
  let lastPublish = 0;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const socket of sockets) socket.close();
    line("stop");
    publish();
    resolve();
  };
  const timer = setInterval(() => {
    const now = Date.now();
    flushEntries(host, now);
    host.shards.forEach((_, index) => {
      if (!considerHeartbeatGap(host, index, now)) return;
      replaceShard(host, sockets, index, PUBLIC_WS_URL);
    });
    const due = nextRest(host, now);
    if (due?.action === "fetch") {
      due.slot.inflight = true;
      host.nextRestMs = now + REST_PACE_MS;
      void fetchRestBar(due.slot.productId, due.slot.barStartSec, host.restRun)
        .then((result) => {
          if (result.budgetStop) {
            due.slot.inflight = false;
            due.slot.notBeforeMs = Math.max(due.slot.notBeforeMs, host.deadlineMs || Date.now() + 60_000);
            host.book.incidents.push(`rest 15m ${due.slot.productId} budget-stop`);
            return;
          }
          if (result.status === 429) {
            noteRest429(due.slot, Date.now(), result.retryAfterMs);
            return;
          }
          noteRestMiss(host, due.slot);
          if (result.bar) acceptRestBar(host, result.bar);
        })
        .catch((error: unknown) => {
          due.slot.inflight = false;
          noteRestMiss(host, due.slot);
          host.book.incidents.push(`rest ${due.slot.productId} ${due.slot.barStartSec} ${error instanceof Error ? error.message : "failed"}`);
        });
    } else if (due?.action === "fallback") {
      fallbackTradesBar(host, due.slot);
    }
    if (opts.logPath && now - lastLog >= 60_000) {
      lastLog = now;
      line("tick");
    }
    if (now - lastPublish >= 1_000) {
      lastPublish = now;
      publish();
    }
  }, REST_PACE_MS);
  if (opts.untilMs != null) {
    const wait = opts.untilMs - Date.now();
    setTimeout(() => {
      releaseForDeadline(host);
      stop();
    }, Math.max(0, wait));
  }
  if (opts.forMs != null && opts.forMs > 0) setTimeout(stop, opts.forMs);
  let resolve: () => void = () => {};
  await new Promise<void>((done) => {
    resolve = done;
    process.on("SIGINT", stop);
  });
}

export interface DriveHooks {
  /** Writes the book, member closes, gaps, and new bars. Called when the run ends and after each applied bar. */
  persist?: () => Promise<void> | void;
  onBar?: (bar: OhlcvBar) => Promise<void> | void;
  /** Lease save clock. The holder passes this. An overlap watch does not. */
  heartbeat?: () => Promise<void> | void;
  /** False while the next instance is overlapping and does not yet hold the lease. */
  applyBars?: boolean;
  /** Overlap ends when this returns true, leaving the sockets up for the lease holder. */
  stopWhen?: () => Promise<boolean> | boolean;
}

function kvIncident(error: unknown): string {
  const message = error instanceof Error ? error.message : "failed";
  return message.startsWith("kv set") || message.includes("lease lost") ? message : `kv set ${message}`;
}

/** Sample on an existing host until `untilMs`, then close the sockets as a deadline handover. */
export async function driveHost(host: PaperHost, untilMs: number, hooks: DriveHooks = {}): Promise<void> {
  const apply = hooks.applyBars !== false;
  if (host.clock() >= untilMs) {
    if (apply) await hooks.persist?.();
    return;
  }
  const sockets = host.openSockets ?? host.shards.map((_, index) => openShard(host, index, PUBLIC_WS_URL));
  host.openSockets = sockets;
  await new Promise<void>((resolve) => {
    let busy = false;
    let lastBeat = host.clock();
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        try {
          const now = host.clock();
          if (host.stopped) {
            clearInterval(timer);
            resolve();
            return;
          }
          if (hooks.heartbeat && now - lastBeat >= SAVE_HEARTBEAT_MS) {
            lastBeat = now;
            await host.durableChain;
            await hooks.heartbeat();
          }
          if (host.stopped) {
            clearInterval(timer);
            for (const socket of sockets) socket.close();
            host.openSockets = undefined;
            resolve();
            return;
          }
          const held = !host.kv || host.leaseToken != null;
          if (apply && held) await sendDueEntries(host, now);
          host.shards.forEach((_, index) => {
            if (!considerHeartbeatGap(host, index, now)) return;
            replaceShard(host, sockets, index, PUBLIC_WS_URL);
          });
          if (apply && held) {
            const due = nextRest(host, now);
            if (due?.action === "fetch") {
              due.slot.inflight = true;
              host.nextRestMs = now + REST_PACE_MS;
              void fetchRestBar(due.slot.productId, due.slot.barStartSec, host.restRun)
                .then(async (result) => {
                  if (result.budgetStop) {
                    due.slot.inflight = false;
                    due.slot.notBeforeMs = Math.max(due.slot.notBeforeMs, host.deadlineMs || Date.now() + 60_000);
                    host.book.incidents.push(`rest 15m ${due.slot.productId} budget-stop`);
                    return;
                  }
                  if (result.status === 429) {
                    noteRest429(due.slot, Date.now(), result.retryAfterMs);
                    return;
                  }
                  noteRestMiss(host, due.slot);
                  if (result.bar) await prepareExitQuotes(host, result.bar.productId, result.bar.startSec, Date.now());
                  if (result.bar && acceptRestBar(host, result.bar) === "accepted") {
                    await hooks.onBar?.(result.bar);
                  }
                })
        .catch((error: unknown) => {
          due.slot.inflight = false;
          noteRestMiss(host, due.slot);
          host.book.incidents.push(kvIncident(error));
        });
            } else if (due?.action === "fallback") {
              await prepareExitQuotes(host, due.slot.productId, due.slot.barStartSec, now);
              const built = fallbackTradesBar(host, due.slot);
              if (built) await hooks.onBar?.(built);
            }
          }
          const stop = hooks.stopWhen ? await hooks.stopWhen() : false;
          if (now < untilMs && !stop) return;
          clearInterval(timer);
          if (!apply) {
            resolve();
            return;
          }
          releaseForDeadline(host);
          for (const socket of sockets) socket.close();
          host.openSockets = undefined;
          try {
            await host.durableChain;
            await hooks.persist?.();
          } catch (error) {
            host.book.incidents.push(kvIncident(error));
          }
          resolve();
        } catch (error) {
          host.book.incidents.push(kvIncident(error));
        } finally {
          busy = false;
        }
      })();
    }, REST_PACE_MS);
  });
}

/** Daily and 1h history from public REST, stored on the host. There is no local candle store on Vercel. */
const HISTORY_GAP_SEC = 7 * 86_400;

function noteCold(host: PaperHost, productId: string, reason = "cold"): void {
  host.cold.add(productId);
  if (!host.restRun.cold.has(productId)) host.restRun.cold.set(productId, reason);
  const prev = host.seedMarks.get(productId);
  host.seedMarks.set(productId, {
    oldestTs: prev?.oldestTs ?? 0,
    newestTs: prev?.newestTs ?? 0,
    status: "cold",
    reason: host.restRun.cold.get(productId) ?? reason,
  });
}

function hostGet(host: PaperHost, seed = false): (url: string) => Promise<Response> {
  return (url) => coinbaseGet(url, host.restRun, seed ? { seed: true } : undefined);
}

/** Tape and 1m backfill. A miss does not mark the product cold. */
function backfillGet(host: PaperHost): (url: string) => Promise<Response> {
  return (url) => coinbaseGet(url, host.restRun, { cold: false, backfill: true });
}

function latestTs(rows: readonly { ts: number }[]): number {
  return rows.reduce((max, row) => Math.max(max, row.ts), -1);
}

export async function warmSeriesFromRest(host: PaperHost, fetchImpl?: SeedFetch): Promise<void> {
  await seedBudgeted(host, fetchImpl);
  if (host.context) {
    const memberCloses = [...host.warmup.entries()].flatMap(([productId, days]) => {
      const flags = host.context?.byProduct.get(productId);
      return flags && days.length > 0 ? [{ productId, flags, days }] : [];
    });
    if (memberCloses.length > 0) {
      host.book.config.memberCloses = memberCloses;
      host.book.config.btcCloses = (host.warmup.get("BTC-USD") ?? [])
        .filter((row) => !row.empty && row.close > 0)
        .map((row) => ({ date: row.date, close: row.close }));
    }
  }
}

function liquidOrder(products: readonly string[]): string[] {
  const path = dataFile("reports", "product-stats.json");
  const quote = new Map<string, number>();
  if (path && existsSync(path)) {
    const body = JSON.parse(readFileSync(path, "utf8")) as { products?: { productId?: string; stats?: { volume?: string; last?: string } | null }[] };
    for (const row of body.products ?? []) {
      if (!row.productId) continue;
      quote.set(row.productId, Number(row.stats?.volume ?? 0) * Number(row.stats?.last ?? 0));
    }
  }
  return products.slice().sort((a, b) => (quote.get(b) ?? -1) - (quote.get(a) ?? -1) || (a < b ? -1 : 1));
}

/**
 * Liquid names first. Whole products only. Stop when the remaining seed budget cannot
 * hold another product, and resume from the cursor on the next run.
 */
export async function seedBudgeted(host: PaperHost, fetchImpl?: SeedFetch): Promise<void> {
  if (host.seedCursor.order.length === 0) {
    host.seedCursor.order = liquidOrder(host.products);
    host.seedCursor.runId = host.seedCursor.runId || `seed-${host.clock()}`;
  }
  const order = host.seedCursor.order;
  for (let index = 0; index < host.seedCursor.idx && index < order.length; index += 1) {
    const prior = order[index]!;
    if (storedSeriesWarm(host, prior)) await seedHourDelta(host, prior, fetchImpl);
  }
  let added = 0;
  while (host.seedCursor.idx < order.length) {
    if (added >= SEED_PRODUCTS_PER_RUN) break;
    if (host.restRun.seedBudget - host.restRun.seedUsed < SEED_REQUESTS_PER_PRODUCT) break;
    const productId = order[host.seedCursor.idx]!;
    const mark = host.seedMarks.get(productId);
    if (mark?.status === "cold" && mark.reason !== "retries" && mark.reason !== "cap") {
      host.seedCursor.idx += 1;
      continue;
    }
    if (storedSeriesWarm(host, productId)) {
      await seedHourDelta(host, productId, fetchImpl);
      host.seedCursor.idx += 1;
      continue;
    }
    const before = host.restRun.seedUsed;
    const dailyStop = await seedDailyProduct(host, productId, fetchImpl);
    if (dailyStop === "budget") {
      host.restRun.seedUsed = before;
      break;
    }
    const stop = await pageHourSeed(host, productId, fetchImpl, true);
    if (stop.reason === "budget") {
      host.restRun.seedUsed = before;
      break;
    }
    host.seedCursor.idx += 1;
    added += 1;
  }
}

/** Full daily history. Stop at the listing, an empty page, or a gap. A warm series fetches only the delta. */
async function seedDailyProduct(host: PaperHost, productId: string, fetchImpl?: SeedFetch): Promise<"ok" | "budget" | "cold"> {
  const nowSec = Math.floor(host.clock() / 1000);
  const existing = host.warmup.get(productId) ?? [];
  const last = latestTs(existing);
  const gap = last >= 0 && nowSec - last > HISTORY_GAP_SEC;
  if (gap) noteCold(host, productId, "gap");
  if (last >= 0 && !gap && last + DAY_SEC > nowSec) return "ok";
  const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const days: SourceDay[] = [];
  let end = nowSec;
  let previousOldest = Number.POSITIVE_INFINITY;
  const delta = last >= 0 && !gap;
  for (let page = 0; page < (delta ? 1 : 40); page += 1) {
    const start = delta ? last + DAY_SEC : Math.max(0, end - 299 * DAY_SEC);
    if (start > end) break;
    const response = await seedCall(host, historyCandleUrl(productId, start, end, DAY_SEC), fetchImpl);
    if (budgetHit(response)) return "budget";
    if (!response.ok) {
      host.book.incidents.push(`history daily ${productId} ${statusNote(response)}`);
      noteCold(host, productId, response.status >= 400 && response.status < 500 ? `http-${response.status}` : "daily");
      return "cold";
    }
    const rows = (await response.json()) as number[][];
    const bars = barsFromExchangeCandles(productId, Array.isArray(rows) ? rows : []);
    if (bars.length === 0) break;
    const oldest = bars[0]!.startSec;
    if (oldest >= previousOldest) break;
    previousOldest = oldest;
    let hole = false;
    for (let index = 1; index < bars.length; index += 1) {
      if (bars[index]!.startSec - bars[index - 1]!.startSec > DAY_SEC) hole = true;
    }
    for (const bar of bars) {
      const date = new Date(bar.startSec * 1000).toISOString().slice(0, 10);
      if (date >= today) continue;
      days.push({ date, ts: bar.startSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, empty: false });
    }
    if (delta || hole || bars.length < 300) break;
    end = oldest - DAY_SEC;
  }
  const series = withExplicitGaps([...existing.filter((day) => gap || day.ts < (delta ? last + DAY_SEC : 0)), ...days]);
  if (series.length > 0) {
    host.warmup.set(productId, series);
    if (existing.length === 0) host.warmupStored = false;
    const origin = historyOriginSec(series);
    if (origin != null) host.historyFrom.set(productId, origin);
  }
  return "ok";
}

/** A warm product fetches only the hours after its watermark. */
async function seedHourDelta(host: PaperHost, productId: string, fetchImpl?: SeedFetch): Promise<void> {
  const mark = host.seedMarks.get(productId);
  if (!mark || !(mark.newestTs > 0)) return;
  const nowSec = Math.floor(host.clock() / 1000);
  const start = mark.newestTs + HOUR_SEC;
  if (start > nowSec) return;
  const url = historyCandleUrl(productId, start, nowSec, HOUR_SEC);
  const response = fetchImpl ? await fetchImpl(url) : await coinbaseGet(url, host.restRun);
  if (budgetHit(response) || !response.ok) return;
  const rows = (await response.json()) as number[][];
  const got = barsFromExchangeCandles(productId, Array.isArray(rows) ? rows : []).map((bar) => ({
    ts: bar.startSec,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
  if (got.length === 0) return;
  const merged = mergeRolled(host.hourWarm.get(productId) ?? [], got, HOUR_KEEP);
  host.hourWarm.set(productId, merged);
  const folded = contiguousTail(foldHours(merged, FOUR_STEP_SEC, HOUR_SEC), FOUR_STEP_SEC);
  if (folded.length > 0) host.fourBars.set(productId, mergeRolled(host.fourBars.get(productId) ?? [], folded, FOUR_KEEP));
  const newest = merged[merged.length - 1]?.ts ?? mark.newestTs;
  host.seedMarks.set(productId, { ...mark, newestTs: newest });
}

/** Warm, or a stored contiguous tail of FOUR_KEEP bars. Either one skips a full re-fetch. */
function storedSeriesWarm(host: PaperHost, productId: string): boolean {
  const mark = host.seedMarks.get(productId);
  if (mark?.status === "cold") return false;
  const bars = host.fourBars.get(productId) ?? [];
  if (fourSeriesReady(bars) && mark?.status !== "warm") {
    const tail = contiguousTail(bars, FOUR_STEP_SEC);
    host.seedMarks.set(productId, {
      oldestTs: mark?.oldestTs || tail[0]?.ts || 0,
      newestTs: mark?.newestTs || tail[tail.length - 1]?.ts || 0,
      status: "warm",
      reason: "seeded",
    });
    host.fourFlushed.add(productId);
  }
  return mark?.status === "warm" || fourSeriesReady(bars);
}

/** Bars walking backward from the newest, each exactly `stepSec` after the previous. A hole ends the tail. */
export function contiguousTail<T extends { ts: number }>(bars: readonly T[], stepSec: number): T[] {
  if (bars.length === 0) return [];
  const ordered = bars.slice().sort((a, b) => a.ts - b.ts);
  const tail: T[] = [ordered[ordered.length - 1]!];
  for (let index = ordered.length - 2; index >= 0; index -= 1) {
    const prev = ordered[index]!;
    if (tail[0]!.ts - prev.ts !== stepSec) break;
    tail.unshift(prev);
  }
  return tail;
}

const FOUR_STEP_SEC = 14_400;

/** The contiguous 4h tail is long enough to trade. A hole keeps the series short. */
export function fourSeriesReady(bars: readonly { ts: number }[]): boolean {
  return contiguousTail(bars, FOUR_STEP_SEC).length >= FOUR_KEEP;
}
const HOUR_SEC = 3_600;
const DAY_SEC = 86_400;
const REST_HOUR_PAGE = 300 * HOUR_SEC;
const HOUR_PAGE_CAP = hourPagesForKeep();
/** One daily page plus the hour pages that fill FOUR_KEEP. A product is never split across runs. */
export const SEED_REQUESTS_PER_PRODUCT = 1 + HOUR_PAGE_CAP;
/** New products started in one run. 13, then 13, then 13, then the rest finishes the 50 in four runs. */
export const SEED_PRODUCTS_PER_RUN = 13;

export const SEED_CURSOR_KEY = "p6:seed:cursor";
export function seedMarkKey(productId: string): string {
  return `p6:seed:wm:${productId}`;
}

type SeedFetch = (url: string) => Promise<Pick<Response, "status" | "ok" | "json"> & { headers?: { get(name: string): string | null } }>;

function budgetHit(response: { status?: number; headers?: { get(name: string): string | null } }): boolean {
  const kind = response.headers?.get("x-p6-budget");
  return kind === "seed" || kind === "reserve" || kind === "hard";
}

async function countedSeedFetch(host: PaperHost, url: string, fetchImpl: SeedFetch): Promise<Awaited<ReturnType<SeedFetch>>> {
  if (host.restRun.seedUsed >= host.restRun.seedBudget) {
    return new Response("", { status: 429, headers: { "x-p6-budget": "seed" } });
  }
  const response = await fetchImpl(url);
  if (!budgetHit(response)) host.restRun.seedUsed += 1;
  return response;
}

function sameOhlcv(left: BarOHLC, right: BarOHLC): boolean {
  return left.open === right.open && left.high === right.high && left.low === right.low && left.close === right.close && left.volume === right.volume;
}

/** Log a 1h fold that does not match the 15m fold on an overlapping timestamp. */
export function logFoldMismatches(host: PaperHost, productId: string, folded: readonly BarOHLC[], fromFifteen: readonly BarOHLC[]): void {
  for (const bar of folded) {
    const other = fromFifteen.find((row) => row.ts === bar.ts);
    if (other && !sameOhlcv(other, bar)) host.book.incidents.push(`4h fold mismatch ${productId} ${bar.ts}`);
  }
}

function rememberFourSeed(host: PaperHost, productId: string, bars: readonly BarOHLC[], src: "research" | "rest_1h"): void {
  const kept = bars.slice(-FOUR_KEEP);
  if (kept.length > 0) host.fourBars.set(productId, kept);
  host.fourSeedSrc.set(productId, src);
  host.ema200.set(productId, "seeded");
  const newest = kept[kept.length - 1];
  if (newest) host.fourSeedThrough.set(productId, newest.ts);
}

/**
 * After a takeover, rebuild the tape and the 1m ring from the hole start through now.
 * /trades first. Minutes still missing come from public 1m candles.
 * A miss is an incident. It does not mark the product cold.
 * Orders the backfill cannot decide stay indeterminate.
 */
function persistedMinute(host: PaperHost): number | null {
  let max = -1;
  for (const mid of host.book.mids.completed) {
    const sec = Math.floor(mid.ts / 1000);
    if (sec > max) max = sec;
  }
  for (const at of host.tapeWritten) if (at > max) max = at;
  return max >= 0 ? max : null;
}

export async function backfillTapeIfNeeded(
  host: PaperHost,
  fetchImpl?: (url: string) => Promise<Pick<Response, "status" | "ok" | "json">>,
): Promise<void> {
  const get = fetchImpl ?? backfillGet(host);
  const nowSec = Math.floor(host.clock() / 1000);
  const persisted = persistedMinute(host);
  const fromPersisted = persisted == null ? null : persisted + 60;
  let from = host.tapeHoleFromSec ?? fromPersisted;
  if (from != null && fromPersisted != null) from = Math.min(from, fromPersisted);
  const until = host.wsTape && host.socketOpenedMs != null ? Math.floor(host.socketOpenedMs / 1000) : nowSec;
  if (from == null || from >= until) {
    if (host.tapeHole) markOrdersBeforeTape(host);
    host.tapeHole = false;
    return;
  }
  const candleGaps: { productId: string; missing: number[]; covered: Set<number> }[] = [];
  for (const productId of host.products) {
    try {
      const response = await get(productTradesUrl(productId));
      if (response.ok) {
        const rows = (await response.json()) as { time?: string; price?: string; size?: string; side?: string }[];
        if (Array.isArray(rows)) {
          for (const row of rows) {
            const tsSec = Math.floor(Date.parse(row.time ?? "") / 1000);
            const price = Number(row.price);
            const size = Number(row.size);
            if (!Number.isFinite(tsSec) || tsSec < from || tsSec >= until || !(price > 0) || !(size > 0)) continue;
            host.trades.push({ productId, tsSec, price, size, ...(row.side ? { side: row.side } : {}) });
          }
        }
      } else {
        host.book.incidents.push(`tape backfill ${productId} ${statusNote(response)}`);
      }
    } catch (error) {
      host.book.incidents.push(`tape backfill ${productId} ${error instanceof Error ? error.message : "failed"}`);
    }
    const fromMinute = Math.floor(from / 60) * 60;
    const buckets = new Map<number, { tsSec: number; price: number; size: number }[]>();
    for (const trade of host.trades) {
      if (trade.productId !== productId || trade.tsSec < from || trade.tsSec >= until) continue;
      const minute = Math.floor(trade.tsSec / 60) * 60;
      if (minute < fromMinute || minute >= until) continue;
      const bucket = buckets.get(minute);
      if (bucket) bucket.push(trade);
      else buckets.set(minute, [trade]);
    }
    for (const [minute, bucket] of buckets) {
      if (host.book.mids.completed.some((mid) => mid.productId === productId && mid.ts === minute * 1000)) continue;
      const ordered = bucket.slice().sort((a, b) => a.tsSec - b.tsSec);
      let high = ordered[0]!.price;
      let low = high;
      let volume = 0;
      for (const trade of ordered) {
        if (trade.price > high) high = trade.price;
        if (trade.price < low) low = trade.price;
        volume += trade.size;
      }
      host.book.mids.completed.push({
        productId,
        ts: minute * 1000,
        open: ordered[0]!.price,
        high,
        low,
        close: ordered[ordered.length - 1]!.price,
        volumeBase: volume,
      });
    }
    const covered = new Set(buckets.keys());
    const missing: number[] = [];
    for (let minute = Math.floor(from / 60) * 60; minute < until; minute += 60) {
      if (!covered.has(minute)) missing.push(minute);
    }
    if (missing.length > 0) candleGaps.push({ productId, missing, covered });
  }
  for (const gap of candleGaps) {
    try {
      const start = gap.missing[0]!;
      const end = gap.missing[gap.missing.length - 1]! + 59;
      const response = await get(historyCandleUrl(gap.productId, start, end, 60));
      if (!response.ok) {
        host.book.incidents.push(`tape candle ${gap.productId} ${statusNote(response)}`);
        continue;
      }
      const rows = (await response.json()) as number[][];
      const bars = barsFromExchangeCandles(gap.productId, Array.isArray(rows) ? rows : []);
      for (const bar of bars) {
        const minute = Math.floor(bar.startSec / 60) * 60;
        if (minute < Math.floor(from / 60) * 60 || minute >= until || gap.covered.has(minute)) continue;
        host.trades.push({ productId: gap.productId, tsSec: bar.startSec, price: bar.close, size: bar.volume });
        host.book.mids.completed.push({
          productId: gap.productId,
          ts: bar.startSec * 1000,
          open: bar.open,
          high: bar.high,
          low: bar.low,
          close: bar.close,
          volumeBase: bar.volume,
        });
        gap.covered.add(minute);
      }
    } catch (error) {
      host.book.incidents.push(`tape candle ${gap.productId} ${error instanceof Error ? error.message : "failed"}`);
    }
  }
  const fromMinute = Math.floor(from / 60) * 60;
  for (const productId of host.products) {
    let missing = 0;
    for (let minute = fromMinute; minute < until; minute += 60) {
      const covered = host.book.mids.completed.some((mid) => mid.productId === productId && Math.floor(mid.ts / 1000) === minute);
      if (!covered) missing += 1;
    }
    if (missing > 0) host.book.incidents.push(`tape gap ${productId} ${missing}`);
  }
  host.tapeHole = false;
  markOrdersBeforeTape(host);
  console.log(`tape backfill from=${from} to=${until} prints=${host.trades.length} minutes=${host.book.mids.completed.length}`);
}

/** Orders placed before the restored tape, or before the 10-minute warm window when the tape is empty. */
export function markOrdersBeforeTape(host: PaperHost): void {
  const earliestTrade = host.trades.reduce((min, trade) => Math.min(min, trade.tsSec * 1000), Number.POSITIVE_INFINITY);
  const earliest = Number.isFinite(earliestTrade) ? earliestTrade : host.clock() - 10 * 60_000;
  for (const order of host.book.working) {
    if (order.status !== "working") continue;
    if (order.order.placedTs >= earliest) continue;
    order.status = "indeterminate";
    host.book.indeterminateByClass[order.classId] += 1;
    host.book.incidents.push("tape window indeterminate");
  }
}

interface PageStop {
  reason: "listing" | "hole" | "empty" | "http" | "budget" | "ok";
  status: number;
}

/**
 * Page 1h candles backward. Stop on an empty page, on the listing (a short page whose
 * oldest candle is after the requested start), or when the contiguous 4h tail does not grow.
 * The page cap is what FOUR_KEEP needs, not a walk back to the listing of a liquid name.
 */
async function pageHourSeed(host: PaperHost, productId: string, fetchImpl: SeedFetch | undefined, budget: boolean): Promise<PageStop> {
  const nowSec = Math.floor(host.clock() / 1000);
  const hours: BarOHLC[] = [];
  let tail: BarOHLC[] = [];
  let end = Math.floor(nowSec / HOUR_SEC) * HOUR_SEC - HOUR_SEC;
  let stop: PageStop = { reason: "ok", status: 200 };
  for (let page = 0; page < HOUR_PAGE_CAP; page += 1) {
    const start = end - (REST_HOUR_PAGE - HOUR_SEC);
    if (end < start) break;
    const response = budget
      ? await seedCall(host, historyCandleUrl(productId, start, end, HOUR_SEC), fetchImpl)
      : await (fetchImpl ?? hostGet(host, true))(historyCandleUrl(productId, start, end, HOUR_SEC));
    if (budgetHit(response)) return { reason: "budget", status: response.status };
    if (!response.ok) {
      host.book.incidents.push(`4h seed rest ${productId} ${statusNote(response)}`);
      stop = { reason: "http", status: response.status };
      break;
    }
    const rows = (await response.json()) as number[][];
    const got = barsFromExchangeCandles(productId, Array.isArray(rows) ? rows : []);
    if (got.length === 0) {
      stop = { reason: "empty", status: 200 };
      break;
    }
    const oldest = got[0]!.startSec;
    if (got.length < 300 && oldest > start) {
      for (const bar of got) hours.push({ ts: bar.startSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
      tail = contiguousTail(foldHours(hours, FOUR_STEP_SEC, HOUR_SEC), FOUR_STEP_SEC);
      stop = { reason: "listing", status: 200 };
      break;
    }
    const before = tail.length;
    for (const bar of got) hours.push({ ts: bar.startSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    tail = contiguousTail(foldHours(hours, FOUR_STEP_SEC, HOUR_SEC), FOUR_STEP_SEC);
    if (tail.length <= before) {
      stop = { reason: "hole", status: 200 };
      break;
    }
    if (tail.length >= FOUR_KEEP) break;
    end = start - HOUR_SEC;
  }
  const keptHours = hours.slice().sort((a, b) => a.ts - b.ts).slice(-HOUR_KEEP);
  if (keptHours.length > 0) host.hourWarm.set(productId, keptHours);
  const fromStore = fourFromResearch(productId);
  logFoldMismatches(host, productId, foldHours(hours, FOUR_STEP_SEC, HOUR_SEC), fromStore);
  rememberFourSeed(host, productId, tail, "rest_1h");
  const newest = keptHours[keptHours.length - 1]?.ts ?? tail[tail.length - 1]?.ts ?? 0;
  const oldestTs = hours.reduce((min, bar) => Math.min(min, bar.ts), newest);
  if (stop.reason === "listing" || stop.reason === "hole" || stop.reason === "empty" || stop.reason === "http" || tail.length < FOUR_HOUR_EMA_BARS) {
    const reason = stop.reason === "ok" ? "short" : stop.reason === "http" ? `http-${stop.status}` : stop.reason === "empty" ? "listing" : stop.reason;
    if (tail.length < FOUR_HOUR_EMA_BARS) host.book.incidents.push(`4h seed short ${productId} ${tail.length}`);
    noteCold(host, productId, reason);
    const prev = host.seedMarks.get(productId);
    host.seedMarks.set(productId, { oldestTs: oldestTs || prev?.oldestTs || 0, newestTs: newest, status: "cold", reason });
    return stop.reason === "ok" ? { reason: "hole", status: 200 } : stop;
  }
  const status = tail.length >= FOUR_KEEP ? "warm" : "short";
  host.seedMarks.set(productId, { oldestTs, newestTs: newest, status, reason: status === "warm" ? "seeded" : "short" });
  if (status === "warm") host.book.incidents.push(`4h seed rest ${productId} ${tail.length} seed_src=rest_1h`);
  return stop;
}

async function seedCall(host: PaperHost, url: string, fetchImpl?: SeedFetch): Promise<Awaited<ReturnType<SeedFetch>>> {
  if (fetchImpl) return countedSeedFetch(host, url, fetchImpl);
  return coinbaseGet(url, host.restRun, { seed: true });
}

/**
 * 4h seed. Use the research store only when its contiguous tail has 200 bars.
 * Otherwise one paged 1h walk fills both hourWarm and the 4h series.
 * A product whose contiguous tail stays under 200 is flagged. Nothing is invented across a hole.
 */
export async function seedFourHours(host: PaperHost, fetchImpl?: SeedFetch): Promise<void> {
  for (const productId of host.products) {
    const existing = contiguousTail(host.fourBars.get(productId) ?? [], FOUR_STEP_SEC);
    if (existing.length >= FOUR_KEEP) {
      if (!host.ema200.has(productId)) host.ema200.set(productId, "seeded");
      if (!host.fourSeedThrough.has(productId)) host.fourSeedThrough.set(productId, existing[existing.length - 1]!.ts);
      if (!host.seedMarks.has(productId)) {
        host.seedMarks.set(productId, { oldestTs: existing[0]!.ts, newestTs: existing[existing.length - 1]!.ts, status: "warm", reason: "seeded" });
      }
      continue;
    }
    const fromStore = fourFromResearch(productId);
    const storeTail = contiguousTail(fromStore, FOUR_STEP_SEC);
    if (storeTail.length >= FOUR_HOUR_EMA_BARS && !fetchImpl) {
      rememberFourSeed(host, productId, storeTail.slice(-FOUR_KEEP), "research");
      continue;
    }
    await pageHourSeed(host, productId, fetchImpl ?? hostGet(host, true), false);
  }
}

function fourFromResearch(productId: string): BarOHLC[] {
  const dir = dataFile("candles", productId);
  if (!dir) return [];
  const months = readdirSync(dir).filter((name) => name.endsWith(".sqlite")).sort().slice(-2);
  const bars: FifteenBar[] = [];
  for (const month of months) {
    const rows = readPairMonth(join(dir, month)).rows;
    for (const row of rows) {
      if (row.empty || row.open == null || row.high == null || row.low == null || row.close == null) continue;
      bars.push({
        productId,
        startSec: row.minuteSec,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume ?? 0),
      });
    }
  }
  if (bars.length === 0) return [];
  const end = bars[bars.length - 1]!.startSec + 900;
  return deriveForwardBook(bars, end)?.four ?? [];
}
