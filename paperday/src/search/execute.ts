/**
 * Walk-forward search runner.
 * The grid is locked before the first engine call. Search windows receive
 * candles with the holdout month removed. The holdout file is opened once,
 * after ranking, and a second process that finds the lock refuses to run.
 * Jev configs stay in the grid. They are not executed when no paid key is set,
 * and they are not filled with a heuristic.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENABLED_PAIRS } from "../config";
import type { Candle } from "../bars";
import { loadCandleCsv, WINDOWS, type WindowId } from "../backtest";
import { classExpectancy } from "../expectancy";
import { requiredGate, TARGET_PACE_USD, targetGate } from "../gate";
import { prepareSwingPairs, runBreakoutPaper, runSwing, type SwingPair } from "../higher";
import { buildMarketProxy, type ProxyBook } from "../proxy";
import type { EngineResult } from "../engine";
import { FOLDS, HOLDOUT_END_MS, HOLDOUT_START_MS, assertNoHoldout, foldsOverlapOwnSample, stripHoldout, type Fold } from "./folds";
import { assertConfigInGrid, lockGrid, type SearchConfig } from "./grid";
import { openHoldout } from "./holdout";
import { JEV_SEARCH_CAP_USD, JevReviewCache, jevBlockedReason, jevKeyPresent } from "./jev";
import {
  eligibility,
  inSampleWinners,
  neighborMean,
  rankEligible,
  scoreConfig,
  topByNet,
  type ConfigScore,
  type FoldScore,
} from "./rank";
import { renderSearchReport, type EvalSnap, type SearchReportInput } from "./report";

export interface SearchPaths {
  gridPath: string;
  manifestPath: string;
  checkpointPath: string;
  lockPath: string;
  reportPath: string;
  rawPath: string;
  cacheDir: string;
}

interface CheckpointRow {
  id: string;
  folds: FoldScore[];
}

function stripBook(candles: Record<string, Candle[]>): Record<string, Candle[]> {
  const out: Record<string, Candle[]> = {};
  for (const [pair, bars] of Object.entries(candles)) out[pair] = stripHoldout(bars);
  assertNoHoldout(out);
  return out;
}

function loadCheckpoint(path: string, ids: Set<string>): Map<string, FoldScore[]> {
  const out = new Map<string, FoldScore[]>();
  if (!existsSync(path)) return out;
  const text = readFileSync(path, "utf8");
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let row: CheckpointRow;
    try {
      row = JSON.parse(line) as CheckpointRow;
    } catch (err) {
      if (i === lines.length - 1) continue;
      throw err;
    }
    if (!ids.has(row.id)) throw new Error(`config not in grid: ${row.id}`);
    out.set(row.id, row.folds);
  }
  return out;
}

async function runWindow(
  cfg: SearchConfig,
  candles: Record<string, Candle[]>,
  prepared: SwingPair[],
  proxy: ProxyBook,
  fromMs: number,
  toMs: number,
): Promise<EngineResult> {
  const common = {
    candles,
    fromMs,
    toMs,
    mode: cfg.mode,
    formula: cfg.formula,
    strategy: cfg.strategy,
    sentimentMode: cfg.sentimentMode,
    proxy,
    swingApproved: true,
    enabledPairs: ENABLED_PAIRS,
    variant: "jev_off" as const,
    prepared,
  };
  if (cfg.strategy === "repo_breakout_4h") return runBreakoutPaper(common);
  return runSwing({
    ...common,
    stopAtrMult: cfg.stopAtrMult ?? undefined,
    targetR: cfg.targetR ?? undefined,
    maxHoldMs: cfg.maxHoldHours != null ? cfg.maxHoldHours * 3_600_000 : undefined,
  });
}

async function runFold(cfg: SearchConfig, candles: Record<string, Candle[]>, prepared: SwingPair[], proxy: ProxyBook, fold: Fold): Promise<FoldScore> {
  const isRun = await runWindow(cfg, candles, prepared, proxy, fold.isFrom, fold.isTo);
  const oosRun = await runWindow(cfg, candles, prepared, proxy, fold.oosFrom, fold.oosTo);
  return {
    fold: fold.id,
    isNetUsd: isRun.netUsd,
    oosNetUsd: oosRun.netUsd,
    oosTrades: oosRun.trades,
    oosMaxDrawdownUsd: oosRun.maxDrawdownUsd,
    pairHalt: oosRun.pairHaltBreached,
    dailyHalt: oosRun.dailyHaltBreached,
    samples: oosRun.samples,
  };
}

function snapOf(id: string, result: EngineResult, fromMs: number, toMs: number, window: WindowId | null): EvalSnap {
  const exp = classExpectancy(result.samples);
  let requiredPass: boolean | null = null;
  let requiredReasons: string[] = [];
  let targetPass: boolean | null = null;
  let targetReasons: string[] = [];
  if (window) {
    const required = requiredGate({
      window,
      netUsd: result.netUsd,
      maxDrawdownUsd: result.maxDrawdownUsd,
      trades: result.trades,
      expectancyPass: exp.pass,
      pairHaltBreached: result.pairHaltBreached,
      dailyHaltBreached: result.dailyHaltBreached,
      research: false,
    });
    const target = targetGate({
      paceUsd: TARGET_PACE_USD[window],
      fromMs,
      toMs,
      netUsd: result.netUsd,
      quarters: result.quarters,
    });
    requiredPass = required.pass;
    requiredReasons = required.reasons;
    targetPass = target.pass;
    targetReasons = target.reasons;
  }
  return {
    id,
    netUsd: result.netUsd,
    maxDrawdownUsd: result.maxDrawdownUsd,
    trades: result.trades,
    eR: exp.eR,
    eBps: exp.eBps,
    pStar: exp.pStar,
    jevSpendUsd: 0,
    requiredPass,
    requiredReasons,
    targetPass,
    targetReasons,
    pairHalt: result.pairHaltBreached,
    dailyHalt: result.dailyHaltBreached,
  };
}

function refuseSecondOpen(lockPath: string): void {
  if (!existsSync(lockPath)) return;
  const prev = readFileSync(lockPath, "utf8");
  throw new Error(`holdout already opened: ${prev.slice(0, 240)}`);
}

export async function runSearch(paths: SearchPaths, now = new Date()): Promise<SearchReportInput> {
  refuseSecondOpen(paths.lockPath);
  const { grid, hash } = lockGrid(paths.gridPath, paths.manifestPath, now);
  const ids = new Set(grid.configs.map((cfg) => cfg.id));
  const done = loadCheckpoint(paths.checkpointPath, ids);
  const problems = foldsOverlapOwnSample();
  if (problems.length) throw new Error(problems.join("; "));

  const searchBook = loadSearchBook(paths.cacheDir);
  const searchCandles = searchBook.candles;
  const prepared = searchBook.prepared;
  const proxy = searchBook.proxy;

  const jevConfigs = grid.configs.filter((cfg) => cfg.variant !== "jev_off");
  const jevReason = jevKeyPresent(process.env) ? null : jevBlockedReason(process.env);
  if (jevKeyPresent(process.env)) {
    console.log("Jev key is present. Paid rows are not filled until a candidate packet is reviewed. No heuristic is substituted.");
  } else {
    console.log(jevReason);
  }

  mkdirSync(dirname(paths.checkpointPath), { recursive: true });
  const executable = grid.configs.filter((cfg) => cfg.variant === "jev_off");
  let finished = 0;
  for (const cfg of executable) {
    assertConfigInGrid(grid, cfg.id);
    finished += 1;
    if (done.has(cfg.id)) {
      if (finished % 25 === 0) console.log(`search ${finished}/${executable.length} (cached ${cfg.id})`);
      continue;
    }
    const t0 = Date.now();
    const folds: FoldScore[] = [];
    for (const fold of FOLDS) folds.push(await runFold(cfg, searchCandles, prepared, proxy, fold));
    done.set(cfg.id, folds);
    appendFileSync(paths.checkpointPath, `${JSON.stringify({ id: cfg.id, folds })}\n`);
    console.log(`search ${finished}/${executable.length} ${Date.now() - t0}ms ${cfg.id}`);
  }

  const byId = new Map(grid.configs.map((cfg) => [cfg.id, cfg]));
  const scores: ConfigScore[] = [];
  for (const cfg of executable) {
    const folds = done.get(cfg.id);
    if (!folds) throw new Error(`missing folds for ${cfg.id}`);
    scores.push(scoreConfig(cfg, folds, 0));
  }
  const ranked = rankEligible(executable, scores, grid);
  const selected = ranked[0] ?? null;
  const bestJevOff = topByNet(scores, (score) => score.variant === "jev_off", 1)[0] ?? null;
  const bestBreakout = topByNet(scores, (score) => score.strategy === "repo_breakout_4h", 1)[0] ?? null;
  const droppedForStability = scores
    .filter((score) => eligibility(score).pass && !ranked.some((row) => row.score.id === score.id))
    .map((score) => ({
      id: score.id,
      neighborMean: neighborMean(byId.get(score.id)!, new Map(scores.map((row) => [row.id, row])), grid),
      oosNetUsd: score.oosNetUsd,
    }));

  const lock = openHoldout(paths.lockPath, now, "search-v1");
  const holdBook = loadFullBook(paths.cacheDir);
  const holdPrepared = holdBook.prepared;
  const holdProxy = holdBook.proxy;
  const full = holdBook.candles;
  const holdCache = new Map<string, EngineResult>();
  const runHold = async (cfg: SearchConfig, fromMs: number, toMs: number): Promise<EngineResult> => {
    assertConfigInGrid(grid, cfg.id);
    const key = `${cfg.id}|${fromMs}|${toMs}`;
    const cached = holdCache.get(key);
    if (cached) return cached;
    const result = await runWindow(cfg, full, holdPrepared, holdProxy, fromMs, toMs);
    holdCache.set(key, result);
    return result;
  };
  const month = async (score: ConfigScore | null): Promise<EvalSnap | null> => {
    if (!score) return null;
    const cfg = byId.get(score.id);
    if (!cfg) throw new Error(`config not in grid: ${score.id}`);
    const result = await runHold(cfg, HOLDOUT_START_MS, HOLDOUT_END_MS);
    return snapOf(cfg.id, result, HOLDOUT_START_MS, HOLDOUT_END_MS, "1m");
  };

  const holdoutSelected = selected ? await month(selected.score) : null;
  const holdoutJevOff = await month(bestJevOff);
  const holdoutBreakout = await month(bestBreakout);

  let selectedWindows: SearchReportInput["selectedWindows"] = null;
  if (selected) {
    const cfg = byId.get(selected.score.id)!;
    const windows = {} as NonNullable<SearchReportInput["selectedWindows"]>;
    for (const window of ["1m", "3m", "6m"] as const) {
      const bounds = WINDOWS[window];
      const result = await runHold(cfg, bounds.fromMs, bounds.toMs);
      windows[window] = snapOf(cfg.id, result, bounds.fromMs, bounds.toMs, window);
    }
    selectedWindows = windows;
  }

  const cache = new JevReviewCache(JEV_SEARCH_CAP_USD);
  const coverage = {
    ...cache.coverage(jevConfigs.length, 0),
    reason: jevReason ?? "blocked: paid Jev rows were not executed",
  };
  const input: SearchReportInput = {
    gridHash: hash,
    configCount: grid.configs.length,
    bounding: grid.bounding,
    jevOffExecuted: executable.length,
    ranked,
    ineligibleTop: topByNet(scores, () => true, 10),
    selected,
    bestJevOff,
    bestBreakout,
    foldPicks: inSampleWinners(scores),
    holdoutOpenedAt: lock.openedAt,
    holdout: { selected: holdoutSelected, jevOff: holdoutJevOff, breakout: holdoutBreakout },
    selectedWindows,
    coverage,
    droppedForStability,
  };
  const markdown = renderSearchReport(input);
  writeFileSync(paths.reportPath, markdown);
  writeFileSync(
    paths.rawPath,
    JSON.stringify(
      {
        gridHash: hash,
        configCount: grid.configs.length,
        jevOffExecuted: executable.length,
        selectedId: selected?.score.id ?? null,
        scores,
        ranked: ranked.map((row) => ({
          id: row.score.id,
          oosNetUsd: row.score.oosNetUsd,
          paramChanges: row.paramChanges,
          neighborMeanOos: row.neighborMeanOos,
        })),
        foldPicks: input.foldPicks,
        holdoutOpenedAt: lock.openedAt,
        holdout: input.holdout,
        selectedWindows,
        coverage,
      },
      null,
      2,
    ),
  );
  return input;
}

function loadSearchBook(cacheDir: string): { candles: Record<string, Candle[]>; prepared: SwingPair[]; proxy: ProxyBook } {
  const loaded = loadCached(cacheDir);
  const candles = stripBook(loaded.pairs);
  const btc = stripHoldout(loaded.btc);
  assertNoHoldout({ ...candles, "BTC-USD": btc });
  return {
    candles,
    prepared: prepareSwingPairs(candles, ENABLED_PAIRS, HOLDOUT_START_MS),
    proxy: buildMarketProxy(candles, btc, HOLDOUT_START_MS),
  };
}

function loadFullBook(cacheDir: string): { candles: Record<string, Candle[]>; prepared: SwingPair[]; proxy: ProxyBook } {
  const loaded = loadCached(cacheDir);
  return {
    candles: loaded.pairs,
    prepared: prepareSwingPairs(loaded.pairs, ENABLED_PAIRS, HOLDOUT_END_MS),
    proxy: buildMarketProxy(loaded.pairs, loaded.btc, HOLDOUT_END_MS),
  };
}

function loadCached(cacheDir: string): { pairs: Record<string, Candle[]>; btc: Candle[] } {
  const pairs: Record<string, Candle[]> = {};
  for (const pair of ENABLED_PAIRS) pairs[pair] = loadCandleCsv(join(cacheDir, `${pair}-1m.csv`));
  return { pairs, btc: loadCandleCsv(join(cacheDir, "BTC-USD-1m.csv")) };
}
