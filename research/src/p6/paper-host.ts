/**
 * Long-running public paper process. Brian runs it on an always-on host.
 * Level2, market_trades, and heartbeats only. At most 10 products per socket.
 * A heartbeat gap reconnects that socket and feeds a gap event per product.
 * 1m bars are L2 mids. Strategy bars are public REST 15m, first requested
 * 15s after the bar ends, retried every 10s for 120s, then a trades-built bar
 * and an incident. No order channel, no key, no signature.
 * Status and the book panel are files. A loopback GET serves the same JSON.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertLoopbackHost, assertSafeToStart } from "../safety";
import { applyForward, freshBook, forwardBookPanel, type Book } from "./engine";
import { parsePublicMessage, type PublicEvent } from "./feed";
import { heartbeatMustReconnect, shardProducts } from "./mid-feed";
import { PUBLIC_CHANNELS, PUBLIC_WS_URL, subscribeFrames } from "./public-ws";
import { barFromExchangeCandles, fifteenMinuteUrl, restOrTrades, restSettleSchedule, tradesBuilt15m, type OhlcvBar, type TradePrint } from "./rest-bars";

export interface RestSlot {
  productId: string;
  barStartSec: number;
  attempts: number;
  done: boolean;
}

export interface PaperHost {
  products: string[];
  shards: string[][];
  frames: string[];
  book: Book;
  lastHeartbeatMs: (number | null)[];
  gapOpen: boolean[];
  reconnects: number;
  gapEvents: number;
  trades: TradePrint[];
  rest: Map<string, RestSlot>;
  books: Map<string, { bids: Map<string, number>; asks: Map<string, number> }>;
  status: "live" | "reconnecting";
}

export function startPaperHost(products: readonly string[], env: Record<string, string | undefined> = process.env): PaperHost {
  const safety = assertSafeToStart(env);
  if (!safety.ok) throw new Error(safety.reason);
  if (products.length === 0) throw new Error("public paper needs a product");
  const frames = subscribeFrames(products, PUBLIC_CHANNELS, env);
  const shards = shardProducts(products);
  if (shards.some((shard) => shard.length > 10)) throw new Error("more than 10 products on one socket");
  for (const frame of frames) {
    const body = JSON.parse(frame) as { channel?: string };
    if (body.channel === "user" || body.channel === "orders" || body.channel === "full") throw new Error("refusing an order channel");
  }
  return {
    products: [...products],
    shards,
    frames,
    book: freshBook({ members: [...products] }),
    lastHeartbeatMs: shards.map(() => null),
    gapOpen: shards.map(() => false),
    reconnects: 0,
    gapEvents: 0,
    trades: [],
    rest: new Map(),
    books: new Map(),
    status: "live",
  };
}

function emitGaps(host: PaperHost, shard: readonly string[]): void {
  host.reconnects += 1;
  host.status = "reconnecting";
  for (const productId of shard) {
    host.gapEvents += 1;
    applyForward(host.book, { kind: "gap", productId });
  }
}

/** Timer path: no heartbeat arrived. Reconnect once until the next heartbeat. */
export function considerHeartbeatGap(host: PaperHost, shardIndex: number, nowMs: number): boolean {
  const last = host.lastHeartbeatMs[shardIndex];
  if (last == null || host.gapOpen[shardIndex]) return false;
  if (!heartbeatMustReconnect(last, nowMs)) return false;
  host.gapOpen[shardIndex] = true;
  emitGaps(host, host.shards[shardIndex] ?? []);
  return true;
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

/** Public messages for one socket. 1m bars come from the L2 mid. */
export function applyPublic(host: PaperHost, shardIndex: number, events: readonly PublicEvent[], nowMs: number): void {
  for (const event of events) {
    if (event.kind === "heartbeat") {
      observeHeartbeat(host, shardIndex, nowMs);
      continue;
    }
    if (event.kind === "trade") {
      host.trades.push({ productId: event.productId, tsSec: Math.floor(nowMs / 1000), price: event.price, size: event.size });
      applyForward(host.book, { kind: "trade", productId: event.productId, price: event.price, size: event.size, makerSide: "BUY", tsMs: nowMs });
      continue;
    }
    if (event.kind === "l2-snapshot") {
      const book = { bids: new Map<string, number>(), asks: new Map<string, number>() };
      for (const [price, size] of event.bids) applyLevel(book, "bid", price, size);
      for (const [price, size] of event.asks) applyLevel(book, "ask", price, size);
      host.books.set(event.productId, book);
      const top = touch(book);
      if (top) applyForward(host.book, { kind: "mid", tsMs: nowMs, productId: event.productId, bid: top.bid, ask: top.ask });
      continue;
    }
    if (event.kind === "l2-update") {
      const book = levelsOf(host, event.productId);
      applyLevel(book, event.side, event.price, event.size);
      const top = touch(book);
      if (top) applyForward(host.book, { kind: "mid", tsMs: nowMs, productId: event.productId, bid: top.bid, ask: top.ask });
    }
  }
}

export function scheduleRest(host: PaperHost, nowMs: number): void {
  const nowSec = Math.floor(nowMs / 1000);
  const current = Math.floor(nowSec / 900) * 900;
  const barStartSec = current - 900;
  if (barStartSec < 0) return;
  for (const productId of host.products) {
    const key = `${productId}:${barStartSec}`;
    if (host.rest.has(key)) continue;
    host.rest.set(key, { productId, barStartSec, attempts: 0, done: false });
  }
}

export function restAction(slot: RestSlot, nowMs: number): "wait" | "fetch" | "fallback" {
  if (slot.done) return "wait";
  const barEndMs = (slot.barStartSec + 900) * 1000;
  const schedule = restSettleSchedule(barEndMs);
  if (nowMs < schedule.firstMs) return "wait";
  if (nowMs >= schedule.deadlineMs) return "fallback";
  const index = Math.floor((nowMs - schedule.firstMs) / schedule.intervalMs);
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

function pushBar(host: PaperHost, bar: OhlcvBar): void {
  applyForward(host.book, {
    kind: "bar15",
    productId: bar.productId,
    startSec: bar.startSec,
    nowSec: bar.startSec + 900,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
  });
}

export function acceptRestBar(host: PaperHost, bar: OhlcvBar): void {
  const slot = host.rest.get(`${bar.productId}:${bar.startSec}`);
  if (slot) slot.done = true;
  const decision = restOrTrades({ restOk: true, deadlinePassed: false });
  if (decision.incident) host.book.incidents.push(`rest ${bar.productId} ${bar.startSec}`);
  pushBar(host, bar);
}

export function noteRestMiss(host: PaperHost, slot: RestSlot): void {
  slot.attempts += 1;
}

export function fallbackTradesBar(host: PaperHost, slot: RestSlot): OhlcvBar | null {
  slot.done = true;
  const prints = host.trades.filter((trade) => trade.productId === slot.productId && trade.tsSec >= slot.barStartSec && trade.tsSec < slot.barStartSec + 900);
  const built = tradesBuilt15m(prints).find((bar) => bar.startSec === slot.barStartSec) ?? null;
  const decision = restOrTrades({ restOk: false, deadlinePassed: true });
  host.book.incidents.push(
    decision.incident
      ? `rest 15m missed ${slot.productId} ${slot.barStartSec} after 120s; ${built ? "trades-built bar" : "no trades"}`
      : `rest ${slot.productId} ${slot.barStartSec}`,
  );
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
    incidents: host.book.incidents,
    completedMidBars: host.book.mids.completed.length,
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

export function writeHostFiles(dir: string, host: PaperHost): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "status.json"), `${JSON.stringify(hostStatus(host), null, 2)}\n`);
  writeFileSync(join(dir, "book.json"), `${JSON.stringify(hostPanel(host), null, 2)}\n`);
}

