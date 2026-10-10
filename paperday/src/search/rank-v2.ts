/**
 * Grid v2 ranking. Eligibility is the turn-3 rule on the longer fold set:
 * 60% of OOS folds positive, trade floors, E, p*, drawdown, halts.
 * A config with no neighbors can still win. That is what lets a lone
 * repo_breakout_4h row be the answer.
 */

import { classExpectancy, type ClosedSample } from "../expectancy";
import type { SearchConfig } from "./grid";

export interface FoldScoreV2 {
  fold: number;
  isNetUsd: number;
  oosNetUsd: number;
  oosTrades: number;
  oosQualified: number;
  isQualified: number;
  oosMaxDrawdownUsd: number;
  pairHalt: boolean;
  dailyHalt: boolean;
  samples: ClosedSample[];
  entryAttempts: number;
  entryFills: number;
  entryTimeouts: number;
  rejects: Record<string, number>;
}

export interface ConfigScoreV2 {
  id: string;
  strategy: SearchConfig["strategy"];
  oosNetUsd: number;
  oosTrades: number;
  oosQualified: number;
  oosMaxDrawdownUsd: number;
  positiveFolds: number;
  foldCount: number;
  pairHalt: boolean;
  dailyHalt: boolean;
  eR: number | null;
  eBps: number | null;
  pStar: number | null;
  expectancyPass: boolean;
  pStarPass: boolean;
  isNetUsd: number;
  folds: FoldScoreV2[];
}

export interface RankedV2 {
  score: ConfigScoreV2;
  eligible: boolean;
  reasons: string[];
  paramChanges: number;
}

const MIN_TRADES: Record<string, number> = {
  swing_combined: 100,
  swing_4h: 100,
  repo_breakout_4h: 100,
  swing_A: 40,
  swing_B: 40,
  swing_C: 40,
};

export function minTradesFor(strategy: string): number {
  return MIN_TRADES[strategy] ?? 100;
}

export function scoreConfigV2(cfg: Pick<SearchConfig, "id" | "strategy">, folds: FoldScoreV2[]): ConfigScoreV2 {
  const samples = folds.flatMap((fold) => fold.samples);
  const exp = classExpectancy(samples);
  return {
    id: cfg.id,
    strategy: cfg.strategy,
    oosNetUsd: folds.reduce((s, fold) => s + fold.oosNetUsd, 0),
    oosTrades: folds.reduce((s, fold) => s + fold.oosTrades, 0),
    oosQualified: folds.reduce((s, fold) => s + fold.oosQualified, 0),
    oosMaxDrawdownUsd: folds.reduce((s, fold) => Math.max(s, fold.oosMaxDrawdownUsd), 0),
    positiveFolds: folds.filter((fold) => fold.oosNetUsd > 0).length,
    foldCount: folds.length,
    pairHalt: folds.some((fold) => fold.pairHalt),
    dailyHalt: folds.some((fold) => fold.dailyHalt),
    eR: exp.eR,
    eBps: exp.eBps,
    pStar: exp.pStar,
    expectancyPass: exp.pass,
    pStarPass: exp.pStarPass,
    isNetUsd: folds.reduce((s, fold) => s + fold.isNetUsd, 0),
    folds,
  };
}

/** Positive OOS net in at least 60% of the folds. */
export function positiveFoldShare(positive: number, foldCount: number): number {
  if (!(foldCount > 0)) return 0;
  return positive / foldCount;
}

export function eligibilityV2(score: ConfigScoreV2): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const need = minTradesFor(score.strategy);
  if (score.oosTrades < need) reasons.push(`trades ${score.oosTrades} < ${need}`);
  if (!(score.eR != null && score.eR >= 0.15) && !(score.eBps != null && score.eBps >= 25)) reasons.push("E below +0.15R and +25 bps");
  if (!(score.pStarPass && score.pStar != null && score.pStar <= 0.45)) reasons.push("p* > 45%");
  if (!(positiveFoldShare(score.positiveFolds, score.foldCount) >= 0.6)) {
    reasons.push(`positive OOS folds ${score.positiveFolds}/${score.foldCount} < 60%`);
  }
  if (!(score.oosMaxDrawdownUsd < 8_000)) reasons.push("DD >= 8000");
  if (score.pairHalt) reasons.push("pair halt breached");
  if (score.dailyHalt) reasons.push("daily halt breached");
  return { pass: reasons.length === 0, reasons };
}

