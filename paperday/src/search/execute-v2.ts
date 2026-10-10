/**
 * Grid v2 runner.
 * Geometry records stop widths and the grid hash. It does not compute a net.
 * Search sets pnlStartedAt only after that timestamp.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENABLED_PAIRS } from "../config";
import { aggregate, type Candle } from "../bars";
import { hashCandles, loadCandleCsv, widthStats, WINDOWS } from "../backtest";
import { replayRepoBreakout, runBreakoutPaper } from "../breakout-paper";
import type { EngineResult } from "../engine";
import { prepareSwingPairs, runSwing, type HigherOpts, type JevAdmit, type QualifiedIdea, type SwingPair } from "../higher";
import { buildPacket, inputHash, type JevPacket } from "../jev";
import { buildMarketProxy, type ProxyBook } from "../proxy";
import { runSwing4h } from "../swing4h";
import { hashBytes, type SearchConfig, type VetoRule } from "./grid";
import { buildFoldsV2, emaWarmCloseMs, foldsV2Problems, SERIES_V2_END_MS, type FoldV2 } from "./folds-v2";
import { applyCellDrops, buildGridV2Universe, cellKey, dropCell, gridFileV2, median, validateGridV2 } from "./grid-v2";
import { JEV_MODEL_ID, JEV_SEARCH_CAP_USD, JevReviewCache, vetoes, type CachedReview } from "./jev";
import {
  foldBeats,
  onlyBreakoutEligible,
  rankBase,
  selectAnswer,
  selectTestable,
  vetoMargin,
  type FoldMargin,
  type FoldScoreV2,
  type RankedV2,
} from "./rank-v2";
import { renderSearchV2, type CellWidth, type JevVariantReport, type SideRow } from "./report-v2";
import { reviewWithJev } from "./transport";

export const PRIOR_PROBE_USD = 0.00001701;
export const PRIOR_PROBE_TOKENS = 405;
const DAY = 86_400_000;

export interface V2Paths {
  gridPath: string;
  manifestPath: string;
  checkpointPath: string;
  reportPath: string;
  rawPath: string;
  holdoutPath: string;
  cacheDir: string;
  jevCachePath: string;
}

export interface WidthCell {
  cell: string;
  strategy: string;
  stopAtrMult: number | null;
  medianP50: number | null;
  dropped: boolean;
  perPair: Record<string, { n: number; p10: number | null; p50: number | null; p90: number | null }>;
}

export interface ManifestV2 {
  holdoutV1: "consumed, pre-contaminated";
  gridVersion: "v2";
  earlierGrid: null;
  note: string;
  drops: {
    recordedAt: string;
    floorBps: 210;
    cells: WidthCell[];
    droppedCells: string[];
  } | null;
  gridHash: string | null;
  gridHashedAt: string | null;
  pnlStartedAt: string | null;
  priorProbe: {
    calls: number;
    tokens: number;
    spendUsd: number;
    responseModel: string;
    note: string;
  };
  candleHash?: string;
  parity?: { blind: number; proxy: number; searchBlind: number; searchProxy: number; pass: boolean };
}

export function v2Paths(root = "paperday"): V2Paths {
  return {
    gridPath: join(root, "search/grid-v2.json"),
    manifestPath: join(root, "results/search-v2-manifest.json"),
    checkpointPath: join(root, "results/search-v2-runs.jsonl"),
    reportPath: join(root, "results/search-v2.md"),
    rawPath: join(root, "results/search-v2.json"),
    holdoutPath: join(root, "results/holdout-v2.json"),
    cacheDir: join(root, "cache/candles"),
    jevCachePath: join(root, "cache/jev-v2-reviews.json"),
  };
}

export function dropsBeforePnl(recordedAt: string, pnlStartedAt: string | null): boolean {
  if (pnlStartedAt == null) return true;
  return Date.parse(recordedAt) < Date.parse(pnlStartedAt);
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readManifest(path: string): ManifestV2 {
  if (!existsSync(path)) {
    return {
      holdoutV1: "consumed, pre-contaminated",
      gridVersion: "v2",
      earlierGrid: null,
      note: "No earlier grid-v2 was hashed. grid-v2a was not required.",
      drops: null,
      gridHash: null,
      gridHashedAt: null,
      pnlStartedAt: null,
      priorProbe: {
        calls: 1,
        tokens: PRIOR_PROBE_TOKENS,
        spendUsd: PRIOR_PROBE_USD,
        responseModel: "jev-1.13.0",
        note: "Stopped probe of the direct API. Public id typesafe-ai/jev is unknown there; jev-latest answered as jev-1.13.0. Not a grid-v1 run.",
      },
    };
  }
  return JSON.parse(readFileSync(path, "utf8")) as ManifestV2;
}

export function loadBook(cacheDir: string): { candles: Record<string, Candle[]>; btc: Candle[]; starts: Array<{ pair: string; first: string; bars: number }> } {
  const candles: Record<string, Candle[]> = {};
  const starts: Array<{ pair: string; first: string; bars: number }> = [];
  for (const pair of ENABLED_PAIRS) {
    const path = join(cacheDir, `${pair}-1m.csv`);
    if (!existsSync(path)) throw new Error(`missing candles for ${pair}`);
    const bars = loadCandleCsv(path).filter((bar) => bar.ts < SERIES_V2_END_MS);
    candles[pair] = bars;
    starts.push({ pair, first: bars[0] ? new Date(bars[0].ts).toISOString() : "none", bars: bars.length });
  }
  const btcPath = join(cacheDir, "BTC-USD-1m.csv");
  if (!existsSync(btcPath)) throw new Error("missing BTC-USD candles");
  const btc = loadCandleCsv(btcPath).filter((bar) => bar.ts < SERIES_V2_END_MS);
  starts.push({ pair: "BTC-USD", first: btc[0] ? new Date(btc[0].ts).toISOString() : "none", bars: btc.length });
  return { candles, btc, starts };
}

export function foldWindow(candles: Record<string, Candle[]>): { folds: FoldV2[]; fromMs: number } {
  let warm = 0;
  for (const pair of ENABLED_PAIRS) {
    const daily = aggregate(candles[pair] ?? [], DAY, SERIES_V2_END_MS);
    const close = emaWarmCloseMs(daily.map((bar) => bar.ts));
    if (close == null) continue;
    if (close > warm) warm = close;
  }
  if (!(warm > 0)) throw new Error("daily EMA200 is not warm on any pair");
  const folds = buildFoldsV2(warm);
  const problems = foldsV2Problems(folds);
  if (problems.length) throw new Error(problems.join("; "));
  if (folds.length === 0) throw new Error("no v2 folds");
  return { folds, fromMs: folds[0]!.isFrom };
}

function cellResult(strategy: string, stop: number | null, result: EngineResult): WidthCell {
  const perPair: WidthCell["perPair"] = {};
  const p50s: number[] = [];
  for (const pair of ENABLED_PAIRS) {
    const stats = widthStats(result.stopsByPair[pair] ?? []);
    perPair[pair] = { n: stats.n, p10: stats.p10, p50: stats.p50, p90: stats.p90 };
    if (stats.p50 != null) p50s.push(stats.p50);
  }
  const medianP50 = median(p50s);
  return { cell: cellKey(strategy, stop), strategy, stopAtrMult: stop, medianP50, dropped: dropCell(medianP50), perPair };
}

/** Stop geometry only. The returned cells have no net, and this function does not print one. */
export async function scanStopCells(candles: Record<string, Candle[]>, fromMs: number, toMs: number): Promise<WidthCell[]> {
  const prepared = prepareSwingPairs(candles, ENABLED_PAIRS, toMs);
  const cells: Array<{ strategy: SearchConfig["strategy"]; stop: number | null }> = [];
  for (const strategy of ["swing_A", "swing_B", "swing_C", "swing_combined"] as const) {
    for (const stop of [1.5, 2, 2.5]) cells.push({ strategy, stop });
  }
  for (const stop of [1, 1.5]) cells.push({ strategy: "swing_4h", stop });
  cells.push({ strategy: "repo_breakout_4h", stop: null });
  const out: WidthCell[] = [];
  for (const cell of cells) {
    const opts: HigherOpts = {
      candles,
      fromMs,
      toMs,
      mode: "POOL",
      formula: "atr_scaled",
      strategy: cell.strategy,
      sentimentMode: "sentiment_blind",
      proxy: null,
      swingApproved: true,
      enabledPairs: ENABLED_PAIRS,
      variant: "jev_off",
      prepared,
      stopAtrMult: cell.stop ?? undefined,
      targetR: cell.strategy === "repo_breakout_4h" ? undefined : 3,
      maxHoldMs: 48 * 3_600_000,
      activityWindow: false,
      geometryOnly: true,
    };
    const result = cell.strategy === "repo_breakout_4h" ? await runBreakoutPaper(opts) : cell.strategy === "swing_4h" ? await runSwing4h(opts) : await runSwing(opts);
    out.push(cellResult(cell.strategy, cell.stop, result));
  }
  return out;
}

