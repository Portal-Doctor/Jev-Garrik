import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { config } from "./config";
import type { DecisionVector, LiquidityStress, Regime, ToxicFlow } from "./gate";
import type { MarketState } from "./state";

/** Spot, long/flat: `buy` targets a long position, `sell` targets flat. */
export type Action = "buy" | "sell";

export interface Decision {
  action: Action;
  probabilities: { buy: number; sell: number };
  /** Probability of `long`. This is the direction_bias score, not a separate model number. */
  pBuy: number;
  vector: DecisionVector;
  latencyMs: number;
  inputTokens: number;
}

export interface Model {
  readonly name: string;
  decide(state: MarketState): Promise<Decision>;
}

/**
 * One classification, four choices. Regime, toxic flow, and liquidity stress are vetoes.
 * Direction is recorded and is not the order. Jev does not set a price target or a fee.
 */
const QUESTIONS = {
  market_regime: {
    type: "choice",
    instructions: {
      question: "What regime is this pair in?",
      goal: "This label is a veto. Contraction blocks a new long and flattens an open long. You do not place orders, set a price target, or compute a fee.",
      timing: "The label is read now and reevaluated each cycle.",
      inputs: "`volBps` is realized volatility scaled to the horizon. `parkinsonBps` is high-low vol from 1 minute candles. `returnsBps` is the path. Expansion is a directional, volatile tape. Balance is a two-way range. Contraction is a quiet tape.",
    },
    criteria: {
      expansion: "Volatility is expanding and the tape has a directional character.",
      balance: "Two-way trade inside a range, without a fresh expansion.",
      contraction: "Volatility is compressing or the tape is quiet.",
    },
  },
  direction_bias: {
    type: "choice",
    instructions: {
      question: "Is the recorded bias long or flat? Coinbase spot cannot short.",
      goal: "Record direction only. The order is not yours. A long bias is not an instruction to buy, and a flat bias is not an instruction to sell. You do not place orders, set a price target, or compute a fee.",
      timing: "The bias is read now. Code decides whether a long is opened.",
      inputs: "`imbalance5` and `imbalance20` are resting pressure at the top of book, from -1 (asks) to 1 (bids). `volumeDelta` is taker buy minus taker sell over the feature window, and `volumeGross` is the total. `emaCross` and `emaGapBps` are the fast versus slow average. `rsi` is Wilder RSI on 1 minute closes. `position` is current spot exposure.",
    },
    criteria: {
      long: "Mid is more likely to be higher after the horizon.",
      flat: "No convincing long bias.",
    },
  },
  toxic_flow_risk: {
    type: "choice",
    instructions: {
      question: "Is taker flow toxic or ordinary?",
      goal: "This label is a veto. High toxic flow blocks a new long and flattens an open long. You do not place orders, set a price target, or compute a fee.",
      timing: "The label is read now.",
      inputs: "`volumeDelta` against `imbalance5` is the tell: heavy taker flow pushing through resting size is toxic. Quiet or agreeing flow is low risk.",
    },
    criteria: {
      low: "Taker flow is ordinary and not running the book.",
      high: "Aggressive flow is one-sided and likely to fade a passive quote.",
    },
  },
  liquidity_stress: {
    type: "choice",
    instructions: {
      question: "Is the book normally liquid or stressed?",
      goal: "This label is a veto on a new long. A stressed book blocks the entry. You do not place orders, set a price target, or compute a fee.",
      timing: "The label is read now.",
      inputs: "`spreadBps` against `spreadEmaBps`, plus thin size behind `imbalance5`, marks a stressed book. A spread sitting on its average is normal.",
    },
    criteria: {
      normal: "Spread and depth are ordinary for this pair.",
      stressed: "The spread is wide versus its average, or the near touch is thin.",
    },
  },
} as const;

const REGIMES = ["expansion", "balance", "contraction"] as const;
const TOXIC = ["low", "high"] as const;
const STRESS = ["normal", "stressed"] as const;

function readChoice(
  answer: { choice?: string; probabilities?: Record<string, number> } | undefined,
  key: string,
): { choice: string; probabilities: Record<string, number> } {
  if (!answer?.choice) throw new Error(`jev missing ${key}`);
  return { choice: answer.choice, probabilities: answer.probabilities ?? { [answer.choice]: 1 } };
}

function expectOne<T extends string>(value: string, allowed: readonly T[], key: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`jev ${key} returned ${value}`);
}

