/**
 * Shadow Jev calls. One drained call per lease-holder tick, after entries are sent.
 * A call never places an order and never reads an order endpoint.
 */

import type { MarketState } from "../../../cb/state";
import { JEV_TIMEOUT_MS } from "../../vendor/87b35d0/config.ts";
import { adjustJevReserve, JEV_CALL_RESERVE_USD, reserveJevCall, type JevMeter, type ShadowPacket } from "./jev-shadow";
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
  | { ok: false; reason: Exclude<JevReason, "no_1m_input">; costUsd?: number };

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
export const JEV_QUESTIONS = {
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

const FIFTEEN_SEC = 900;

/** Start of the 15m bar that most recently closed. Older catch-up bars are not a Jev window. */
export function latestCompletedBarStartSec(nowMs: number): number {
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / FIFTEEN_SEC) * FIFTEEN_SEC - FIFTEEN_SEC;
}

/**
 * True only for the latest completed 15m bar, however late it arrives.
 * A bar still forming is false. An older catch-up bar is false so history is not sent to Jev.
 */
export function scheduleClosedJevBar(barStartSec: number, nowMs: number): boolean {
  if (nowMs < (barStartSec + FIFTEEN_SEC) * 1000) return false;
  return barStartSec === latestCompletedBarStartSec(nowMs);
}

/** Drop done keys and rows that cannot be drained. The handover stores this list. */
export function queuedForHandover(rows: readonly JevQueued[], done: ReadonlySet<string>): JevQueued[] {
  const out: JevQueued[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row.pair !== "string" || typeof row.barStartSec !== "number" || !row.state) continue;
    const key = jevKey(row.pair, row.barStartSec);
    if (done.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ pair: row.pair, barStartSec: row.barStartSec, state: row.state, minutes: Array.isArray(row.minutes) ? row.minutes : [] });
  }
  return out;
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

function skipOne(host: JevDrainHost, row: JevQueued, reason: JevReason, costUsd: number, answer: JevAnswer | null = null): void {
  noteSkip(host.jevSkip, reason, liquidityTier(row.pair));
  host.book.jevSkipped += 1;
  host.book.incidents.push(`jev ${reason} ${row.pair} ${row.barStartSec}`);
  remember(host, row, reason, answer, costUsd);
}

/** A failed call that named its price settles to that price. An unpriced failure keeps the hold. */
function chargeFailure(host: JevDrainHost, reservedUsd: number, costUsd: number | undefined): number {
  if (!(costUsd != null && costUsd > 0)) return reservedUsd;
  try {
    host.jevMeter = adjustJevReserve(host.jevMeter, reservedUsd, costUsd);
    return costUsd;
  } catch {
    return reservedUsd;
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
  const caller = host.jevCaller;
  if (!caller) {
    skipOne(host, next, "not_called", 0);
    dropQueued(host, "not_called");
    return;
  }
  try {
    host.jevMeter = reserveJevCall(host.jevMeter, nowMs);
  } catch {
    skipOne(host, next, "not_called", 0);
    dropQueued(host, "not_called");
    return;
  }
  const reserved = JEV_CALL_RESERVE_USD;
  let outcome: JevCallOutcome;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reachedNetwork = true;
  try {
    outcome = await Promise.race([
      caller(next.state, budget),
      new Promise<JevCallOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "timeout" }), budget);
      }),
    ]);
  } catch {
    reachedNetwork = false;
    outcome = { ok: false, reason: "call_error" };
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (!outcome.ok) {
    if (outcome.reason === "not_called" || !reachedNetwork) {
      host.jevMeter = adjustJevReserve(host.jevMeter, reserved, 0);
      skipOne(host, next, outcome.reason, 0);
      return;
    }
    const billed = chargeFailure(host, reserved, outcome.costUsd);
    skipOne(host, next, outcome.reason, billed);
    return;
  }
  try {
    host.jevMeter = adjustJevReserve(host.jevMeter, reserved, outcome.costUsd);
    host.jevMeter = { ...host.jevMeter, calls: (host.jevMeter.calls ?? 0) + 1 };
  } catch {
    skipOne(host, next, "call_error", reserved, outcome.answer);
    return;
  }
  remember(host, next, "ok", outcome.answer, outcome.costUsd);
}
