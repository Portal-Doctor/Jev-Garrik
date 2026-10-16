/**
 * Shadow Jev calls. One drained call per lease-holder tick, after entries are sent.
 * A call never places an order and never reads an order endpoint.
 */

import { createHash } from "node:crypto";
import type { MarketState } from "../../../cb/state";
import { JEV_TIMEOUT_MS } from "../../vendor/87b35d0/config.ts";
import { adjustJevReserve, JEV_CALL_RESERVE_USD, reserveJevCall, type JevMeter, type ShadowPacket } from "./jev-shadow";
import { liquidityTier, scheduledPairs, type JevMinuteSummary, type JevTape } from "./jev-minute";

export const JEV_CALL_CAP_MS = JEV_TIMEOUT_MS;
/** Matches relay HANDOVER_MARGIN_MS. A call is not started inside this margin. */
export const JEV_CALL_MARGIN_MS = 60_000;
export const JEV_ANSWER_KEEP = 20;
/** Bar length plus 600s. An uncalled packet is a counted timeout at this age. */
export const JEV_EXPIRY_SEC = 900 + 600;
export const JEV_PACKET_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const JEV_DONE_BARS = 8;
const LEASE_KEY = "p6:lease";

export const JEV_REASONS = ["no_1m_input", "not_called", "timeout", "call_error", "invalid_response"] as const;
export type JevReason = (typeof JEV_REASONS)[number];

export interface JevAnswer {
  market_regime: "expansion" | "balance" | "contraction";
  direction_bias: "long" | "flat";
  toxic_flow_risk: "low" | "high";
  liquidity_stress: "normal" | "stressed";
}

export type JevCallOutcome =
  | { ok: true; answer: JevAnswer; costUsd: number; tokens?: number }
  | { ok: false; reason: Exclude<JevReason, "no_1m_input">; costUsd?: number; tokens?: number };

export type JevCaller = (state: MarketState, timeoutMs: number) => Promise<JevCallOutcome>;

export interface JevQueued {
  pair: string;
  barStartSec: number;
  state: MarketState;
  minutes: JevMinuteSummary[];
  /** In-process only. A crash leaves the row queued for the next holder. */
  inflight?: boolean;
}

export interface JevStored {
  pair: string;
  barStartSec: number;
  answer: JevAnswer | null;
  reason: JevReason | "ok";
  costUsd: number;
  tokens: number | null;
  answeredAtMs: number;
  latencyMs: number;
  packetHash: string;
  holder?: string;
  handoverMinutes?: number;
  /** True when the answer is included in guard-effect scoring. */
  guardIncluded?: boolean;
  /** Mid used for scoring. The arrival mid at answeredAtMs, never the bar-close mid. */
  scoreMid?: number | null;
}

export interface JevLatencyBuckets {
  le60: number;
  le300: number;
  le600: number;
}

export interface JevSkipLedger {
  byReason: Record<JevReason, number>;
  bySub: { no_trades_feed: number; no_book_feed: number };
  byTier: Record<string, { packets: number; skipped: number }>;
  latency: JevLatencyBuckets;
  handoverMinutes: number;
  holder: string;
}

export interface JevSkipReport {
  byReason: Record<JevReason, number>;
  byTier: Record<string, number>;
  bySub: { no_trades_feed: number; no_book_feed: number };
  latency: JevLatencyBuckets;
  handoverMinutes: number;
  holder: string;
}

export function freshJevSkip(): JevSkipLedger {
  return {
    byReason: { no_1m_input: 0, not_called: 0, timeout: 0, call_error: 0, invalid_response: 0 },
    bySub: { no_trades_feed: 0, no_book_feed: 0 },
    byTier: {},
    latency: { le60: 0, le300: 0, le600: 0 },
    handoverMinutes: 0,
    holder: "",
  };
}

export function normalizeJevSkip(ledger: Partial<JevSkipLedger> | undefined): JevSkipLedger {
  const fresh = freshJevSkip();
  if (!ledger) return fresh;
  return {
    byReason: { ...fresh.byReason, ...ledger.byReason },
    bySub: { ...fresh.bySub, ...ledger.bySub },
    byTier: ledger.byTier ?? {},
    latency: { ...fresh.latency, ...ledger.latency },
    handoverMinutes: ledger.handoverMinutes ?? 0,
    holder: ledger.holder ?? "",
  };
}