export async function writeGeometry(paths: V2Paths = v2Paths()): Promise<ManifestV2> {
  const manifest = readManifest(paths.manifestPath);
  if (manifest.pnlStartedAt) throw new Error("refusing to edit the grid after P&L started");
  if (manifest.gridHash && existsSync(paths.gridPath)) throw new Error("grid v2 is already hashed; refusing to edit it");
  const { candles } = loadBook(paths.cacheDir);
  const { fromMs } = foldWindow(candles);
  const cells = await scanStopCells(candles, fromMs, SERIES_V2_END_MS);
  const recordedAt = new Date().toISOString();
  const droppedCells = cells.filter((cell) => cell.dropped).map((cell) => cell.cell);
  const configs = applyCellDrops(buildGridV2Universe(), droppedCells);
  const grid = gridFileV2(configs);
  const problems = validateGridV2(grid);
  if (problems.length) throw new Error(problems.join("; "));
  manifest.drops = { recordedAt, floorBps: 210, cells, droppedCells };
  manifest.gridHash = null;
  manifest.gridHashedAt = null;
  manifest.pnlStartedAt = null;
  writeJson(paths.manifestPath, manifest);
  const text = `${JSON.stringify(grid, null, 2)}\n`;
  mkdirSync(dirname(paths.gridPath), { recursive: true });
  writeFileSync(paths.gridPath, text);
  manifest.gridHash = hashBytes(text);
  manifest.gridHashedAt = new Date().toISOString();
  if (!dropsBeforePnl(recordedAt, manifest.pnlStartedAt)) throw new Error("drop timestamp is not earlier than P&L");
  writeJson(paths.manifestPath, manifest);
  for (const cell of cells) {
    console.log(`geometry ${cell.cell} medianP50=${cell.medianP50 == null ? "none" : cell.medianP50.toFixed(1)} drop=${cell.dropped}`);
  }
  console.log(`geometry recorded ${recordedAt}; hash ${manifest.gridHash}; configs ${configs.length}; no P&L`);
  return manifest;
}

