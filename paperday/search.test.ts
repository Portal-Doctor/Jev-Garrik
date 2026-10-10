import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BOOK_DRAWDOWN_HALT_USD,
  DAILY_LOSS_HALT_USD,
  FILL_HAIRCUT,
  MAKER_FEE_BPS,
  MAX_CONCURRENT,
  MAX_IDEAS_WEEKDAY,
  OVERNIGHT_RISK_CAP_USD,
  PAIR_LOSS_HALT_USD,
  SWING_APPROVED,
  TAKER_FEE_BPS,
} from "./src/config";
import { classExpectancy, type ClosedSample } from "./src/expectancy";
import { FOLDS, HOLDOUT_START_MS, assertNoHoldout, foldsOverlapOwnSample, stripHoldout } from "./src/search/folds";
import {
  GRID_CAP,
  buildGridV1,
  hashBytes,
  loadGrid,
  lockGrid,
  neighborsOf,
  paramChanges,
  validateGrid,
  assertConfigInGrid,
  type GridFile,
  type SearchConfig,
} from "./src/search/grid";
import { openHoldout } from "./src/search/holdout";
import {
  JEV_MODEL_ID,
  JevReviewCache,
  applyJevDecision,
  jevBlockedReason,
  redactSecrets,
  selectByConfidence,
  vetoes,
} from "./src/search/jev";
import { eligibility, rankEligible, scoreConfig, type FoldScore } from "./src/search/rank";
import { renderSearchReport, type SearchReportInput } from "./src/search/report";
import { jevTransportPlan, reviewWithJev } from "./src/search/transport";
import { runSearch } from "./src/search/execute";
import { searchSwingTarget, swingStop } from "./src/swing";
import type { JevLabels } from "./src/jev";
import type { JevPacket } from "./src/jev";

const GRID_PATH = join(import.meta.dir, "search", "grid-v1.json");

function samples(n: number, firstWin: number, stopBps = 500, targetBps = 1500): ClosedSample[] {
  return Array.from({ length: n }, (_, i) => ({
    closeTs: Date.parse("2026-06-10T00:00:00.000Z") + i * 86_400_000,
    stopBps,
    targetBps,
    win: i >= firstWin,
    rMultiple: i >= firstWin ? 2 : -1,
  }));
}

function foldsOf(net: number, dd: number, rows: ClosedSample[], halt = false): FoldScore[] {
  const a = Math.floor(rows.length / 3);
  const b = Math.floor(rows.length / 3);
  const cuts = [0, a, a + b, rows.length];
  return ([1, 2, 3] as const).map((fold, i) => ({
    fold,
    isNetUsd: net / 3,
    oosNetUsd: net / 3,
    oosTrades: cuts[i + 1]! - cuts[i]!,
    oosMaxDrawdownUsd: dd,
    pairHalt: halt,
    dailyHalt: false,
    samples: rows.slice(cuts[i], cuts[i + 1]),
  }));
}

function swingCfg(over: Partial<SearchConfig> & { id: string }): SearchConfig {
  return {
    strategy: "swing_A",
    stopAtrMult: 2,
    targetR: 3,
    maxHoldHours: 48,
    mode: "POOL",
    formula: "equal",
    sentimentMode: "market_proxy",
    variant: "jev_off",
    vetoRule: null,
    ...over,
  };
}

test("grid file is the pre-registered 372-config bound", () => {
  const built = `${JSON.stringify(buildGridV1(), null, 2)}\n`;
  const bytes = readFileSync(GRID_PATH);
  expect(bytes.toString("utf8")).toBe(built);
  const { grid, hash } = loadGrid(GRID_PATH);
  expect(hash).toBe(hashBytes(bytes));
  expect(validateGrid(grid)).toEqual([]);
  expect(grid.configs.length).toBe(372);
  expect(grid.configs.length).toBeLessThanOrEqual(GRID_CAP);
  expect(grid.configs.filter((cfg) => cfg.variant === "jev_off" && cfg.strategy !== "repo_breakout_4h")).toHaveLength(288);
  expect(grid.configs.filter((cfg) => cfg.variant === "jev_off" && cfg.strategy === "repo_breakout_4h")).toHaveLength(4);
  expect(grid.configs.filter((cfg) => cfg.variant !== "jev_off" && cfg.strategy !== "repo_breakout_4h")).toHaveLength(64);
  expect(grid.configs.filter((cfg) => cfg.variant !== "jev_off" && cfg.strategy === "repo_breakout_4h")).toHaveLength(16);
  expect(grid.configs.some((cfg) => cfg.sentimentMode !== "market_proxy")).toBe(false);
  expect(grid.configs.some((cfg) => cfg.strategy === "intraday_research")).toBe(false);
  expect(grid.configs.some((cfg) => JSON.stringify(cfg).includes("sentiment_blind"))).toBe(false);
  const changed = grid.configs.filter((cfg) => cfg.variant !== "jev_off" && cfg.strategy !== "repo_breakout_4h");
  expect(changed.every((cfg) => cfg.stopAtrMult === 2 && cfg.targetR === 3 && cfg.maxHoldHours === 48)).toBe(true);
});