export function skipShareReport(ledger: JevSkipLedger): JevSkipReport {
  const row = normalizeJevSkip(ledger);
  const packets = Object.values(row.byTier).reduce((sum, item) => sum + item.packets, 0);
  const byReason = {} as Record<JevReason, number>;
  for (const reason of JEV_REASONS) byReason[reason] = packets > 0 ? row.byReason[reason] / packets : 0;
  const byTier: Record<string, number> = {};
  for (const [tier, item] of Object.entries(row.byTier)) byTier[tier] = item.packets > 0 ? item.skipped / item.packets : 0;
  const bySub = {
    no_trades_feed: packets > 0 ? row.bySub.no_trades_feed / packets : 0,
    no_book_feed: packets > 0 ? row.bySub.no_book_feed / packets : 0,
  };
  return { byReason, byTier, bySub, latency: { ...row.latency }, handoverMinutes: row.handoverMinutes, holder: row.holder };
}

/** Exclusive buckets. 60s is le60, 300s is le300, 600s is le600. */
export function noteLatency(ledger: JevSkipLedger, latencyMs: number): void {
  const row = ledger.latency ?? (ledger.latency = { le60: 0, le300: 0, le600: 0 });
  if (latencyMs <= 60_000) row.le60 += 1;
  else if (latencyMs <= 300_000) row.le300 += 1;
  else if (latencyMs <= 600_000) row.le600 += 1;
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
  stopped?: boolean;
  holderId?: string | null;
  jevMeter: JevMeter;
  jevTape: JevTape;
  jevQueue: JevQueued[];
  jevDone: Set<string>;
  jevAnswers: JevStored[];
  jevSkip: JevSkipLedger;
  jevCaller?: JevCaller;
  jevPacketWrites?: { key: string; value: string }[];
  jevPacketSent?: Set<string>;
  book: {
    jevBarSec?: number;
    jevPackets: number;
    jevSkipped: number;
    incidents: string[];
    packets: ShadowPacket[];
    positions: { productId: string }[];
    closed?: { productId: string; exitTs: number }[];
  };
}

const FIFTEEN_SEC = 900;

/** Start of the 15m bar that most recently closed. Older catch-up bars are not a Jev window. */
export function latestCompletedBarStartSec(nowMs: number): number {
  const nowSec = Math.floor(nowMs / 1000);
  return Math.floor(nowSec / FIFTEEN_SEC) * FIFTEEN_SEC - FIFTEEN_SEC;
}

/** True once the 15m bar has closed, however late. A bar still forming is false. */
export function scheduleClosedJevBar(barStartSec: number, nowMs: number): boolean {
  return nowMs >= (barStartSec + FIFTEEN_SEC) * 1000;
}

export function packetExpired(barStartSec: number, nowMs: number): boolean {
  return Math.floor(nowMs / 1000) >= barStartSec + JEV_EXPIRY_SEC;
}

export function jevAnswerKey(pair: string, barStartSec: number): string {
  return `p6:jev:ans:${pair}:${barStartSec}`;
}

/** Last 8 bar starts, plus any key whose packet has not expired. */
export function boundJevDone(keys: readonly string[], nowSec: number): string[] {
  const parsed = keys
    .map((key) => {
      const cut = key.lastIndexOf(":");
      return { key, bar: Number(key.slice(cut + 1)) };
    })
    .filter((row) => Number.isFinite(row.bar));
  const bars = [...new Set(parsed.map((row) => row.bar))].sort((a, b) => b - a);
  const keep = new Set(bars.slice(0, JEV_DONE_BARS));
  return parsed.filter((row) => keep.has(row.bar) || nowSec < row.bar + JEV_EXPIRY_SEC).map((row) => row.key);
}

export function packetHash(state: MarketState, minutes: readonly JevMinuteSummary[]): string {
  return createHash("sha256").update(JSON.stringify({ state, minutes })).digest("hex");
}

/**
 * Guard-effect scoring uses the mid at answeredAtMs. A trade already closed
 * by then is excluded. The bar-close mid is never the score.
 */
