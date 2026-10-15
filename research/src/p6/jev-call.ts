/**
 * Shadow Jev calls. One drained call per lease-holder tick, after entries are sent.
 * A call never places an order and never reads an order endpoint.
 */

import type { MarketState } from "../../../cb/state";
import { costUsdFromTokens } from "../../vendor/87b35d0/jev.ts";
import { JEV_TIMEOUT_MS } from "../../vendor/87b35d0/config.ts";
import { chargeJevCall, jevSpendFits, type JevMeter, type ShadowPacket } from "./jev-shadow";
import { liquidityTier, scheduledPairs, type JevMinuteSummary, type JevTape } from "./jev-minute";

export const JEV_CALL_CAP_MS = JEV_TIMEOUT_MS;
/** Matches relay HANDOVER_MARGIN_MS. A call is not started inside this margin. */
export const JEV_CALL_MARGIN_MS = 60_000;
export const JEV_ANSWER_KEEP = 20;

export const JEV_REASONS = ["no_1m_input", "not_called", "timeout", "call_error", "invalid_response"] as const;
export type JevReason = (typeof JEV_REASONS)[number];

export interface JevAnswer {
  market_regime: "expansion" | "balance" | "contraction";
  direction_bias: "long" | "flat";
  toxic_flow_risk: "low" | "high";
  liquidity_stress: "normal" | "stressed";
}

export type JevCallOutcome =
  | { ok: true; answer: JevAnswer; costUsd: number }
  | { ok: false; reason: Exclude<JevReason, "no_1m_input"> };

export type JevCaller = (state: MarketState, timeoutMs: number) => Promise<JevCallOutcome>;

export interface JevQueued {
  pair: string;
  barStartSec: number;
  state: MarketState;
  minutes: JevMinuteSummary[];
}

export interface JevStored {
  pair: string;
  barStartSec: number;
  packet: MarketState;
  minutes: JevMinuteSummary[];
  answer: JevAnswer | null;
  reason: JevReason | "ok";
  costUsd: number;
}

export interface JevSkipLedger {
  byReason: Record<JevReason, number>;
  bySub: { no_trades_feed: number; no_book_feed: number };
  byTier: Record<string, { packets: number; skipped: number }>;
}

export interface JevSkipReport {
  byReason: Record<JevReason, number>;
  byTier: Record<string, number>;
  bySub: { no_trades_feed: number; no_book_feed: number };
}

export function freshJevSkip(): JevSkipLedger {
  return {
    byReason: { no_1m_input: 0, not_called: 0, timeout: 0, call_error: 0, invalid_response: 0 },
    bySub: { no_trades_feed: 0, no_book_feed: 0 },
    byTier: {},
  };
}

export function skipShareReport(ledger: JevSkipLedger): JevSkipReport {
  const packets = Object.values(ledger.byTier).reduce((sum, row) => sum + row.packets, 0);
  const byReason = {} as Record<JevReason, number>;
  for (const reason of JEV_REASONS) byReason[reason] = packets > 0 ? ledger.byReason[reason] / packets : 0;
  const byTier: Record<string, number> = {};
  for (const [tier, row] of Object.entries(ledger.byTier)) byTier[tier] = row.packets > 0 ? row.skipped / row.packets : 0;
  const bySub = {
    no_trades_feed: packets > 0 ? ledger.bySub.no_trades_feed / packets : 0,
    no_book_feed: packets > 0 ? ledger.bySub.no_book_feed / packets : 0,
  };
  return { byReason, byTier, bySub };
}

function noteScheduled(ledger: JevSkipLedger, tier: string): void {
  const row = ledger.byTier[tier] ?? { packets: 0, skipped: 0 };
  row.packets += 1;
  ledger.byTier[tier] = row;
}

function noteSkip(ledger: JevSkipLedger, reason: JevReason, tier: string, sub?: "no_trades_feed" | "no_book_feed"): void {
  ledger.byReason[reason] += 1;
  if (sub) ledger.bySub[sub] += 1;
  const row = ledger.byTier[tier] ?? { packets: 0, skipped: 0 };
  row.skipped += 1;
  ledger.byTier[tier] = row;
}

export function callBudgetMs(nowMs: number, untilMs: number): number {
  return Math.min(JEV_CALL_CAP_MS, untilMs - nowMs - JEV_CALL_MARGIN_MS);
}

