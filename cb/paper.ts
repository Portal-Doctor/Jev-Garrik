import { Accounting, feeUsd } from "./accounting";
import type { PairBook, TradePrint } from "./feed";
import type { Broker, OrderIntent } from "./engine";
import type { Action } from "./model";
import type { Store } from "./db/store";

/**
 * Paper broker: simulates the execution policy against the real feed and keeps a fee-inclusive
 * ledger. Rules adapted from Trader.simFills (src/trader.ts) with an honesty haircut:
 *
 * - Entry: post-only limit at the touch (join best bid to buy, best ask to sell-to-close). Reprice
 *   if the touch moves more than `repriceTicks` while resting. Unfilled after `entryTimeoutSec`,
 *   convert to taker (cross the spread) so decisions get exposure and taker costs are measured.
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

interface OpenOrder {
  id: string;
  side: "buy" | "sell";
  purpose: "entry" | "exit";
  price: number;
  remaining: number;
  createdAt: number;
  eligibleAt: number;
  decisionId: string | null;
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
}

export interface FillEvent {
  pair: string;
  side: "buy" | "sell";
  purpose: "entry" | "exit";
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
  private seq = 0;
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
    }
  }

  async start(restUrl?: string): Promise<void> {
    if (restUrl) await this.loadTicks(restUrl);
    this.tickTimer = setInterval(() => this.tick(), 1_000);
    this.snapTimer = setInterval(() => void this.snapshot(), 60_000);
  }

  stop(): void {
    if (this.tickTimer) clearInterval(this.tickTimer);
    if (this.snapTimer) clearInterval(this.snapTimer);
  }

  // --- Broker interface ------------------------------------------------------

  positionOf(pair: string): "long" | "flat" {
    return (this.acct.get(pair)?.positionBase ?? 0) > 0 ? "long" : "flat";
  }

  observe(pair: string, action: Action, inferenceUsd: number): void {
    this.acct.get(pair)?.addInference(inferenceUsd);
    // A refreshing buy while long resets the horizon clock (hold, do not re-enter).
    if (action === "buy" && this.positionOf(pair) === "long") {
      this.horizonExpiresAt.set(pair, Date.now() + this.opts.horizonSec * 1000);
    }
  }

  onIntent(intent: OrderIntent): void {
    if (this.open.get(intent.pair)) return; // one order in flight per pair
    void this.place(intent.pair, intent.side, intent.purpose, intent.decisionId);
  }

  // --- order lifecycle -------------------------------------------------------

  private async place(pair: string, side: "buy" | "sell", purpose: "entry" | "exit", decisionId: string | null): Promise<void> {
    const book = this.feed.book(pair);
    if (!book) return;
    const touch = side === "buy" ? book.bestBid() : book.bestAsk();
    if (touch == null) return;
    const acct = this.acct.get(pair)!;
    const sizeBase = side === "buy" ? this.opts.notionalUsd / touch : acct.positionBase;
    if (sizeBase <= 0) return;
    const now = Date.now();
    const id = await this.store.insertOrder({
      run_id: this.runId,
      decision_id: decisionId,
      pair,
      side,
      purpose,
      price: touch,
      size_base: sizeBase,
      status: "open",
      venue_order_id: null,
      created_at: now,
      updated_at: now,
    });
    this.open.set(pair, { id, side, purpose, price: touch, remaining: sizeBase, createdAt: now, eligibleAt: now + ELIGIBLE_DELAY_MS, decisionId });
  }

  private tick(now = Date.now()): void {
    for (const pair of this.pairs) {
      void this.processOrder(pair, now);
      // Horizon expiry: close a long that no refreshing buy kept alive (mandatory taker at timeout).
      const expiresAt = this.horizonExpiresAt.get(pair);
      if (this.positionOf(pair) === "long" && !this.open.get(pair) && expiresAt != null && now >= expiresAt) {
        this.horizonExpiresAt.set(pair, null);
        void this.place(pair, "sell", "exit", null);
      }
    }
  }

  private async processOrder(pair: string, now: number): Promise<void> {
    const order = this.open.get(pair);
    const book = this.feed.book(pair);
    if (!order || !book) return;

    // Reprice if the touch moved more than repriceTicks while resting (resets eligibility).
    const touch = order.side === "buy" ? book.bestBid() : book.bestAsk();
    const tick = this.tickFor(pair, book.mid() ?? touch ?? 0);
    if (touch != null && Math.abs(touch - order.price) > this.opts.repriceTicks * tick) {
      order.price = touch;
      order.eligibleAt = now + ELIGIBLE_DELAY_MS;
      await this.store.updateOrder(order.id, { price: touch }, now);
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

    // Taker conversion after the timeout: fill the remainder immediately, walking the book.
    const current = this.open.get(pair);
    if (current && current.id === order.id && current.remaining > 1e-12 && now - current.createdAt >= this.opts.entryTimeoutSec * 1000) {
      const price = book.walk(current.side, current.remaining) ?? touch ?? current.price;
      await this.fill(pair, current, current.remaining, price, "taker", now, true);
    }
  }

  private async fill(pair: string, order: OpenOrder, size: number, price: number, liquidity: "maker" | "taker", now: number, converted = false): Promise<void> {
    const acct = this.acct.get(pair)!;
    const notional = price * size;
    const fee = feeUsd(notional, liquidity === "maker" ? this.opts.makerFeeBps : this.opts.takerFeeBps);
    acct.apply({ side: order.side, sizeBase: size, notionalUsd: notional, feeUsd: fee });
    order.remaining -= size;
    const done = order.remaining <= 1e-12;
    const status = done ? (converted ? "converted_taker" : "filled") : "partial";

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
    await this.store.updateOrder(order.id, { status, size_base: order.remaining }, now);
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
      openOrder: order ? { side: order.side, purpose: order.purpose, price: order.price, remaining: order.remaining, ageMs: Date.now() - order.createdAt } : null,
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
