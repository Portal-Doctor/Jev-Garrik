import { appendFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { config } from "./config";
import { log10 } from "./book";
import { Market, type Book, type Fill, type Quote, type QuoteResult, type Side } from "./market";
import type { Action, Decision, Model, TradeState } from "./model";
import { TradeFeed, type MakerFill, type TradePrint } from "./trades";
import { Inventory, feeUsd } from "./accounting";
import { killSwitch } from "./kill";
import { KuruLedger } from "./ledger";
import { makerFillSize, planMakerQuotes, type MakerLast } from "./maker";

export interface BlockEvent {
  block: number;
  ts: number;
  mid: number;
  bestBid: number;
  bestAsk: number;
  spreadBps: number;
  decision: { action: Action; probabilities: Record<Action, number>; upIn10: number; latencyMs: number; late: boolean } | null;
  /** The order this block put on the book. */
  quote: Quote | null;
  /** Maker fills that landed in this block (aggregated), attached when the trade logs for it arrive. */
  fill: Fill | null;
  /** Our size known to be resting on the book after this block's order. */
  resting: { bidMon: number; askMon: number };
  position: { side: "long" | "short" | "flat"; size: number; entryPrice: number | null; unrealizedUsd: number; unrealizedMon: number };
  totals: Totals;
}

/** Per-block latency: the book read, and read + decide + send end to end. */
export interface Timing { readMs: number; loopMs: number }

export interface Totals {
  blocks: number;
  decisions: number;
  quotes: number;
  fills: number;
  reverted: number;
  lateBlocks: number;
  jevUsd: number;
  gasMon: number;
  gasUsd: number;
  feesUsd: number;
  realizedUsd: number;
  pnlUsd: number;
  pnlMon: number;
  pnlPct: number;
}

interface Resting { side: Side; price: number; size: number; block: number }

export interface ActivityFill {
  block: number;
  ts: number;
  side: Side;
  size: number;
  price: number;
  simulated: boolean;
}

/**
 * Every block: read the book and post. Jev and ledger writes run in the background so a slow
 * gateway or Postgres tick cannot mark the next 300 ms head late. One book-loop in flight; a
 * block that arrives while the previous read/send is still running is emitted as late.
 *
 * Live sends are fire-and-forget: the block event carries the quote as `sent`; its receipt
 * (`placed` with an order id, or `reverted`) is applied when it turns up on a later block. Fills
 * come from the Trade log feed: a taker hit one of our resting orders. Dry runs simulate both:
 * the order rests for one block and fills when a real print crosses its price.
 */
export class Trader {
  readonly history: BlockEvent[] = [];
  private mids: number[] = [];
  private busy = false;
  private lastBook: Book | null = null;
  private trades: TradeFeed | null = null;
  /** Orders we know are resting on the book (live: from receipts; dry run: last block's simulated order). */
  private orders = new Map<number, Resting>();
  /** Live quotes sent but not yet confirmed; they may become resting orders, so they count toward the cap. */
  private inflight = new Map<string, Quote[]>();
  private simId = 0;
  private position = { mon: 0, costUsd: 0 }; // signed inventory and its cost basis
  private totals: Totals = { blocks: 0, decisions: 0, quotes: 0, fills: 0, reverted: 0, lateBlocks: 0, jevUsd: 0, gasMon: 0, gasUsd: 0, feesUsd: 0, realizedUsd: 0, pnlUsd: 0, pnlMon: 0, pnlPct: 0 };
  private ledger: KuruLedger | null = null;
  private lastDecisionId: string | null = null;
  private lastDecision: Decision | null = null;
  private lastDecideBlock = 0;
  private lastMaker: MakerLast | null = null;
  private needFillRequote = false;
  private decideInflight = false;
  private latestEvent: BlockEvent | null = null;
  private recentFills: ActivityFill[] = [];
  readonly acct = new Inventory(config.bankrollUsd);

  get latest(): BlockEvent | null {
    return this.latestEvent ?? this.history.at(-1) ?? null;
  }

  get activity(): { quotes: BlockEvent[]; fills: ActivityFill[] } {
    return { quotes: this.history.slice(-30).reverse(), fills: this.recentFills };
  }

  constructor(
    private market: Market,
    private model: Model,
    private onEvent: (e: BlockEvent, timing?: Timing) => void,
    private onFill: (block: number, fill: Fill) => void = () => {},
    private onQuote: (block: number, quote: Quote) => void = () => {},
  ) {
    mkdirSync("data", { recursive: true });
  }

  /** Call once the market params are known. Without it `trades` in the state is all zeros and no fills are ever seen. */
  attachTradeFeed(sizeDec: number) {
    this.trades = new TradeFeed({ market: config.market, url: config.readRpcUrl, sizeDec, maker: this.market.address });
  }

  attachLedger(ledger: KuruLedger) {
    this.ledger = ledger;
  }

  async onBlock(block: number) {
    this.totals.blocks++;
    this.confirmPending(block); // off the hot path: receipts for earlier blocks' sends
    if (this.totals.blocks % config.refreshBlocks === 0) this.market.refresh().catch(() => {}); // fee estimate + margin + vault check
    if (this.busy) {
      this.totals.lateBlocks++;
      return;
    }
    this.busy = true;
    const t0 = performance.now();
    try {
      const book = await this.market.readBook();
      const readMs = performance.now() - t0;
      this.lastBook = book;
      this.mids.push(book.mid);
      if (this.mids.length > 400) this.mids.shift();
      this.trades?.poll(block).then(() => this.harvest()); // off the hot path: eth_getLogs for prints (and our fills) since the last poll
      void this.ledger?.bar(book.mid);

      const timing = { readMs: Math.round(readMs), loopMs: Math.round(performance.now() - t0) };
      await this.onBlockMaker(block, book, timing);
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /**
   * Ask Jev in the background. Quotes keep using `lastDecision` until this lands. One call at a time.
   */
  private requestDecide(block: number, book: Book): void {
    if (this.decideInflight) return;
    this.decideInflight = true;
    const askedAt = block;
    void this.model
      .decide(this.buildState(block, book))
      .then((decision) => {
        this.lastDecision = decision;
        this.lastDecideBlock = askedAt;
        this.totals.decisions++;
        const inference = (decision.inputTokens / 1e6) * config.jevUsdPerMTok;
        this.totals.jevUsd += inference;
        this.acct.addInference(inference);
        const action = decision.action === "sell" ? "sell" : "buy";
        void this.ledger
          ?.recordDecision({
            action,
            pBuy: decision.probabilities.buy,
            pSell: decision.probabilities.sell,
            mid: book.mid,
            spreadBps: book.spreadBps,
            state: { block: askedAt, mid: book.mid, jev: action },
            latencyMs: decision.latencyMs,
            inputTokens: decision.inputTokens,
            inferenceUsd: inference,
            traded: true,
          })
          .then((id) => {
            if (id) this.lastDecisionId = id;
          });
      })
      .catch((e) => {
        console.error(`decide ${askedAt}:`, (e as Error).message);
      })
      .finally(() => {
        this.decideInflight = false;
      });
  }

  /**
   * Two-sided maker path. Jev still decides (skew) off the hot path. We only send when the touch
   * moved, the skew flipped, a fill took a level, or nothing is resting, and only when a side has
   * size. Paper charges estimated gas at that requote rate so the hurdle is honest.
   */
  private async onBlockMaker(block: number, book: Book, timing: Timing) {
    const priceScale = 10 ** log10(this.market.params.pricePrecision);
    const tickUnits = Number(this.market.params.tickSize.toString());
    const dueDecide = !this.lastDecision || block - this.lastDecideBlock >= config.decideBlocks;
    const decision = this.lastDecision;
    const jevSide: Side = decision ? (decision.action === "sell" ? "sell" : "buy") : "buy";
    const plan = decision
      ? planMakerQuotes({
          book: { bid: book.bid, ask: book.ask },
          priceScale,
          tickUnits,
          quoteInsideTicks: config.quoteInsideTicks,
          requoteTicks: config.requoteTicks,
          tradeSizeMon: config.tradeSizeMon,
          maxPositionMon: config.maxPositionMon,
          positionMon: this.position.mon,
          jevSide,
          last: this.lastMaker,
          forceFillRequote: this.needFillRequote,
        })
      : null;
    const legs = plan ? [plan.bid, plan.ask].filter((x): x is NonNullable<typeof x> => x != null && x.size > 0) : [];
    const canQuote = legs.length > 0;
    const wantRequote = !!plan?.requote && canQuote;
    if (!decision || dueDecide || wantRequote || this.needFillRequote) this.requestDecide(block, book);

    let quote: Quote | null = null;
    if (wantRequote && plan) {
      this.needFillRequote = false;
      const cancel = [...this.orders.keys()].filter((id) => id > 0);
      const quotes = await this.market.sendMany(block, legs, cancel, false);
      this.totals.quotes += quotes.length;
      const gasMon = quotes[0]?.gasMon ?? 0;
      if (!this.market.wallet && gasMon > 0) {
        this.totals.gasMon += gasMon;
        this.acct.addGas(gasMon * book.mid);
        killSwitch.recordUsd(-(gasMon * book.mid));
      }
      if (quotes[0]?.status === "sim") {
        this.orders.clear();
        for (const q of quotes) {
          const id = --this.simId;
          this.orders.set(id, { side: q.side, price: q.price, size: q.size, block });
          this.ledger?.noteRemaining(id, q.size);
          void this.ledger?.openOrder(id, q, this.lastDecisionId);
        }
      } else if (quotes[0]?.txHash) {
        this.inflight.set(quotes[0].txHash, quotes);
      }
      quote = quotes.find((q) => q.side === jevSide) ?? quotes[0] ?? null;
      this.lastMaker = {
        bookBid: book.bid,
        bookAsk: book.ask,
        jevSide,
        bidPrice: plan.bid?.price ?? null,
        askPrice: plan.ask?.price ?? null,
      };
    } else if (decision) {
      this.needFillRequote = false;
      if (this.lastMaker) {
        this.lastMaker = { ...this.lastMaker, bookBid: book.bid, bookAsk: book.ask };
      }
    }

    if (this.totals.blocks % config.refreshBlocks === 0) void this.ledger?.snapshot(book.mid);
    this.emit(block, book, decision, quote, false, timing);
  }

  /** One eth_getTransactionReceipt per in-flight tx, in parallel with this block's decision. */
  private confirmPending(block: number) {
    this.market.pollPending(block).then((results) => {
      for (const r of results) this.applyQuoteResult(r);
    }).catch(() => {});
  }

  private applyQuoteResult({ block, quote, quotes, canceled }: QuoteResult) {
    const all = quotes?.length ? quotes : [quote];
    if (quote.txHash) this.inflight.delete(quote.txHash);
    this.totals.gasMon += all.reduce((s, q) => s + q.gasMon, 0); // charged on reverts too
    if (all.some((q) => q.status === "reverted")) this.totals.reverted++;
    for (const id of canceled) this.orders.delete(id);
    for (const q of all) {
      if (q.status === "placed" && q.orderId !== null) {
        this.orders.set(q.orderId, { side: q.side, price: q.price, size: q.size, block });
        this.ledger?.noteRemaining(q.orderId, q.size);
        void this.ledger?.openOrder(q.orderId, q, this.lastDecisionId);
      }
      this.onQuote(block, q);
    }
    const e = this.history.find((h) => h.block === block);
    if (e) e.quote = all[0] ?? quote;
    if (quote.gasMon && this.lastBook) {
      this.acct.addGas(quote.gasMon * this.lastBook.mid);
      killSwitch.recordUsd(-(quote.gasMon * this.lastBook.mid));
    }
  }

  /** After each trade-log poll: apply our maker fills (live) or simulate them against the new prints (dry run). */
  private harvest() {
    if (!this.trades) return;
    const prints = this.trades.drainPrints();
    const fills: Fill[] = this.market.wallet ? this.liveFills(this.trades.drainFills()) : this.simFills(prints);
    if (!fills.length) return;
    const byBlock = new Map<number, Fill[]>();
    for (const f of fills) {
      this.applyFill(f);
      const b = (f as Fill & { block: number }).block;
      byBlock.set(b, [...(byBlock.get(b) ?? []), f]);
    }
    for (const [block, fs] of byBlock) {
      const fill = aggregate(fs);
      const e = this.history.find((h) => h.block === block);
      if (e) e.fill = fill;
      this.recentFills.unshift({ block, ts: Date.now(), side: fill.side, size: fill.size, price: fill.price, simulated: fill.simulated });
      if (this.recentFills.length > 40) this.recentFills.length = 40;
      this.onFill(block, fill);
    }
    if (this.lastBook) void this.ledger?.snapshot(this.lastBook.mid);
  }

  private liveFills(raw: MakerFill[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const f of raw) {
      const o = this.orders.get(f.orderId);
      if (f.updatedSize <= 0) this.orders.delete(f.orderId);
      else if (o) o.size = f.updatedSize;
      this.ledger?.noteRemaining(f.orderId, f.updatedSize);
      out.push({ side: f.side, size: f.size, price: f.price, txHash: f.txHash, orderId: f.orderId, simulated: false, block: f.block });
    }
    return out;
  }

  /**
   * A simulated order placed at block N is on the book from N+1. A taker sell printing at or below
   * our bid (or a taker buy at or above our ask) would have taken us first: fill up to the print's size.
   */
  private simFills(prints: TradePrint[]): (Fill & { block: number })[] {
    const out: (Fill & { block: number })[] = [];
    for (const p of prints) {
      for (const [id, o] of this.orders) {
        if (p.block <= o.block || o.size <= 0) continue;
        const hit = o.side === "buy" ? p.side === "sell" && p.price <= o.price : p.side === "buy" && p.price >= o.price;
        if (!hit) continue;
        const size = makerFillSize(o.size, p.size, config.fillHaircut);
        if (size <= 0) continue;
        o.size -= size;
        if (o.size <= 1e-9) this.orders.delete(id);
        this.ledger?.noteRemaining(id, o.size);
        out.push({ side: o.side, size, price: o.price, txHash: null, orderId: id, simulated: true, block: p.block });
      }
    }
    return out;
  }

  private restingMon(side: Side) {
    let mon = 0;
    for (const o of this.orders.values()) if (o.side === side) mon += o.size;
    for (const qs of this.inflight.values()) for (const q of qs) if (q.side === side) mon += q.size;
    return mon;
  }

  /** Would this order, and everything already resting on its side, keep us inside the cap and (live) inside margin funds? */
  private allowed(side: Side, book: Book) {
    const size = config.tradeSizeMon;
    const exposure = side === "buy" ? this.position.mon + this.restingMon("buy") + size : this.position.mon - this.restingMon("sell") - size;
    if (Math.abs(exposure) > config.maxPositionMon) return false;
    if (!this.market.wallet) return true;
    // Kuru debits margin when an order is placed, so the balance already excludes what is resting.
    return side === "buy" ? this.market.margin.usdc >= size * book.ask : this.market.margin.mon >= size;
  }

  private buildState(block: number, book: Book): TradeState {
    const m = this.mids, n = m.length, H = config.horizonBlocks;
    const ret = (k: number) => (n > k ? ((m[n - 1]! - m[n - 1 - k]!) / m[n - 1 - k]!) * 10_000 : 0);
    const sampled = m.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0); // every 5th block, newest included
    const lvl = (l: [number, number]) => `${l[0].toFixed(6)} x ${round(l[1], 1)}`;
    const empty = { count: 0, buyMon: 0, sellMon: 0, cvdMon: 0, vwap: null, lastPrice: null, lastSide: null };
    const depth: TradeState["depth"] = {};
    for (const [k, v] of Object.entries(book.depthBps)) depth[k + "bps"] = { bid: round(v.bid, 1), ask: round(v.ask, 1) };
    return {
      market: "MON-USDC",
      block,
      horizonBlocks: H,
      blockMs: 300,
      mid: book.mid,
      spreadBps: round(book.spreadBps, 2),
      bookImbalance: round(book.imbalance, 3),
      depth,
      book: { bids: book.levels.bids.map(lvl), asks: book.levels.asks.map(lvl) },
      returnsBps: { last1: round(ret(1), 2), last5: round(ret(5), 2), last20: round(ret(20), 2), last100: round(ret(100), 2) },
      recentMids: sampled.map((x) => x.toFixed(6)).join(" "),
      trades: this.trades ? this.trades.summary(H, block) : empty,
      recentTrades: (this.trades?.recent(10) ?? []).map((t) => `${t.block} ${t.side} ${round(t.size, 1)} @ ${t.price.toFixed(6)}`),
      allowed: { buy: this.allowed("buy", book), sell: this.allowed("sell", book) },
    };
  }

  private applyFill(f: Fill) {
    if (f.size <= 0) return;
    const signed = f.side === "buy" ? f.size : -f.size;
    const p = this.position;
    const realizedBefore = this.totals.realizedUsd;
    if (p.mon === 0 || Math.sign(p.mon) === Math.sign(signed)) {
      p.costUsd += signed * f.price; // adding to position
    } else {
      const closing = Math.min(Math.abs(signed), Math.abs(p.mon)) * Math.sign(signed);
      const entry = p.costUsd / p.mon;
      this.totals.realizedUsd += -closing * (f.price - entry); // closing part realizes pnl
      p.costUsd += closing * entry;
      const remainder = signed - closing;
      p.costUsd += remainder * f.price; // any flip opens the other way
    }
    p.mon += signed;
    if (Math.abs(p.mon) < 1e-9) { p.mon = 0; p.costUsd = 0; }
    const notional = f.size * f.price;
    const fee = feeUsd(notional, this.market.makerFeeBps);
    this.totals.feesUsd += fee;
    this.acct.apply({ side: f.side, sizeBase: f.size, notionalUsd: notional, feeUsd: fee });
    killSwitch.recordUsd(this.totals.realizedUsd - realizedBefore - fee);
    this.totals.fills++;
    this.needFillRequote = true;
    void this.ledger?.fill(f.orderId, f, fee);
  }

  private entryPrice() { return this.position.mon ? this.position.costUsd / this.position.mon : null; }
  private unrealizedUsd(mid: number) { return this.position.mon ? this.position.mon * (mid - this.entryPrice()!) : 0; }

  private emit(block: number, book: Book, decision: Decision | null, quote: Quote | null, late: boolean, timing?: Timing) {
    const t = this.totals;
    t.gasUsd = t.gasMon * book.mid;
    const unrealized = this.unrealizedUsd(book.mid);
    t.pnlUsd = t.realizedUsd + unrealized - t.gasUsd - t.feesUsd;
    t.pnlMon = t.pnlUsd / book.mid;
    t.pnlPct = (t.pnlUsd / config.bankrollUsd) * 100;
    const size = Math.abs(this.position.mon);
    const event: BlockEvent = {
      block, ts: Date.now(), mid: book.mid, bestBid: book.bid, bestAsk: book.ask, spreadBps: round(book.spreadBps, 2),
      decision: late
        ? { action: "hold", probabilities: { buy: 0, sell: 0, hold: 1 }, upIn10: 0.5, latencyMs: 0, late: true }
        : decision && { action: decision.action, probabilities: decision.probabilities, upIn10: decision.upIn10, latencyMs: Math.round(decision.latencyMs), late: false },
      quote,
      fill: null,
      resting: { bidMon: round(this.restingMon("buy"), 1), askMon: round(this.restingMon("sell"), 1) },
      position: {
        side: this.position.mon > 0 ? "long" : this.position.mon < 0 ? "short" : "flat",
        size, entryPrice: this.entryPrice(), unrealizedUsd: round(unrealized, 4), unrealizedMon: round(unrealized / book.mid, 4),
      },
      totals: { ...t, jevUsd: round(t.jevUsd, 6), gasMon: round(t.gasMon, 6), gasUsd: round(t.gasUsd, 6), feesUsd: round(t.feesUsd, 4), realizedUsd: round(t.realizedUsd, 4), pnlUsd: round(t.pnlUsd, 4), pnlMon: round(t.pnlMon, 4), pnlPct: round(t.pnlPct, 3) },
    };
    this.latestEvent = event;
    this.history.push(event);
    if (this.history.length > config.historySize) this.history.shift();
    if (quote) void appendFile("data/events.jsonl", JSON.stringify(event) + "\n");
    this.onEvent(event, timing);
  }
}

/** Several fills in one block become one: total size, size-weighted price, the side with more size. */
function aggregate(fills: Fill[]): Fill {
  const buy = fills.filter((f) => f.side === "buy").reduce((s, f) => s + f.size, 0);
  const sell = fills.filter((f) => f.side === "sell").reduce((s, f) => s + f.size, 0);
  const side: Side = buy >= sell ? "buy" : "sell";
  const same = fills.filter((f) => f.side === side);
  const size = same.reduce((s, f) => s + f.size, 0);
  const price = same.reduce((s, f) => s + f.size * f.price, 0) / size;
  return { side, size: round(size, 4), price, txHash: same[0]!.txHash, orderId: same[0]!.orderId, simulated: same[0]!.simulated };
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
