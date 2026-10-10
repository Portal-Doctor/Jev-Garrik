/**
 * Jev Review Service. Center of the flow, authority by stage.
 * Stage 0 logs. Stage 1 may only cut. Stage 2 may only rank already-qualified names.
 * Timeout, bad JSON, outage, and the monthly budget never add a trade.
 * Spend is token usage times jevUsdPerMTok ($0.042), hard-stopped at $100 per UTC month.
 */

import { createHash } from "node:crypto";
import { JEV_MONTHLY_BUDGET_USD, JEV_TIMEOUT_MS, JEV_USD_PER_MTOK, type JevStage } from "./config";
import { utcMonthKey } from "./clock";
import type { Candidate } from "./rules";

export const JEV_PROMPT =
  "paperday-jev-v1: review a qualified candidate. Do not place orders, set stops, targets, exits, or size. Return verdict approve, veto, or rank, plus regime, direction_bias, toxic_flow, liquidity_stress.";

export type JevVerdict = "approve" | "veto" | "rank";

export interface JevLabels {
  regime: "expansion" | "balance" | "contraction";
  direction_bias: "long" | "flat";
  toxic_flow: "low" | "high";
  liquidity_stress: "normal" | "stressed";
}

export interface JevPacket {
  asOf: number;
  pair: string;
  setup: string;
  barTs: number;
  candidateId: string;
  biasUp: boolean;
  close: number;
  stop: number;
  atr: number | null;
  rsi: number | null;
  vwap: number | null;
  sentiment: string;
  prompt: string;
}

export interface PacketInput {
  asOf: number;
  pair: string;
  setup: string;
  barTs: number;
  candidateId: string;
  biasUp: boolean;
  close: number;
  stop: number;
  atr: number | null;
  rsi: number | null;
  vwap: number | null;
  sentiment: string;
  /** Bar open times visible to the packet. Any ts > asOf is lookahead and is rejected. */
  barTsList: number[];
}

