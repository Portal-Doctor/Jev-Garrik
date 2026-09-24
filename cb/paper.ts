import { findBook } from "./books";
import { Accounting, feeUsd } from "./accounting";
import type { PairBook, TradePrint } from "./feed";
import type { Broker, OrderIntent } from "./engine";
import type { Action } from "./model";
import type { Store } from "./db/store";
import { guardTrip } from "./gate";
import { killSwitch } from "./kill";

/**
 * Paper broker: simulates the execution policy against the real feed and keeps a fee-inclusive
 * ledger. An honesty haircut stands in for unknown queue position:
 *
 * - Entry: post-only, one tick inside the touch, clamped so a buy never reaches the ask and a
 *   sell never reaches the bid. Reprice if that quote moves more than `repriceTicks`. An entry
 *   that is still open after `entryTimeoutSec` is canceled. Entries never taker-convert.
 * - A resting maker order is eligible one second after placement (models propagation), then fills
 *   when a print crosses it: a taker sell at or below our bid, a taker buy at or above our ask.
 *   Fill size is `min(remaining, printSize * fillHaircut)`. The haircut is the single biggest
 *   paper-vs-live gap: we cannot know our queue position, so we take only part of each print.
 * - Exit at horizon expiry uses the same ladder, but taker conversion is mandatory: an unresolved
 *   exit would corrupt measurement.
 * - Every fill is venue "paper" with a synthetic external_id, its liquidity flag, and the fee
 *   actually charged, then flows through the same accounting a live fill would.
 */

/** Does a taker print cross our resting order? bid filled by a taker sell at/below; ask by a taker buy at/above. */
export function crosses(orderSide: "buy" | "sell", orderPrice: number, print: TradePrint): boolean {
  return orderSide === "buy"
    ? print.takerSide === "sell" && print.price <= orderPrice
    : print.takerSide === "buy" && print.price >= orderPrice;
}

/** How much of a crossing print we capture as a maker: min(remaining, printSize * haircut). */
export function makerFillSize(remaining: number, printSize: number, haircut: number): number {
  return Math.min(remaining, printSize * haircut);
}

/**
 * One tick inside the touch. A buy that would reach the ask stays on the bid.
 * A sell that would reach the bid stays on the ask. `tick` is the product quote increment.
 */
export function insideTouchPrice(side: "buy" | "sell", bid: number, ask: number, tick: number): number {
  if (!(bid > 0) || !(ask > 0) || !(tick > 0) || ask <= bid) return side === "buy" ? bid : ask;
  const bidU = Math.round(bid / tick);
  const askU = Math.round(ask / tick);
  let p = side === "buy" ? bidU + 1 : askU - 1;
  if (side === "buy" && p >= askU) p = bidU;
  if (side === "sell" && p <= bidU) p = askU;
  return p * tick;
}

export type OrderPurpose = "entry" | "exit" | "stop" | "take_profit";

interface OpenOrder {
  id: string;
  side: "buy" | "sell";
  purpose: OrderPurpose;
  price: number;
  remaining: number;
  createdAt: number;
  eligibleAt: number;
  decisionId: string | null;
  /** Mid when the order was placed. Slippage is measured against this, not an older decision. */
  refMid: number | null;
}

/** Minimal feed surface the broker needs; the real Feed satisfies it, and tests can fake it. */
export interface FeedLike {
  book(pair: string): PairBook | undefined;
  drainPrints(pair: string): TradePrint[];
}

export interface PaperOpts {
  notionalUsd: number;
  makerFeeBps: number;
  takerFeeBps: number;
  fillHaircut: number;
  entryTimeoutSec: number;
  repriceTicks: number;
  horizonSec: number;
  bankrollUsd: number;
  /** Kept for config compatibility. Entries never cross, whatever this is set to. */
  neverCrossEntry?: boolean;
  stopLossBps?: number;
  takeProfitBps?: number;
  /** Book-level cap on open longs plus resting entries. Omit to leave size uncapped. */
  maxGrossUsd?: number;
  /** Residual under this is not posted when the gross cap is on. */
  minSizeUsd?: number;
  /** Fill farther than this from `refMid` cancels the rest and blocks new entries. */
  maxSlippageBps?: number;
  /** When this returns false, resting entries are canceled and new entries are refused. */
  feedHealthy?: (pair: string) => boolean;
}

