/**
 * 1m mid bars from 1s samples of the local L2 book, matching cb/feed.ts sample().
 * The Advanced Trade candles channel is 5-minute and is not a source of these bars.
 * PairBook follows cb/feed.ts. Features live in cb-port/features.ts, byte for byte.
 */

const DEPTH_BANDS_BPS = [10, 25, 50] as const;
const IMBALANCE_PCT = 0.01;

export interface DepthBands {
  [band: string]: { bid: number; ask: number };
}

/** A single pair's order book. `qty` <= 0 removes the level. */
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

  bidsDesc(): Array<[number, number]> {
    return [...this.bids].sort((a, b) => b[0] - a[0]);
  }

  asksAsc(): Array<[number, number]> {
    return [...this.asks].sort((a, b) => a[0] - b[0]);
  }

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
    for (const price of this.bids.keys()) if (best === null || price > best) best = price;
    return best;
  }

  bestAsk(): number | null {
    let best: number | null = null;
    for (const price of this.asks.keys()) if (best === null || price < best) best = price;
    return best;
  }

  mid(): number | null {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    return bid !== null && ask !== null ? (bid + ask) / 2 : null;
  }

  spreadBps(): number | null {
    const bid = this.bestBid();
    const ask = this.bestAsk();
    if (bid === null || ask === null) return null;
    const mid = (bid + ask) / 2;
    return mid > 0 ? ((ask - bid) / mid) * 10_000 : null;
  }

  imbalance(pct = IMBALANCE_PCT): number {
    const mid = this.mid();
    if (mid === null) return 0;
    let bid = 0;
    let ask = 0;
    const lo = mid * (1 - pct);
    const hi = mid * (1 + pct);
    for (const [price, qty] of this.bids) if (price >= lo) bid += qty;
    for (const [price, qty] of this.asks) if (price <= hi) ask += qty;
    const total = bid + ask;
    return total > 0 ? (bid - ask) / total : 0;
  }

  depthBands(bandsBps: readonly number[] = DEPTH_BANDS_BPS): DepthBands {
    const mid = this.mid();
    const out: DepthBands = {};
    for (const band of bandsBps) out[`${band}bps`] = { bid: 0, ask: 0 };
    if (mid === null) return out;
    for (const [price, qty] of this.bids) {
      const bps = ((mid - price) / mid) * 10_000;
      for (const band of bandsBps) if (bps <= band) out[`${band}bps`]!.bid += qty;
    }
    for (const [price, qty] of this.asks) {
      const bps = ((price - mid) / mid) * 10_000;
      for (const band of bandsBps) if (bps <= band) out[`${band}bps`]!.ask += qty;
    }
    return out;
  }
}

/** Coinbase `side` is the maker side. */
export function takerSideFromMaker(makerSide: string): "buy" | "sell" {
  return makerSide === "BUY" ? "sell" : "buy";
}

export const HEARTBEAT_GAP_MS = 15_000;
export const MISSING_MID_KILL = 0.05;

/** Exchange limit is not specified. The caller passes the shard size. */
/**
 * Architect's cap. Advanced Trade does not publish a products-per-message maximum.
 * The Exchange websocket limit is 10 subscriptions per product per channel.
 * One subscribe per product per channel stays inside that limit. A caller cannot
 * put more than 10 products on one socket.
 */
export const MAX_PRODUCTS_PER_SOCKET = 10;

export function shardProducts(ids: readonly string[], perSocket: number = MAX_PRODUCTS_PER_SOCKET): string[][] {
  if (!(perSocket > 0)) throw new Error("L2 shard size is not specified");
  const cap = Math.min(perSocket, MAX_PRODUCTS_PER_SOCKET);
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += cap) out.push(ids.slice(i, i + cap));
  return out;
}

/** Half the touch spread, in bps. s_live = 0.5 * (ask - bid) / mid * 1e4. */
export function halfSpreadBps(bid: number, ask: number): number | null {
  if (!(bid > 0) || !(ask >= bid)) return null;
  const mid = (bid + ask) / 2;
  if (!(mid > 0)) return null;
  return 0.5 * ((ask - bid) / mid) * 10_000;
}

/**
 * s_live for `size` units. Walking the touch returns the half spread. Walking
 * deeper levels returns the larger slippage versus mid.
 */
export function walkedSpreadBps(book: PairBook, side: "buy" | "sell", size: number): number | null {
  const bid = book.bidsDesc()[0]?.[0];
  const ask = book.asksAsc()[0]?.[0];
  if (bid == null || ask == null) return null;
  if (!(size > 0)) return halfSpreadBps(bid, ask);
  const mid = (bid + ask) / 2;
  const walked = book.walk(side, size);
  if (walked == null || !(mid > 0)) return halfSpreadBps(bid, ask);
  const slip = side === "buy" ? (walked - mid) / mid : (mid - walked) / mid;
  return Math.max(0, slip * 10_000);
}

export function heartbeatMustReconnect(lastHeartbeatMs: number, nowMs: number, gapMs = HEARTBEAT_GAP_MS): boolean {
  return nowMs - lastHeartbeatMs > gapMs;
}

export interface MidBar {
  productId: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeBase: number;
}

interface FormingMid {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeBase: number;
}

export interface MidBook {
  forming: Record<string, FormingMid | null>;
  completed: MidBar[];
}

export function freshMidBook(): MidBook {
  return { forming: {}, completed: [] };
}

/**
 * One sample, as Feed.sample rolls a minute: the previous minute completes
 * when `nowMs` enters a new minute. A null mid does not open a bar.
 */
export function applyMidSample(state: MidBook, sample: { productId: string; nowMs: number; bid: number; ask: number; tradeVolume?: number }): { completed: MidBar | null } {
  const book = new PairBook();
  if (sample.bid > 0) book.set("bid", sample.bid, 1);
  if (sample.ask > 0) book.set("offer", sample.ask, 1);
  const mid = book.mid();
  const minuteTs = Math.floor(sample.nowMs / 60_000) * 60_000;
  const volume = sample.tradeVolume ?? 0;
  if (mid === null) return { completed: null };
  let bar = state.forming[sample.productId] ?? null;
  let completed: MidBar | null = null;
  if (bar && bar.ts !== minuteTs) {
    completed = { productId: sample.productId, ...bar };
    state.completed.push(completed);
    bar = null;
  }
  if (!bar) bar = { ts: minuteTs, open: mid, high: mid, low: mid, close: mid, volumeBase: 0 };
  bar.high = Math.max(bar.high, mid);
  bar.low = Math.min(bar.low, mid);
  bar.close = mid;
  bar.volumeBase += volume;
  state.forming[sample.productId] = bar;
  return { completed };
}

/** Missing minutes at or above 5 percent kill. The count is mid bars, not 5m candles. */
export function missingMidShare(expectedMinutes: number, presentMinutes: number): { missing: number; share: number; kill: boolean } {
  if (!(expectedMinutes > 0)) return { missing: 0, share: 0, kill: false };
  const missing = Math.max(0, expectedMinutes - presentMinutes);
  const share = missing / expectedMinutes;
  return { missing, share, kill: share >= MISSING_MID_KILL };
}