export interface JevRaw {
  model: string;
  verdict: string;
  rankScore?: number;
  labels?: Partial<JevLabels>;
  rationale?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface JevReview {
  candidateId: string;
  model: string;
  promptHash: string;
  inputHash: string;
  verdict: JevVerdict | null;
  rankScore: number | null;
  labels: JevLabels | null;
  rationale: string;
  latencyMs: number;
  costUsd: number;
  tokens: number;
  status: "ok" | "timeout" | "bad_json" | "outage" | "budget_hit" | "cache_hit" | "model_version_change";
  jevStageAtTime: JevStage;
  applied: boolean;
  month: string;
}

export interface JevTransport {
  review(packet: JevPacket): Promise<JevRaw>;
}

export interface Scorecard {
  resetAt: number | null;
  pinnedModel: string;
  samples: number;
}

const REGIMES = ["expansion", "balance", "contraction"] as const;
const BIASES = ["long", "flat"] as const;
const TOXIC = ["low", "high"] as const;
const STRESS = ["normal", "stressed"] as const;
const VERDICTS = ["approve", "veto", "rank"] as const;

export function promptHash(): string {
  return createHash("sha256").update(JEV_PROMPT).digest("hex");
}

export function canonical(packet: JevPacket): string {
  return JSON.stringify(packet);
}

export function inputHash(packet: JevPacket): string {
  return createHash("sha256").update(canonical(packet)).digest("hex");
}

export function costUsdFromTokens(tokens: number, usdPerMTok = JEV_USD_PER_MTOK): number {
  if (!(tokens > 0)) return 0;
  return (tokens * usdPerMTok) / 1_000_000;
}

export function buildPacket(input: PacketInput): JevPacket {
  for (const ts of input.barTsList) {
    if (ts > input.asOf) throw new Error("lookahead bar in Jev packet");
  }
  if (input.barTs > input.asOf) throw new Error("lookahead candidate bar");
  return {
    asOf: input.asOf,
    pair: input.pair,
    setup: input.setup,
    barTs: input.barTs,
    candidateId: input.candidateId,
    biasUp: input.biasUp,
    close: input.close,
    stop: input.stop,
    atr: input.atr,
    rsi: input.rsi,
    vwap: input.vwap,
    sentiment: input.sentiment,
    prompt: JEV_PROMPT,
  };
}

export function parseRaw(raw: unknown): { ok: true; value: Required<Pick<JevRaw, "model" | "verdict" | "rationale">> & JevRaw } | { ok: false } {
  if (raw == null || typeof raw !== "object") return { ok: false };
  const r = raw as JevRaw;
  if (typeof r.model !== "string" || r.model.length === 0) return { ok: false };
  if (!VERDICTS.includes(r.verdict as JevVerdict)) return { ok: false };
  if (r.verdict === "rank" && !(typeof r.rankScore === "number" && Number.isFinite(r.rankScore))) return { ok: false };
  const labels = r.labels;
  if (!labels) return { ok: false };
  if (!REGIMES.includes(labels.regime as (typeof REGIMES)[number])) return { ok: false };
  if (!BIASES.includes(labels.direction_bias as (typeof BIASES)[number])) return { ok: false };
  if (!TOXIC.includes(labels.toxic_flow as (typeof TOXIC)[number])) return { ok: false };
  if (!STRESS.includes(labels.liquidity_stress as (typeof STRESS)[number])) return { ok: false };
  const inputTokens = r.inputTokens ?? 0;
  const outputTokens = r.outputTokens ?? 0;
  if (!Number.isFinite(inputTokens) || !Number.isFinite(outputTokens) || inputTokens < 0 || outputTokens < 0) return { ok: false };
  return {
    ok: true,
    value: {
      ...r,
      rationale: typeof r.rationale === "string" ? r.rationale : "",
      inputTokens,
      outputTokens,
    },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("jev_timeout")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export class JevReviewService {
  stage: JevStage;
  pinnedModel: string;
  spendByMonth = new Map<string, number>();
  private cache = new Map<string, JevReview>();
  scorecard: Scorecard;
  calls = 0;

  constructor(
    private readonly transport: JevTransport,
    opts: { stage: JevStage; pinnedModel: string; timeoutMs?: number },
  ) {
    this.stage = opts.stage;
    this.pinnedModel = opts.pinnedModel;
    this.timeoutMs = opts.timeoutMs ?? JEV_TIMEOUT_MS;
    this.scorecard = { resetAt: null, pinnedModel: opts.pinnedModel, samples: 0 };
  }

  private readonly timeoutMs: number;

  spent(month: string): number {
    return this.spendByMonth.get(month) ?? 0;
  }

  /** Hard stop. No call is placed once the UTC month has reached $100. */
  budgetOpen(month: string): boolean {
    return this.spent(month) < JEV_MONTHLY_BUDGET_USD;
  }

  async review(input: PacketInput, nowMs: number): Promise<JevReview> {
    const packet = buildPacket(input);
    const month = utcMonthKey(nowMs);
    const hash = inputHash(packet);
    const cached = this.cache.get(hash);
    if (cached) {
      const usable = cached.verdict != null && (cached.status === "ok" || cached.status === "cache_hit");
      return {
        ...cached,
        status: cached.status === "ok" || cached.status === "cache_hit" ? "cache_hit" : cached.status,
        costUsd: 0,
        latencyMs: 0,
        applied: usable && this.stage > 0 && cached.model === this.pinnedModel,
        jevStageAtTime: this.stage,
      };
    }
    const base: JevReview = {
      candidateId: packet.candidateId,
      model: this.pinnedModel,
      promptHash: promptHash(),
      inputHash: hash,
      verdict: null,
      rankScore: null,
      labels: null,
      rationale: "",
      latencyMs: 0,
      costUsd: 0,
      tokens: 0,
      status: "outage",
      jevStageAtTime: this.stage,
      applied: false,
      month,
    };
    if (!this.budgetOpen(month)) {
      return { ...base, status: "budget_hit" };
    }
    const t0 = Date.now();
    let raw: unknown;
    try {
      this.calls += 1;
      raw = await withTimeout(this.transport.review(packet), this.timeoutMs);
    } catch (err) {
      const timeout = err instanceof Error && err.message === "jev_timeout";
      return { ...base, status: timeout ? "timeout" : "outage", latencyMs: Date.now() - t0 };
    }
    const parsed = parseRaw(raw);
    if (!parsed.ok) {
      return { ...base, status: "bad_json", latencyMs: Date.now() - t0, rationale: "schema" };
    }
    const tokens = (parsed.value.inputTokens ?? 0) + (parsed.value.outputTokens ?? 0);
    const cost = costUsdFromTokens(tokens);
    const nextSpend = this.spent(month) + cost;
    this.spendByMonth.set(month, nextSpend);
    const modelChanged = parsed.value.model !== this.pinnedModel;
    if (modelChanged) {
      this.stage = 0;
      this.scorecard = { resetAt: nowMs, pinnedModel: parsed.value.model, samples: 0 };
      this.pinnedModel = parsed.value.model;
    }
    const labels = parsed.value.labels as JevLabels;
    const verdict = parsed.value.verdict as JevVerdict;
    const review: JevReview = {
      ...base,
      model: parsed.value.model,
      verdict,
      rankScore: verdict === "rank" ? (parsed.value.rankScore ?? null) : null,
      labels,
      rationale: parsed.value.rationale ?? "",
      latencyMs: Date.now() - t0,
      costUsd: cost,
      tokens,
      status: modelChanged ? "model_version_change" : "ok",
      jevStageAtTime: modelChanged ? 0 : this.stage,
      applied: false,
      month,
    };
    // A call that crosses the cap is recorded and not applied. Later calls hard-stop.
    if (nextSpend > JEV_MONTHLY_BUDGET_USD + 1e-9) {
      review.status = "budget_hit";
      review.applied = false;
      this.cache.set(hash, review);
      return review;
    }
    review.applied = !modelChanged && this.stage > 0 && review.status === "ok";
    this.cache.set(hash, review);
    if (review.status === "ok") this.scorecard.samples += 1;
    return review;
  }
}

export interface SelectInput {
  candidate: Candidate;
  review: JevReview | null;
}

/**
 * Stage 2 picks among qualified candidates when fewer slots than names.
 * Failures and stage 0 keep rules order. Jev cannot introduce a name that was not qualified.
 */
export function applyStagePolicy(qualified: Candidate[], reviews: Map<string, JevReview>, stage: JevStage, room: number): Candidate[] {
  if (room <= 0) return [];
  const rules = qualified.slice().sort((a, b) => (a.barTs - b.barTs) || (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : a.setup < b.setup ? -1 : 1));
  if (stage === 0) return rules.slice(0, room);
  const usable = rules.filter((c) => {
    const rev = reviews.get(c.id);
    if (!rev || rev.applied !== true) return true;
    return rev.verdict !== "veto";
  });
  if (stage === 1) return usable.slice(0, room);
  const ranked = usable.slice().sort((a, b) => {
    const ra = reviews.get(a.id);
    const rb = reviews.get(b.id);
    const sa = ra?.applied && ra.verdict === "rank" && ra.rankScore != null ? ra.rankScore : Number.NEGATIVE_INFINITY;
    const sb = rb?.applied && rb.verdict === "rank" && rb.rankScore != null ? rb.rankScore : Number.NEGATIVE_INFINITY;
    if (sa !== sb) return sb - sa;
    return a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0;
  });
  return ranked.slice(0, room);
}
