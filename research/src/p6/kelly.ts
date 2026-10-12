/**
 * Architect's forward sizing ruling, relayed by Jimmy. It is not amendment 2.
 * It deviates from the registered $60: every class A–E starts at $20, and a
 * promoted class is sized from its own forward net R. P5 rows are not an input.
 *
 * "(default 13)" is stored as default13Usd and is not applied. Its meaning is
 * an open question.
 */

import { kellyFraction, PAPER_MINIMUM_USD } from "../p3/design-rules";
import { HOLM_ALPHA, holmAdjusted, netRStreamP, oneSided80TradeMean, weeklyGroups, weekKey } from "../p5/stats";

export const UNPROMOTED_RISK_USD = PAPER_MINIMUM_USD;
export const REGISTERED_FULL_RISK_USD = 60;

/** Named stand-in for Architect's "(default 13)". Not used in the size. */
export const DEFAULT_13_USD = 13;

export const KELLY_RULING_TEXT =
  "Every class A-E trades at $20 risk from forward bar 1. The hard-coded $60 is a defect. kellyRiskUsd stays $20 until a class is promoted. The forward gate is mean net R > 0, L80 > 0, and Holm over the 5 streams. After promotion, risk is min(0.75%, half-Kelly) on forward realized net R only. P5 data never sizes a forward trade. Recompute at each weekly review (Monday 00:00 UTC cutoff) and hold until the next review. Drop back to $20 if the forward bound goes <= 0. Sizing may go under $20 below the cap. Architect wrote '(default 13)'.";

export interface ForwardPoint {
  netR: number;
  entryDate: string;
}

export interface KellyStream {
  id: string;
  netR: readonly number[];
}

export interface KellyHold {
  reviewMonday: string;
  riskUsd: number;
  promoted: boolean;
}

export interface KellySize {
  riskUsd: number;
  promoted: boolean;
  reviewMonday: string;
  held: boolean;
  meanNetR: number | null;
  l80: number | null;
  holmPass: boolean;
  /** Echo of the named parameter. The size does not read it. */
  default13Usd: number;
}

export function kellyRulingBody(): {
  role: "architect-ruling";
  relayedBy: "Jimmy";
  partOfAmendment2: false;
  registrationEdited: false;
  registeredRiskUsd: 60;
  registeredSource: string;
  registrationSha256: string;
  text: string;
  default13Parameter: "default13Usd";
  default13Applied: false;
} {
  return {
    role: "architect-ruling",
    relayedBy: "Jimmy",
    partOfAmendment2: false,
    registrationEdited: false,
    registeredRiskUsd: REGISTERED_FULL_RISK_USD,
    registeredSource: "research/data/reports/p4-registration.json risk.riskUsd",
    registrationSha256: "f4f7657329237bd29a3fe8f752daca82d4ef2a2b887346772e112146e7272c1d",
    text: KELLY_RULING_TEXT,
    default13Parameter: "default13Usd",
    default13Applied: false,
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mu = mean(values) ?? 0;
  return values.reduce((sum, value) => sum + (value - mu) ** 2, 0) / (values.length - 1);
}

export function holmPass(classId: string, streams: readonly KellyStream[]): boolean {
  const rows = streams.map((stream) => ({ id: stream.id, p: netRStreamP(stream.netR).p }));
  const adjusted = holmAdjusted(rows);
  const row = adjusted.find((item) => item.id === classId);
  return row != null && row.adjusted < HOLM_ALPHA;
}

export function forwardBound(points: readonly ForwardPoint[], seed: number, reps?: number): { mean: number | null; l80: number | null } {
  const mu = mean(points.map((point) => point.netR));
  if (points.length === 0) return { mean: null, l80: null };
  const weeks = [...new Set(points.map((point) => weekKey(point.entryDate)))].sort();
  const grouped = weeklyGroups(
    points.map((point) => ({ week: weekKey(point.entryDate), value: point.netR })),
    weeks,
  );
  const bound = oneSided80TradeMean(grouped, { seed, reps });
  return { mean: mu, l80: bound?.l80 ?? null };
}

/**
 * Size one class from its forward trades. `held` is the last Monday review.
 * The same Monday returns that size unchanged. `default13Usd` is recorded and
 * is not a floor, a count, or a risk.
 */
export function forwardClassRisk(opts: {
  classId: string;
  forward: readonly ForwardPoint[];
  streams: readonly KellyStream[];
  bankrollUsd: number;
  nowMs: number;
  held: KellyHold | null;
  bootstrapSeed: number;
  default13Usd?: number;
  reps?: number;
}): KellySize {
  const reviewMonday = weekKey(new Date(opts.nowMs).toISOString().slice(0, 10));
  const default13Usd = opts.default13Usd ?? DEFAULT_13_USD;
  if (opts.held && opts.held.reviewMonday === reviewMonday) {
    return {
      riskUsd: opts.held.riskUsd,
      promoted: opts.held.promoted,
      reviewMonday,
      held: true,
      meanNetR: null,
      l80: null,
      holmPass: opts.held.promoted,
      default13Usd,
    };
  }
  const bound = forwardBound(opts.forward, opts.bootstrapSeed, opts.reps);
  const pass = bound.mean != null && bound.mean > 0 && bound.l80 != null && bound.l80 > 0 && holmPass(opts.classId, opts.streams);
  const fraction = pass ? kellyFraction(bound.mean ?? 0, sampleVariance(opts.forward.map((point) => point.netR))) : null;
  const sized = fraction != null && fraction > 0 ? fraction * opts.bankrollUsd : UNPROMOTED_RISK_USD;
  const riskUsd = pass && fraction != null && fraction > 0 ? sized : UNPROMOTED_RISK_USD;
  return {
    riskUsd,
    promoted: pass && fraction != null && fraction > 0,
    reviewMonday,
    held: false,
    meanNetR: bound.mean,
    l80: bound.l80,
    holmPass: pass,
    default13Usd,
  };
}
