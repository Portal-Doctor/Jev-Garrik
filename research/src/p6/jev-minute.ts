/**
 * Per-minute Jev input from the live level2 book and market_trades.
 * Formulas for the packet are cb/state.ts buildState and cb/features.ts.
 * This file does not open a socket and does not place an order.
 */

import { FeatureAccumulator, topImbalance, type BookView } from "../../../cb/features";
import { buildState, type MarketState } from "../../../cb/state";

export const JEV_SCHEMA = "jev-1m-v2.1";
export const JEV_MINUTE_MS = 60_000;
export const JEV_WINDOW_MS = 15 * JEV_MINUTE_MS;
export const JEV_MIN_PRESENT = 13;
export const JEV_SLOT_LAST = 14;
export const JEV_CARRY_MAX = 5;
export const JEV_HORIZON_SEC = 900;
export const JEV_PERSIST_PRODUCTS = 16;
export const JEV_PERSIST_MINUTES = 15;

export interface JevMinuteSummary {
  ts: number;
  takerBuyUsd: number;
  takerSellUsd: number;
  trades: number;
  midClose: number;
  midHigh: number;
  midLow: number;
  spreadBps: number;
  imbalance5: number;
  imbalance20: number;
  carried: boolean;
}

export interface StoredJevMinute extends JevMinuteSummary {
  productId: string;
  /** False on rows restored from a flush. Only a live row can make a packet valid. */
  live: boolean;
}

export type JevFeedGap = "no_book_feed" | "no_trades_feed" | "carry_limit";

export interface JevWindow {
  ok: boolean;
  minutes: JevMinuteSummary[];
  sub?: "no_book_feed" | "no_trades_feed";
}

interface FormingMinute {
  ts: number;
  high: number;
  low: number;
  close: number;
  spread: number;
  imb5: number;
  imb20: number;
  buyUsd: number;
  sellUsd: number;
  trades: number;
  book: boolean;
  tradesFeed: boolean;
}

interface PendingFlow {
  minute: number;
  usd: number;
  taker: "buy" | "sell";
}

interface ProductTape {
  bookUp: boolean;
  tradesUp: boolean;
  /** Clock when this feed last became up. Null while down. Carry requires both to be <= the minute start. */
  bookUpSince: number | null;
  tradesUpSince: number | null;
  snapshot: boolean;
  /** Minute start that `heartbeatAtMs` falls in. A later minute's beat is stored only after this minute is sealed. */
  heartbeatMinuteTs: number | null;
  heartbeatAtMs: number | null;
  /** Timestamp of the latest socket close or heartbeat-gap fire. Judged per minute on [T, T+60000). */
  downMs: number | null;
  lastMid: number | null;
  lastSpread: number;
  lastImb5: number;
  lastImb20: number;
  lastView: BookView | null;
  carryStreak: number;
  nextTs: number | null;
  forming: FormingMinute | null;
  minutes: StoredJevMinute[];
  absent: Map<number, JevFeedGap>;
  pending: PendingFlow[];
  features: FeatureAccumulator;
  ring: { ts: number; mid: number }[];
}

const RING_MAX = 20_000;

export function liquidityTier(pair: string): "btc" | "major" | "other" {
  if (pair === "BTC-USD") return "btc";
  if (pair === "ETH-USD" || pair === "SOL-USD") return "major";
  return "other";
}

/** Open-position pairs, then BTC once. */
export function scheduledPairs(openPairs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of openPairs) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (!seen.has("BTC-USD")) out.push("BTC-USD");
  return out;
}

/** Two-sided book view. Levels are the full map, best first. A one-sided book is not a mid. */
export function bookView(book: { bids: Map<string, number>; asks: Map<string, number> }): BookView | null {
  const bids: Array<[number, number]> = [];
  const asks: Array<[number, number]> = [];
  for (const [price, qty] of book.bids) {
    const px = Number(price);
    if (qty > 0 && px > 0) bids.push([px, qty]);
  }
  for (const [price, qty] of book.asks) {
    const px = Number(price);
    if (qty > 0 && px > 0) asks.push([px, qty]);
  }
  bids.sort((a, b) => b[0] - a[0]);
  asks.sort((a, b) => a[0] - b[0]);
  if (bids.length === 0 || asks.length === 0) return null;
  const bid = bids[0]![0];
  const ask = asks[0]![0];
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  const spreadBps = ((ask - bid) / mid) * 10_000;
  return {
    bidsDesc: () => bids,
    asksAsc: () => asks,
    mid: () => mid,
    spreadBps: () => spreadBps,
  };
}

