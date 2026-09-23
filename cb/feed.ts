import { config } from "./config";
import type { Store } from "./db/store";
import { FeatureAccumulator, emptySnapshot, type FeatureSnapshot } from "./features";

/**
 * Coinbase Advanced Trade market-data feed for all configured pairs on one socket.
 *
 * Channels (all currently unauthenticated): `level2` (l2_data snapshots + updates), `market_trades`
 * (taker prints for CVD), `heartbeats` (liveness). Per pair it maintains a top-of-book + depth-band
 * book, a rolling trade tape for CVD, a 1/second mid ring buffer capped at 26 h, and persisted
 * minute bars so the resolver survives restarts. Reconnects with backoff and resyncs the book on the
 * next level2 snapshot; a heartbeat gap beyond 15 s forces a reconnect. Once a minute it cross-checks
 * the local book against the REST best bid/ask and logs divergence over a spread-scaled threshold.
 *
 * Mirrors the role of src/book.ts + src/trades.ts for the demo, so the MarketState the model later
 * sees is structurally familiar.
 *
 * `Feed.incidents` (SENIOR-DEV-REPORT-2026-09-19.md item 1) only counts signals that indicate an
 * actual feed defect: WS reconnects, heartbeat-gap forced reconnects, mid-stream book resyncs
 * (outside of the initial sync), and REST/WS mid divergence that persists across two consecutive
 * checks of the same pair. A single divergent check is still logged for diagnostics but not
 * counted, since on volatile/wide-spread pairs ordinary timing skew between the two samples
 * routinely exceeds a fixed bps threshold without indicating anything wrong with the feed.
 */

const DEPTH_BANDS_BPS = [10, 25, 50] as const;
const IMBALANCE_PCT = 0.01;
const MID_RING_MS = 26 * 60 * 60 * 1000; // 26 h covers the 24 h measured horizon
const TAPE_MS = 90 * 60 * 1000; // keep 90 min of prints
const HEARTBEAT_GAP_MS = 15_000;
const DIVERGENCE_BPS = 5;

/** Divergence incident threshold: the fixed floor, or 2x the pair's own live spread, whichever is
 *  wider. A pair with a 10 bps spread routinely shows >5 bps of local/REST timing skew with no
 *  feed defect at all; scaling to the spread keeps the check meaningful on volatile pairs. */
export function divergenceThreshold(spreadBps: number | null, baseBps: number = DIVERGENCE_BPS): number {
  const spread = spreadBps != null && spreadBps > 0 ? spreadBps : 0;
  return Math.max(baseBps, 2 * spread);
}

export interface DepthBands {
  [band: string]: { bid: number; ask: number };
}

export interface TapeSummary {
  count: number;
  buyBase: number;
  sellBase: number;
  cvdBase: number;
  vwap: number | null;
  lastPrice: number | null;
  lastSide: "buy" | "sell" | null;
}

export interface PairFeedState {
  pair: string;
  mid: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  levels: number;
  synced: boolean;
  lastTradeTs: number | null;
}

export interface TradePrint {
  ts: number;
  price: number;
  size: number;
  takerSide: "buy" | "sell";
}

interface MinuteBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_base: number;
}

/** A single pair's order book. `new_quantity` is absolute per Coinbase; "0" removes the level. */
export class PairBook {
  private bids = new Map<number, number>();
  private asks = new Map<number, number>();

  clear(): void {
    this.bids.clear();
    this.asks.clear();
  }

  set(side: "bid" | "offer", price: number, qty: number): void {
    const book = side === "bid" ? this.bids : this.asks;
    if (qty <= 0) book.delete(price);
    else book.set(price, qty);
  }

  levelCount(): number {
    return this.bids.size + this.asks.size;
  }

  /** Bids best (highest) first. */
  bidsDesc(): Array<[number, number]> {
    return [...this.bids].sort((a, b) => b[0] - a[0]);
  }