test("the runner refuses a changed grid hash and an unknown config", () => {
  const dir = mkdtempSync(join(tmpdir(), "paperday-grid-"));
  const gridPath = join(dir, "grid.json");
  const manifestPath = join(dir, "manifest.json");
  writeFileSync(gridPath, readFileSync(GRID_PATH));
  const first = lockGrid(gridPath, manifestPath, new Date("2026-10-10T00:00:00.000Z"));
  expect(first.manifest.gridHash).toBe(first.hash);
  const again = lockGrid(gridPath, manifestPath);
  expect(again.manifest.gridHash).toBe(first.hash);
  const parsed = JSON.parse(readFileSync(gridPath, "utf8")) as GridFile;
  parsed.bounding = `${parsed.bounding} edited`;
  writeFileSync(gridPath, JSON.stringify(parsed));
  expect(() => lockGrid(gridPath, manifestPath)).toThrow(/grid hash changed/);
  expect(() => assertConfigInGrid(first.grid, "not-a-config")).toThrow(/config not in grid/);
});

test("folds do not overlap their own in-sample and the holdout stays unread", () => {
  expect(foldsOverlapOwnSample()).toEqual([]);
  for (const fold of FOLDS) {
    expect(fold.oosFrom).toBe(fold.isTo);
    expect(fold.oosTo).toBeLessThanOrEqual(HOLDOUT_START_MS);
  }
  expect(stripHoldout([{ ts: HOLDOUT_START_MS - 1 }, { ts: HOLDOUT_START_MS }])).toEqual([{ ts: HOLDOUT_START_MS - 1 }]);
  expect(() => assertNoHoldout({ "UNI-USD": [{ ts: HOLDOUT_START_MS }] })).toThrow(/holdout bar/);
});

test("the holdout lock opens once", () => {
  const dir = mkdtempSync(join(tmpdir(), "paperday-holdout-"));
  const path = join(dir, "holdout-open.json");
  const lock = openHoldout(path, new Date("2026-10-10T12:00:00.000Z"), "search-v1");
  expect(lock.openedAt).toBe("2026-10-10T12:00:00.000Z");
  expect(() => openHoldout(path)).toThrow(/holdout already opened/);
});

test("veto rules and select do not invent a name", () => {
  const flat: JevLabels = { regime: "balance", direction_bias: "flat", toxic_flow: "low", liquidity_stress: "normal" };
  const toxic: JevLabels = { regime: "expansion", direction_bias: "long", toxic_flow: "high", liquidity_stress: "normal" };
  const stressed: JevLabels = { regime: "expansion", direction_bias: "long", toxic_flow: "low", liquidity_stress: "stressed" };
  const clean: JevLabels = { regime: "expansion", direction_bias: "long", toxic_flow: "low", liquidity_stress: "normal" };
  expect(vetoes("V1", flat)).toBe(true);
  expect(vetoes("V1", clean)).toBe(false);
  expect(vetoes("V2", toxic)).toBe(true);
  expect(vetoes("V2", stressed)).toBe(true);
  expect(vetoes("V2", clean)).toBe(false);
  expect(vetoes("V3", flat)).toBe(true);
  expect(vetoes("V3", toxic)).toBe(true);
  expect(vetoes("V3", clean)).toBe(false);
  const qualified = [
    { id: "a", labels: clean, longConfidence: 0.2 },
    { id: "b", labels: flat, longConfidence: 0.9 },
  ];
  expect(applyJevDecision("jev_veto", "V1", qualified, 2)).toEqual(["a"]);
  expect(applyJevDecision("jev_select", null, qualified, 1)).toEqual(["b"]);
  expect(selectByConfidence([{ id: "a", longConfidence: 0.2 }], 0)).toEqual([]);
  expect(applyJevDecision("jev_select", null, qualified, 5).sort()).toEqual(["a", "b"]);
});