export interface ParityCounts {
  blind: number;
  proxy: number;
  searchBlind: number;
  searchProxy: number;
  pass: boolean;
}

export async function measureParity(candles: Record<string, Candle[]>, btc: Candle[]): Promise<ParityCounts> {
  const fromMs = WINDOWS["6m"].fromMs;
  const toMs = WINDOWS["6m"].toMs;
  const prepared = prepareSwingPairs(candles, ENABLED_PAIRS, toMs);
  const proxy = buildMarketProxy(candles, btc, toMs);
  const base: HigherOpts = {
    candles,
    fromMs,
    toMs,
    mode: "POOL",
    formula: "equal",
    strategy: "swing_combined",
    sentimentMode: "sentiment_blind",
    proxy: null,
    swingApproved: true,
    enabledPairs: ENABLED_PAIRS,
    variant: "jev_off",
    prepared,
    stopAtrMult: 2,
    maxHoldMs: 48 * 3_600_000,
    activityWindow: true,
  };
  const blind = await runSwing(base);
  const proxyRun = await runSwing({ ...base, sentimentMode: "market_proxy", proxy });
  const searchTarget = harnessTarget("swing_combined", 3);
  const searchBlind = await runSwing({ ...base, targetR: searchTarget });
  const searchProxy = await runSwing({ ...base, targetR: searchTarget, sentimentMode: "market_proxy", proxy });
  const pass = blind.trades === 12 && proxyRun.trades === 11 && searchBlind.trades === 12 && searchProxy.trades === 11;
  return { blind: blind.trades, proxy: proxyRun.trades, searchBlind: searchBlind.trades, searchProxy: searchProxy.trades, pass };
}

interface CheckpointRow {
  id: string;
  folds: FoldScoreV2[];
  packets: QualifiedIdea[];
}

function loadCheckpoint(path: string): Map<string, CheckpointRow> {
  const out = new Map<string, CheckpointRow>();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as CheckpointRow;
    out.set(row.id, row);
  }
  return out;
}