  /** Asks best (lowest) first. */
  asksAsc(): Array<[number, number]> {
    return [...this.asks].sort((a, b) => a[0] - b[0]);
  }

  /**
   * Average execution price to take `size` base units immediately, walking the book from the touch.
   * `side` is our aggressor side: "buy" walks asks, "sell" walks bids. Returns the touch price if
   * the book cannot fill the full size (paper: we do not model beyond visible liquidity).
   */
  walk(side: "buy" | "sell", size: number): number | null {
    const levels = side === "buy" ? this.asksAsc() : this.bidsDesc();
    if (levels.length === 0) return null;
    let remaining = size;
    let cost = 0;
    for (const [price, qty] of levels) {
      const take = Math.min(remaining, qty);
      cost += take * price;
      remaining -= take;
      if (remaining <= 1e-12) break;
    }
    const filled = size - Math.max(0, remaining);
    return filled > 0 ? cost / filled : levels[0]![0];
  }

  bestBid(): number | null {
    let best: number | null = null;
    for (const p of this.bids.keys()) if (best === null || p > best) best = p;
    return best;
  }

  bestAsk(): number | null {
    let best: number | null = null;
    for (const p of this.asks.keys()) if (best === null || p < best) best = p;
    return best;
  }

  mid(): number | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    return b !== null && a !== null ? (b + a) / 2 : null;
  }

  spreadBps(): number | null {
    const b = this.bestBid();
    const a = this.bestAsk();
    if (b === null || a === null) return null;
    const mid = (b + a) / 2;
    return mid > 0 ? ((a - b) / mid) * 10_000 : null;
  }

  /** Signed book imbalance within `pct` of mid: (bid - ask) / (bid + ask), -1..1. */
  imbalance(pct = IMBALANCE_PCT): number {
    const mid = this.mid();
    if (mid === null) return 0;
    let bid = 0;
    let ask = 0;
    const lo = mid * (1 - pct);
    const hi = mid * (1 + pct);
    for (const [p, q] of this.bids) if (p >= lo) bid += q;
    for (const [p, q] of this.asks) if (p <= hi) ask += q;
    const total = bid + ask;
    return total > 0 ? (bid - ask) / total : 0;
  }

  /** Cumulative resting base size within each band (bps) of mid, per side. */
  depthBands(bandsBps: readonly number[] = DEPTH_BANDS_BPS): DepthBands {
    const mid = this.mid();
    const out: DepthBands = {};
    for (const band of bandsBps) out[`${band}bps`] = { bid: 0, ask: 0 };
    if (mid === null) return out;
    for (const [p, q] of this.bids) {
      const bps = ((mid - p) / mid) * 10_000;
      for (const band of bandsBps) if (bps <= band) out[`${band}bps`]!.bid += q;
    }
    for (const [p, q] of this.asks) {
      const bps = ((p - mid) / mid) * 10_000;
      for (const band of bandsBps) if (bps <= band) out[`${band}bps`]!.ask += q;
    }
    return out;
  }
}

/** Summarize a trade tape over the last `windowSec` seconds. `takerSide` drives CVD. */
export function summarizeTape(tape: TradePrint[], windowSec: number, now = Date.now()): TapeSummary {
  const min = now - windowSec * 1000;
  let count = 0;
  let buyBase = 0;
  let sellBase = 0;
  let notional = 0;
  let lastPrice: number | null = null;
  let lastSide: "buy" | "sell" | null = null;
  for (const t of tape) {
    if (t.ts < min) continue;
    count++;
    if (t.takerSide === "buy") buyBase += t.size;
    else sellBase += t.size;
    notional += t.size * t.price;
    lastPrice = t.price;
    lastSide = t.takerSide;
  }
  const vol = buyBase + sellBase;
  return { count, buyBase, sellBase, cvdBase: buyBase - sellBase, vwap: vol > 0 ? notional / vol : null, lastPrice, lastSide };
}