test("the review cache charges a hit to the row and stops after the cap", async () => {
  const labels: JevLabels = { regime: "balance", direction_bias: "long", toxic_flow: "low", liquidity_stress: "normal" };
  const cache = new JevReviewCache(0.05);
  const paid = await cache.review("a", async () => ({
    hash: "a",
    model: JEV_MODEL_ID,
    tokens: 1_000_000,
    costUsd: 0.042,
    labels,
    longConfidence: 0.4,
  }));
  expect(paid.hit).toBe(false);
  expect(cache.calls).toBe(1);
  expect(cache.spentUsd).toBeCloseTo(0.042);
  const again = await cache.review("a", async () => {
    throw new Error("second paid call");
  });
  expect(again.hit).toBe(true);
  expect(again.attributedUsd).toBeCloseTo(0.042);
  expect(cache.spentUsd).toBeCloseTo(0.042);
  expect(cache.hits).toBe(1);
  const crossing = await cache.review("b", async () => ({
    hash: "b",
    model: JEV_MODEL_ID,
    tokens: 500_000,
    costUsd: 0.02,
    labels,
    longConfidence: 0.4,
  }));
  expect(crossing.review?.hash).toBe("b");
  expect(cache.stopped).toBe(true);
  const stopped = await cache.review("c", async () => {
    throw new Error("past the cap");
  });
  expect(stopped.stopped).toBe(true);
  expect(stopped.review).toBeNull();
  expect(cache.calls).toBe(2);
  const fresh = new JevReviewCache(25);
  await expect(
    fresh.review("d", async () => ({ hash: "d", model: "other", tokens: 10, costUsd: 1, labels, longConfidence: 0.1 })),
  ).rejects.toThrow(/typesafe-ai\/jev/);
});

test("secrets stay out of the blocked reason and the transport plan", async () => {
  const secret = "sk-test-secret-value";
  expect(redactSecrets(`authorization failed Bearer ${secret} and ${secret}`)).not.toContain(secret);
  expect(jevBlockedReason({})).toBe("blocked: TYPESAFE_AI_API_KEY not present");
  expect(jevBlockedReason({})!.includes(secret)).toBe(false);
  const plan = jevTransportPlan({ AI_GATEWAY_API_KEY: secret, TYPESAFE_AI_API_KEY: secret });
  expect(plan.kind).toBe("gateway");
  expect(JSON.stringify(plan).includes(secret)).toBe(false);
  const direct = jevTransportPlan({ TYPESAFE_AI_API_KEY: secret });
  expect(direct.kind).toBe("typesafe");
  expect(JSON.stringify(direct).includes(secret)).toBe(false);
  const packet = { asOf: 1, pair: "UNI-USD", setup: "A", barTs: 1, candidateId: "c", biasUp: true, close: 1, stop: 1, atr: 1, rsi: 1, vwap: 1, sentiment: "clear", prompt: "" } as JevPacket;
  await expect(reviewWithJev({}, packet, "hash")).rejects.toThrow("blocked: TYPESAFE_AI_API_KEY not present");
});

test("eligibility is the pre-registered OOS list", () => {
  const base = swingCfg({ id: "swing_A|default" });
  const enough = scoreConfig(base, foldsOf(90, 40, samples(40, 0)), 0);
  expect(eligibility(enough).pass).toBe(true);
  const short = scoreConfig(base, foldsOf(90, 40, samples(39, 0)), 0);
  expect(eligibility(short).pass).toBe(false);
  expect(eligibility(short).reasons.join(" ")).toContain("39");
  const combined = swingCfg({ id: "combined", strategy: "swing_combined" });
  expect(eligibility(scoreConfig(combined, foldsOf(90, 40, samples(100, 0)), 0)).pass).toBe(true);
  expect(eligibility(scoreConfig(combined, foldsOf(90, 40, samples(99, 0)), 0)).reasons.join(" ")).toContain("99");
  const late = samples(40, 25);
  const exp = classExpectancy(late);
  expect(exp.pass).toBe(false);
  expect(exp.eR ?? 0).toBeGreaterThanOrEqual(0.15);
  const lateScore = scoreConfig(base, foldsOf(90, 40, late), 0);
  expect(lateScore.expectancyPass).toBe(false);
  expect(eligibility(lateScore).pass).toBe(true);
  const wide = scoreConfig(base, foldsOf(90, 40, samples(40, 0, 150, 450)), 0);
  expect(eligibility(wide).reasons.join(" ")).toContain("p*");
  const halted = scoreConfig(base, foldsOf(90, 40, samples(40, 0), true), 0);
  expect(eligibility(halted).reasons.join(" ")).toContain("pair halt");
  const deep = scoreConfig(base, foldsOf(90, 8_000, samples(40, 0)), 0);
  expect(eligibility(deep).reasons.join(" ")).toContain("DD");
});