/**
 * The 1h grid's registered 3R is the turn-1 target band (2.5R–4R, or the nearer
 * 4h swing high). A fixed 3R multiple on that same window produced 1 trade
 * instead of 12. 4R stays the fixed multiple. swing_4h keeps searchSwingTarget.
 */
export function harnessTarget(strategy: string, targetR: number | null): number | undefined {
  if (strategy !== "swing_4h" && strategy !== "repo_breakout_4h" && targetR === 3) return undefined;
  return targetR ?? undefined;
}

async function runConfigWindow(
  cfg: SearchConfig,
  candles: Record<string, Candle[]>,
  prepared: SwingPair[],
  proxy: ProxyBook,
  fromMs: number,
  toMs: number,
  extra: Partial<HigherOpts> = {},
): Promise<EngineResult> {
  const opts: HigherOpts = {
    candles,
    fromMs,
    toMs,
    mode: cfg.mode,
    formula: cfg.formula,
    strategy: cfg.strategy,
    sentimentMode: "market_proxy",
    proxy,
    swingApproved: true,
    enabledPairs: ENABLED_PAIRS,
    variant: extra.variant ?? "jev_off",
    prepared,
    stopAtrMult: cfg.stopAtrMult ?? undefined,
    targetR: harnessTarget(cfg.strategy, cfg.targetR),
    maxHoldMs: cfg.maxHoldHours != null ? cfg.maxHoldHours * 3_600_000 : undefined,
    activityWindow: false,
    ...extra,
  };
  if (cfg.strategy === "repo_breakout_4h") return runBreakoutPaper(opts);
  if (cfg.strategy === "swing_4h") return runSwing4h(opts);
  return runSwing(opts);
}

function scoreFold(fold: FoldV2, isRun: EngineResult, oosRun: EngineResult): FoldScoreV2 {
  return {
    fold: fold.id,
    isNetUsd: isRun.netUsd,
    oosNetUsd: oosRun.netUsd,
    oosTrades: oosRun.trades,
    oosQualified: oosRun.qualified,
    isQualified: isRun.qualified,
    oosMaxDrawdownUsd: oosRun.maxDrawdownUsd,
    pairHalt: oosRun.pairHaltBreached,
    dailyHalt: oosRun.dailyHaltBreached,
    samples: oosRun.samples,
    entryAttempts: oosRun.entryAttempts,
    entryFills: oosRun.entryFills,
    entryTimeouts: oosRun.entryTimeouts,
    rejects: oosRun.rejects,
  };
}

function packetOf(idea: QualifiedIdea): { packet: JevPacket; hash: string } {
  const packet = buildPacket({
    asOf: idea.asOf,
    pair: idea.pair,
    setup: idea.setup,
    barTs: idea.barTs,
    candidateId: idea.id,
    biasUp: idea.biasUp,
    close: idea.entry,
    stop: idea.stop,
    atr: idea.atr,
    rsi: idea.rsi,
    vwap: idea.vwap,
    sentiment: "clear",
    barTsList: [idea.barTs],
  });
  return { packet, hash: inputHash(packet) };
}

interface DiskCache {
  spentUsd: number;
  reviews: CachedReview[];
}

function loadJevCache(path: string, cap: number): JevReviewCache {
  const cache = new JevReviewCache(cap);
  cache.spentUsd = PRIOR_PROBE_USD;
  if (!existsSync(path)) return cache;
  const disk = JSON.parse(readFileSync(path, "utf8")) as DiskCache;
  cache.spentUsd = Math.max(PRIOR_PROBE_USD, disk.spentUsd);
  for (const review of disk.reviews) {
    if (review.model === JEV_MODEL_ID) cache.seed(review);
  }
  return cache;
}

function saveJevCache(path: string, cache: JevReviewCache): void {
  const reviews: CachedReview[] = [];
  const seen = new Set<string>();
  const disk = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as DiskCache) : { spentUsd: PRIOR_PROBE_USD, reviews: [] };
  for (const review of disk.reviews) {
    if (seen.has(review.hash)) continue;
    seen.add(review.hash);
    reviews.push(review);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ spentUsd: cache.spentUsd, reviews }));
}

