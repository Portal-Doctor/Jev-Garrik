import type { Feed } from "./feed";
import { classifyDeterministic, type Model, type Decision, type Action } from "./model";
import type { Store } from "./db/store";
import { buildState, type MarketState } from "./state";
import { depthUsd } from "./features";
import { findBook } from "./books";
import { evaluateGate, type DecisionVector, type GateResult } from "./gate";
import { killSwitch } from "./kill";
import { PairVetoes, sampleFromState, VETO_RING_MS, type VetoDecision, type VetoSample } from "./vetoes";
import type { TrendLike } from "./trend";
import { MAX_CONCURRENT, planRotation, POOL_DD, POOL_USD } from "./pool";
import type { PoolBook } from "./poolbook";

/** A target-position change the broker should act on. */
export interface OrderIntent {
  pair: string;
  target: "long" | "flat";
  side: "buy" | "sell";
  purpose: "entry" | "exit";
  decisionId: string;
  mid: number;
  ts: number;
  /** Approved entry size. Exits sell the open position and omit this. */
  sizeUsd?: number;
}

/** The engine asks the broker for the current position and hands it intents. Paper broker (M3). */
export interface Broker {
  positionOf(pair: string): "long" | "flat";
  /** Mark of open longs plus resting entries, in USD. */
  openGrossUsd(): number;
  /** Fee-inclusive entry, or null when flat. */
  entryPriceOf?(pair: string): number | null;
  /** Mark equity of the whole book. */
  markEquityUsd?(): number;
  /** Uncommitted cash across the book. */
  cashUsd?(): number;
  /** Called on every decision (traded or not), so the broker can refresh the horizon clock and accrue inference cost. */
  observe(pair: string, action: Action, inferenceUsd: number): void;
  onIntent(intent: OrderIntent): void;
}

/** Broker that never holds a position. Used until the paper broker is wired in (M3). */
export class FlatBroker implements Broker {
  positionOf(): "long" | "flat" {
    return "flat";
  }
  openGrossUsd(): number {
    return 0;
  }
  entryPriceOf(): number | null {
    return null;
  }
  markEquityUsd(): number {
    return 0;
  }
  cashUsd(): number {
    return 0;
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
  buyThreshold: number;
  sellThreshold: number;
  feeBuffer: number;
  notionalUsd: number;
  depthParticipation: number;
  minSizeUsd: number;
  /** Book-level cap. Omit to leave size uncapped. */
  maxGrossUsd?: number;
  book?: "htf" | "pooled";
  maxConcurrent?: number;
  poolDd?: number;
  bankrollUsd?: number;
}

export interface GatedDecision extends Decision {
  gate: GateResult;
}

/** Reject if `p` has not settled so a hung Jev/429 call cannot pin `busy` and skip later cycles. */
export function withDeadline<T>(p: Promise<T>, ms: number, label = "operation"): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** Cap on a single Jev call. Gateway 429s can sit until this fires, then the pair is free again. */
export const DECIDE_DEADLINE_MS = 25_000;

/**
 * One model call per pair every `decideSec`. One-in-flight guard (`busy`): a
 * cycle that arrives while the previous one for that pair is still running is skipped. The model
 * returns a decision vector. The gate approves a long or flattens. Only a decision that changes
 * the target position is `traded` and emits an intent to the broker. Raw probabilities are still
 * recorded when the gate refuses. Pairs are staggered across the interval so their calls do not bunch.
 */
export class Engine {
  private busy = new Map<string, boolean>();
  /** Bumps when a pair starts a decide so a late return from a timed-out call is ignored. */
  private decideGen = new Map<string, number>();
  private timers: Array<ReturnType<typeof setInterval>> = [];
  private starters: Array<ReturnType<typeof setTimeout>> = [];
  /** Wall-clock ms of the next scheduled decision per pair (drives the UI countdown). */
  private nextAt = new Map<string, number>();
  readonly latest = new Map<string, { decision: GatedDecision; state: MarketState; id: string }>();
  private readonly vetoes = new Map<string, PairVetoes>();
  private lastPlan: { flatten: string[]; enter: string[] } = { flatten: [], enter: [] };

  constructor(
    private readonly pairs: string[],
    private readonly feed: Feed,
    private readonly model: Model,
    private readonly store: Store,
    private readonly runId: string,
    private readonly opts: EngineOpts,
    private readonly broker: Broker,
    private readonly onDecision: (id: string, decision: GatedDecision, state: MarketState, intent?: OrderIntent) => void = () => {},
    private readonly trend: TrendLike = { known: () => false, trendUp: () => false },
    private readonly pool: PoolBook | null = null,
  ) {
    for (const pair of pairs) this.vetoes.set(pair, new PairVetoes());
  }