test("the ranker breaks ties inside 5% and drops an unstable neighbor mean", () => {
  const leader = swingCfg({ id: "leader", stopAtrMult: 2, targetR: 3, maxHoldHours: 48 });
  const neighborA = swingCfg({ id: "n-stop", stopAtrMult: 1.5 });
  const neighborB = swingCfg({ id: "n-target", targetR: 2.5 });
  const neighborC = swingCfg({ id: "n-hold", maxHoldHours: 24 });
  const stable = swingCfg({ id: "stable", stopAtrMult: 1.5, targetR: 2.5, maxHoldHours: 24 });
  const stableN = swingCfg({ id: "stable-hold", stopAtrMult: 1.5, targetR: 2.5, maxHoldHours: 48 });
  const breakout = swingCfg({
    id: "repo_breakout_4h|locked|POOL|equal|market_proxy|jev_off",
    strategy: "repo_breakout_4h",
    stopAtrMult: null,
    targetR: null,
    maxHoldHours: null,
  });
  const configs = [breakout, leader, neighborA, neighborB, neighborC, stable, stableN];
  const grid: GridFile = {
    version: 1,
    cap: 500,
    bounding: "test",
    hardLimitsNotSearched: [],
    defaults: { stopAtrMult: 2, targetR: 3, maxHoldHours: 48 },
    configs,
  };
  const scores = [
    scoreConfig(breakout, foldsOf(5_000, 10, samples(100, 0)), 0),
    scoreConfig(leader, foldsOf(1_000, 400, samples(40, 0)), 0),
    scoreConfig(neighborA, foldsOf(-30, 10, []), 0),
    scoreConfig(neighborB, foldsOf(-30, 10, []), 0),
    scoreConfig(neighborC, foldsOf(-30, 10, []), 0),
    scoreConfig(stable, foldsOf(900, 50, samples(40, 0)), 0),
    scoreConfig(stableN, foldsOf(30, 10, []), 0),
  ];
  const ranked = rankEligible(configs, scores, grid);
  expect(ranked[0]?.score.id).toBe("stable");
  expect(ranked.some((row) => row.score.strategy === "repo_breakout_4h")).toBe(false);
  expect(paramChanges(leader)).toBe(0);
  expect(paramChanges(stable)).toBe(3);
  expect(paramChanges(breakout)).toBe(0);
});

test("within 5%, lower drawdown then fewer knob changes wins", () => {
  const rich = swingCfg({ id: "rich", stopAtrMult: 1.5, targetR: 2.5, maxHoldHours: 24 });
  const calm = swingCfg({ id: "calm" });
  const calmNeighbor = swingCfg({ id: "calm-hold", maxHoldHours: 24 });
  const richNeighbor = swingCfg({ id: "rich-hold", stopAtrMult: 1.5, targetR: 2.5, maxHoldHours: 48 });
  const configs = [rich, calm, calmNeighbor, richNeighbor];
  const grid: GridFile = {
    version: 1,
    cap: 500,
    bounding: "test",
    hardLimitsNotSearched: [],
    defaults: { stopAtrMult: 2, targetR: 3, maxHoldHours: 48 },
    configs,
  };
  const scores = [
    scoreConfig(rich, foldsOf(1_000, 400, samples(40, 0)), 0),
    scoreConfig(calm, foldsOf(960, 80, samples(40, 0)), 0),
    scoreConfig(calmNeighbor, foldsOf(20, 5, []), 0),
    scoreConfig(richNeighbor, foldsOf(20, 5, []), 0),
  ];
  const ranked = rankEligible(configs, scores, grid);
  expect(ranked[0]?.score.id).toBe("calm");
  expect(ranked[0]?.paramChanges).toBe(0);
});