export function jevKey(pair: string, barStartSec: number): string {
  return `${pair}:${barStartSec}`;
}

/** Criteria match cb/model.ts. The instructions are the same four questions. */
const JEV_QUESTIONS = {
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
      goal: "This label is a veto. High toxic flow blocks a new long. You do not place orders, set a price target, or compute a fee.",
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

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | null {
  if (!value || typeof value !== "object") return null;
  const choice = (value as { choice?: unknown }).choice;
  if (typeof choice !== "string") return null;
  return (allowed as readonly string[]).includes(choice) ? (choice as T) : null;
}

export function readJevAnswer(answers: unknown): JevAnswer | null {
  if (!answers || typeof answers !== "object") return null;
  const body = answers as Record<string, unknown>;
  const market_regime = oneOf(body.market_regime, ["expansion", "balance", "contraction"] as const);
  const direction_bias = oneOf(body.direction_bias, ["long", "flat"] as const);
  const toxic_flow_risk = oneOf(body.toxic_flow_risk, ["low", "high"] as const);
  const liquidity_stress = oneOf(body.liquidity_stress, ["normal", "stressed"] as const);
  if (!market_regime || !direction_bias || !toxic_flow_risk || !liquidity_stress) return null;
  return { market_regime, direction_bias, toxic_flow_risk, liquidity_stress };
}

function isAbort(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError";
}

/**
 * Live shadow call. No key means not_called and no network.
 * Tests pass a mock caller and do not set the key.
 */
export async function liveJevCaller(state: MarketState, timeoutMs: number, env: NodeJS.ProcessEnv = process.env): Promise<JevCallOutcome> {
  if (!env.TYPESAFE_AI_API_KEY) return { ok: false, reason: "not_called" };
  if (!(timeoutMs > 0)) return { ok: false, reason: "timeout" };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const { experimental_evaluate } = await import("ai");
    const { typeSafeAi } = await import("@ai-sdk/typesafe-ai");
    const result = await experimental_evaluate({
      model: typeSafeAi.evaluationModel("jev-latest"),
      state: state as never,
      questions: JEV_QUESTIONS as never,
      maxRetries: 0,
      abortSignal: controller.signal,
    });
    const answer = readJevAnswer(result.answers);
    if (!answer) return { ok: false, reason: "invalid_response" };
    const inputTokens = result.usage.inputTokens ?? null;
    const outputTokens = result.usage.outputTokens ?? null;
    const total = result.usage.totalTokens ?? (inputTokens != null && outputTokens != null ? inputTokens + outputTokens : null);
    if (total == null || !(total > 0)) return { ok: false, reason: "invalid_response" };
    const costUsd = costUsdFromTokens(total);
    if (!(costUsd > 0)) return { ok: false, reason: "invalid_response" };
    return { ok: true, answer, costUsd };
  } catch (error) {
    if (isAbort(error)) return { ok: false, reason: "timeout" };
    return { ok: false, reason: "call_error" };
  } finally {
    clearTimeout(timer);
  }
}

export interface JevDrainHost {
  clock: () => number;
  kv?: unknown;
  leaseToken: string | null;
  jevMeter: JevMeter;
  jevTape: JevTape;
  jevQueue: JevQueued[];
  jevDone: Set<string>;
  jevAnswers: JevStored[];
  jevSkip: JevSkipLedger;
  jevCaller?: JevCaller;
  book: {
    jevBarSec?: number;
    jevPackets: number;
    jevSkipped: number;
    incidents: string[];
    packets: ShadowPacket[];
    positions: { productId: string }[];
  };
}

