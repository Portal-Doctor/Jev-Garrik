/**
 * Architect's forward sizing ruling, relayed by Jimmy. It is not amendment 2.
 * Forward paper starts every class A–E at $20. A promoted class is sized from
 * its own forward net R. The registered comparison book stays $60 and is not
 * a forward size. P5 rows are not an input.
 *
 * The bankroll is the fixed $8,000 reference. The Kelly fraction uses the
 * lower-80% bound of forward net R, not the sample mean. Promotion also needs
 * 90 forward days and n >= 30. Resolved default 13 is the $20 size when that
 * bound is null or not positive. There is no default13Usd parameter.
 */

import { kellyFraction, PAPER_MINIMUM_USD } from "../p3/design-rules";
import { HOLM_ALPHA, holmAdjusted, netRStreamP, oneSided80TradeMean, weeklyGroups, weekKey } from "../p5/stats";

export const UNPROMOTED_RISK_USD = PAPER_MINIMUM_USD;
export const REGISTERED_FULL_RISK_USD = 60;
export const PAPER_BANKROLL_USD = 8_000;
export const PROMOTION_MIN_DAYS = 90;
export const PROMOTION_MIN_N = 30;

export const KELLY_STATUS_TEXT =
  "$20 until promotion is registered (TDF Section 8, ADD Section 5, R5, default 13); the hard-coded $60 was the defect.";

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
  forwardDays: number;
  bankrollUsd: number;
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

/**
 * Marks p6-kelly-ruling.json superseded. The ruling file is not edited.
 * Its registeredRiskUsd 60 line is not the forward size.
 */
export function kellyRulingSupersededBody(): {
  role: "supersession";
  supersedes: string;
  supersedesSha256: string;
  superseded: true;
  supersededLine: string;
  text: string;
  rulingFileEdited: false;
  unpromotedRiskUsd: 20;
  bankrollUsd: 8000;
} {
  return {
    role: "supersession",
    supersedes: "research/data/reports/p6-kelly-ruling.json",
    supersedesSha256: "e099c0223e35712e78e4b7f0ef19f72d8f312a539a75e4d7f397816f57cd8e48",
    superseded: true,
    supersededLine: "registeredRiskUsd: 60",
    text: "p6-kelly-ruling.json (e099c022) is superseded. Its registeredRiskUsd 60 line is not the forward size. Forward paper stays at $20 until promotion. The ruling file is not edited.",
    rulingFileEdited: false,
    unpromotedRiskUsd: UNPROMOTED_RISK_USD,
    bankrollUsd: PAPER_BANKROLL_USD,
  };
}

/** Supersedes p6-kelly-status.json. The forward size is $20; $60 is not restated. */
export function kellySupersedingBody(): {
  role: "label";
  supersedes: string;
  supersedesSha256: string;
  rulingFile: string;
  rulingSha256: string;
  text: string;
  unpromotedRiskUsd: 20;
  bankrollUsd: 8000;
  kellyInput: "L80";
  promotionMinDays: 90;
  promotionMinN: 30;
  default13: string;
  registrationEdited: false;
  amendment2Edited: false;
  kellyRulingEdited: false;
  kellyStatusEdited: false;
} {
  return {
    role: "label",
    supersedes: "research/data/reports/p6-kelly-status.json",
    supersedesSha256: "162131821d358c2caf8faf21ebe58005dee875a8e7d7023b33c8324bcea584ba",
    rulingFile: "research/data/reports/p6-kelly-ruling.json",
    rulingSha256: "e099c0223e35712e78e4b7f0ef19f72d8f312a539a75e4d7f397816f57cd8e48",
    text: KELLY_STATUS_TEXT,
    unpromotedRiskUsd: UNPROMOTED_RISK_USD,
    bankrollUsd: PAPER_BANKROLL_USD,
    kellyInput: "L80",
    promotionMinDays: PROMOTION_MIN_DAYS,
    promotionMinN: PROMOTION_MIN_N,
    default13: "resolved default 13: a null or non-positive lower-80% bound sizes at $20",
    registrationEdited: false,
    amendment2Edited: false,
    kellyRulingEdited: false,
    kellyStatusEdited: false,
  };
}