test("default swing neighbors are one step, and a default Jev row has none", () => {
  const grid = buildGridV1();
  const def = grid.configs.find((cfg) => cfg.id === "swing_A|stop=2|target=3|hold=48|POOL|equal|market_proxy|jev_off");
  expect(def).toBeDefined();
  expect(neighborsOf(def!, grid).map((cfg) => cfg.id).sort()).toEqual(
    [
      "swing_A|stop=1.5|target=3|hold=48|POOL|equal|market_proxy|jev_off",
      "swing_A|stop=2.5|target=3|hold=48|POOL|equal|market_proxy|jev_off",
      "swing_A|stop=2|target=2.5|hold=48|POOL|equal|market_proxy|jev_off",
      "swing_A|stop=2|target=4|hold=48|POOL|equal|market_proxy|jev_off",
      "swing_A|stop=2|target=3|hold=24|POOL|equal|market_proxy|jev_off",
    ].sort(),
  );
  const veto = grid.configs.find((cfg) => cfg.id === "swing_A|stop=2|target=3|hold=48|POOL|equal|market_proxy|jev_veto|V1");
  expect(neighborsOf(veto!, grid)).toEqual([]);
  const breakout = grid.configs.find((cfg) => cfg.strategy === "repo_breakout_4h");
  expect(neighborsOf(breakout!, grid)).toEqual([]);
});

test("search target uses the registered R unless a nearer 4h swing high sits inside it", () => {
  expect(searchSwingTarget(100, 90, 2.5, 110)).toBe(110);
  expect(searchSwingTarget(100, 90, 2.5, 130)).toBe(125);
  expect(searchSwingTarget(100, 90, 2.5, null)).toBe(125);
  expect(searchSwingTarget(100, 90, 4, 130)).toBe(130);
  expect(swingStop(100, 98, 3)?.stop).toBe(94);
  expect(swingStop(100, 90, 3)?.stop).toBe(90);
});

test("hard limits stay the locked constants", () => {
  expect(MAKER_FEE_BPS).toBe(50);
  expect(TAKER_FEE_BPS).toBe(90);
  expect(FILL_HAIRCUT).toBe(0.5);
  expect(BOOK_DRAWDOWN_HALT_USD).toBe(8_000);
  expect(PAIR_LOSS_HALT_USD).toBe(500);
  expect(DAILY_LOSS_HALT_USD).toBe(900);
  expect(MAX_CONCURRENT).toBe(2);
  expect(MAX_IDEAS_WEEKDAY).toBe(3);
  expect(OVERNIGHT_RISK_CAP_USD).toBe(500);
  expect(SWING_APPROVED).toBe(false);
});

test("the search runner is exported for the cli", () => {
  expect(typeof runSearch).toBe("function");
});

test("the search report shows Jev and jev_off side by side and does not pick", () => {
  const input: SearchReportInput = {
    gridHash: "abc",
    configCount: 372,
    bounding: "bound",
    jevOffExecuted: 292,
    ranked: [],
    ineligibleTop: [],
    selected: null,
    bestJevOff: null,
    bestBreakout: null,
    foldPicks: [],
    holdoutOpenedAt: "2026-10-10T12:00:00.000Z",
    holdout: { selected: null, jevOff: null, breakout: null },
    selectedWindows: null,
    coverage: {
      capUsd: 25,
      spentUsd: 0,
      calls: 0,
      hits: 0,
      tokens: 0,
      stopped: false,
      jevConfigs: 80,
      executed: 0,
      model: JEV_MODEL_ID,
      reason: "blocked: TYPESAFE_AI_API_KEY not present",
    },
    droppedForStability: [],
  };
  const text = renderSearchReport(input);
  expect(text).toContain("best Jev");
  expect(text).toContain("best jev_off");
  expect(text).toContain("does not pick");
  expect(text).toContain("Brian decides if jev_off wins");
  expect(text).toContain("Selected config: null");
  expect(text).not.toContain("the winner is");
  expect(text).toContain("blocked: TYPESAFE_AI_API_KEY not present");
});