/** Knobs off the row's own default. 1h default is 2× / 3R / 48h. swing_4h default is k 1.5 / 3R / 48h. */
export function paramChangesV2(cfg: Pick<SearchConfig, "strategy" | "stopAtrMult" | "targetR" | "maxHoldHours">): number {
  if (cfg.strategy === "repo_breakout_4h") return 0;
  const stopDefault = cfg.strategy === "swing_4h" ? 1.5 : 2;
  let n = 0;
  if (cfg.stopAtrMult !== stopDefault) n += 1;
  if (cfg.targetR !== 3) n += 1;
  if (cfg.maxHoldHours !== 48) n += 1;
  return n;
}

export function rankBase(configs: readonly SearchConfig[], foldsById: Map<string, FoldScoreV2[]>): RankedV2[] {
  const ranked: RankedV2[] = [];
  for (const cfg of configs) {
    const folds = foldsById.get(cfg.id);
    if (!folds) continue;
    const score = scoreConfigV2(cfg, folds);
    const gate = eligibilityV2(score);
    ranked.push({ score, eligible: gate.pass, reasons: gate.reasons, paramChanges: paramChangesV2(cfg) });
  }
  ranked.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    if (b.score.oosNetUsd !== a.score.oosNetUsd) return b.score.oosNetUsd - a.score.oosNetUsd;
    if (a.score.oosMaxDrawdownUsd !== b.score.oosMaxDrawdownUsd) return a.score.oosMaxDrawdownUsd - b.score.oosMaxDrawdownUsd;
    if (a.paramChanges !== b.paramChanges) return a.paramChanges - b.paramChanges;
    return a.score.id < b.score.id ? -1 : a.score.id > b.score.id ? 1 : 0;
  });
  return ranked;
}

/**
 * Winner inside 5% of the best eligible net, then lower drawdown, then fewer
 * knobs off that row's default. Returns null when nothing is eligible.
 * The stability guard is not applied.
 */
export function selectAnswer(ranked: readonly RankedV2[]): RankedV2 | null {
  const eligible = ranked.filter((row) => row.eligible);
  if (eligible.length === 0) return null;
  const best = Math.max(...eligible.map((row) => row.score.oosNetUsd));
  const band =
    best > 0 ? eligible.filter((row) => row.score.oosNetUsd >= best * 0.95) : eligible.filter((row) => row.score.oosNetUsd === best);
  band.sort((a, b) => {
    if (a.score.oosMaxDrawdownUsd !== b.score.oosMaxDrawdownUsd) return a.score.oosMaxDrawdownUsd - b.score.oosMaxDrawdownUsd;
    if (a.paramChanges !== b.paramChanges) return a.paramChanges - b.paramChanges;
    return a.score.id < b.score.id ? -1 : 1;
  });
  return band[0] ?? null;
}

export function onlyBreakoutEligible(ranked: readonly RankedV2[]): boolean {
  const eligible = ranked.filter((row) => row.eligible);
  return eligible.length > 0 && eligible.every((row) => row.score.strategy === "repo_breakout_4h");
}

export interface FoldMargin {
  fold: number;
  jevGrossUsd: number;
  twinUsd: number;
  costUsd: number;
  /** jev gross minus the twin. The fold passes when this exceeds the fold's inference cost. */
  marginUsd: number;
  beats: boolean;
}

export interface VetoMarginResult {
  folds: FoldMargin[];
  passFolds: number;
  foldCount: number;
  passShare: number;
  totalJevAfterCost: number;
  totalTwin: number;
  wins: boolean;
}

/** jev_veto wins on the margin rule. Cost in the total is deducted once. */
export function vetoMargin(folds: readonly FoldMargin[], totalCostUsd: number): VetoMarginResult {
  const passFolds = folds.filter((fold) => fold.beats).length;
  const foldCount = folds.length;
  const passShare = foldCount > 0 ? passFolds / foldCount : 0;
  const gross = folds.reduce((s, fold) => s + fold.jevGrossUsd, 0);
  const twin = folds.reduce((s, fold) => s + fold.twinUsd, 0);
  const totalJevAfterCost = gross - totalCostUsd;
  return {
    folds: folds.slice(),
    passFolds,
    foldCount,
    passShare,
    totalJevAfterCost,
    totalTwin: twin,
    wins: passShare >= 0.6 && totalJevAfterCost > twin,
  };
}

export function foldBeats(jevGrossUsd: number, twinUsd: number, costUsd: number): boolean {
  return jevGrossUsd - twinUsd > costUsd;
}

/** Under 20 real choices, jev_select is not testable and cannot win. */
export function selectTestable(choiceCount: number): { testable: boolean; label: string } {
  if (choiceCount < 20) return { testable: false, label: "not testable on this sample" };
  return { testable: true, label: "testable" };
}