export class Feed {
  private ws: WebSocket | null = null;
  private books = new Map<string, PairBook>();
  private tapes = new Map<string, TradePrint[]>();
  private fresh = new Map<string, TradePrint[]>(); // prints since the last drainPrints, for paper fills
  private mids = new Map<string, { ts: number; mid: number }[]>();
  private features = new Map<string, FeatureAccumulator>();
  private curBar = new Map<string, MinuteBar | null>();
  private volAccum = new Map<string, number>();
  private lastTrade = new Map<string, number>();
  private synced = new Set<string>();
  private everSynced = new Set<string>(); // pairs that have received at least one snapshot ever
  private lastDivergent = new Map<string, boolean>(); // per pair: was the previous check over threshold?
  private hasConnectedOnce = false; // true once the current/prior connection has successfully opened
  private lastHeartbeat = 0;
  private backoffMs = 1_000;
  private closed = false;
  private sampler: ReturnType<typeof setInterval> | null = null;
  private divergenceTimer: ReturnType<typeof setInterval> | null = null;
  private divergenceIdx = 0;
  incidents = 0;

  constructor(
    private readonly pairs: string[],
    private readonly store: Store | null,
    private readonly onIncident: (msg: string) => void = (m) => console.warn(`[feed incident] ${m}`),
  ) {
    for (const p of pairs) {
      this.books.set(p, new PairBook());
      this.tapes.set(p, []);
      this.fresh.set(p, []);
      this.mids.set(p, []);
      this.features.set(p, new FeatureAccumulator());
      this.curBar.set(p, null);
      this.volAccum.set(p, 0);
    }
  }

  start(): void {
    this.connect();
    this.sampler = setInterval(() => this.sample(), 1_000);
    this.divergenceTimer = setInterval(() => this.checkDivergence(), 60_000 / Math.max(1, this.pairs.length));
  }

  stop(): void {
    this.closed = true;
    if (this.sampler) clearInterval(this.sampler);
    if (this.divergenceTimer) clearInterval(this.divergenceTimer);
    this.ws?.close();
  }

  book(pair: string): PairBook | undefined {
    return this.books.get(pair);
  }

  /** Compact features for the model. Empty until the first book event. */
  featureSnapshot(pair: string, horizonSec: number): FeatureSnapshot {
    return this.features.get(pair)?.snapshot(horizonSec) ?? emptySnapshot();
  }

  /**
   * Entries require a synced book and a live socket. A quiet public tape is not a fault.
   * The 300ms staleness budget belongs to chain RPC, which this feed does not use.
   */
  feedHealthy(pair: string): boolean {
    return this.synced.has(pair) && this.ws?.readyState === WebSocket.OPEN;
  }

  state(pair: string): PairFeedState {
    const b = this.books.get(pair)!;
    return {
      pair,
      mid: b.mid(),
      bestBid: b.bestBid(),
      bestAsk: b.bestAsk(),
      spreadBps: b.spreadBps(),
      levels: b.levelCount(),
      synced: this.synced.has(pair),
      lastTradeTs: this.lastTrade.get(pair) ?? null,
    };
  }

  allState(): PairFeedState[] {
    return this.pairs.map((p) => this.state(p));
  }

  tapeSummary(pair: string, windowSec: number, now = Date.now()): TapeSummary {
    return summarizeTape(this.tapes.get(pair) ?? [], windowSec, now);
  }

  /** Taker prints for a pair since the last call (oldest first). Used to simulate maker fills. */
  drainPrints(pair: string): TradePrint[] {
    const out = this.fresh.get(pair) ?? [];
    this.fresh.set(pair, []);
    return out;
  }

