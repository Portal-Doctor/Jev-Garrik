/**
 * Public candle, L2, and trade reducer.
 * A 1m candle completes only when a later minute starts. Forming updates do not emit a bar.
 */

export interface MinuteBar {
  productId: string;
  startSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type PublicEvent =
  | { kind: "candle"; productId: string; startSec: number; open: number; high: number; low: number; close: number; volume: number }
  | { kind: "l2-snapshot"; productId: string; bids: readonly (readonly [string, string])[]; asks: readonly (readonly [string, string])[] }
  | { kind: "l2-update"; productId: string; side: "bid" | "ask"; price: string; size: string }
  | { kind: "trade"; productId: string; price: number; size: number }
  | { kind: "heartbeat" };

export interface FeedGap {
  productId: string;
  fromSec: number;
  toSec: number;
}

export interface FeedState {
  warming: boolean;
  forming: Map<string, MinuteBar>;
  completed: MinuteBar[];
  gaps: FeedGap[];
  books: Map<string, { bids: Map<string, string>; asks: Map<string, string> }>;
  trades: { productId: string; price: number; size: number }[];
}

export interface ApplyResult {
  completed: MinuteBar | null;
  gap: boolean;
  warming: boolean;
}

export function freshFeed(): FeedState {
  return { warming: false, forming: new Map(), completed: [], gaps: [], books: new Map(), trades: [] };
}

export function rebuildFeed(completed: readonly MinuteBar[]): FeedState {
  const state = freshFeed();
  state.warming = true;
  state.completed = completed.map((bar) => ({ ...bar }));
  return state;
}

export function finishWarmup(state: FeedState): void {
  state.warming = false;
}

function bookOf(state: FeedState, productId: string): { bids: Map<string, string>; asks: Map<string, string> } {
  let book = state.books.get(productId);
  if (!book) {
    book = { bids: new Map(), asks: new Map() };
    state.books.set(productId, book);
  }
  return book;
}

function applyLevel(book: { bids: Map<string, string>; asks: Map<string, string> }, side: "bid" | "ask", price: string, size: string): void {
  const levels = side === "bid" ? book.bids : book.asks;
  if (!(Number(size) > 0)) levels.delete(price);
  else levels.set(price, size);
}

export function applyEvent(state: FeedState, event: PublicEvent): ApplyResult {
  const warming = state.warming;
  if (event.kind === "heartbeat") return { completed: null, gap: false, warming };
  if (event.kind === "trade") {
    state.trades.push({ productId: event.productId, price: event.price, size: event.size });
    return { completed: null, gap: false, warming };
  }
  if (event.kind === "l2-snapshot") {
    const book = { bids: new Map<string, string>(), asks: new Map<string, string>() };
    for (const [price, size] of event.bids) applyLevel(book, "bid", price, size);
    for (const [price, size] of event.asks) applyLevel(book, "ask", price, size);
    state.books.set(event.productId, book);
    return { completed: null, gap: false, warming };
  }
  if (event.kind === "l2-update") {
    applyLevel(bookOf(state, event.productId), event.side, event.price, event.size);
    return { completed: null, gap: false, warming };
  }
  const next: MinuteBar = {
    productId: event.productId,
    startSec: event.startSec,
    open: event.open,
    high: event.high,
    low: event.low,
    close: event.close,
    volume: event.volume,
  };
  const prev = state.forming.get(event.productId);
  if (!prev || event.startSec < prev.startSec) {
    if (!prev) state.forming.set(event.productId, next);
    return { completed: null, gap: false, warming };
  }
  if (event.startSec === prev.startSec) {
    state.forming.set(event.productId, {
      ...prev,
      high: Math.max(prev.high, event.high),
      low: Math.min(prev.low, event.low),
      close: event.close,
      volume: event.volume,
    });
    return { completed: null, gap: false, warming };
  }
  const last = lastCompleted(state, event.productId);
  const skipped = event.startSec !== prev.startSec + 60;
  const broken = last != null && prev.startSec !== last.startSec + 60;
  const gap = skipped || broken;
  if (gap) state.gaps.push({ productId: event.productId, fromSec: last?.startSec ?? prev.startSec, toSec: event.startSec });
  state.completed.push(prev);
  state.forming.set(event.productId, next);
  return { completed: prev, gap, warming };
}

function lastCompleted(state: FeedState, productId: string): MinuteBar | null {
  for (let i = state.completed.length - 1; i >= 0; i -= 1) {
    const bar = state.completed[i]!;
    if (bar.productId === productId) return bar;
  }
  return null;
}

/**
 * A product's UTC day is complete only when that same product has a bar on a
 * later UTC date. One product rolling forward does not complete the others.
 */
export function completedProductDays(bars: readonly { productId: string; startSec: number }[]): { productId: string; date: string }[] {
  const newest = new Map<string, string>();
  const dates = new Map<string, Set<string>>();
  for (const bar of bars) {
    const date = new Date(bar.startSec * 1000).toISOString().slice(0, 10);
    const seen = dates.get(bar.productId) ?? new Set<string>();
    seen.add(date);
    dates.set(bar.productId, seen);
    const prior = newest.get(bar.productId) ?? "";
    if (date > prior) newest.set(bar.productId, date);
  }
  const out: { productId: string; date: string }[] = [];
  for (const [productId, seen] of dates) {
    const latest = newest.get(productId) ?? "";
    for (const date of seen) if (date < latest) out.push({ productId, date });
  }
  return out.sort((a, b) => a.productId.localeCompare(b.productId) || a.date.localeCompare(b.date));
}

function num(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** Parse a normalized event or a public Advanced Trade envelope. Order channels throw. */
export function parsePublicMessage(raw: unknown): PublicEvent[] {
  if (raw == null || typeof raw !== "object") return [];
  const msg = raw as Record<string, unknown>;
  if (typeof msg.kind === "string") return [msg as PublicEvent];
  const channel = typeof msg.channel === "string" ? msg.channel : "";
  if (channel === "user" || channel === "orders" || channel === "full") throw new Error(`refusing order channel ${channel}`);
  const events = Array.isArray(msg.events) ? msg.events : [];
  const out: PublicEvent[] = [];
  if (channel === "candles") {
    // Five-minute buckets. They are not 1m bars and they are not ingested.
    return out;
  }
  if (channel === "market_trades") {
    for (const event of events) {
      const trades = Array.isArray((event as { trades?: unknown }).trades) ? (event as { trades: Record<string, unknown>[] }).trades : [];
      for (const trade of trades) {
        const price = num(trade.price);
        const size = num(trade.size);
        const productId = typeof trade.product_id === "string" ? trade.product_id : "";
        if (price == null || size == null || !productId) continue;
        out.push({ kind: "trade", productId, price, size });
      }
    }
  }
  if (channel === "level2" || channel === "l2_data") {
    for (const event of events) {
      const row = event as { type?: string; product_id?: string; updates?: { side?: string; price_level?: string; new_quantity?: string }[] };
      const productId = row.product_id ?? "";
      if (!productId || !Array.isArray(row.updates)) continue;
      if (row.type === "snapshot") {
        const bids: [string, string][] = [];
        const asks: [string, string][] = [];
        for (const update of row.updates) {
          if (!update.price_level || update.new_quantity == null) continue;
          const side = update.side === "offer" || update.side === "ask" ? asks : bids;
          side.push([update.price_level, update.new_quantity]);
        }
        out.push({ kind: "l2-snapshot", productId, bids, asks });
      } else {
        for (const update of row.updates) {
          if (!update.price_level || update.new_quantity == null || !update.side) continue;
          const side = update.side === "offer" || update.side === "ask" ? "ask" : "bid";
          out.push({ kind: "l2-update", productId, side, price: update.price_level, size: update.new_quantity });
        }
      }
    }
  }
  if (channel === "heartbeats") out.push({ kind: "heartbeat" });
  return out;
}