function remember(path: string, cache: JevReviewCache, review: CachedReview): void {
  const disk = existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as DiskCache) : { spentUsd: cache.spentUsd, reviews: [] };
  if (!disk.reviews.some((row) => row.hash === review.hash)) disk.reviews.push(review);
  disk.spentUsd = cache.spentUsd;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(disk));
}

const FORWARD_COMMAND = "PAPERDAY_SWING_APPROVED=true PAPERDAY_FORWARD_CONFIRM=1 bun run paperday/src/forward-paper.ts";

export async function runSearchV2(paths: V2Paths = v2Paths()): Promise<void> {
  const manifest = readManifest(paths.manifestPath);
  if (!manifest.gridHash || !manifest.drops) throw new Error("grid v2 is not hashed");
  const gridText = readFileSync(paths.gridPath, "utf8");
  if (hashBytes(gridText) !== manifest.gridHash) throw new Error("grid file does not match the manifest hash");
  const grid = JSON.parse(gridText) as ReturnType<typeof gridFileV2>;
  const problems = validateGridV2(grid);
  if (problems.length) throw new Error(problems.join("; "));
  if (!manifest.pnlStartedAt) {
    manifest.pnlStartedAt = new Date().toISOString();
    if (!dropsBeforePnl(manifest.drops.recordedAt, manifest.pnlStartedAt)) throw new Error("drop timestamp is not earlier than P&L");
    writeJson(paths.manifestPath, manifest);
  }
  const { candles, btc, starts } = loadBook(paths.cacheDir);
  const parity = await measureParity(candles, btc);
  manifest.parity = parity;
  writeJson(paths.manifestPath, manifest);
  writeJson(join(dirname(paths.reportPath), "parity-v2.json"), parity);
  if (!parity.pass) {
    throw new Error(`parity failed blind ${parity.blind} proxy ${parity.proxy} search ${parity.searchBlind}/${parity.searchProxy}`);
  }
  const { folds } = foldWindow(candles);
  const proxy = buildMarketProxy(candles, btc, SERIES_V2_END_MS);
  const prepared = prepareSwingPairs(candles, ENABLED_PAIRS, SERIES_V2_END_MS);
  const done = loadCheckpoint(paths.checkpointPath);
  mkdirSync(dirname(paths.checkpointPath), { recursive: true });
  for (const cfg of grid.configs) {
    if (done.has(cfg.id)) continue;
    const foldScores: FoldScoreV2[] = [];
    const packets: QualifiedIdea[] = [];
    for (const fold of folds) {
      const isRun = await runConfigWindow(cfg, candles, prepared, proxy, fold.isFrom, fold.isTo);
      const oosPackets: QualifiedIdea[] = [];
      const oosRun = await runConfigWindow(cfg, candles, prepared, proxy, fold.oosFrom, fold.oosTo, {
        onQualified: (idea) => oosPackets.push(idea),
      });
      packets.push(...oosPackets);
      foldScores.push(scoreFold(fold, isRun, oosRun));
      console.log(`v2 ${cfg.id} fold ${fold.id} oosTrades=${oosRun.trades} oosNet=${oosRun.netUsd.toFixed(2)}`);
    }
    const row: CheckpointRow = { id: cfg.id, folds: foldScores, packets };
    appendFileSync(paths.checkpointPath, `${JSON.stringify(row)}\n`);
    done.set(cfg.id, row);
  }
  const foldsById = new Map<string, FoldScoreV2[]>();
  for (const cfg of grid.configs) foldsById.set(cfg.id, done.get(cfg.id)!.folds);
  const ranked = rankBase(grid.configs, foldsById);
  const answer = selectAnswer(ranked);
  const breakoutOnly = onlyBreakoutEligible(ranked);
  let jev: Awaited<ReturnType<typeof runJevPhase>>;
  try {
    jev = await runJevPhase(paths, grid.configs, ranked, done, candles, prepared, proxy, folds);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    jev = { status: `not run: ${message}`, variants: [], calls: 0, tokens: 0, paidUsd: 0, hits: 0 };
  }
  const replay = replayRepoBreakout(candles, Date.UTC(2026, 6, 1), Date.UTC(2026, 9, 1));
  const breakoutRanked = ranked.filter((row) => row.score.strategy === "repo_breakout_4h");
  const bestBreakout = breakoutRanked.slice().sort((a, b) => b.score.oosNetUsd - a.score.oosNetUsd)[0] ?? null;
  const sides = sideBySide(answer, ranked[0] ?? null, jev.variants, bestBreakout);
  const top = ranked.slice(0, 10);
  let attempts = 0;
  let fills = 0;
  let timeouts = 0;
  for (const row of ranked) {
    for (const fold of row.score.folds) {
      attempts += fold.entryAttempts;
      fills += fold.entryFills;
      timeouts += fold.entryTimeouts;
    }
  }
  const frozen = freezeConfigs(grid.configs, answer, jev.variants, bestBreakout);
  const configHash = frozen.length ? hashBytes(JSON.stringify(frozen)) : null;
  const plannedStart = "Starts when Brian runs the forward-paper command on the home PC. The 30-day clock is not running.";
  writeJson(paths.holdoutPath, {
    version: "v2",
    holdoutV1: "consumed, pre-contaminated",
    gridVersion: "v2",
    gridHash: manifest.gridHash,
    configHash,
    answerId: answer?.score.id ?? null,
    onlyBreakout: breakoutOnly,
    jevWinners: jev.variants.filter((row) => row.wins).map((row) => row.id),
    frozen,
    plannedStart,
    startedAt: null,
    windowDays: 30,
    jevStage: 0,
    swingApprovedConstant: false,
    command: FORWARD_COMMAND,
  });
  const foldLines = folds.map(
    (fold) => `fold ${fold.id}: IS ${new Date(fold.isFrom).toISOString().slice(0, 10)} to ${new Date(fold.isTo).toISOString().slice(0, 10)}, OOS ${new Date(fold.oosFrom).toISOString().slice(0, 10)} to ${new Date(fold.oosTo).toISOString().slice(0, 10)}`,
  );
  const markdown = renderSearchV2({
    gridVersion: "v2",
    gridHash: manifest.gridHash,
    baseConfigs: grid.configs.length,
    baseBeforeDrops: 114,
    droppedCells: manifest.drops.droppedCells,
    holdoutV1: "consumed, pre-contaminated",
    candleHash: hashCandles({ ...candles, "BTC-USD": btc }),
    pairStarts: starts,
    foldCount: folds.length,
    foldLines,
    parity,
    breakoutTrades: breakoutRanked.reduce((s, row) => s + row.score.oosTrades, 0),
    breakoutByAllocator: breakoutRanked.map((row) => `${row.score.id} ${row.score.oosTrades}`).join("; ") || "none",
    repoReplayNet: replay.netUsd,
    repoReplayTrades: replay.trades,
    repoDocNet: 1171.8,
    clauses: proxy.clauses,
    cells: manifest.drops.cells as CellWidth[],
    ranked,
    answerId: answer?.score.id ?? null,
    onlyBreakout: breakoutOnly,
    jevStatus: jev.status,
    jevVariants: jev.variants,
    jevCalls: jev.calls,
    jevTokens: jev.tokens,
    jevPaidUsd: jev.paidUsd,
    jevHits: jev.hits,
    priorProbeUsd: PRIOR_PROBE_USD,
    sides,
    top,
    fillRate: { attempts, fills, timeouts },
    command: FORWARD_COMMAND,
    configHash,
    plannedStart,
  });
  mkdirSync(dirname(paths.reportPath), { recursive: true });
  writeFileSync(paths.reportPath, markdown);
  writeJson(paths.rawPath, {
    holdoutV1: "consumed, pre-contaminated",
    answerId: answer?.score.id ?? null,
    onlyBreakout: breakoutOnly,
    parity,
    jev: { status: jev.status, calls: jev.calls, tokens: jev.tokens, paidUsd: jev.paidUsd, hits: jev.hits, variants: jev.variants },
    ranked: ranked.map((row) => ({ ...row, score: { ...row.score, folds: row.score.folds.map((fold) => ({ ...fold, samples: undefined })) } })),
    replay,
    clauses: proxy.clauses,
  });
  manifest.candleHash = hashCandles({ ...candles, "BTC-USD": btc });
  writeJson(paths.manifestPath, manifest);
  console.log(`search v2 wrote ${paths.reportPath}`);
}

