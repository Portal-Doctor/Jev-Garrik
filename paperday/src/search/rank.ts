/**
 * Rank eligible configs by out-of-sample net.
 * A tie inside 5% of the best net prefers lower max drawdown, then fewer
 * knobs moved off 2× / 3R / 48h. The stability guard then requires the
 * one-step neighbors' mean OOS net to be positive.
 */

import { classExpectancy, type ClosedSample } from "../expectancy";
import type { GridFile, SearchConfig } from "./grid";
import { neighborsOf, paramChanges } from "./grid";

export interface FoldScore {
  fold: 1 | 2 | 3;
  isNetUsd: number;
  oosNetUsd: number;
  oosTrades: number;
  oosMaxDrawdownUsd: number;
  pairHalt: boolean;
  dailyHalt: boolean;
  samples: ClosedSample[];
}

export interface ConfigScore {
  id: string;
  strategy: SearchConfig["strategy"];
  variant: SearchConfig["variant"];
  vetoRule: SearchConfig["vetoRule"];
  isNetUsd: number;
  oosNetUsd: number;
  oosTrades: number;
  oosMaxDrawdownUsd: number;
  positiveFolds: number;
  pairHalt: boolean;
  dailyHalt: boolean;
  eR: number | null;
  eBps: number | null;
  pStar: number | null;
  expectancyPass: boolean;
  pStarPass: boolean;
  jevSpendUsd: number;
  folds: FoldScore[];
}

export interface Ranked {
  score: ConfigScore;
  eligible: boolean;
  reasons: string[];
  paramChanges: number;
  stable: boolean;
  neighborMeanOos: number | null;
}

const MIN_TRADES: Record<string, number> = {
  swing_combined: 100,
  repo_breakout_4h: 100,
  swing_A: 40,
  swing_B: 40,
  swing_C: 40,
};

export function scoreConfig(cfg: SearchConfig, folds: FoldScore[], jevSpendUsd = 0): ConfigScore {
  const samples = folds.flatMap((fold) => fold.samples);
  const exp = classExpectancy(samples);
  const oosNet = folds.reduce((s, fold) => s + fold.oosNetUsd, 0) - jevSpendUsd;
  return {
    id: cfg.id,
    strategy: cfg.strategy,
    variant: cfg.variant,
    vetoRule: cfg.vetoRule,
    isNetUsd: folds.reduce((s, fold) => s + fold.isNetUsd, 0),
    oosNetUsd: oosNet,
    oosTrades: folds.reduce((s, fold) => s + fold.oosTrades, 0),
    oosMaxDrawdownUsd: folds.reduce((s, fold) => Math.max(s, fold.oosMaxDrawdownUsd), 0),
    positiveFolds: folds.filter((fold) => fold.oosNetUsd > 0).length,
    pairHalt: folds.some((fold) => fold.pairHalt),
    dailyHalt: folds.some((fold) => fold.dailyHalt),
    eR: exp.eR,
    eBps: exp.eBps,
    pStar: exp.pStar,
    expectancyPass: exp.pass,
    pStarPass: exp.pStarPass,
    jevSpendUsd,
    folds,
  };
}

/**
 * Pre-registered OOS filter from the turn-2 ranking section.
 * E is the pooled class formula: +0.15R or +25 bps.
 * p* <= 45%. At least two of the three OOS folds have net > 0.
 * The turn-1 three-split walk-forward flag is not a second filter on top of those folds.
 */
export function eligibility(score: ConfigScore): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const need = MIN_TRADES[score.strategy] ?? 100;
  if (score.oosTrades < need) reasons.push(`trades ${score.oosTrades} < ${need}`);
  if (!(score.eR != null && score.eR >= 0.15) && !(score.eBps != null && score.eBps >= 25)) reasons.push("E below +0.15R and +25 bps");
  if (!(score.pStarPass && score.pStar != null && score.pStar <= 0.45)) reasons.push("p* > 45%");
  if (score.positiveFolds < 2) reasons.push(`positive OOS folds ${score.positiveFolds} < 2`);
  if (!(score.oosMaxDrawdownUsd < 8_000)) reasons.push("DD >= 8000");
  if (score.pairHalt) reasons.push("pair halt breached");
  if (score.dailyHalt) reasons.push("daily halt breached");
  return { pass: reasons.length === 0, reasons };
}

