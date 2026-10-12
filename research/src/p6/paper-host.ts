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
import { repoRoot } from "../manifest";
import { registeredFlags, type RegistrationFlagSource } from "../p5/flags";
import { isDayCloseBar } from "../p5/book";
import { assertSafeToStart } from "../safety";
import { readPairMonth } from "../data/store";
import { readDailyHistory } from "./daily";
import { applyForward, freshBook, forwardBookPanel, noteMemberDay, type Book } from "./engine";
import { parsePublicMessage, type PublicEvent } from "./feed";
import type { BarOHLC } from "../p3/signals";
import { deriveForwardBook, forwardBarAnnotation, generateForward, hourAtrAt, vetoFromBtc, withExplicitGaps, type FifteenBar, type GeneratedEntry, type GenerateResult } from "./generate";
import { STALE_QUOTE_MS } from "./legs";
import { HEARTBEAT_GAP_MS, heartbeatMustReconnect } from "./mid-feed";
import { PUBLIC_CHANNELS, PUBLIC_WS_URL, subscribeFrames } from "./public-ws";
import {
  barFromExchangeCandles,
  barsFromExchangeCandles,
  fifteenMinuteUrl,
  planHistorySpans,
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
  lastBar: { productId: string; atr1h: number; dailyAtr: number; dailyClose: boolean; bScores: number } | null;
}

export interface StatusPublisher {
  publish(snapshot: { status: Record<string, unknown>; book: unknown }): void;
}

export interface RestRead {
  bar: OhlcvBar | null;
  status: number;
  retryAfterMs: number;
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
  const path = join(repoRoot(), "research/data/products/usd-spot.json");
  if (!existsSync(path)) return ticks;
  const body = JSON.parse(readFileSync(path, "utf8")) as { products?: { productId?: string; tickSize?: string | null }[] };
  for (const product of body.products ?? []) {
    const tick = Number(product.tickSize);
    if (product.productId && tick > 0) ticks.set(product.productId, tick);
  }
  return ticks;
}

function loadContext(): HostContext | null {
  const root = repoRoot();
  const registrationPath = join(root, "research/data/reports/p4-registration.json");
  const membershipPath = join(root, "research/data/reports/universe-membership.json");
  if (!existsSync(registrationPath) || !existsSync(membershipPath)) return null;
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
  const dailyDir = join(repoRoot(), "research/data/daily");
  const warmup = new Map<string, SourceDay[]>();
  const watched = [...new Set([...products, "BTC-USD"])];
  if (!existsSync(join(dailyDir, "candles"))) {
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
  if (!context) book.incidents.push("registration flags unavailable");
  if (!existsSync(join(dailyDir, "candles"))) book.incidents.push("daily warmup unavailable");
  else {
    for (const productId of products) {
      if ((warmup.get(productId)?.length ?? 0) === 0) book.incidents.push(`daily warmup missing ${productId}`);
    }
  }
  return {
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
  };
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
}

/** Public messages for one socket. Trade time and maker side come from the exchange. */
export function applyPublic(host: PaperHost, shardIndex: number, events: readonly PublicEvent[], nowMs: number): void {
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
      host.trades.push({ productId: event.productId, tsSec: Math.floor(tsMs / 1000), price: event.price, size: event.size });
      if (event.side === "BUY" || event.side === "SELL") {
        applyForward(host.book, { kind: "trade", productId: event.productId, price: event.price, size: event.size, makerSide: event.side, tsMs });
      }
      continue;
    }
    if (event.kind === "l2-snapshot") {
      const book = { bids: new Map<string, number>(), asks: new Map<string, number>() };
      for (const [price, size] of event.bids) applyLevel(book, "bid", price, size);
      for (const [price, size] of event.asks) applyLevel(book, "ask", price, size);
      host.books.set(event.productId, book);
      dirty.add(event.productId);
      continue;
    }
    if (event.kind === "l2-update") {
      const book = levelsOf(host, event.productId);
      applyLevel(book, event.side, event.price, event.size);
      dirty.add(event.productId);
    }
  }
  for (const productId of dirty) {
    const book = host.books.get(productId);
    const top = book ? touch(book) : null;
    if (top) applyForward(host.book, { kind: "mid", tsMs: nowMs, productId, bid: top.bid, ask: top.ask });
  }
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
  const btcDays = host.warmup.get("BTC-USD") ?? [];
  const btcFour = deriveForwardBook(host.fifteen.filter((bar) => bar.productId === "BTC-USD"), nowSec)?.four ?? [];
  const generated = generateForward({
    bars: host.fifteen,
    nowSec,
    flags: host.context.flags,
    flagsByProduct: host.context.byProduct,
    memberOn: host.context.memberOn,
    warmupDays: host.warmup,
    veto: vetoFromBtc(btcDays, btcFour),
    pick: { lookback: host.book.aPick.lookback, k: host.book.aPick.k },
  });
  host.weeks.set("*", generated.weeks);
  return generated;
}

function hourSeries(host: PaperHost, productId: string, derived: readonly BarOHLC[]): BarOHLC[] {
  return [...(host.hourWarm.get(productId) ?? []), ...derived];
}

