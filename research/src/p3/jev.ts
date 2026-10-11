import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { experimental_evaluate } from "ai";

/** Synthetic packet only. Never built from a real candidate. */
export interface SyntheticPacket {
  synthetic: true;
  pair: "SYNTHETIC-USD";
  asOf: string;
  decisionTs: string;
  spreadBps: number;
  position: 0;
}

export function syntheticPacket(now: Date): SyntheticPacket {
  const asOf = now.toISOString();
  return {
    synthetic: true,
    pair: "SYNTHETIC-USD",
    asOf,
    decisionTs: asOf,
    spreadBps: 5,
    position: 0,
  };
}

export function assertSynthetic(packet: { synthetic?: boolean; pair?: string }): void {
  if (packet.synthetic !== true || packet.pair !== "SYNTHETIC-USD") {
    throw new Error("Jev transport smoke refuses a real candidate");
  }
}

const QUESTIONS = [
  { id: "market_regime", question: "What is the market regime?", options: ["trend", "range", "shock"] },
  { id: "direction_bias", question: "What is the direction bias?", options: ["long", "flat"] },
  { id: "toxic_flow_risk", question: "What is the toxic flow risk?", options: ["low", "high"] },
  { id: "liquidity_stress", question: "What is the liquidity stress?", options: ["calm", "stressed"] },
] as const;

export interface JevSmokeResult {
  modelId: string;
  latencyMs: number;
  synthetic: true;
}

/**
 * One direct jev-latest call. The API key is read from the environment and is not returned.
 */
export async function jevSmoke(env: NodeJS.ProcessEnv, now = new Date()): Promise<JevSmokeResult> {
  const packet = syntheticPacket(now);
  assertSynthetic(packet);
  if (!env.TYPESAFE_AI_API_KEY) throw new Error("TYPESAFE_AI_API_KEY is not set");
  const modelId = "jev-latest";
  const started = performance.now();
  const result = await experimental_evaluate({
    model: typeSafeAi.evaluationModel(modelId),
    state: packet as never,
    questions: {
      market_regime: { type: "choice", instructions: { question: QUESTIONS[0].question }, criteria: { trend: "trend", range: "range", shock: "shock" } },
      direction_bias: { type: "choice", instructions: { question: QUESTIONS[1].question }, criteria: { long: "long", flat: "flat" } },
      toxic_flow_risk: { type: "choice", instructions: { question: QUESTIONS[2].question }, criteria: { low: "low", high: "high" } },
      liquidity_stress: { type: "choice", instructions: { question: QUESTIONS[3].question }, criteria: { calm: "calm", stressed: "stressed" } },
    } as never,
    maxRetries: 0,
  });
  const latencyMs = performance.now() - started;
  const raw = result as { modelId?: string; response?: { modelId?: string } };
  return { modelId: raw.response?.modelId ?? raw.modelId ?? modelId, latencyMs, synthetic: true };
}
