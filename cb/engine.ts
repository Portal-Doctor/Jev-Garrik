import type { Feed } from "./feed";
import type { Model, Decision, Action } from "./model";
import type { Store } from "./db/store";
import { buildState, type MarketState } from "./state";
import { killSwitch } from "./kill";

/** A target-position change the broker should act on. */
export interface OrderIntent {
  pair: string;
  target: "long" | "flat";
  side: "buy" | "sell";
  purpose: "entry" | "exit";
  decisionId: string;
  mid: number;
  ts: number;
}

/** The engine asks the broker for the current position and hands it intents. Paper broker (M3). */
export interface Broker {
  positionOf(pair: string): "long" | "flat";
  /** Called on every decision (traded or not), so the broker can refresh the horizon clock and accrue inference cost. */
  observe(pair: string, action: Action, inferenceUsd: number): void;
  onIntent(intent: OrderIntent): void;
}

/** Broker that never holds a position. Used until the paper broker is wired in (M3). */
export class FlatBroker implements Broker {
  positionOf(): "long" | "flat" {
    return "flat";
  }
  observe(): void {}
  onIntent(): void {}
}

export interface EngineOpts {
  decideSec: number;
  horizonSec: number;
  makerFeeBps: number;
  takerFeeBps: number;
  jevUsdPerMTok: number;
  /** Enter long only when p(buy) clears this; exit to flat only when p(buy) drops below sellThreshold. */
  buyThreshold: number;
  sellThreshold: number;
}

/**
 * Confidence-band hysteresis on top of the model's raw buy/sell call (PL-REVENUE-REVIEW.md 3.2):
 * with a ~140bps round-trip cost, a flip should only be actioned when the model's conviction
 * clears a band wide enough to plausibly beat that cost. Flat only enters above `buyThreshold`;
 * long only exits below `sellThreshold`; in between, hold the current position. The raw
 * decision/probabilities are still recorded for measurement regardless of this gate.
 */
export function targetFor(position: "long" | "flat", pBuy: number, buyThreshold: number, sellThreshold: number): "long" | "flat" {
  if (position === "flat") return pBuy >= buyThreshold ? "long" : "flat";
  return pBuy <= sellThreshold ? "flat" : "long";
}

/**
 * One model call per pair every `decideSec`. Same one-in-flight guard as src/trader.ts (`busy`): a
 * cycle that arrives while the previous one for that pair is still running is skipped. A `buy`
 * decision targets a long of the configured notional; a `sell` targets flat. Only a decision that
 * changes the target position is `traded` and emits an intent to the broker. Pairs are staggered
 * across the interval so their calls do not bunch.
 */
export class Engine {
  private busy = new Map<string, boolean>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private starters: Array<ReturnType<typeof setTimeout>> = [];
  /** Wall-clock ms of the next scheduled decision per pair (drives the UI countdown). */
  private nextAt = new Map<string, number>();
  readonly latest = new Map<string, { decision: Decision; state: MarketState; id: string }>();

  constructor(
    private readonly pairs: string[],
    private readonly feed: Feed,
    private readonly model: Model,
    private readonly store: Store,
    private readonly runId: string,
    private readonly opts: EngineOpts,
    private readonly broker: Broker,
    private readonly onDecision: (id: string, decision: Decision, state: MarketState, intent?: OrderIntent) => void = () => {},
  ) {}

  start(): void {
    const n = this.pairs.length || 1;
    const base = Date.now();
    this.pairs.forEach((pair, i) => {
      const stagger = (this.opts.decideSec * 1000 * i) / n;
      this.nextAt.set(pair, base + stagger);
      const t = setTimeout(() => {
        this.fire(pair);
        this.timers.push(setInterval(() => this.fire(pair), this.opts.decideSec * 1000));
      }, stagger);
      this.starters.push(t);
    });
  }

  stop(): void {
    this.starters.forEach(clearTimeout);
    this.timers.forEach(clearInterval);
  }

  /** Advance the schedule clock (kept stable for the UI even if a cycle is skipped), then decide. */
  private fire(pair: string): void {
    this.nextAt.set(pair, Date.now() + this.opts.decideSec * 1000);
    void this.decide(pair);
  }

  /** Wall-clock ms of the next scheduled decision for a pair, or null before `start()`. */
  nextDecisionAt(pair: string): number | null {
    return this.nextAt.get(pair) ?? null;
  }

  async decide(pair: string): Promise<void> {
    if (this.busy.get(pair)) return; // one in flight per pair
    const position = this.broker.positionOf(pair);
    const state = buildState(this.feed, pair, position, {
      horizonSec: this.opts.horizonSec,
      makerFeeBps: this.opts.makerFeeBps,
      takerFeeBps: this.opts.takerFeeBps,
    });
    if (!state) return; // book not ready
    this.busy.set(pair, true);
    try {
      const decision = await this.model.decide(state);
      const inferenceUsd = (decision.inputTokens / 1e6) * this.opts.jevUsdPerMTok;
      let target = targetFor(position, decision.probabilities.buy, this.opts.buyThreshold, this.opts.sellThreshold);
      const halt = killSwitch.blocked();
      if (halt) target = "flat";
      const traded = target !== position;
      const id = await this.store.insertDecision({
        run_id: this.runId,
        pair,
        ts: state.ts,
        action: decision.action,
        p_buy: decision.probabilities.buy,
        p_sell: decision.probabilities.sell,
        mid: state.mid,
        spread_bps: state.spreadBps,
        state,
        latency_ms: Math.round(decision.latencyMs),
        input_tokens: decision.inputTokens,
        inference_usd: inferenceUsd,
        traded,
      });
      this.latest.set(pair, { decision, state, id });
      this.broker.observe(pair, decision.action, inferenceUsd);
      let intent: OrderIntent | undefined;
      if (traded) {
        intent = {
          pair,
          target,
          side: target === "long" ? "buy" : "sell",
          purpose: target === "long" ? "entry" : "exit",
          decisionId: id,
          mid: state.mid,
          ts: state.ts,
        };
        this.broker.onIntent(intent);
        if (halt) console.log(`kill ${pair}: ${halt}`);
      }
      this.onDecision(id, decision, state, intent);
    } catch (e) {
      console.error(`decide ${pair}:`, (e as Error).message);
    } finally {
      this.busy.set(pair, false);
    }
  }
}