function freezeConfigs(configs: readonly SearchConfig[], answer: RankedV2 | null, variants: JevVariantReport[], baseline: RankedV2 | null): SearchConfig[] {
  if (!answer) return [];
  const ids = new Set<string>();
  const out: SearchConfig[] = [];
  const add = (id: string | null | undefined) => {
    if (!id || ids.has(id)) return;
    const cfg = configs.find((row) => row.id === id);
    if (!cfg) return;
    ids.add(id);
    out.push(cfg);
  };
  add(answer.score.id);
  add(baseline?.score.id);
  for (const variant of variants) {
    if (variant.wins) add(variant.baseId);
  }
  return out;
}

function sideBySide(answer: RankedV2 | null, topOff: RankedV2 | null, variants: JevVariantReport[], baseline: RankedV2 | null): SideRow[] {
  const winner = variants.filter((row) => row.wins).sort((a, b) => b.totalJevAfterCost - a.totalJevAfterCost)[0];
  const shown = answer ?? topOff;
  const jevRow: SideRow = winner
    ? {
        label: "best Jev",
        id: winner.id,
        oosNetUsd: winner.totalJevAfterCost,
        oosMaxDrawdownUsd: null,
        oosTrades: null,
        eR: null,
        pStar: null,
        positiveFolds: `${winner.margins.filter((fold) => fold.jevGrossUsd - fold.costUsd > 0).length}/${winner.margins.length}`,
        jevSpendUsd: winner.totalCostUsd,
      }
    : { label: "best Jev", id: "none", oosNetUsd: null, oosMaxDrawdownUsd: null, oosTrades: null, eR: null, pStar: null, positiveFolds: "", jevSpendUsd: 0 };
  const off: SideRow = shown
    ? {
        label: shown.eligible ? "best jev_off" : "best jev_off (not eligible)",
        id: shown.score.id,
        oosNetUsd: shown.score.oosNetUsd,
        oosMaxDrawdownUsd: shown.score.oosMaxDrawdownUsd,
        oosTrades: shown.score.oosTrades,
        eR: shown.score.eR,
        pStar: shown.score.pStar,
        positiveFolds: `${shown.score.positiveFolds}/${shown.score.foldCount}`,
        jevSpendUsd: 0,
      }
    : { label: "best jev_off", id: "none", oosNetUsd: null, oosMaxDrawdownUsd: null, oosTrades: null, eR: null, pStar: null, positiveFolds: "", jevSpendUsd: 0 };
  const base: SideRow = baseline
    ? {
        label: "baseline",
        id: baseline.score.id,
        oosNetUsd: baseline.score.oosNetUsd,
        oosMaxDrawdownUsd: baseline.score.oosMaxDrawdownUsd,
        oosTrades: baseline.score.oosTrades,
        eR: baseline.score.eR,
        pStar: baseline.score.pStar,
        positiveFolds: `${baseline.score.positiveFolds}/${baseline.score.foldCount}`,
        jevSpendUsd: 0,
      }
    : { label: "baseline", id: "none", oosNetUsd: null, oosMaxDrawdownUsd: null, oosTrades: null, eR: null, pStar: null, positiveFolds: "", jevSpendUsd: 0 };
  return [jevRow, off, base];
}