  /** Interpolated (nearest at or before) mid at `targetTs` from the ring, or the oldest if before it. */
  midAt(pair: string, targetTs: number): number | null {
    const ring = this.mids.get(pair);
    if (!ring || ring.length === 0) return null;
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

  /** Signed return in bps over the last `sec` seconds, from the mid ring. */
  returnBps(pair: string, sec: number, now = Date.now()): number {
    const then = this.midAt(pair, now - sec * 1000);
    const nowMid = this.books.get(pair)?.mid() ?? this.midAt(pair, now);
    if (then === null || nowMid === null || then === 0) return 0;
    return ((nowMid - then) / then) * 10_000;
  }

  /** `count` mids sampled evenly over the last `spanSec`, oldest..newest. */
  recentMidsSample(pair: string, count: number, spanSec: number, now = Date.now()): number[] {
    const out: number[] = [];
    for (let i = count - 1; i >= 0; i--) {
      const ts = now - (spanSec * 1000 * i) / (count - 1 || 1);
      const m = this.midAt(pair, ts);
      if (m !== null) out.push(m);
    }
    return out;
  }

  // --- socket ----------------------------------------------------------------

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(config.coinbaseWsUrl);
    this.ws = ws;
    ws.onopen = () => {
      this.backoffMs = 1_000;
      this.lastHeartbeat = Date.now();
      this.hasConnectedOnce = true;
      ws.send(JSON.stringify({ type: "subscribe", channel: "level2", product_ids: this.pairs }));
      ws.send(JSON.stringify({ type: "subscribe", channel: "market_trades", product_ids: this.pairs }));
      ws.send(JSON.stringify({ type: "subscribe", channel: "heartbeats" }));
    };
    ws.onmessage = (e) => this.onMessage(String((e as MessageEvent).data));
    ws.onerror = () => ws.close();
    ws.onclose = () => {
      this.synced.clear(); // force a fresh snapshot on reconnect
      this.noteDisconnect();
      if (this.closed) return;
      setTimeout(() => this.connect(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 10_000);
    };
  }

  /** Counts a genuine feed defect: a socket that had successfully connected before just dropped.
   *  A close before the first successful open (e.g. initial connection refused) is not counted -
   *  that is startup flakiness, not an established feed going bad. */
  private noteDisconnect(): void {
    if (!this.hasConnectedOnce) return;
    this.hasConnectedOnce = false;
    this.incidents++;
    this.onIncident("ws disconnected, reconnecting (incident)");
  }

  private onMessage(raw: string): void {
    let msg: any;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.channel) {
      case "l2_data":
        for (const ev of msg.events ?? []) this.onL2(ev);
        break;
      case "market_trades":
        for (const ev of msg.events ?? []) this.onTrades(ev);
        break;
      case "heartbeats":
        this.lastHeartbeat = Date.now();
        break;
      case "subscriptions":
        break;
      default:
        if (msg.type === "error") this.onIncident(`ws error: ${msg.message ?? raw.slice(0, 200)}`);
    }
  }

  private onL2(ev: any): void {
    const pair: string = ev.product_id;
    const book = this.books.get(pair);
    if (!book) return;
    if (ev.type === "snapshot") {
      book.clear();
      // A fresh snapshot while this pair was already synced on the current connection means the
      // server (or we) decided the book needed resyncing mid-stream, without a WS drop - a
      // genuine feed defect distinct from the ordinary post-reconnect resync (already counted by
      // noteDisconnect). Only counts once we've seen a real startup sync for this pair.
      if (this.synced.has(pair) && this.everSynced.has(pair)) {
        this.incidents++;
        this.onIncident(`${pair} book resync mid-stream (incident)`);
      }
      this.synced.add(pair);
      this.everSynced.add(pair);
    }
    for (const u of ev.updates ?? []) {
      book.set(u.side, Number(u.price_level), Number(u.new_quantity));
    }
    this.features.get(pair)?.onBook(Date.now(), book);
  }