export function kellyStatusBody(): {
  role: "label";
  text: string;
  unpromotedRiskUsd: 20;
  registeredRiskUsd: 60;
  bankrollUsd: 8000;
  kellyInput: "L80";
  promotionMinDays: 90;
  promotionMinN: 30;
  default13: string;
  registrationEdited: false;
  amendment2Edited: false;
  kellyRulingEdited: false;
} {
  return {
    role: "label",
    text: KELLY_STATUS_TEXT,
    unpromotedRiskUsd: UNPROMOTED_RISK_USD,
    registeredRiskUsd: REGISTERED_FULL_RISK_USD,
    bankrollUsd: PAPER_BANKROLL_USD,
    kellyInput: "L80",
    promotionMinDays: PROMOTION_MIN_DAYS,
    promotionMinN: PROMOTION_MIN_N,
    default13: "resolved default 13: a null or non-positive lower-80% bound sizes at $20",
    registrationEdited: false,
    amendment2Edited: false,
    kellyRulingEdited: false,
  };
}

export function forwardDays(points: readonly ForwardPoint[], nowMs: number): number {
  if (points.length === 0) return 0;
  let first = Number.POSITIVE_INFINITY;
  for (const point of points) {
    const ts = Date.parse(`${point.entryDate}T00:00:00.000Z`);
    if (Number.isFinite(ts) && ts < first) first = ts;
  }
  if (!Number.isFinite(first) || nowMs < first) return 0;
  return Math.floor((nowMs - first) / 86_400_000);
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
 * The same Monday returns that size unchanged. The fraction is half of L80/Var,
 * capped at 0.75% of the fixed $8,000 bankroll ($60). A null or non-positive
 * L80 bound, or fewer than 90 forward days or 30 trades, stays at $20.
 */
export function forwardClassRisk(opts: {
  classId: string;
  forward: readonly ForwardPoint[];
  streams: readonly KellyStream[];
  nowMs: number;
  held: KellyHold | null;
  bootstrapSeed: number;
  reps?: number;
}): KellySize {
  const reviewMonday = weekKey(new Date(opts.nowMs).toISOString().slice(0, 10));
  const days = forwardDays(opts.forward, opts.nowMs);
  if (opts.held && opts.held.reviewMonday === reviewMonday) {
    return {
      riskUsd: opts.held.riskUsd,
      promoted: opts.held.promoted,
      reviewMonday,
      held: true,
      meanNetR: null,
      l80: null,
      holmPass: opts.held.promoted,
      forwardDays: days,
      bankrollUsd: PAPER_BANKROLL_USD,
    };
  }
  const bound = forwardBound(opts.forward, opts.bootstrapSeed, opts.reps);
  const eligible =
    days >= PROMOTION_MIN_DAYS &&
    opts.forward.length >= PROMOTION_MIN_N &&
    bound.mean != null &&
    bound.mean > 0 &&
    bound.l80 != null &&
    bound.l80 > 0 &&
    holmPass(opts.classId, opts.streams);
  const fraction = eligible && bound.l80 != null ? kellyFraction(bound.l80, sampleVariance(opts.forward.map((point) => point.netR))) : null;
  const riskUsd = fraction != null && fraction > 0 ? fraction * PAPER_BANKROLL_USD : UNPROMOTED_RISK_USD;
  return {
    riskUsd,
    promoted: fraction != null && fraction > 0,
    reviewMonday,
    held: false,
    meanNetR: bound.mean,
    l80: bound.l80,
    holmPass: eligible,
    forwardDays: days,
    bankrollUsd: PAPER_BANKROLL_USD,
  };
}