async function fetchRestBar(productId: string, startSec: number): Promise<OhlcvBar | null> {
  const response = await fetch(fifteenMinuteUrl(productId, startSec, startSec));
  if (!response.ok) return null;
  const rows = (await response.json()) as number[][];
  if (!Array.isArray(rows)) return null;
  return barFromExchangeCandles(productId, startSec, rows);
}

function openShard(host: PaperHost, shardIndex: number, url: string): WebSocket {
  const shard = host.shards[shardIndex] ?? [];
  const ws = new WebSocket(url);
  ws.addEventListener("open", () => {
    for (const channel of PUBLIC_CHANNELS) {
      ws.send(JSON.stringify({ type: "subscribe", product_ids: shard, channel }));
    }
  });
  ws.addEventListener("message", (event) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(event.data));
    } catch {
      return;
    }
    applyPublic(host, shardIndex, parsePublicMessage(parsed), Date.now());
  });
  return ws;
}

/**
 * Connects the public sockets and stays up. The caller (the CLI) is the
 * always-on process. Tests use the pure functions above and do not call this.
 */
export async function runPublicPaper(opts: {
  products: readonly string[];
  statusDir: string;
  env?: Record<string, string | undefined>;
  listen?: string | null;
  port?: number;
}): Promise<void> {
  const host = startPaperHost(opts.products, opts.env ?? process.env);
  writeHostFiles(opts.statusDir, host);
  const sockets = host.shards.map((_, index) => openShard(host, index, PUBLIC_WS_URL));
  const timer = setInterval(() => {
    const now = Date.now();
    host.shards.forEach((_, index) => {
      if (!considerHeartbeatGap(host, index, now)) return;
      const dead = sockets[index];
      if (dead) dead.close();
      sockets[index] = openShard(host, index, PUBLIC_WS_URL);
    });
    for (const due of dueRest(host, now)) {
      if (due.action === "fetch") {
        noteRestMiss(host, due.slot);
        void fetchRestBar(due.slot.productId, due.slot.barStartSec).then((bar) => {
          if (bar) acceptRestBar(host, bar);
        });
        continue;
      }
      fallbackTradesBar(host, due.slot);
    }
    writeHostFiles(opts.statusDir, host);
  }, 1_000);
  if (opts.listen) {
    assertLoopbackHost(opts.listen);
    Bun.serve({
      hostname: opts.listen,
      port: opts.port ?? 8787,
      fetch(req) {
        const url = new URL(req.url);
        const res = readOnlyResponse(host, req.method, url.pathname);
        return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
      },
    });
  }
  await new Promise<void>((resolve) => {
    process.on("SIGINT", () => {
      clearInterval(timer);
      for (const socket of sockets) socket.close();
      writeHostFiles(opts.statusDir, host);
      resolve();
    });
  });
}