  /**
   * Seed 7-day rings so neither a restart nor a paper reset resets calibration.
   *
   * Two sources, deduped by timestamp: the decision rows (which a reset wipes) and the
   * `veto_samples` mirror (which it does not). Neither is scoped to a run id.
   */
  async seedVetoes(): Promise<void> {
    const since = Date.now() - VETO_RING_MS;
    await this.store.pruneVetoSamples(since);
    for (const pair of this.pairs) {
      const [decisions, samples] = await Promise.all([
        this.store.vetoRingForPair(pair, since),
        this.store.vetoSamplesForPair(pair, since),
      ]);
      this.vetoes.get(pair)?.seed(mergeSeedSamples(decisions, samples));
    }
  }

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

  private evaluatePooled(
    pair: string,
    position: "long" | "flat",
    vector: DecisionVector,
    halted: boolean,
    feedBlocked: boolean,
    remainingGrossUsd: number,
  ): GateResult {
    const clip = findBook(pair)?.notionalUsd ?? this.opts.notionalUsd;
    const base = { expectedYieldBps: 0, hurdleBps: 0, sizeUsd: 0, approved: false as boolean };
    if (halted) return { ...base, target: "flat", reason: "halt" };
    if (position === "long" && vector.market_regime === "contraction") {
      return { ...base, target: "flat", reason: "regime" };
    }
    const names = this.pairs.map((p) => {
      const snap = this.pool!.snap(p);
      const open = this.broker.positionOf(p) === "long";
      return {
        pair: p,
        rank: snap.rank,
        clipUsd: findBook(p)?.notionalUsd ?? this.opts.notionalUsd,
        open,
        candidate: !open && snap.known && snap.candidate,
      };
    });
    const plan = planRotation({
      equityUsd: this.broker.markEquityUsd?.() ?? POOL_USD,
      cashUsd: this.broker.cashUsd?.() ?? Math.max(0, (this.opts.bankrollUsd ?? POOL_USD) - this.broker.openGrossUsd()),
      grossUsd: this.broker.openGrossUsd(),
      maxGrossUsd: this.opts.maxGrossUsd ?? 3_000,
      maxConcurrent: this.opts.maxConcurrent ?? MAX_CONCURRENT,
      makerFeeBps: this.opts.makerFeeBps,
      minSizeUsd: this.opts.minSizeUsd,
      names,
      halted,
      poolUsd: this.opts.bankrollUsd ?? POOL_USD,
      poolDd: this.opts.poolDd ?? POOL_DD,
    });
    this.lastPlan = plan;
    if (plan.halt && position === "long") return { ...base, target: "flat", reason: "pool dd" };
    if (position === "long" && plan.flatten.includes(pair)) {
      return { ...base, target: "flat", reason: Number.isFinite(names.find((n) => n.pair === pair)?.rank) ? "rotate" : "trail" };
    }
    if (position === "long") return { ...base, target: "long", reason: null };
    if (feedBlocked) return { ...base, target: "flat", reason: "feed" };
    if (vector.liquidity_stress === "stressed") return { ...base, target: "flat", reason: "liquidity stress" };
    if (vector.market_regime === "contraction") return { ...base, target: "flat", reason: "regime" };
    if (plan.halt) return { ...base, target: "flat", reason: "pool dd" };
    if (Number.isFinite(remainingGrossUsd) && remainingGrossUsd < this.opts.minSizeUsd) return { ...base, target: "flat", reason: "gross cap" };
    if (!plan.enter.includes(pair)) return { ...base, target: "flat", reason: "rank" };
    return { ...base, target: "long", approved: true, reason: null, sizeUsd: clip };
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
    const gen = (this.decideGen.get(pair) ?? 0) + 1;
    this.decideGen.set(pair, gen);
    try {
      const decision = await withDeadline(this.model.decide(state), DECIDE_DEADLINE_MS, `decide ${pair}`);
      if (this.decideGen.get(pair) !== gen) return;
      const inferenceUsd = (decision.inputTokens / 1e6) * this.opts.jevUsdPerMTok;
      const book = this.feed.book(pair);
      const halt = killSwitch.blocked();
      const risk = findBook(pair);
      const maxGross = this.opts.maxGrossUsd;
      const remainingGrossUsd = maxGross == null ? Number.POSITIVE_INFINITY : Math.max(0, maxGross - this.broker.openGrossUsd());
      const rule = classifyDeterministic(state).vector;
      const veto = (this.vetoes.get(pair) ?? new PairVetoes()).decide({
        ts: state.ts,
        toxicPHigh: decision.vector.toxicPHigh,
        stressPStressed: decision.vector.stressPStressed,
        ruleToxic: rule.toxic_flow_risk === "high",
        ruleStress: rule.liquidity_stress === "stressed",
      });
      // Mirrored outside `decisions` so a paper reset cannot cold-start the ring. The mirror is a
      // calibration convenience, so a write failure is logged and the decision still goes through.
      try {
        await this.store.insertVetoSample({
          pair,
          ts: state.ts,
          toxicPHigh: decision.vector.toxicPHigh,
          stressPStressed: decision.vector.stressPStressed,
        });
      } catch (e) {
        console.error(`veto sample ${pair}:`, (e as Error).message);
      }
      const gatedVector = applyEntryVetoes(decision.vector, veto);
      const gate =
        this.opts.book === "pooled" && this.pool
          ? this.evaluatePooled(pair, position, gatedVector, halt != null, !this.feed.feedHealthy(pair), remainingGrossUsd)
          : evaluateGate({
              position,
              vector: gatedVector,
              horizonVolBps: state.volBps,
              spreadBps: state.spreadBps,
              makerFeeBps: this.opts.makerFeeBps,
              takerFeeBps: this.opts.takerFeeBps,
              feeBuffer: this.opts.feeBuffer,
              buyThreshold: this.opts.buyThreshold,
              sellThreshold: this.opts.sellThreshold,
              depthUsd: book ? depthUsd(book, "buy", 3) : 0,
              notionalUsd: risk?.notionalUsd ?? this.opts.notionalUsd,
              participation: this.opts.depthParticipation,
              minSizeUsd: this.opts.minSizeUsd,
              remainingGrossUsd,
              halted: halt != null,
              feedBlocked: !this.feed.feedHealthy(pair),
              emaCross: state.emaCross,
              htfTrendUp: this.trend.trendUp(pair),
              htfTrendKnown: this.trend.known(pair),
              h4ReturnBps: state.returnsBps.h4,
              stopLossBps: risk?.stopLossBps ?? 0,
              takeProfitBps: risk?.takeProfitBps ?? 0,
            });
      const action = gate.approved ? "buy" : decision.action;
      const gated: GatedDecision = { ...decision, action, gate };
      const target = gate.target;
      const traded = target !== position;
      const id = await this.store.insertDecision({
        run_id: this.runId,
        pair,
        ts: state.ts,
        action,
        p_buy: decision.probabilities.buy,
        p_sell: decision.probabilities.sell,
        mid: state.mid,
        spread_bps: state.spreadBps,
        state: {
          ...state,
          vector: decision.vector,
          gate: {
            ...gate,
            // The toxic veto is deleted, so this pair of fields is an observation, not an action:
            // whether the toxic percentile would have fired, kept so the section 3 forward-return
            // table on /report keeps scoring after the deletion.
            toxicVeto: veto.toxicVeto,
            toxicSource: veto.toxicSource,
            stressVeto: veto.stressVeto,
            stressSource: veto.stressSource,
          },
        },
        latency_ms: Math.round(decision.latencyMs),
        input_tokens: decision.inputTokens,
        inference_usd: inferenceUsd,
        traded,
      });
      this.latest.set(pair, { decision: gated, state, id });
      this.broker.observe(pair, action, inferenceUsd);
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
          sizeUsd: target === "long" ? gate.sizeUsd : undefined,
        };
        this.broker.onIntent(intent);
        if (halt) console.log(`kill ${pair}: ${halt}`);
      }
      if (this.opts.book === "pooled") {
        for (const other of this.lastPlan.flatten) {
          if (other === pair) continue;
          if (this.broker.positionOf(other) !== "long") continue;
          this.broker.onIntent({
            pair: other,
            target: "flat",
            side: "sell",
            purpose: "exit",
            decisionId: id,
            mid: this.feed.book(other)?.mid() ?? state.mid,
            ts: state.ts,
          });
        }
      }
      this.onDecision(id, gated, state, intent);
    } catch (e) {
      console.error(`decide ${pair}:`, (e as Error).message);
    } finally {
      this.busy.set(pair, false);
    }
  }
}