/** Verbatim cb/feed.ts midAt on an array ring. */
export function midAt(ring: readonly { ts: number; mid: number }[], targetTs: number): number | null {
  if (ring.length === 0) return null;
  let lo = 0;
  let hi = ring.length - 1;
  if (targetTs <= ring[0]!.ts) return ring[0]!.mid;
  if (targetTs >= ring[hi]!.ts) return ring[hi]!.mid;
  while (lo < hi) {
    const midIdx = (lo + hi + 1) >> 1;
    if (ring[midIdx]!.ts <= targetTs) lo = midIdx;
    else hi = midIdx - 1;
  }
  return ring[lo]!.mid;
}

/** Verbatim cb/feed.ts returnBps. `nowMid` is the live book mid. */
export function returnBpsFromRing(ring: readonly { ts: number; mid: number }[], nowMid: number | null, sec: number, now: number): number {
  const then = midAt(ring, now - sec * 1000);
  const midNow = nowMid ?? midAt(ring, now);
  if (then === null || midNow === null || then === 0) return 0;
  return ((midNow - then) / then) * 10_000;
}

/** A heartbeat covers minute T only when its own timestamp is in [T, T+60000). T+60000 belongs to the next minute. */
function heartbeatCovers(atMs: number | null, minuteTs: number): boolean {
  if (atMs == null) return false;
  return atMs >= minuteTs && atMs < minuteTs + JEV_MINUTE_MS;
}

function downDuring(downMs: number | null, minuteTs: number): boolean {
  return downMs != null && downMs >= minuteTs && downMs < minuteTs + JEV_MINUTE_MS;
}

/** no_book_feed if any missing slot was book-down or never seen, otherwise no_trades_feed. */
function missingSlotSub(bookDownOrUnseen: boolean, tradesDown: boolean): "no_book_feed" | "no_trades_feed" | undefined {
  if (bookDownOrUnseen) return "no_book_feed";
  if (tradesDown) return "no_trades_feed";
  return undefined;
}

function freshProduct(): ProductTape {
  return {
    bookUp: false,
    tradesUp: false,
    bookUpSince: null,
    tradesUpSince: null,
    snapshot: false,
    heartbeatMinuteTs: null,
    heartbeatAtMs: null,
    downMs: null,
    lastMid: null,
    lastSpread: 0,
    lastImb5: 0,
    lastImb20: 0,
    lastView: null,
    carryStreak: 0,
    nextTs: null,
    forming: null,
    minutes: [],
    absent: new Map(),
    pending: [],
    features: new FeatureAccumulator(),
    ring: [],
  };
}

export class JevTape {
  private readonly products = new Map<string, ProductTape>();

  private row(productId: string): ProductTape {
    let row = this.products.get(productId);
    if (!row) {
      row = freshProduct();
      this.products.set(productId, row);
    }
    return row;
  }

  /**
   * A heartbeat confirms the trades feed only. The book feed returns on a two-sided level2 event.
   * Minutes that have already ended are sealed before this beat is stored, so a beat at or after
   * T+60000 is evidence for the next minute and cannot cover the one that just ended.
   */
  heartbeat(nowMs: number, productIds: readonly string[]): void {
    for (const productId of productIds) {
      const row = this.row(productId);
      const minute = Math.floor(nowMs / JEV_MINUTE_MS) * JEV_MINUTE_MS;
      this.sealUntil(row, productId, minute, nowMs);
      row.heartbeatMinuteTs = minute;
      row.heartbeatAtMs = nowMs;
      row.tradesUp = true;
      if (row.tradesUpSince == null) row.tradesUpSince = nowMs;
    }
  }