function byNet(a: ConfigScore, b: ConfigScore): number {
  if (b.oosNetUsd !== a.oosNetUsd) return b.oosNetUsd - a.oosNetUsd;
  if (a.oosMaxDrawdownUsd !== b.oosMaxDrawdownUsd) return a.oosMaxDrawdownUsd - b.oosMaxDrawdownUsd;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function neighborMean(cfg: SearchConfig, scores: Map<string, ConfigScore>, grid: GridFile): number | null {
  const neighbors = neighborsOf(cfg, grid);
  const nets = neighbors.map((n) => scores.get(n.id)?.oosNetUsd).filter((n): n is number => n != null);
  if (nets.length === 0) return null;
  return nets.reduce((s, n) => s + n, 0) / nets.length;
}

/**
 * Eligible configs, winner chosen inside the 5% band, then configs that fail
 * the neighbor guard are dropped. Order is the selection order.
 */
export function rankEligible(configs: SearchConfig[], scores: ConfigScore[], grid: GridFile): Ranked[] {
  const byId = new Map(configs.map((cfg) => [cfg.id, cfg]));
  const scoreById = new Map(scores.map((score) => [score.id, score]));
  const eligibleScores = scores.filter((score) => eligibility(score).pass);
  if (eligibleScores.length === 0) return [];
  const bestNet = Math.max(...eligibleScores.map((score) => score.oosNetUsd));
  const band = eligibleScores.filter((score) => bestNet > 0 && score.oosNetUsd >= bestNet * 0.95);
  band.sort((a, b) => {
    if (a.oosMaxDrawdownUsd !== b.oosMaxDrawdownUsd) return a.oosMaxDrawdownUsd - b.oosMaxDrawdownUsd;
    const ca = paramChanges(byId.get(a.id)!);
    const cb = paramChanges(byId.get(b.id)!);
    if (ca !== cb) return ca - cb;
    return a.id < b.id ? -1 : 1;
  });
  const winner = band[0] ?? eligibleScores.slice().sort(byNet)[0]!;
  const rest = eligibleScores.filter((score) => score.id !== winner.id).sort(byNet);
  const ordered = [winner, ...rest];
  const ranked: Ranked[] = [];
  for (const score of ordered) {
    const cfg = byId.get(score.id);
    if (!cfg) continue;
    const mean = neighborMean(cfg, scoreById, grid);
    const stable = mean != null && mean > 0;
    if (!stable) continue;
    ranked.push({
      score,
      eligible: true,
      reasons: [],
      paramChanges: paramChanges(cfg),
      stable: true,
      neighborMeanOos: mean,
    });
  }
  return ranked;
}

export function topByNet(scores: ConfigScore[], pred: (score: ConfigScore) => boolean, n: number): ConfigScore[] {
  return scores.filter(pred).sort(byNet).slice(0, n);
}

export interface FoldPick {
  fold: 1 | 2 | 3;
  id: string;
  isNetUsd: number;
  oosNetUsd: number;
}

/** Per fold, the config with the highest in-sample net, and the OOS net it then scored. */
export function inSampleWinners(scores: readonly ConfigScore[]): FoldPick[] {
  const out: FoldPick[] = [];
  for (const foldId of [1, 2, 3] as const) {
    let best: FoldPick | null = null;
    for (const score of scores) {
      const fold = score.folds.find((row) => row.fold === foldId);
      if (!fold) continue;
      if (
        !best ||
        fold.isNetUsd > best.isNetUsd ||
        (fold.isNetUsd === best.isNetUsd && score.id < best.id)
      ) {
        best = { fold: foldId, id: score.id, isNetUsd: fold.isNetUsd, oosNetUsd: fold.oosNetUsd };
      }
    }
    if (best) out.push(best);
  }
  return out;
}

export function decayOf(score: ConfigScore): { isNetUsd: number; oosNetUsd: number; decayUsd: number } {
  return {
    isNetUsd: score.isNetUsd,
    oosNetUsd: score.oosNetUsd,
    decayUsd: score.oosNetUsd - score.isNetUsd,
  };
}