export interface FillEvent {
  pair: string;
  side: "buy" | "sell";
  purpose: OrderPurpose;
  price: number;
  sizeBase: number;
  feeUsd: number;
  liquidity: "maker" | "taker";
  ts: number;
}

const ELIGIBLE_DELAY_MS = 1_000;

export class PaperBroker implements Broker {
  private acct = new Map<string, Accounting>();
  private open = new Map<string, OpenOrder | null>();
  private horizonExpiresAt = new Map<string, number | null>();
  private ticks = new Map<string, number>();
  /** Fill-liquidity counters per pair, instrumenting how much entry edge is lost to taker fallback (PL-REVENUE-REVIEW.md 3.4). */
  private fillCounts = new Map<string, { maker: number; taker: number }>();
  private seq = 0;
  /** Latched by a fill that slipped too far from the placement mid. Exits still flatten. */
  private entryBlocked = new Map<string, boolean>();
  /** Buy notional reserved before the order row exists, so two pairs cannot both clear the cap. */
  private reservedUsd = new Map<string, number>();
  private stepping = new Map<string, boolean>();
  /** Per-instance token so synthetic external ids stay unique even if a runId is ever reused. */
  private readonly instance = crypto.randomUUID().slice(0, 8);
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private snapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pairs: string[],
    private readonly feed: FeedLike,
    private readonly store: Store,
    private readonly runId: string,
    private readonly opts: PaperOpts,
    private readonly onFill: (f: FillEvent) => void = () => {},
  ) {
    const perPairBankroll = opts.bankrollUsd / (pairs.length || 1);
    for (const p of pairs) {
      this.acct.set(p, new Accounting(perPairBankroll));
      this.open.set(p, null);
      this.horizonExpiresAt.set(p, null);
      this.fillCounts.set(p, { maker: 0, taker: 0 });
    }
  }

  async start(restUrl?: string): Promise<void> {
    if (restUrl) await this.loadTicks(restUrl);
    await this.restore();
    this.tickTimer = setInterval(() => this.tick(), 1_000);
    this.snapTimer = setInterval(() => void this.snapshot(), 60_000);
  }

  /** Replay paper fills and leftover orders so a container restart does not flatten inventory. */
  private async restore(): Promise<void> {
    const fills = await this.store.fillsByVenue("paper");
    const lastEntryAt = new Map<string, number>();
    for (const f of fills) {
      const acct = this.acct.get(f.pair);
      if (!acct) continue;
      acct.apply({
        side: f.side,
        sizeBase: Number(f.size_base),
        notionalUsd: Number(f.notional_usd),
        feeUsd: Number(f.fee_usd),
      });
      const counts = this.fillCounts.get(f.pair);
      if (counts) counts[f.liquidity === "taker" ? "taker" : "maker"]++;
      if (f.side === "buy") lastEntryAt.set(f.pair, Number(f.traded_at));
    }
    for (const [pair, ts] of lastEntryAt) {
      if (this.positionOf(pair) === "long") {
        this.horizonExpiresAt.set(pair, ts + this.opts.horizonSec * 1000);
      }
    }
    const opens = await this.store.openOrdersForVenue("paper");
    for (const o of opens) {
      if (!this.acct.has(o.pair)) continue;
      this.open.set(o.pair, {
        id: o.id,
        side: o.side,
        purpose: o.purpose,
        price: Number(o.price),
        remaining: Number(o.size_base),
        createdAt: Number(o.created_at),
        eligibleAt: Number(o.created_at) + ELIGIBLE_DELAY_MS,
        decisionId: o.decision_id,
        refMid: null,
      });
    }
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.snapTimer) clearInterval(this.snapTimer);
  }

  // --- Broker interface ------------------------------------------------------

  positionOf(pair: string): "long" | "flat" {
    return (this.acct.get(pair)?.positionBase ?? 0) > 0 ? "long" : "flat";
  }

  /** Mark of every open long, plus resting and reserved entry notionals. */
  openGrossUsd(): number {
    let sum = 0;
    for (const pair of this.pairs) {
      const acct = this.acct.get(pair);
      if (!acct) continue;
      if (acct.positionBase > 0) {
        const mid = this.feed.book(pair)?.mid() ?? acct.entryPrice() ?? 0;
        if (mid > 0) sum += acct.positionBase * mid;
        continue;
      }
      const order = this.open.get(pair);
      if (order && order.purpose === "entry" && order.side === "buy") sum += order.remaining * order.price;
    }
    for (const usd of this.reservedUsd.values()) sum += usd;
    return sum;
  }

  private risk(pair: string): { stopLossBps?: number; takeProfitBps?: number; notionalUsd: number } {
    const book = findBook(pair);
    return {
      stopLossBps: book?.stopLossBps ?? this.opts.stopLossBps,
      takeProfitBps: book?.takeProfitBps ?? this.opts.takeProfitBps,
      notionalUsd: book?.notionalUsd ?? this.opts.notionalUsd,
    };
  }

  observe(pair: string, _action: Action, inferenceUsd: number): void {
    this.acct.get(pair)?.addInference(inferenceUsd);
    // The hold clock starts when the entry fills and is not extended by a later buy.
  }

  onIntent(intent: OrderIntent): void {
    if (this.open.get(intent.pair)) return; // one order in flight per pair
    if (intent.purpose === "entry") {
      if (killSwitch.blocked()) return;
      if (this.entryBlocked.get(intent.pair)) return;
      if (this.opts.feedHealthy && !this.opts.feedHealthy(intent.pair)) return;
    }
    void this.place(intent.pair, intent.side, intent.purpose, intent.decisionId, intent.sizeUsd, intent.mid);
  }

  // --- order lifecycle -------------------------------------------------------

  private async place(
    pair: string,
    side: "buy" | "sell",
    purpose: OrderPurpose,
    decisionId: string | null,
    sizeUsd?: number,
    refMid?: number | null,
  ): Promise<void> {
    const book = this.feed.book(pair);
    if (!book) return;
    const bid = book.bestBid();
    const ask = book.bestAsk();
    if (bid == null || ask == null) return;
    const tick = this.tickFor(pair, book.mid() ?? bid);
    const price = insideTouchPrice(side, bid, ask, tick);
    if (!(price > 0)) return;
    const acct = this.acct.get(pair)!;
    const risk = this.risk(pair);
    let usd = sizeUsd != null && sizeUsd > 0 ? sizeUsd : risk.notionalUsd;
    let reserved = false;
    if (side === "buy" && this.opts.maxGrossUsd != null) {
      const room = this.opts.maxGrossUsd - this.openGrossUsd();
      const min = this.opts.minSizeUsd ?? 0;
      if (!(room > 0) || room < min) return;
      usd = Math.min(usd, room);
      if (usd < min) return;
      this.reservedUsd.set(pair, usd);
      reserved = true;
    }
    const sizeBase = side === "buy" ? usd / price : acct.positionBase;
    if (sizeBase <= 0) {
      if (reserved) this.reservedUsd.delete(pair);
      return;
    }
    // A buy needs cash for its notional plus the maker fee. Entries do not convert to taker.
    if (side === "buy") {
      const requiredCashUsd = usd * (1 + this.opts.makerFeeBps / 10_000);
      if (acct.cashUsd() < requiredCashUsd) {
        if (reserved) this.reservedUsd.delete(pair);
        console.warn(`${pair}: skipping ${purpose} buy, insufficient cash ($${acct.cashUsd().toFixed(2)} < $${requiredCashUsd.toFixed(2)} needed)`);
        return;
      }
    }
    const now = Date.now();
    try {
      const id = await this.store.insertOrder({
        run_id: this.runId,
        decision_id: decisionId,
        pair,
        side,
        purpose,
        price,
        size_base: sizeBase,
        status: "open",
        venue_order_id: null,
        created_at: now,
        updated_at: now,
      });
      this.open.set(pair, {
        id,
        side,
        purpose,
        price,
        remaining: sizeBase,
        createdAt: now,
        eligibleAt: now + ELIGIBLE_DELAY_MS,
        decisionId,
        refMid: refMid ?? book.mid(),
      });
    } finally {
      if (reserved) this.reservedUsd.delete(pair);
    }
  }

  private tick(now = Date.now()): void {
    for (const pair of this.pairs) void this.tickPair(pair, now);
  }

  /** One second of broker work for a pair: feed circuit, guards, resting order, horizon. */
  private async tickPair(pair: string, now: number): Promise<void> {
    if (this.stepping.get(pair)) return;
    this.stepping.set(pair, true);
    try {
      await this.cancelEntryIfFeedDown(pair, now);
      await this.enforceGuards(pair, now);
      await this.processOrder(pair, now);
      await this.enforceGuards(pair, now);
      const expiresAt = this.horizonExpiresAt.get(pair);
      if (this.positionOf(pair) === "long" && !this.open.get(pair) && expiresAt != null && now >= expiresAt) {
        this.horizonExpiresAt.set(pair, null);
        await this.place(pair, "sell", "exit", null);
      }
    } finally {
      this.stepping.set(pair, false);
    }
  }

  private async cancelEntryIfFeedDown(pair: string, now: number): Promise<void> {
    if (!this.opts.feedHealthy || this.opts.feedHealthy(pair)) return;
    const order = this.open.get(pair);
    if (!order || order.purpose !== "entry") return;
    await this.store.updateOrder(order.id, { status: "canceled" }, now);
    this.open.set(pair, null);
  }

  /**
   * Stop and take-profit on the 1 second tick. A later long classification cannot hold through
   * a breach: the guard cancels the resting order and flattens as a taker immediately.
   * A flat pair has no entry price, so neither guard can trip.
   */
  private async enforceGuards(pair: string, now: number): Promise<void> {
    const risk = this.risk(pair);
    const stop = risk.stopLossBps;
    const take = risk.takeProfitBps;
    if (stop == null || take == null) return;
    if (this.positionOf(pair) !== "long") return;
    const entry = this.acct.get(pair)?.entryPrice();
    const mid = this.feed.book(pair)?.mid();
    if (entry == null || mid == null) return;
    const trip = guardTrip(entry, mid, stop, take);
    if (!trip) return;
    await this.takerFlatten(pair, trip, now);
  }

  private async takerFlatten(pair: string, purpose: "stop" | "take_profit", now: number): Promise<void> {
    const resting = this.open.get(pair);
    if (resting) {
      await this.store.updateOrder(resting.id, { status: "canceled" }, now);
      this.open.set(pair, null);
    }
    const book = this.feed.book(pair);
    const acct = this.acct.get(pair);
    if (!book || !acct || acct.positionBase <= 0) return;
    const size = acct.positionBase;
    const price = book.walk("sell", size) ?? book.bestBid();
    if (price == null || !(price > 0)) return;
    const id = await this.store.insertOrder({
      run_id: this.runId,
      decision_id: null,
      pair,
      side: "sell",
      purpose,
      price,
      size_base: size,
      status: "open",
      venue_order_id: null,
      created_at: now,
      updated_at: now,
    });
    const order: OpenOrder = {
      id,
      side: "sell",
      purpose,
      price,
      remaining: size,
      createdAt: now,
      eligibleAt: now,
      decisionId: null,
      refMid: book.mid(),
    };
    this.open.set(pair, order);
    await this.fill(pair, order, size, price, "taker", now, true);
  }

  private async processOrder(pair: string, now: number): Promise<void> {
    const order = this.open.get(pair);
    const book = this.feed.book(pair);
    if (!order || !book) return;

    // A guard that was inserted and not filled (restart) crosses immediately.
    if (order.purpose === "stop" || order.purpose === "take_profit") {
      const cross = book.walk(order.side, order.remaining) ?? (order.side === "sell" ? book.bestBid() : book.bestAsk()) ?? order.price;
      await this.fill(pair, order, order.remaining, cross, "taker", now, true);
      return;
    }

    // Reprice to one tick inside the touch when that quote moves more than repriceTicks.
    const bid = book.bestBid();
    const ask = book.bestAsk();
    const tick = this.tickFor(pair, book.mid() ?? bid ?? ask ?? 0);
    const quote = bid != null && ask != null ? insideTouchPrice(order.side, bid, ask, tick) : order.side === "buy" ? bid : ask;
    if (quote != null && Math.abs(quote - order.price) > this.opts.repriceTicks * tick) {
      order.price = quote;
      order.eligibleAt = now + ELIGIBLE_DELAY_MS;
      await this.store.updateOrder(order.id, { price: quote }, now);
    }

    // Maker fills from crossing prints that arrived after the order became eligible.
    const prints = this.feed.drainPrints(pair);
    if (now >= order.eligibleAt) {
      for (const print of prints) {
        if (print.ts < order.eligibleAt) continue; // models propagation delay
        if (order.remaining <= 1e-12) break;
        if (!crosses(order.side, order.price, print)) continue;
        const size = makerFillSize(order.remaining, print.size, this.opts.fillHaircut);
        if (size > 0) await this.fill(pair, order, size, order.price, "maker", now);
      }
    }

    // After the timeout: entries cancel (a missed entry costs nothing). A signal or horizon
    // exit may cross so inventory does not stick. That cross is the taker cost the gate
    // already required the entry to beat. Stop and take-profit never rest, so they are not here.
    const current = this.open.get(pair);
    if (current && current.id === order.id && current.remaining > 1e-12 && now - current.createdAt >= this.opts.entryTimeoutSec * 1000) {
      if (current.purpose === "entry") {
        await this.store.updateOrder(current.id, { status: "canceled" }, now);
        this.open.set(pair, null);
        return;
      }
      const price = book.walk(current.side, current.remaining) ?? quote ?? current.price;
      await this.fill(pair, current, current.remaining, price, "taker", now, true);
    }
  }

  private async fill(pair: string, order: OpenOrder, size: number, price: number, liquidity: "maker" | "taker", now: number, converted = false): Promise<void> {
    const acct = this.acct.get(pair)!;
    const notional = price * size;
    const fee = feeUsd(notional, liquidity === "maker" ? this.opts.makerFeeBps : this.opts.takerFeeBps);
    const realizedBefore = acct.realizedUsd;
    acct.apply({ side: order.side, sizeBase: size, notionalUsd: notional, feeUsd: fee });
    killSwitch.recordUsd(acct.realizedUsd - realizedBefore);
    const counts = this.fillCounts.get(pair)!;
    counts[liquidity]++;
    order.remaining -= size;
    const maxSlip = this.opts.maxSlippageBps ?? 10;
    const ref = order.refMid;
    const slipped = ref != null && ref > 0 && (Math.abs(price - ref) / ref) * 10_000 > maxSlip;
    if (slipped) this.entryBlocked.set(pair, true);
    const done = order.remaining <= 1e-12 || slipped;
    const status = slipped && order.remaining > 1e-12 ? "canceled" : done ? (converted ? "converted_taker" : "filled") : "partial";

    await this.store.upsertFill({
      run_id: this.runId,
      order_id: order.id,
      venue: "paper",
      external_id: `paper-${this.runId}-${this.instance}-${++this.seq}`,
      pair,
      side: order.side,
      price,
      size_base: size,
      notional_usd: notional,
      fee_usd: fee,
      liquidity,
      cost_basis_usd: order.side === "buy" ? notional + fee : 0,
      proceeds_usd: order.side === "sell" ? notional - fee : 0,
      source: "paper_sim",
      traded_at: now,
      recorded_at: now,
    });
    await this.store.updateOrder(order.id, { status, size_base: slipped ? 0 : order.remaining }, now);
    if (done) this.open.set(pair, null);

    if (order.purpose === "entry" && this.positionOf(pair) === "long") {
      this.horizonExpiresAt.set(pair, now + this.opts.horizonSec * 1000);
    } else if (this.positionOf(pair) === "flat") {
      this.horizonExpiresAt.set(pair, null);
    }

    this.onFill({ pair, side: order.side, purpose: order.purpose, price, sizeBase: size, feeUsd: fee, liquidity, ts: now });
  }

  // --- state + snapshots -----------------------------------------------------

  state(pair: string) {
    const acct = this.acct.get(pair)!;
    const mid = this.feed.book(pair)?.mid() ?? null;
    const order = this.open.get(pair);
    const counts = this.fillCounts.get(pair)!;
    const totalFills = counts.maker + counts.taker;
    return {
      pair,
      position: this.positionOf(pair),
      sizeBase: acct.positionBase,
      entryPrice: acct.entryPrice(),
      realizedUsd: acct.realizedUsd,
      unrealizedUsd: mid != null ? acct.unrealized(mid) : 0,
      feesUsd: acct.feesUsd,
      inferenceUsd: acct.inferenceUsd,
      equityUsd: mid != null ? acct.equity(mid) : acct.equity(acct.entryPrice() ?? 0),
      cashUsd: acct.cashUsd(),
      bankrollUsd: acct.bankrollUsd,
      openOrder: order ? { side: order.side, purpose: order.purpose, price: order.price, remaining: order.remaining, ageMs: Date.now() - order.createdAt } : null,
      stopPrice: this.guardPrice(pair, "stop"),
      takeProfitPrice: this.guardPrice(pair, "take_profit"),
      stopLossBps: this.risk(pair).stopLossBps ?? null,
      takeProfitBps: this.risk(pair).takeProfitBps ?? null,
      notionalUsd: this.risk(pair).notionalUsd,
      makerFills: counts.maker,
      takerFills: counts.taker,
      takerFillShare: totalFills > 0 ? counts.taker / totalFills : 0,
    };
  }

  allState() {
    return this.pairs.map((p) => this.state(p));
  }

  private async snapshot(now = Date.now()): Promise<void> {
    let realized = 0;
    let unrealized = 0;
    let fees = 0;
    let inference = 0;
    for (const pair of this.pairs) {
      const acct = this.acct.get(pair)!;
      const mid = this.feed.book(pair)?.mid() ?? null;
      const u = mid != null ? acct.unrealized(mid) : 0;
      realized += acct.realizedUsd;
      unrealized += u;
      fees += acct.feesUsd;
      inference += acct.inferenceUsd;
      await this.store.insertSnapshot({
        run_id: this.runId,
        pair,
        ts: now,
        mid,
        position_base: acct.positionBase,
        entry_price: acct.entryPrice(),
        realized_usd: acct.realizedUsd,
        unrealized_usd: u,
        fees_usd: acct.feesUsd,
        inference_usd: acct.inferenceUsd,
        equity_usd: mid != null ? acct.equity(mid) : acct.realizedUsd,
      });
    }
    await this.store.insertSnapshot({
      run_id: this.runId,
      pair: "TOTAL",
      ts: now,
      mid: null,
      position_base: 0,
      entry_price: null,
      realized_usd: realized,
      unrealized_usd: unrealized,
      fees_usd: fees,
      inference_usd: inference,
      equity_usd: this.opts.bankrollUsd + realized + unrealized - inference,
    });
  }

  private guardPrice(pair: string, which: "stop" | "take_profit"): number | null {
    if (this.positionOf(pair) !== "long") return null;
    const entry = this.acct.get(pair)?.entryPrice();
    const risk = this.risk(pair);
    const bps = which === "stop" ? risk.stopLossBps : risk.takeProfitBps;
    if (entry == null || !(entry > 0) || bps == null) return null;
    return which === "stop" ? entry * (1 - bps / 10_000) : entry * (1 + bps / 10_000);
  }

  private tickFor(pair: string, mid: number): number {
    const t = this.ticks.get(pair);
    if (t && t > 0) return t;
    // Fallback: a tick two orders of magnitude below the price scale.
    return mid > 0 ? 10 ** (Math.floor(Math.log10(mid)) - 4) : 1e-6;
  }

  private async loadTicks(restUrl: string): Promise<void> {
    await Promise.all(
      this.pairs.map(async (pair) => {
        try {
          const res = await fetch(`${restUrl}/api/v3/brokerage/market/products/${pair}`);
          if (!res.ok) return;
          const p: any = await res.json();
          const inc = Number(p.quote_increment ?? p.price_increment);
          if (inc > 0) this.ticks.set(pair, inc);
        } catch {
          // fallback tick used
        }
      }),
    );
  }
}