  /** The shard socket closed or the heartbeat gap fired. A minute already ended is sealed first. */
  feedDown(nowMs: number, productIds: readonly string[]): void {
    for (const productId of productIds) {
      const row = this.products.get(productId);
      if (!row) continue;
      this.sealUntil(row, productId, Math.floor(nowMs / JEV_MINUTE_MS) * JEV_MINUTE_MS, nowMs);
      row.bookUp = false;
      row.tradesUp = false;
      row.bookUpSince = null;
      row.tradesUpSince = null;
      row.heartbeatMinuteTs = null;
      row.heartbeatAtMs = null;
      row.downMs = nowMs;
    }
  }

  onBook(productId: string, nowMs: number, book: { bids: Map<string, number>; asks: Map<string, number> }): void {
    const view = bookView(book);
    if (!view) return;
    const mid = view.mid();
    if (mid == null) return;
    const row = this.row(productId);
    const minute = Math.floor(nowMs / JEV_MINUTE_MS) * JEV_MINUTE_MS;
    this.sealUntil(row, productId, minute, nowMs);
    row.snapshot = true;
    row.bookUp = true;
    if (row.bookUpSince == null) row.bookUpSince = nowMs;
    row.lastView = view;
    row.features.onBook(nowMs, view);
    row.ring.push({ ts: nowMs, mid });
    if (row.ring.length > RING_MAX) row.ring.splice(0, row.ring.length - RING_MAX);
    const spread = view.spreadBps() ?? 0;
    const imb5 = topImbalance(view.bidsDesc(), view.asksAsc(), 5);
    const imb20 = topImbalance(view.bidsDesc(), view.asksAsc(), 20);
    row.lastMid = mid;
    row.lastSpread = spread;
    row.lastImb5 = imb5;
    row.lastImb20 = imb20;
    this.openForming(row, minute, mid, spread, imb5, imb20);
  }

  onTrade(productId: string, tsMs: number, price: number, size: number, makerSide: string): void {
    if (!(price > 0) || !(size > 0)) return;
    if (makerSide !== "BUY" && makerSide !== "SELL") return;
    const row = this.row(productId);
    const minute = Math.floor(tsMs / JEV_MINUTE_MS) * JEV_MINUTE_MS;
    const openTs = row.nextTs ?? row.forming?.ts ?? null;
    if (openTs != null && minute > openTs && minute - openTs <= JEV_MINUTE_MS) this.sealUntil(row, productId, minute, tsMs);
    row.tradesUp = true;
    if (row.tradesUpSince == null) row.tradesUpSince = tsMs;
    const taker = makerSide === "BUY" ? "sell" : "buy";
    row.features.onTrade(tsMs, size, taker);
    const usd = price * size;
    if (row.nextTs != null && minute < row.nextTs) return;
    if (row.forming?.ts === minute) {
      this.addFlow(row.forming, usd, taker);
      return;
    }
    row.pending.push({ minute, usd, taker });
  }

  closeThrough(productId: string, nowMs: number): void {
    const row = this.products.get(productId);
    if (!row) return;
    this.sealUntil(row, productId, Math.floor(nowMs / JEV_MINUTE_MS) * JEV_MINUTE_MS, nowMs);
  }

  /** Seal every minute that has already ended. The drive tick calls this on each pace. */
  sealDue(nowMs: number): void {
    const end = Math.floor(nowMs / JEV_MINUTE_MS) * JEV_MINUTE_MS;
    for (const [productId, row] of this.products) this.sealUntil(row, productId, end, nowMs);
  }