export function guardEffectScore(opts: {
  answeredAtMs: number;
  arrivalMid: number | null;
  barCloseMid: number | null;
  tradeClosedAtMs: number | null;
}): { included: boolean; mid: number | null } {
  void opts.barCloseMid;
  if (opts.tradeClosedAtMs != null && opts.tradeClosedAtMs <= opts.answeredAtMs) return { included: false, mid: null };
  return { included: true, mid: opts.arrivalMid };
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
    const key = jevKey(pair, barStartSec);
    if (host.jevDone.has(key) || host.jevQueue.some((row) => jevKey(row.pair, row.barStartSec) === key)) continue;
    noteScheduled(host.jevSkip, tier);
    if (packetExpired(barStartSec, nowMs)) {
      const state = host.jevTape.marketState(pair, nowMs) ?? ({ pair } as MarketState);
      skipOne(host, { pair, barStartSec, state, minutes: [] }, "timeout", 0);
      continue;
    }
    host.jevTape.closeThrough(pair, nowMs);
    const window = host.jevTape.assess(pair, barStartSec * 1000);
    if (!window.ok) {
      noteSkip(host.jevSkip, "no_1m_input", tier, window.sub);
      host.book.jevSkipped += 1;
      host.jevDone.add(key);
      host.book.incidents.push(`jev no_1m_input ${pair} ${barStartSec}${window.sub ? ` ${window.sub}` : ""}`);
      const state = host.jevTape.marketState(pair, nowMs) ?? ({ pair } as MarketState);
      remember(host, { pair, barStartSec, state, minutes: window.minutes }, "no_1m_input", null, 0, null);
      continue;
    }
    const state = host.jevTape.marketState(pair, nowMs);
    if (!state) {
      noteSkip(host.jevSkip, "no_1m_input", tier);
      host.book.jevSkipped += 1;
      host.jevDone.add(key);
      host.book.incidents.push(`jev no_1m_input ${pair} ${barStartSec}`);
      remember(host, { pair, barStartSec, state: { pair } as MarketState, minutes: window.minutes }, "no_1m_input", null, 0, null);
      continue;
    }
    host.jevQueue.push({ pair, barStartSec, state, minutes: window.minutes });
    host.book.packets.push({ pair, position: 0, barStartSec, label: "read", called: false });
  }
}

function closedAtMs(host: JevDrainHost, pair: string, answeredAtMs: number): number | null {
  if (host.book.positions.some((position) => position.productId === pair)) return null;
  let last: number | null = null;
  for (const trade of host.book.closed ?? []) {
    if (trade.productId !== pair || !(trade.exitTs <= answeredAtMs)) continue;
    if (last == null || trade.exitTs > last) last = trade.exitTs;
  }
  return last;
}

function remember(
  host: JevDrainHost,
  row: JevQueued,
  reason: JevReason | "ok",
  answer: JevAnswer | null,
  costUsd: number,
  tokens: number | null,
): void {
  const answeredAtMs = host.clock();
  const latencyMs = Math.max(0, answeredAtMs - (row.barStartSec + FIFTEEN_SEC) * 1000);
  const arrivalMid = host.jevTape.midAtTime(row.pair, answeredAtMs);
  const barCloseMid = typeof row.state.mid === "number" ? row.state.mid : null;
  const score = guardEffectScore({ answeredAtMs, arrivalMid, barCloseMid, tradeClosedAtMs: closedAtMs(host, row.pair, answeredAtMs) });
  noteLatency(host.jevSkip, latencyMs);
  host.jevSkip.holder = host.holderId ?? host.jevSkip.holder;
  host.jevSkip.handoverMinutes = host.jevTape.handoverMinutes;
  const stored: JevStored = {
    pair: row.pair,
    barStartSec: row.barStartSec,
    answer,
    reason,
    costUsd,
    tokens,
    answeredAtMs,
    latencyMs,
    packetHash: packetHash(row.state, row.minutes),
    ...(host.holderId ? { holder: host.holderId } : {}),
    handoverMinutes: host.jevTape.handoverMinutes,
    guardIncluded: score.included,
    scoreMid: score.mid,
  };
  host.jevDone.add(jevKey(row.pair, row.barStartSec));
  host.jevAnswers.push(stored);
  if (host.jevAnswers.length > JEV_ANSWER_KEEP) host.jevAnswers.splice(0, host.jevAnswers.length - JEV_ANSWER_KEEP);
  const key = jevAnswerKey(row.pair, row.barStartSec);
  const sent = host.jevPacketSent ?? (host.jevPacketSent = new Set());
  if (sent.has(key)) return;
  const writes = host.jevPacketWrites ?? (host.jevPacketWrites = []);
  if (writes.some((item) => item.key === key)) return;
  writes.push({
    key,
    value: JSON.stringify({
      ...stored,
      packet: row.state,
      minutes: row.minutes,
    }),
  });
}

