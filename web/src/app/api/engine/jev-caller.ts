/**
 * The only module that imports the Jev SDK. Research tests pass a mock and never reach this file.
 * No key means not_called and no connection.
 */

import { experimental_evaluate } from "ai";
import { typeSafeAi } from "@ai-sdk/typesafe-ai";
import type { MarketState } from "../../../../../cb/state";
import { costUsdFromTokens } from "../../../../../research/vendor/87b35d0/jev.ts";
import { JEV_QUESTIONS, readJevAnswer, type JevCallOutcome } from "../../../../../research/src/p6/jev-call";

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export async function liveJevCaller(state: MarketState, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<JevCallOutcome> {
  if (!env.TYPESAFE_AI_API_KEY) return { ok: false, reason: "not_called" };
  if (!(timeoutMs > 0)) return { ok: false, reason: "timeout" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const result = await experimental_evaluate({
      model: typeSafeAi.evaluationModel("jev-latest"),
      state: state as never,
      questions: JEV_QUESTIONS as never,
      maxRetries: 0,
      abortSignal: controller.signal,
    });
    const answer = readJevAnswer(result.answers);
    const inputTokens = result.usage.inputTokens ?? null;
    const outputTokens = result.usage.outputTokens ?? null;
    const total = result.usage.totalTokens ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null);
    const costUsd = total != null && total > 0 ? costUsdFromTokens(total) : 0;
    if (!answer || !(costUsd > 0)) return { ok: false, reason: "invalid_response", ...(costUsd > 0 ? { costUsd } : {}), ...(total != null ? { tokens: total } : {}) };
    return { ok: true, answer, costUsd, ...(total != null ? { tokens: total } : {}) };
  } catch (error) {
    if (isAbort(error)) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "call_error" };
  } finally {
    clearTimeout(timer);
  }
}