async function runJevPhase(
  paths: V2Paths,
  configs: readonly SearchConfig[],
  ranked: readonly RankedV2[],
  done: Map<string, CheckpointRow>,
  candles: Record<string, Candle[]>,
  prepared: SwingPair[],
  proxy: ProxyBook,
  folds: readonly FoldV2[],
): Promise<{ status: string; variants: JevVariantReport[]; calls: number; tokens: number; paidUsd: number; hits: number }> {
  const eligible = ranked.filter((row) => row.eligible);
  if (eligible.length === 0) {
    return { status: "not run: no eligible jev_off twins", variants: [], calls: 0, tokens: 0, paidUsd: 0, hits: 0 };
  }
  const cache = loadJevCache(paths.jevCachePath, JEV_SEARCH_CAP_USD);
  const paidBefore = cache.spentUsd;
  const callsBefore = cache.calls;
  const unique = new Map<string, JevPacket>();
  for (const row of eligible) {
    for (const idea of done.get(row.score.id)?.packets ?? []) {
      const built = packetOf(idea);
      if (!unique.has(built.hash)) unique.set(built.hash, built.packet);
    }
  }
  let stopped = false;
  for (const [hash, packet] of unique) {
    if (cache.peek(hash)) continue;
    const lookup = await cache.review(hash, () => reviewWithJev(process.env, packet, hash));
    if (lookup.review) remember(paths.jevCachePath, cache, lookup.review);
    if (lookup.stopped && !lookup.review) {
      stopped = true;
      break;
    }
  }
  saveJevCache(paths.jevCachePath, cache);
  const variants: JevVariantReport[] = [];
  const rules: Array<{ variant: "jev_veto" | "jev_select"; vetoRule: VetoRule | null }> = [
    { variant: "jev_veto", vetoRule: "V1" },
    { variant: "jev_veto", vetoRule: "V2" },
    { variant: "jev_veto", vetoRule: "V3" },
    { variant: "jev_select", vetoRule: null },
  ];
  for (const base of eligible) {
    const cfg = configs.find((row) => row.id === base.score.id);
    if (!cfg) continue;
    const ideas = done.get(cfg.id)?.packets ?? [];
    const idToHash = new Map<string, string>();
    const confidence = new Map<string, number>();
    for (const idea of ideas) {
      const built = packetOf(idea);
      idToHash.set(idea.id, built.hash);
      const review = cache.peek(built.hash);
      if (review) confidence.set(idea.id, review.longConfidence);
    }
    for (const rule of rules) {
      const consultedByFold: string[][] = [];
      let choiceCount = 0;
      let incomplete = stopped;
      const margins: FoldMargin[] = [];
      for (let i = 0; i < folds.length; i++) {
        const fold = folds[i]!;
        const consulted = new Set<string>();
        const admit: JevAdmit = {
          allow(id: string) {
            const hash = idToHash.get(id);
            if (!hash) return false;
            const review = cache.peek(hash);
            if (!review) {
              incomplete = true;
              return false;
            }
            consulted.add(hash);
            if (rule.variant === "jev_select") return true;
            return rule.vetoRule != null && !vetoes(rule.vetoRule, review.labels);
          },
          order(rows) {
            return rows.slice().sort((a, b) => (confidence.get(b.id) ?? 0) - (confidence.get(a.id) ?? 0) || (a.id < b.id ? -1 : 1));
          },
          onChoice(count: number) {
            if (rule.variant === "jev_select" && count >= 2) choiceCount += 1;
          },
        };
        const oos = await runConfigWindow(cfg, candles, prepared, proxy, fold.oosFrom, fold.oosTo, {
          variant: rule.variant,
          jevAdmit: admit,
        });
        consultedByFold.push([...consulted]);
        const cost = [...consulted].reduce((s, hash) => s + (cache.peek(hash)?.costUsd ?? 0), 0);
        const twin = base.score.folds[i]?.oosNetUsd ?? 0;
        margins.push({
          fold: fold.id,
          jevGrossUsd: oos.netUsd,
          twinUsd: twin,
          costUsd: cost,
          marginUsd: oos.netUsd - twin,
          beats: foldBeats(oos.netUsd, twin, cost),
        });
      }
      const uniqueCost = new Set(consultedByFold.flat());
      const totalCost = [...uniqueCost].reduce((s, hash) => s + (cache.peek(hash)?.costUsd ?? 0), 0);
      const margin = vetoMargin(margins, totalCost);
      const select = rule.variant === "jev_select" ? selectTestable(choiceCount) : { testable: true, label: "n/a" };
      const wins = !incomplete && margin.wins && (rule.variant !== "jev_select" || select.testable);
      variants.push({
        id: `${cfg.id}|${rule.variant}${rule.vetoRule ? "|" + rule.vetoRule : ""}`,
        baseId: cfg.id,
        variant: rule.variant,
        vetoRule: rule.vetoRule,
        choiceCount,
        selectLabel: rule.variant === "jev_select" ? select.label : "n/a",
        canWin: rule.variant !== "jev_select" || select.testable,
        wins,
        margins,
        passShare: margin.passShare,
        totalJevAfterCost: margin.totalJevAfterCost,
        totalTwin: margin.totalTwin,
        totalCostUsd: totalCost,
        incomplete,
      });
    }
  }
  const paidUsd = Math.max(0, cache.spentUsd - paidBefore);
  const status = stopped
    ? `partial: cap reached after eligible twins. Paid v2 spend $${paidUsd.toFixed(8)}.`
    : `ran on ${eligible.length} eligible base config(s). v2 paid spend $${paidUsd.toFixed(8)}.`;
  return { status, variants, calls: cache.calls - callsBefore, tokens: cache.tokens, paidUsd, hits: cache.hits };
}

export function forwardCommand(): string {
  return FORWARD_COMMAND;
}
