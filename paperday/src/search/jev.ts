/**
 * Jev grid rules and the paid-review cache.
 * V1 vetoes direction_bias=flat.
 * V2 vetoes toxic_flow=high or liquidity_stress=stressed.
 * V3 is V1 or V2.
 * Select keeps the highest long confidence among names the rules already qualified.
 * Nothing here invents a review. A missing key does not become a heuristic.
 */

import { JEV_USD_PER_MTOK } from "../config";
import { costUsdFromTokens, type JevLabels } from "../jev";
import type { VetoRule } from "./grid";

export const JEV_MODEL_ID = "typesafe-ai/jev";
export const JEV_SEARCH_CAP_USD = 25;

export function vetoes(rule: VetoRule, labels: JevLabels): boolean {
  const v1 = labels.direction_bias === "flat";
  const v2 = labels.toxic_flow === "high" || labels.liquidity_stress === "stressed";
  if (rule === "V1") return v1;
  if (rule === "V2") return v2;
  return v1 || v2;
}

export interface Selectable {
  id: string;
  /** Long confidence from the review. Higher is kept. */
  longConfidence: number;
}

/** Stage-2 select: rank already-qualified names. Does not add a name that was not passed in. */
export function selectByConfidence(qualified: readonly Selectable[], room: number): Selectable[] {
  if (!(room > 0)) return [];
  return qualified.slice().sort((a, b) => b.longConfidence - a.longConfidence || (a.id < b.id ? -1 : 1)).slice(0, room);
}

export interface QualifiedName {
  id: string;
  labels: JevLabels;
  longConfidence: number;
}

/**
 * Veto removes names the rule flags and keeps the remaining order.
 * Select reorders the names it was given and keeps `room` of them.
 * Neither path invents an id.
 */
export function applyJevDecision(
  variant: "jev_veto" | "jev_select",
  vetoRule: VetoRule | null,
  qualified: readonly QualifiedName[],
  room: number,
): string[] {
  if (variant === "jev_select") {
    return selectByConfidence(
      qualified.map((row) => ({ id: row.id, longConfidence: row.longConfidence })),
      room,
    ).map((row) => row.id);
  }
  if (vetoRule == null) return [];
  return qualified.filter((row) => !vetoes(vetoRule, row.labels)).map((row) => row.id);
}

export interface CachedReview {
  hash: string;
  model: string;
  tokens: number;
  costUsd: number;
  labels: JevLabels;
  longConfidence: number;
}

export interface CacheLookup {
  review: CachedReview | null;
  hit: boolean;
  stopped: boolean;
  /** Cost attributed to the row that used the review, including a cache hit. */
  attributedUsd: number;
}

export class JevReviewCache {
  readonly capUsd: number;
  spentUsd = 0;
  calls = 0;
  hits = 0;
  tokens = 0;
  stopped = false;
  private readonly entries = new Map<string, CachedReview>();

  constructor(capUsd = JEV_SEARCH_CAP_USD) {
    this.capUsd = capUsd;
  }

  /**
   * One paid call per hash. Later configs reuse it.
   * The cap is checked before the call. A call that crosses the cap is kept, and the next one stops.
   * `fetchReview` is the real transport. This class does not supply a stand-in.
   */
  async review(hash: string, fetchReview: () => Promise<CachedReview>): Promise<CacheLookup> {
    const cached = this.entries.get(hash);
    if (cached) {
      this.hits += 1;
      return { review: cached, hit: true, stopped: false, attributedUsd: cached.costUsd };
    }
    if (this.spentUsd >= this.capUsd || this.stopped) {
      this.stopped = true;
      return { review: null, hit: false, stopped: true, attributedUsd: 0 };
    }
    const review = await fetchReview();
    if (review.model !== JEV_MODEL_ID) {
      throw new Error(`Jev model id ${review.model} is not ${JEV_MODEL_ID}`);
    }
    if (!(review.costUsd > 0) || !(review.tokens > 0)) {
      throw new Error("Jev review returned no token cost");
    }
    this.entries.set(hash, review);
    this.calls += 1;
    this.tokens += review.tokens;
    this.spentUsd += review.costUsd;
    if (this.spentUsd >= this.capUsd) this.stopped = true;
    return { review, hit: false, stopped: false, attributedUsd: review.costUsd };
  }

  coverage(gridJevConfigs: number, executed: number): JevCoverage {
    return {
      capUsd: this.capUsd,
      spentUsd: this.spentUsd,
      calls: this.calls,
      hits: this.hits,
      tokens: this.tokens,
      stopped: this.stopped,
      jevConfigs: gridJevConfigs,
      executed,
      model: JEV_MODEL_ID,
    };
  }
}

export interface JevCoverage {
  capUsd: number;
  spentUsd: number;
  calls: number;
  hits: number;
  tokens: number;
  stopped: boolean;
  jevConfigs: number;
  executed: number;
  model: string;
}

export function attributedCost(netUsd: number, attributedUsd: number): number {
  return netUsd - attributedUsd;
}

export function costOf(tokens: number): number {
  return costUsdFromTokens(tokens, JEV_USD_PER_MTOK);
}

/** Errors returned to the report. The key itself is never copied into the message. */
export function redactSecrets(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_\-]+/g, "[redacted]")
    .replace(/\bkey-[A-Za-z0-9_\-]+/g, "[redacted]");
}

export function jevKeyPresent(env: Record<string, string | undefined>): boolean {
  return Boolean(env.TYPESAFE_AI_API_KEY || env.AI_GATEWAY_API_KEY);
}

export function jevBlockedReason(env: Record<string, string | undefined>): string | null {
  if (jevKeyPresent(env)) return null;
  return "blocked: TYPESAFE_AI_API_KEY not present";
}