function ensureHourWarm(host: PaperHost, productId: string): void {
  if (host.hourWarm.has(productId)) return;
  const dir = join(repoRoot(), "research/data/candles", productId);
  if (!existsSync(dir)) {
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
  host.hourWarm.set(productId, deriveForwardBook(bars, end)?.hour.slice(-400) ?? []);
}

function entryId(entry: GeneratedEntry): string {
  return `${entry.classId}-${entry.productId}-${entry.tsMs}`;
}

/** Send a queued entry at the fill open. Level2 is the book now. Staleness uses the wall clock. */
export function flushEntries(host: PaperHost, nowMs: number): void {
  for (const [id, entry] of host.queued) {
    if (entry.tsMs > nowMs) continue;
    host.queued.delete(id);
    if (nowMs - entry.tsMs > STALE_QUOTE_MS) {
      host.emitted.add(id);
      host.book.rejected.push({ id, reason: "stale-book" });
      host.book.incidents.push(`missed send ${id}`);
      continue;
    }
    const stored = host.books.get(entry.productId);
    const top = stored ? touch(stored) : null;
    const quoted = host.book.quotes[entry.productId];
    if (!top || !quoted || nowMs - quoted.tsMs > STALE_QUOTE_MS) {
      host.emitted.add(id);
      host.book.rejected.push({ id, reason: "stale-book" });
      continue;
    }
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
    });
  }
}

function queueEntries(host: PaperHost, entries: readonly GeneratedEntry[], nowMs: number): void {
  for (const entry of entries) {
    const id = entryId(entry);
    if (host.emitted.has(id) || host.queued.has(id)) continue;
    if (entry.tsMs < nowMs - 86_400_000) continue;
    host.queued.set(id, entry);
  }
  flushEntries(host, nowMs);
}

function pushBar(host: PaperHost, bar: OhlcvBar): void {
  host.fifteen.push({ productId: bar.productId, startSec: bar.startSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
  const nowSec = bar.startSec + 900;
  let atr1h = 0;
  let dailyAtr = 0;
  let bScores: ClassBRow[] | undefined;
  const dailyClose = isDayCloseBar(bar.startSec);
  const live = host.clock() - nowSec * 1000 < 180_000;
  try {
    ensureHourWarm(host, bar.productId);
    const derived = deriveForwardBook(host.fifteen.filter((row) => row.productId === bar.productId), nowSec);
    if (dailyClose && derived) {
      const first = derived.days[0]?.date ?? "9999-99-99";
      const prior = (host.warmup.get(bar.productId) ?? []).filter((row) => row.date < first);
      for (const day of withExplicitGaps([...prior, ...derived.days])) noteMemberDay(host.book, bar.productId, day);
    }
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
  };
  applyForward(host.book, { ...fields, phase: "gap" });
  applyForward(host.book, { ...fields, phase: "rest" });
  boundHost(host);
}

function barKey(productId: string, startSec: number): string {
  return `${productId}:${startSec}`;
}

function noteApplied(host: PaperHost, productId: string, startSec: number): void {
  host.applied.add(barKey(productId, startSec));
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
}

/** Persistence for the book and the last processed bar. The driver does not choose the store. */
export interface PaperStore {
  load(): PaperStateBody | null;
  save(body: PaperStateBody): void;
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
  fetchImpl: (url: string) => Promise<Pick<Response, "status" | "ok" | "json">> = fetch,
): Promise<void> {
  const nowSec = Math.floor(host.clock() / 1000);
  const newest = Math.floor(nowSec / 900) * 900 - 900;
  for (const productId of host.products) {
    const origin = host.historyFrom.get(productId);
    const cursor = host.restCursor.get(productId) ?? origin;
    if (cursor == null || cursor > newest) continue;
    for (const span of planHistorySpans(cursor, newest)) {
      try {
        const response = await fetchImpl(fifteenMinuteUrl(productId, span.startSec, span.endSec));
        if (response.status === 429) {
          host.book.incidents.push(`history rest ${productId} ${span.startSec} 429`);
          break;
        }
        if (!response.ok) {
          host.book.incidents.push(`history rest ${productId} ${span.startSec} ${response.status}`);
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
        break;
      }
    }
  }
}

export async function fetchRestBar(productId: string, startSec: number): Promise<RestRead> {
  try {
    const response = await fetch(fifteenMinuteUrl(productId, startSec, startSec));
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

/** One socket frame. The envelope sequence covers every channel, then the book updates. */
export function ingestSocketMessage(host: PaperHost, shardIndex: number, raw: unknown, nowMs: number): void {
  const sequence = envelopeSequence(raw);
  if (sequence != null) noteSequence(host, shardIndex, sequence, false);
  applyPublic(host, shardIndex, parsePublicMessage(raw), nowMs);
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
      void fetchRestBar(due.slot.productId, due.slot.barStartSec)
        .then((result) => {
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
  if (opts.forMs != null && opts.forMs > 0) setTimeout(stop, opts.forMs);
  let resolve: () => void = () => {};
  await new Promise<void>((done) => {
    resolve = done;
    process.on("SIGINT", stop);
  });
}