  private onTrades(ev: any): void {
    for (const t of ev.trades ?? []) {
      const pair: string = t.product_id;
      const tape = this.tapes.get(pair);
      if (!tape) continue;
      // Coinbase `side` is the maker's side, so the taker aggressor is the opposite.
      const takerSide: "buy" | "sell" = t.side === "BUY" ? "sell" : "buy";
      const size = Number(t.size);
      const price = Number(t.price);
      const ts = Date.parse(t.time) || Date.now();
      const print = { ts, price, size, takerSide };
      tape.push(print);
      this.fresh.get(pair)?.push(print);
      this.features.get(pair)?.onTrade(ts, size, takerSide);
      this.volAccum.set(pair, (this.volAccum.get(pair) ?? 0) + size);
      this.lastTrade.set(pair, ts);
    }
  }

  // --- sampling + persistence ------------------------------------------------

  private sample(): void {
    const now = Date.now();
    if (this.ws && this.ws.readyState === WebSocket.OPEN && now - this.lastHeartbeat > HEARTBEAT_GAP_MS) {
      this.onIncident(`heartbeat gap ${Math.round((now - this.lastHeartbeat) / 1000)}s, reconnecting`);
      this.lastHeartbeat = now;
      this.ws.close();
      return;
    }
    const minuteTs = Math.floor(now / 60_000) * 60_000;
    for (const pair of this.pairs) {
      const book = this.books.get(pair)!;
      this.features.get(pair)?.onBook(now, book);
      const mid = book.mid();
      const vol = this.volAccum.get(pair) ?? 0;
      this.volAccum.set(pair, 0);
      if (mid === null) continue;

      const ring = this.mids.get(pair)!;
      ring.push({ ts: now, mid });
      const cutoff = now - MID_RING_MS;
      while (ring.length > 1 && ring[0]!.ts < cutoff) ring.shift();

      const tape = this.tapes.get(pair)!;
      const tapeCut = now - TAPE_MS;
      while (tape.length > 0 && tape[0]!.ts < tapeCut) tape.shift();

      let bar = this.curBar.get(pair) ?? null;
      if (bar && bar.ts !== minuteTs) {
        this.persistBar(pair, bar);
        bar = null;
      }
      if (!bar) bar = { ts: minuteTs, open: mid, high: mid, low: mid, close: mid, volume_base: 0 };
      bar.high = Math.max(bar.high, mid);
      bar.low = Math.min(bar.low, mid);
      bar.close = mid;
      bar.volume_base += vol;
      this.curBar.set(pair, bar);
    }
  }

  private persistBar(pair: string, bar: MinuteBar): void {
    this.store?.upsertBar({ pair, ...bar }).catch((e) => this.onIncident(`bar upsert ${pair}: ${(e as Error).message}`));
  }

  private async checkDivergence(): Promise<void> {
    if (this.pairs.length === 0) return;
    const pair = this.pairs[this.divergenceIdx % this.pairs.length]!;
    this.divergenceIdx++;
    const book = this.books.get(pair);
    const localMid = book?.mid();
    if (localMid == null) return;
    try {
      const res = await fetch(`${config.coinbaseRestUrl}/api/v3/brokerage/market/products/${pair}`);
      if (!res.ok) return;
      const p: any = await res.json();
      const bid = Number(p.best_bid ?? p.price);
      const ask = Number(p.best_ask ?? p.price);
      const restMid = bid && ask ? (bid + ask) / 2 : Number(p.price);
      if (!restMid) return;
      const diffBps = (Math.abs(localMid - restMid) / restMid) * 10_000;
      const threshold = divergenceThreshold(book?.spreadBps() ?? null);
      const over = diffBps > threshold;
      const wasOver = this.lastDivergent.get(pair) ?? false;
      if (over) {
        // Always log for diagnostics; only count once it persists across two consecutive checks
        // of the same pair - a genuinely stale book stays diverged, ordinary timing skew does not.
        this.onIncident(
          `${pair} book diverges from REST by ${diffBps.toFixed(1)} bps (threshold ${threshold.toFixed(1)}, local ${localMid}, rest ${restMid})${wasOver ? " (incident)" : ""}`,
        );
        if (wasOver) this.incidents++;
      }
      this.lastDivergent.set(pair, over);
    } catch {
      // network hiccup; not an incident on its own
    }
  }
}