export function scheduleLiveJev(host: JevDrainHost, barStartSec: number): void {
  if (host.book.jevBarSec === barStartSec) return;
  host.book.jevBarSec = barStartSec;
  const nowMs = host.clock();
  const pairs = scheduledPairs(host.book.positions.map((position) => position.productId));
  host.book.jevPackets += pairs.length;
  for (const pair of pairs) {
    const tier = liquidityTier(pair);
    noteScheduled(host.jevSkip, tier);
    const key = jevKey(pair, barStartSec);
    if (host.jevDone.has(key)) continue;
    host.jevTape.closeThrough(pair, nowMs);
    const window = host.jevTape.assess(pair, barStartSec * 1000);
    if (!window.ok) {
      noteSkip(host.jevSkip, "no_1m_input", tier, window.sub);
      host.book.jevSkipped += 1;
      host.jevDone.add(key);
      host.book.incidents.push(`jev no_1m_input ${pair} ${barStartSec}${window.sub ? ` ${window.sub}` : ""}`);
      continue;
    }
    const state = host.jevTape.marketState(pair, nowMs);
    if (!state) {
      noteSkip(host.jevSkip, "no_1m_input", tier);
      host.book.jevSkipped += 1;
      host.jevDone.add(key);
      host.book.incidents.push(`jev no_1m_input ${pair} ${barStartSec}`);
      continue;
    }
    host.jevQueue.push({ pair, barStartSec, state, minutes: window.minutes });
    host.book.packets.push({ pair, position: 0, barStartSec, label: "read", called: false });
  }
}

function remember(host: JevDrainHost, row: JevQueued, reason: JevReason | "ok", answer: JevAnswer | null, costUsd: number): void {
  host.jevDone.add(jevKey(row.pair, row.barStartSec));
  host.jevAnswers.push({ pair: row.pair, barStartSec: row.barStartSec, packet: row.state, minutes: row.minutes, answer, reason, costUsd });
  if (host.jevAnswers.length > JEV_ANSWER_KEEP) host.jevAnswers.splice(0, host.jevAnswers.length - JEV_ANSWER_KEEP);
}

function dropQueued(host: JevDrainHost, reason: Exclude<JevReason, "no_1m_input">): void {
  const pending = host.jevQueue.filter((row) => !host.jevDone.has(jevKey(row.pair, row.barStartSec)));
  host.jevQueue = [];
  for (const row of pending) {
    noteSkip(host.jevSkip, reason, liquidityTier(row.pair));
    host.book.jevSkipped += 1;
    host.book.incidents.push(`jev ${reason} ${row.pair} ${row.barStartSec}`);
    remember(host, row, reason, null, 0);
  }
}

/** One shadow call, or none. Does not throw. Does not touch orders. */
export async function drainJevShadow(host: JevDrainHost, nowMs: number, untilMs: number): Promise<void> {
  if (host.kv && host.leaseToken == null) return;
  host.jevQueue = host.jevQueue.filter((row) => !host.jevDone.has(jevKey(row.pair, row.barStartSec)));
  if (host.jevQueue.length === 0) return;
  const budget = callBudgetMs(nowMs, untilMs);
  if (!(budget > 0)) {
    dropQueued(host, "timeout");
    return;
  }
  const next = host.jevQueue[0];
  if (!next) return;
  host.jevQueue = host.jevQueue.slice(1);
  const month = new Date(nowMs).toISOString().slice(0, 7);
  if (!jevSpendFits(host.jevMeter, month)) {
    noteSkip(host.jevSkip, "not_called", liquidityTier(next.pair));
    host.book.jevSkipped += 1;
    host.book.incidents.push(`jev not_called ${next.pair} ${next.barStartSec}`);
    remember(host, next, "not_called", null, 0);
    dropQueued(host, "not_called");
    return;
  }
  const caller = host.jevCaller ?? liveJevCaller;
  let outcome: JevCallOutcome;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    outcome = await Promise.race([
      caller(next.state, budget),
      new Promise<JevCallOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), budget);
      }),
    ]);
  } catch {
    outcome = { ok: false, reason: "call_error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!outcome.ok) {
    noteSkip(host.jevSkip, outcome.reason, liquidityTier(next.pair));
    host.book.jevSkipped += 1;
    host.book.incidents.push(`jev ${outcome.reason} ${next.pair} ${next.barStartSec}`);
    remember(host, next, outcome.reason, null, 0);
    return;
  }
  try {
    host.jevMeter = chargeJevCall(host.jevMeter, outcome.costUsd, nowMs);
  } catch {
    noteSkip(host.jevSkip, "call_error", liquidityTier(next.pair));
    host.book.jevSkipped += 1;
    host.book.incidents.push(`jev call_error ${next.pair} ${next.barStartSec}`);
    remember(host, next, "call_error", outcome.answer, 0);
    return;
  }
  remember(host, next, "ok", outcome.answer, outcome.costUsd);
}
