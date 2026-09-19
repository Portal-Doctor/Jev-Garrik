import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";
import type { MarketState } from "./state";

/** Spot, long/flat: `buy` targets a long position, `sell` targets flat. */
export type Action = "buy" | "sell";

export interface Decision {
  action: Action;
  probabilities: { buy: number; sell: number };
  /** buy probability = probability mid is higher after the horizon. */
  pBuy: number;
  latencyMs: number;
  inputTokens: number;
}

export interface Model {
  readonly name: string;
  decide(state: MarketState): Promise<Decision>;
}

/**
 * The question mirrors the Kuru prompt but states the horizon in hours and gives the round-trip
 * cost in bps explicitly; the criteria require the expected move to beat that cost. This is the
 * whole empirical test: does the model have edge at multi-hour horizons after fees?
 */
const QUESTIONS = {
  direction: {
    type: "choice",
    instructions: {
      question: "Will this pair's mid be higher or lower than the current mid after `horizonSec` seconds (stated in hours below)?",
      goal: "Trade a Coinbase spot pair, long or flat only. A `buy` opens or holds a long; a `sell` closes to flat. A round trip costs about `feeBps.maker + feeBps.taker` basis points, so only call `buy` when the expected move over the horizon beats that cost. The horizon is `horizonSec / 3600` hours.",
      timing: "The decision is acted on now and reevaluated each cycle; the position closes when the horizon expires without a refreshing buy.",
      inputs: "Taker flow is the strongest signal: `trades.cvdBase` (taker buys minus taker sells) and its split show who is hitting the book. `depth` shows resting liquidity per side at several distances from mid; thin depth on one side means price moves that way more easily. `returnsBps` (m5..h24) and `recentMids` show the path over several horizons. `bookImbalance` is resting pressure within 1% of mid. `position` is your current spot exposure.",
    },
    criteria: {
      buy: "Go long now: mid more likely to be higher after the horizon, by more than the round-trip cost in `feeBps`.",
      sell: "Go flat now: mid more likely to be lower after the horizon, or not enough to beat the round-trip cost.",
    },
  },
} as const;

/**
 * Real Jev via the AI SDK. Two transports:
 * - Vercel AI Gateway (AI_GATEWAY_API_KEY set): pass the string model id `typesafe-ai/jev`; the SDK
 *   resolves it through the Gateway. No TypeSafe waitlist/key needed.
 * - Direct TypeSafe provider (otherwise): `typeSafeAi.evaluationModel(...)` with TYPESAFE_AI_API_KEY.
 */
export class JevModel implements Model {
  readonly name: string;
  private readonly model: ReturnType<typeof typeSafeAi.evaluationModel> | string;

  constructor() {
    if (config.aiGatewayApiKey) {
      this.name = config.jevGatewayModelId;
      this.model = config.jevGatewayModelId; // string routes via the Gateway
    } else {
      this.name = config.jevModelId;
      this.model = typeSafeAi.evaluationModel(config.jevModelId);
    }
  }

  async decide(state: MarketState): Promise<Decision> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: QUESTIONS, maxRetries: 0 });
    const a = r.answers.direction;
    const p = a.probabilities ?? { buy: 0, sell: 0, [a.choice]: 1 };
    const buy = p.buy ?? 0;
    const sell = p.sell ?? 0;
    return {
      action: a.choice as Action,
      probabilities: { buy, sell },
      pBuy: buy,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

/**
 * Deterministic stand-in for pipeline testing. Multi-hour momentum (h1/h4) + book imbalance +
 * taker flow (CVD), squashed to a probability, with seeded per-slot noise so it trades both ways.
 * `Bun.sleep(150)` stands in for inference latency.
 */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: MarketState): Promise<Decision> {
    const t0 = performance.now();
    const flow = state.trades.buyBase + state.trades.sellBase
      ? state.trades.cvdBase / (state.trades.buyBase + state.trades.sellBase)
      : 0;
    const signal =
      state.returnsBps.h1 / 20 +
      state.returnsBps.h4 / 40 +
      state.bookImbalance * 1.2 +
      flow * 1.5 +
      this.noise(state);
    const buy = 1 / (1 + Math.exp(-signal));
    const probabilities = { buy, sell: 1 - buy };
    const action: Action = buy >= 0.5 ? "buy" : "sell";
    await Bun.sleep(150);
    return {
      action,
      probabilities,
      pBuy: buy,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }

  /** Deterministic per (pair, decision slot): stable across a restart within the same cycle. */
  private noise(state: MarketState): number {
    let h = 2166136261 >>> 0;
    const seed = `${state.pair}:${Math.floor(state.ts / (config.decideSec * 1000))}`;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ((h % 1000) / 1000 - 0.5) * 2;
  }
}

export const createModel = (): Model => (config.model === "jev" ? new JevModel() : new MockModel());
