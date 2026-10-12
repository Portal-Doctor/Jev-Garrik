/**
 * Long-running public paper process. Brian runs it on an always-on host.
 * Level2, market_trades, and heartbeats only. At most 10 products per socket.
 * A missed first heartbeat reconnects, and a socket that stays silent reconnects
 * again. Strategy bars are public REST 15-minute candles. Daily, 1h, and 4h
 * series are derived from those bars plus the daily warmup. Status and the book
 * are files under data/runtime. Nothing here opens a port.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GroupFlags, SourceDay } from "../p3/bar-access";
import type { ClassBRow } from "../p3/design-rules";
import { repoRoot } from "../manifest";
import { registeredFlags, type RegistrationFlagSource } from "../p5/flags";
import { isDayCloseBar } from "../p5/book";
import { assertSafeToStart } from "../safety";
import { readDailyHistory } from "./daily";
import { applyForward, freshBook, forwardBookPanel, type Book } from "./engine";
import { parsePublicMessage, type PublicEvent } from "./feed";
import { deriveForwardBook, forwardBarAnnotation, generateForward, type FifteenBar, type GeneratedEntry } from "./generate";
import { STALE_QUOTE_MS } from "./legs";
import { HEARTBEAT_GAP_MS, heartbeatMustReconnect } from "./mid-feed";
import { PUBLIC_CHANNELS, PUBLIC_WS_URL, subscribeFrames } from "./public-ws";
import {
  barFromExchangeCandles,
  fifteenMinuteUrl,
  restOrTrades,
  restSettleSchedule,
  tradesBuilt15m,
  type OhlcvBar,
  type TradePrint,
} from "./rest-bars";

const MAX_TRADES = 50_000;
const MAX_MIDS = 10_000;
const MAX_INCIDENTS = 1_000;
const MAX_FIFTEEN_PER_PRODUCT = 500;
const MAX_REST_SLOTS = 64;
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
  nextRestMs: number;
  books: Map<string, { bids: Map<string, number>; asks: Map<string, number> }>;
  fifteen: FifteenBar[];
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
  const kept = new Map<string, FifteenBar[]>();
  for (const bar of host.fifteen) {
    const list = kept.get(bar.productId) ?? [];
    list.push(bar);
    kept.set(bar.productId, list);
  }
  const fifteen: FifteenBar[] = [];
  for (const list of kept.values()) fifteen.push(...list.slice(-MAX_FIFTEEN_PER_PRODUCT));
  host.fifteen = fifteen;
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
    nextRestMs: 0,
    books: new Map(),
    fifteen: [],
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

function emitGaps(host: PaperHost, shard: readonly string[]): void {
  host.reconnects += 1;
  host.status = "reconnecting";
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
    emitGaps(host, host.shards[shardIndex] ?? []);
    return true;
  }
  const last = host.lastHeartbeatMs[shardIndex] ?? host.openedMs[shardIndex];
  if (last == null || !heartbeatMustReconnect(last, nowMs, HEARTBEAT_GAP_MS)) return false;
  host.gapOpen[shardIndex] = false;
  host.lastHeartbeatMs[shardIndex] = null;
  host.openedMs[shardIndex] = nowMs;
  emitGaps(host, host.shards[shardIndex] ?? []);
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
  if (reconnect) emitGaps(host, host.shards[shardIndex] ?? []);
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
    if (cursor == null) cursor = newestClosed;
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
  if (nowMs >= deadline) return "fallback";
  const index = Math.floor((nowMs - first) / schedule.intervalMs);
  if (index >= slot.attempts) return "fetch";
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

function rememberProduct(host: PaperHost, productId: string, nowSec: number): { entries: GeneratedEntry[]; atr: number; date: string } {
  const date = new Date((nowSec - 900) * 1000).toISOString().slice(0, 10);
  if (!host.context || !host.book.aPick) return { entries: [], atr: 0, date };
  const warmup = new Map<string, SourceDay[]>();
  const days = host.warmup.get(productId);
  if (days && days.length > 0) warmup.set(productId, days);
  const generated = generateForward({
    bars: host.fifteen.filter((bar) => bar.productId === productId),
    nowSec,
    flags: host.context.flags,
    flagsByProduct: host.context.byProduct,
    memberOn: host.context.memberOn,
    warmupDays: warmup,
    pick: { lookback: host.book.aPick.lookback, k: host.book.aPick.k },
  });
  host.weeks.set(productId, generated.weeks);
  return { entries: generated.entries, atr: generated.atrByProduct.get(productId)?.get(date) ?? 0, date };
}

function emitEntry(host: PaperHost, entry: GeneratedEntry): void {
  const id = `${entry.classId}-${entry.productId}-${entry.tsMs}`;
  if (host.emitted.has(id)) return;
  const stored = host.books.get(entry.productId);
  const top = stored ? touch(stored) : null;
  const quoted = host.book.quotes[entry.productId];
  if (!top || !quoted) {
    host.book.rejected.push({ id, reason: "stale-book" });
    host.emitted.add(id);
    return;
  }
  host.emitted.add(id);
  if (entry.kind === "d-order") {
    applyForward(host.book, {
      kind: "d-order",
      id,
      productId: entry.productId,
      limit: entry.nextOpen,
      units: 1,
      placedTs: entry.tsMs,
      stop: entry.stop,
      bid: top.bid,
      ask: top.ask,
      bookTsMs: quoted.tsMs,
      decisionMid: entry.nextOpen,
      tick: 0.01,
      target: entry.target ?? undefined,
    });
    return;
  }
  applyForward(host.book, {
    kind: "x1",
    id,
    classId: entry.classId,
    productId: entry.productId,
    tsMs: entry.tsMs,
    nextOpen: entry.nextOpen,
    stop: entry.stop,
    atr1h: Math.max(entry.dailyAtr / 24, 0.01),
    bid: top.bid,
    ask: top.ask,
    bookTsMs: quoted.tsMs,
    sendTsMs: entry.tsMs,
    decisionMid: entry.nextOpen,
    target: entry.target ?? undefined,
    dailyAtr: entry.dailyAtr,
    priorDailyCloses: entry.priorDailyCloses,
    ...(entry.aConfig ? { aConfig: entry.aConfig } : {}),
  });
}

function pushBar(host: PaperHost, bar: OhlcvBar): void {
  host.fifteen.push({ productId: bar.productId, startSec: bar.startSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
  const nowSec = bar.startSec + 900;
  let entries: GeneratedEntry[] = [];
  let atr1h = 0;
  let dailyAtr = 0;
  let bScores: ClassBRow[] | undefined;
  const dailyClose = isDayCloseBar(bar.startSec);
  try {
    const remembered = rememberProduct(host, bar.productId, nowSec);
    entries = remembered.entries;
    dailyAtr = remembered.atr;
    const derived = deriveForwardBook(host.fifteen.filter((row) => row.productId === bar.productId), nowSec);
    const note = forwardBarAnnotation(
      { entries, weeks: host.weeks.get(bar.productId) ?? [], atrByProduct: new Map([[bar.productId, new Map([[remembered.date, dailyAtr]])]]) },
      derived?.hour ?? [],
      bar.productId,
      bar.startSec,
    );
    atr1h = note.atr1h;
    bScores = mergedScores(host, remembered.date);
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
  for (const entry of entries) {
    if (Math.floor(entry.tsMs / 1000) !== bar.startSec) continue;
    emitEntry(host, entry);
  }
  applyForward(host.book, { ...fields, phase: "rest" });
  boundHost(host);
}

export function acceptRestBar(host: PaperHost, bar: OhlcvBar): "accepted" | "drop-late" {
  const slot = host.rest.get(`${bar.productId}:${bar.startSec}`);
  if (slot?.done && slot.fallback) return "drop-late";
  if (slot) {
    slot.done = true;
    slot.inflight = false;
    slot.fallback = false;
  }
  host.restAccepted += 1;
  pushBar(host, bar);
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
  if (built) pushBar(host, built);
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

export function savePaperState(dir: string, host: PaperHost): void {
  assertRuntimeDir(dir);
  mkdirSync(dir, { recursive: true });
  const book = host.book;
  const body = {
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
    emitted: [...host.emitted],
  };
  writeFileSync(join(dir, "state.json"), JSON.stringify(body));
}

export function loadPaperState(dir: string, host: PaperHost): boolean {
  assertRuntimeDir(dir);
  const path = join(dir, "state.json");
  if (!existsSync(path)) return false;
  const body = JSON.parse(readFileSync(path, "utf8")) as {
    positions?: Book["positions"];
    closed?: Book["closed"];
    kelly?: Book["kelly"];
    pairs?: Book["pairs"];
    realizedUsd?: number;
    incidents?: string[];
    aPickConfig?: string | null;
    classes?: Book["classes"];
    day?: string | null;
    week?: string | null;
    dayStartEquity?: number;
    weekStartEquity?: number;
    peakEquity?: number;
    killSwitch?: boolean;
    rejected?: Book["rejected"];
    haltWeeks?: string[];
    momentumDates?: string[];
    restCursor?: [string, number][];
    emitted?: string[];
  };
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
  host.emitted = new Set(body.emitted ?? []);
  return true;
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
    if (host.socketGen[shardIndex] !== gen) return;
    onSocketClosed(host, shardIndex);
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