function fromAnswers(answers: {
  market_regime?: { choice?: string; probabilities?: Record<string, number> };
  direction_bias?: { choice?: string; probabilities?: Record<string, number> };
  toxic_flow_risk?: { choice?: string; probabilities?: Record<string, number> };
  liquidity_stress?: { choice?: string; probabilities?: Record<string, number> };
}): { action: Action; probabilities: { buy: number; sell: number }; pBuy: number; vector: DecisionVector } {
  const regime = expectOne(readChoice(answers.market_regime, "market_regime").choice, REGIMES, "market_regime") as Regime;
  const bias = readChoice(answers.direction_bias, "direction_bias");
  const direction = expectOne(bias.choice, ["long", "flat"] as const, "direction_bias");
  const toxic = expectOne(readChoice(answers.toxic_flow_risk, "toxic_flow_risk").choice, TOXIC, "toxic_flow_risk") as ToxicFlow;
  const stress = expectOne(readChoice(answers.liquidity_stress, "liquidity_stress").choice, STRESS, "liquidity_stress") as LiquidityStress;
  const confidence = bias.probabilities.long ?? (direction === "long" ? 1 : 0);
  const flatP = bias.probabilities.flat ?? 1 - confidence;
  return {
    action: direction === "long" ? "buy" : "sell",
    probabilities: { buy: confidence, sell: flatP },
    pBuy: confidence,
    vector: {
      market_regime: regime,
      direction_bias: direction,
      toxic_flow_risk: toxic,
      liquidity_stress: stress,
      confidence,
    },
  };
}

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
      this.model = config.jevGatewayModelId;
    } else {
      this.name = config.jevModelId;
      this.model = typeSafeAi.evaluationModel(config.jevModelId);
    }
  }

  async decide(state: MarketState): Promise<Decision> {
    const t0 = performance.now();
    const r = await experimental_evaluate({ model: this.model, state: state as any, questions: QUESTIONS, maxRetries: 0 });
    const parsed = fromAnswers(r.answers);
    return {
      ...parsed,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.inputTokens ?? 0,
    };
  }
}

/**
 * Deterministic classifier shared by the mock model and the historical backtest.
 * Direction is momentum, imbalance, and CVD. Regime is realized vol.
 * Stress is the spread versus its EMA. No network and no sleep.
 */
export function classifyDeterministic(state: MarketState): {
  action: Action;
  probabilities: { buy: number; sell: number };
  pBuy: number;
  vector: DecisionVector;
} {
  const flow = state.volumeGross > 0 ? state.volumeDelta / state.volumeGross : 0;
  const momentum = state.returnsBps.h1 / 20 + state.returnsBps.h4 / 40;
  const signal = momentum + state.imbalance5 * 1.2 + flow * 1.5 + mockNoise(state);
  const confidence = 1 / (1 + Math.exp(-signal));
  const direction = confidence >= 0.5 ? "long" : "flat";
  const regime: Regime = state.volBps >= 80 ? "expansion" : state.volBps >= 25 ? "balance" : "contraction";
  const stressed = state.spreadEmaBps > 0 && state.spreadBps > state.spreadEmaBps * 1.5;
  const toxic: ToxicFlow =
    Math.abs(flow) >= 0.65 && momentum !== 0 && Math.sign(flow) !== Math.sign(momentum) ? "high" : "low";
  const vector: DecisionVector = {
    market_regime: regime,
    direction_bias: direction,
    toxic_flow_risk: toxic,
    liquidity_stress: (stressed ? "stressed" : "normal") as LiquidityStress,
    confidence,
  };
  return {
    action: direction === "long" ? "buy" : "sell",
    probabilities: { buy: confidence, sell: 1 - confidence },
    pBuy: confidence,
    vector,
  };
}

/** Deterministic per (pair, decision slot): stable across a restart within the same cycle. */
function mockNoise(state: MarketState): number {
  let h = 2166136261 >>> 0;
  const seed = `${state.pair}:${Math.floor(state.ts / (config.decideSec * 1000))}`;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return ((h % 1000) / 1000 - 0.5) * 2;
}

/**
 * Deterministic stand-in. Direction is the momentum, imbalance, and CVD heuristic.
 * Regime comes from realized vol. Stress comes from the spread versus its EMA.
 */
export class MockModel implements Model {
  readonly name = "mock";

  async decide(state: MarketState): Promise<Decision> {
    const t0 = performance.now();
    const parsed = classifyDeterministic(state);
    await Bun.sleep(150);
    return {
      ...parsed,
      latencyMs: performance.now() - t0,
      inputTokens: Math.round(JSON.stringify(state).length / 4),
    };
  }
}

export const createModel = (): Model => (config.model === "jev" ? new JevModel() : new MockModel());