  assess(productId: string, barStartMs: number): JevWindow {
    const row = this.products.get(productId);
    const end = barStartMs + JEV_WINDOW_MS;
    const minutes = (row?.minutes ?? []).filter((bar) => bar.live && bar.ts >= barStartMs && bar.ts < end);
    const slot14 = barStartMs + JEV_SLOT_LAST * JEV_MINUTE_MS;
    const present = new Set(minutes.map((bar) => bar.ts));
    if (minutes.length >= JEV_MIN_PRESENT && present.has(slot14)) {
      return { ok: true, minutes: minutes.map(publicMinute) };
    }
    let bookDownOrUnseen = false;
    let tradesDown = false;
    for (let i = 0; i < 15; i += 1) {
      const ts = barStartMs + i * JEV_MINUTE_MS;
      if (present.has(ts)) continue;
      const gap = row?.absent.get(ts) ?? "no_book_feed";
      if (gap === "no_book_feed") bookDownOrUnseen = true;
      else if (gap === "no_trades_feed") tradesDown = true;
    }
    const sub = missingSlotSub(bookDownOrUnseen, tradesDown);
    return { ok: false, minutes: minutes.map(publicMinute), ...(sub ? { sub } : {}) };
  }

  marketState(productId: string, nowMs: number): MarketState | null {
    const row = this.products.get(productId);
    if (!row?.lastView) return null;
    const view = row.lastView;
    return buildState(
      {
        book: () => view,
        returnBps: (_pair, sec, now) => returnBpsFromRing(row.ring, view.mid(), sec, now ?? nowMs),
        featureSnapshot: () => row.features.snapshot(JEV_HORIZON_SEC),
      },
      productId,
      "flat",
      { horizonSec: JEV_HORIZON_SEC, makerFeeBps: 0, takerFeeBps: 0 },
      nowMs,
    );
  }

  /** Audit rows. Restored rows stay non-live so they cannot authorize a call. */
  exportMinutes(): StoredJevMinute[] {
    const byProduct = new Map<string, StoredJevMinute[]>();
    for (const [productId, row] of this.products) {
      if (row.minutes.length === 0) continue;
      byProduct.set(productId, row.minutes.slice(-JEV_PERSIST_MINUTES));
    }
    const ids = [...byProduct.keys()].sort((a, b) => {
      const aLive = (byProduct.get(a) ?? []).some((bar) => bar.live) ? 1 : 0;
      const bLive = (byProduct.get(b) ?? []).some((bar) => bar.live) ? 1 : 0;
      if (aLive !== bLive) return bLive - aLive;
      return a < b ? -1 : 1;
    });
    const out: StoredJevMinute[] = [];
    for (const id of ids.slice(0, JEV_PERSIST_PRODUCTS)) out.push(...(byProduct.get(id) ?? []));
    return out;
  }

  importMinutes(rows: readonly StoredJevMinute[]): void {
    for (const row of rows) {
      if (!row || typeof row.productId !== "string" || !(row.ts > 0)) continue;
      const tape = this.row(row.productId);
      if (tape.minutes.some((bar) => bar.ts === row.ts)) continue;
      tape.minutes.push({ ...row, live: false });
    }
    for (const tape of this.products.values()) tape.minutes.sort((a, b) => a.ts - b.ts);
  }

  private openForming(row: ProductTape, minute: number, mid: number, spread: number, imb5: number, imb20: number): void {
    if (row.forming?.ts === minute) {
      const forming = row.forming;
      forming.high = Math.max(forming.high, mid);
      forming.low = Math.min(forming.low, mid);
      forming.close = mid;
      forming.spread = spread;
      forming.imb5 = imb5;
      forming.imb20 = imb20;
      forming.book = true;
      forming.tradesFeed = forming.tradesFeed || row.tradesUp;
      return;
    }
    const forming: FormingMinute = {
      ts: minute,
      high: mid,
      low: mid,
      close: mid,
      spread,
      imb5,
      imb20,
      buyUsd: 0,
      sellUsd: 0,
      trades: 0,
      book: true,
      tradesFeed: row.tradesUp,
    };
    const pending = row.pending.filter((flow) => flow.minute === minute);
    row.pending = row.pending.filter((flow) => flow.minute !== minute && flow.minute >= minute);
    for (const flow of pending) this.addFlow(forming, flow.usd, flow.taker);
    row.forming = forming;
  }

  private addFlow(forming: FormingMinute, usd: number, taker: "buy" | "sell"): void {
    if (taker === "buy") forming.buyUsd += usd;
    else forming.sellUsd += usd;
    forming.trades += 1;
    forming.tradesFeed = true;
  }