function dropQueued(host: JevDrainHost, reason: Exclude<JevReason, "no_1m_input">): void {
  const pending = host.jevQueue.filter((row) => !row.inflight && !host.jevDone.has(jevKey(row.pair, row.barStartSec)));
  host.jevQueue = host.jevQueue.filter((row) => row.inflight);
  for (const row of pending) {
    noteSkip(host.jevSkip, reason, liquidityTier(row.pair));
    host.book.jevSkipped += 1;
    host.book.incidents.push(`jev ${reason} ${row.pair} ${row.barStartSec}`);
    remember(host, row, reason, null, 0, null);
  }
}

function skipOne(
  host: JevDrainHost,
  row: JevQueued,
  reason: JevReason,
  costUsd: number,
  answer: JevAnswer | null = null,
  tokens: number | null = null,
): void {
  noteSkip(host.jevSkip, reason, liquidityTier(row.pair));
  host.book.jevSkipped += 1;
  host.book.incidents.push(`jev ${reason} ${row.pair} ${row.barStartSec}`);
  remember(host, row, reason, answer, costUsd, tokens);
}

function removeQueued(host: JevDrainHost, row: JevQueued): void {
  host.jevQueue = host.jevQueue.filter((item) => item !== row && jevKey(item.pair, item.barStartSec) !== jevKey(row.pair, row.barStartSec));
}

function kvGet(kv: unknown): ((key: string) => Promise<string | null>) | null {
  if (!kv || typeof kv !== "object" || !("get" in kv) || typeof (kv as { get?: unknown }).get !== "function") return null;
  return (key) => (kv as { get(key: string): Promise<string | null> }).get(key);
}

function leaseHeld(raw: string | null, token: string): boolean {
  if (!raw) return false;
  try {
    const body = JSON.parse(raw) as { token?: string; release?: string };
    return body.token === token && body.release === "none";
  } catch {
    return false;
  }
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

/** One shadow call, or none. Does not throw. Does not touch orders. A non-positive budget leaves the queue. */
export async function drainJevShadow(host: JevDrainHost, nowMs: number, untilMs: number): Promise<void> {
  if (host.stopped) return;
  const read = kvGet(host.kv);
  if (read) {
    if (host.leaseToken == null) return;
    const raw = await read(LEASE_KEY);
    if (!leaseHeld(raw, host.leaseToken)) return;
  } else if (host.kv && host.leaseToken == null) return;
  host.jevDone = new Set(boundJevDone([...host.jevDone], Math.floor(nowMs / 1000)));
  host.jevQueue = host.jevQueue.filter((row) => !host.jevDone.has(jevKey(row.pair, row.barStartSec)));
  const next = host.jevQueue.find((row) => !row.inflight);
  if (!next) return;
  if (read && host.leaseToken) {
    const stored = await read(jevAnswerKey(next.pair, next.barStartSec));
    if (stored) {
      host.jevDone.add(jevKey(next.pair, next.barStartSec));
      removeQueued(host, next);
      return;
    }
  }
  if (packetExpired(next.barStartSec, nowMs)) {
    skipOne(host, next, "timeout", 0);
    removeQueued(host, next);
    return;
  }
  const budget = callBudgetMs(nowMs, untilMs);
  if (!(budget > 0) || nowMs + budget > untilMs) return;
  const caller = host.jevCaller;
  if (!caller) {
    skipOne(host, next, "not_called", 0);
    removeQueued(host, next);
    dropQueued(host, "not_called");
    return;
  }
  try {
    host.jevMeter = reserveJevCall(host.jevMeter, nowMs);
  } catch {
    skipOne(host, next, "not_called", 0);
    removeQueued(host, next);
    dropQueued(host, "not_called");
    return;
  }
  next.inflight = true;
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
    removeQueued(host, next);
  }
  if (!outcome.ok) {
    if (outcome.reason === "not_called" || !reachedNetwork) {
      host.jevMeter = adjustJevReserve(host.jevMeter, reserved, 0);
      skipOne(host, next, outcome.reason, 0, null, outcome.tokens ?? null);
      return;
    }
    const billed = chargeFailure(host, reserved, outcome.costUsd);
    skipOne(host, next, outcome.reason, billed, null, outcome.tokens ?? null);
    return;
  }
  try {
    host.jevMeter = adjustJevReserve(host.jevMeter, reserved, outcome.costUsd);
    host.jevMeter = { ...host.jevMeter, calls: (host.jevMeter.calls ?? 0) + 1 };
  } catch {
    skipOne(host, next, "call_error", reserved, outcome.answer, outcome.tokens ?? null);
    return;
  }
  remember(host, next, "ok", outcome.answer, outcome.costUsd, outcome.tokens ?? null);
}
