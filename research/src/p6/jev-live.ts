/**
 * One synthetic jev-latest call. A second call throws.
 * The packet is the smoke packet, never a real candidate.
 * Spend is refused above $5.
 */

import { readFileSync, existsSync } from "node:fs";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import { experimental_evaluate } from "ai";
import { costUsdFromTokens } from "../../vendor/87b35d0/jev.ts";
import { assertSynthetic, syntheticPacket } from "../p3/jev";

export const JEV_BUILD_CAP_USD = 5;

export interface JevSpend {
  calls: 1;
  synthetic: true;
  modelId: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
  capUsd: 5;
}

let called = false;

export function jevSpendFromFile(path: string): JevSpend | null {
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as JevSpend;
  if (parsed.calls !== 1 || parsed.synthetic !== true) throw new Error("jev spend receipt is not the one allowed call");
  if (parsed.costUsd != null && (!(parsed.costUsd > 0) || parsed.costUsd > JEV_BUILD_CAP_USD)) throw new Error("jev spend receipt is outside the cap");
  return parsed;
}

/** The only live call this build is allowed to make. */
export async function jevProbeOnce(env: NodeJS.ProcessEnv = process.env): Promise<JevSpend> {
  if (called) throw new Error("refusing a second Jev call");
  called = true;
  const packet = syntheticPacket(new Date());
  assertSynthetic(packet);
  if (!env.TYPESAFE_AI_API_KEY) throw new Error("TYPESAFE_AI_API_KEY is not set");
  const result = await experimental_evaluate({
    model: typeSafeAi.evaluationModel("jev-latest"),
    state: packet as never,
    questions: {
      market_regime: { type: "choice", instructions: { question: "What is the market regime?" }, criteria: { trend: "trend", range: "range", shock: "shock" } },
      direction_bias: { type: "choice", instructions: { question: "What is the direction bias?" }, criteria: { long: "long", flat: "flat" } },
      toxic_flow_risk: { type: "choice", instructions: { question: "What is the toxic flow risk?" }, criteria: { low: "low", high: "high" } },
      liquidity_stress: { type: "choice", instructions: { question: "What is the liquidity stress?" }, criteria: { calm: "calm", stressed: "stressed" } },
    } as never,
    maxRetries: 0,
  });
  const inputTokens = result.usage.inputTokens ?? null;
  const outputTokens = result.usage.outputTokens ?? null;
  const totalTokens = result.usage.totalTokens ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null);
  const costUsd = totalTokens != null && totalTokens > 0 ? costUsdFromTokens(totalTokens) : null;
  if (costUsd != null && costUsd > JEV_BUILD_CAP_USD) throw new Error("jev call exceeded the $5 build cap");
  return {
    calls: 1,
    synthetic: true,
    modelId: result.response.modelId,
    inputTokens,
    outputTokens,
    totalTokens,
    costUsd,
    capUsd: 5,
  };
}