  private sealUntil(row: ProductTape, productId: string, endMs: number, nowMs: number): void {
    let ts = row.nextTs;
    if (ts == null) {
      if (row.forming) ts = row.forming.ts;
      else return;
    }
    while (ts < endMs) {
      this.sealOne(row, productId, ts, nowMs);
      ts += JEV_MINUTE_MS;
    }
    row.nextTs = ts;
    this.trim(row);
  }

  private sealOne(row: ProductTape, productId: string, ts: number, nowMs: number): void {
    if (downDuring(row.downMs, ts)) {
      if (row.forming?.ts === ts) row.forming = null;
      row.absent.set(ts, "no_book_feed");
      row.carryStreak = 0;
      return;
    }
    const forming = row.forming?.ts === ts ? row.forming : null;
    if (forming?.book) {
      row.forming = null;
      if (!forming.tradesFeed && !row.tradesUp) {
        row.absent.set(ts, "no_trades_feed");
        row.carryStreak = 0;
        return;
      }
      row.minutes.push({
        productId,
        ts,
        takerBuyUsd: forming.buyUsd,
        takerSellUsd: forming.sellUsd,
        trades: forming.trades,
        midClose: forming.close,
        midHigh: forming.high,
        midLow: forming.low,
        spreadBps: forming.spread,
        imbalance5: forming.imb5,
        imbalance20: forming.imb20,
        carried: false,
        live: true,
      });
      row.carryStreak = 0;
      return;
    }
    // Both feeds must have been up from T, and the covering heartbeat must itself fall in [T, T+60000).
    // A reconnect after feedDown starts a new up-since and does not carry the gap, including slot 14.
    const upWholeMinute =
      row.bookUp &&
      row.tradesUp &&
      row.bookUpSince != null &&
      row.bookUpSince <= ts &&
      row.tradesUpSince != null &&
      row.tradesUpSince <= ts;
    const beat = row.heartbeatMinuteTs === ts ? row.heartbeatAtMs : null;
    const covered = upWholeMinute && heartbeatCovers(beat, ts) && row.lastMid != null && row.carryStreak < JEV_CARRY_MAX;
    if (covered && row.lastMid != null) {
      row.minutes.push({
        productId,
        ts,
        takerBuyUsd: 0,
        takerSellUsd: 0,
        trades: 0,
        midClose: row.lastMid,
        midHigh: row.lastMid,
        midLow: row.lastMid,
        spreadBps: row.lastSpread,
        imbalance5: row.lastImb5,
        imbalance20: row.lastImb20,
        carried: true,
        live: true,
      });
      row.carryStreak += 1;
      return;
    }
    const bookWhole = row.snapshot && row.bookUp && row.bookUpSince != null && row.bookUpSince <= ts;
    const tradesWhole = row.tradesUp && row.tradesUpSince != null && row.tradesUpSince <= ts;
    // Sub-reason order: no_book_feed if the book was down or the minute was never seen, otherwise no_trades_feed.
    if (!bookWhole) row.absent.set(ts, "no_book_feed");
    else if (!tradesWhole) row.absent.set(ts, "no_trades_feed");
    else row.absent.set(ts, "carry_limit");
    row.carryStreak = 0;
  }

  private trim(row: ProductTape): void {
    if (row.minutes.length > 40) row.minutes.splice(0, row.minutes.length - 40);
    const newest = row.minutes.length > 0 ? row.minutes[row.minutes.length - 1]!.ts : row.nextTs;
    if (newest == null) return;
    const keepFrom = newest - 40 * JEV_MINUTE_MS;
    for (const ts of row.absent.keys()) if (ts < keepFrom) row.absent.delete(ts);
  }
}

function publicMinute(bar: StoredJevMinute): JevMinuteSummary {
  return {
    ts: bar.ts,
    takerBuyUsd: bar.takerBuyUsd,
    takerSellUsd: bar.takerSellUsd,
    trades: bar.trades,
    midClose: bar.midClose,
    midHigh: bar.midHigh,
    midLow: bar.midLow,
    spreadBps: bar.spreadBps,
    imbalance5: bar.imbalance5,
    imbalance20: bar.imbalance20,
    carried: bar.carried,
  };
}