/**
 * Only the stress veto reaches the gate. The toxic veto was deleted after the section 3
 * forward-return test, so overwriting `toxic_flow_risk` with the percentile answer would put a
 * number in front of the gate that nothing reads. Jev's own toxic label is left untouched.
 */
/**
 * Ring seed from both persisted sources, deduped by timestamp and sorted oldest first.
 *
 * Decision rows are the richer source and are wiped by a paper reset. `veto_samples` survives
 * one. Either alone can warm the ring; together they cover both a restart and a reset.
 */
export function mergeSeedSamples(
  decisions: Array<{ ts: number; state: unknown }>,
  samples: Array<{ ts: number; toxicPHigh: number; stressPStressed: number }>,
): VetoSample[] {
  const byTs = new Map<number, VetoSample>();
  for (const row of decisions) {
    const sample = sampleFromState(Number(row.ts), row.state);
    if (sample) byTs.set(sample.ts, sample);
  }
  for (const s of samples) byTs.set(Number(s.ts), { ts: Number(s.ts), toxicPHigh: s.toxicPHigh, stressPStressed: s.stressPStressed });
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

export function applyEntryVetoes(vector: DecisionVector, veto: VetoDecision): DecisionVector {
  return {
    ...vector,
    liquidity_stress: veto.stressVeto ? "stressed" : "normal",
  };
}
