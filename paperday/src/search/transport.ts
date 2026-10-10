/**
 * Real Jev transport. This module does not call the network unless
 * `reviewWithJev` is awaited, and that function returns before any call
 * when neither TYPESAFE_AI_API_KEY nor AI_GATEWAY_API_KEY is set.
 * The key is read only to decide which client to construct. It is never
 * copied into a log, an error string, or a return value.
 */

import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import type { JevPacket } from "../jev";
import type { CachedReview } from "./jev";
import { JEV_MODEL_ID, costOf, jevBlockedReason, redactSecrets } from "./jev";

export type JevTransportPlan =
  | { kind: "blocked"; reason: string }
  | { kind: "gateway"; model: typeof JEV_MODEL_ID }
  | { kind: "typesafe"; model: typeof JEV_MODEL_ID };

/** Gateway wins when both keys are set, matching the repo client's preference. The key itself is not returned. */
export function jevTransportPlan(env: Record<string, string | undefined>): JevTransportPlan {
  if (env.AI_GATEWAY_API_KEY) return { kind: "gateway", model: JEV_MODEL_ID };
  if (env.TYPESAFE_AI_API_KEY) return { kind: "typesafe", model: JEV_MODEL_ID };
  return { kind: "blocked", reason: jevBlockedReason(env) ?? "blocked: TYPESAFE_AI_API_KEY not present" };
}

const QUESTIONS = {
  market_regime: {
    type: "choice" as const,
    instructions: {
      question: "What regime is this pair in?",
      goal: "This label is a veto. You do not place an order, set a price target, or compute a fee.",
      timing: "The label is read at the packet's as-of time.",
      inputs: "The packet has close, stop, atr, rsi, and vwap from candles already closed.",
    },
    criteria: {
      expansion: "Volatility is expanding and the tape has a directional character.",
      balance: "Two-way trade inside a range, without a fresh expansion.",
      contraction: "Volatility is compressing or the tape is quiet.",
    },
  },
  direction_bias: {
    type: "choice" as const,
    instructions: {
      question: "Is the recorded bias long or flat? The book is long-only.",
      goal: "Record direction only. You do not place an order, set a price target, or compute a fee.",
      timing: "The bias is read at the packet's as-of time.",
      inputs: "rsi, close versus vwap, and whether the higher-timeframe bias was up.",
    },
    criteria: {
      long: "The next swing is more likely to be higher.",
      flat: "No convincing long bias.",
    },
  },
  toxic_flow_risk: {
    type: "choice" as const,
    instructions: {
      question: "Is taker flow toxic or ordinary?",
      goal: "This label is a veto. You do not place an order, set a price target, or compute a fee.",
      timing: "The label is read at the packet's as-of time.",
      inputs: "The packet does not include a live order book. Judge from the candle path only, and prefer low when the path is quiet.",
    },
    criteria: {
      low: "Nothing in the closed candles shows one-sided aggressive flow.",
      high: "The closed candles show a one-sided spike that is likely to fade.",
    },
  },
  liquidity_stress: {
    type: "choice" as const,
    instructions: {
      question: "Is the book normally liquid or stressed?",
      goal: "This label is a veto on a new long. You do not place an order, set a price target, or compute a fee.",
      timing: "The label is read at the packet's as-of time.",
      inputs: "atr versus close is the only stress proxy in the packet.",
    },
    criteria: {
      normal: "Range and ATR look ordinary.",
      stressed: "ATR is wide versus the price, or the candle path is disjointed.",
    },
  },
};

function choiceOf(
  answer: { choice?: string; probabilities?: Record<string, number> } | undefined,
  key: string,
): { choice: string; probabilities: Record<string, number> } {
  if (!answer?.choice) throw new Error(`jev missing ${key}`);
  return { choice: answer.choice, probabilities: answer.probabilities ?? { [answer.choice]: 1 } };
}

/**
 * One paid review of one point-in-time packet.
 * Throws the blocked reason when no key is set, before constructing a client.
 */
export async function reviewWithJev(env: Record<string, string | undefined>, packet: JevPacket, hash: string): Promise<CachedReview> {
  const plan = jevTransportPlan(env);
  if (plan.kind === "blocked") throw new Error(plan.reason);
  const model = plan.kind === "gateway" ? plan.model : typeSafeAi.evaluationModel(plan.model);
  let raw: {
    answers?: Record<string, { choice?: string; probabilities?: Record<string, number> } | undefined>;
    usage?: { inputTokens?: number; outputTokens?: number };
  };
  try {
    raw = await experimental_evaluate({
      model: model as never,
      state: {
        pair: packet.pair,
        asOf: packet.asOf,
        close: packet.close,
        stop: packet.stop,
        atr: packet.atr,
        rsi: packet.rsi,
        vwap: packet.vwap,
        sentiment: packet.sentiment,
        biasUp: packet.biasUp,
        setup: packet.setup,
      },
      questions: QUESTIONS,
      maxRetries: 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(redactSecrets(message));
  }
  const answers = raw.answers ?? {};
  const regime = choiceOf(answers.market_regime, "market_regime").choice;
  const bias = choiceOf(answers.direction_bias, "direction_bias");
  const toxic = choiceOf(answers.toxic_flow_risk, "toxic_flow_risk").choice;
  const stress = choiceOf(answers.liquidity_stress, "liquidity_stress").choice;
  if (regime !== "expansion" && regime !== "balance" && regime !== "contraction") throw new Error(`jev regime ${regime}`);
  if (bias.choice !== "long" && bias.choice !== "flat") throw new Error(`jev direction ${bias.choice}`);
  if (toxic !== "low" && toxic !== "high") throw new Error(`jev toxic ${toxic}`);
  if (stress !== "normal" && stress !== "stressed") throw new Error(`jev stress ${stress}`);
  const tokens = (raw.usage?.inputTokens ?? 0) + (raw.usage?.outputTokens ?? 0);
  const longConfidence = bias.probabilities.long ?? (bias.choice === "long" ? 1 : 0);
  return {
    hash,
    model: JEV_MODEL_ID,
    tokens,
    costUsd: costOf(tokens),
    labels: {
      regime,
      direction_bias: bias.choice,
      toxic_flow: toxic,
      liquidity_stress: stress,
    },
    longConfidence,
  };
}
