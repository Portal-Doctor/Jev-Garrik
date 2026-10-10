import { expect, test } from "bun:test";
import { SWING_APPROVED } from "./src/config";
import { btcClauseFlag, emptyClauses } from "./src/proxy";
import { buildFoldsV2, ninthOnOrAfter } from "./src/search/folds-v2";
import { applyCellDrops, assertGridCap, buildGridV2Universe, dropCell, median, validateGridV2, gridFileV2, GRID_V2_CAP } from "./src/search/grid-v2";
import { dropsBeforePnl, forwardCommand, harnessTarget } from "./src/search/execute-v2";
import { eligibilityV2, foldBeats, positiveFoldShare, scoreConfigV2, selectTestable, vetoMargin, type FoldScoreV2 } from "./src/search/rank-v2";
import { planForward } from "./src/forward-paper";
import { openHoldout } from "./src/search/holdout";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("grid v2 universe is 114 and the runner refuses more than 120", () => {
  const configs = buildGridV2Universe();
  expect(configs).toHaveLength(114);
  expect(configs.filter((cfg) => cfg.strategy === "swing_4h")).toHaveLength(16);
  expect(configs.filter((cfg) => cfg.strategy === "swing_4h" && cfg.maxHoldHours === 96)).toHaveLength(8);
  expect(configs.filter((cfg) => cfg.strategy !== "swing_4h" && cfg.strategy !== "repo_breakout_4h" && cfg.maxHoldHours === 96)).toHaveLength(0);
  expect(new Set(configs.map((cfg) => `${cfg.mode}|${cfg.formula}`))).toEqual(new Set(["POOL|atr_scaled", "SILO|equal"]));
  expect(validateGridV2(gridFileV2(configs))).toEqual([]);
  expect(GRID_V2_CAP).toBe(120);
  expect(() => assertGridCap(121)).toThrow(/refuses 121/);
});

test("6b drops a cell only when the median p50 is under 210", () => {
  expect(median([1, 3, 2, 4])).toBe(2.5);
  expect(median([])).toBeNull();
  expect(dropCell(209.9)).toBe(true);
  expect(dropCell(210)).toBe(false);
  expect(dropCell(null)).toBe(false);
  const universe = buildGridV2Universe();
  const kept = applyCellDrops(universe, ["swing_A|stop=1.5", "swing_4h|stop=1"]);
  expect(kept.some((cfg) => cfg.strategy === "swing_A" && cfg.stopAtrMult === 1.5)).toBe(false);
  expect(kept.some((cfg) => cfg.strategy === "swing_4h" && cfg.stopAtrMult === 1)).toBe(false);
  expect(kept.some((cfg) => cfg.strategy === "swing_A" && cfg.stopAtrMult === 2)).toBe(true);
  expect(universe.length - kept.length).toBe(16);
});

test("v2 folds start after a 200-day warm close and do not overlap", () => {
  const warm = Date.parse("2025-10-26T00:00:00.000Z");
  expect(new Date(ninthOnOrAfter(warm)).toISOString()).toBe("2025-11-09T00:00:00.000Z");
  const folds = buildFoldsV2(warm);
  expect(folds.length).toBe(8);
  for (let i = 0; i < folds.length; i++) {
    expect(folds[i]!.oosFrom).toBe(folds[i]!.isTo);
    if (i > 0) expect(folds[i]!.oosFrom).toBeGreaterThanOrEqual(folds[i - 1]!.oosTo);
  }
});

test("eligibility requires 60 percent of folds and select under 20 cannot win", () => {
  expect(positiveFoldShare(5, 8) >= 0.6).toBe(true);
  expect(positiveFoldShare(4, 8) >= 0.6).toBe(false);
  const fold = (net: number): FoldScoreV2 => ({
    fold: 1,
    isNetUsd: 0,
    oosNetUsd: net,
    oosTrades: 20,
    oosQualified: 20,
    isQualified: 20,
    oosMaxDrawdownUsd: 10,
    pairHalt: false,
    dailyHalt: false,
    samples: Array.from({ length: 20 }, (_, i) => ({ closeTs: 1_000 + i, stopBps: 300, targetBps: 1200, win: net > 0, rMultiple: net > 0 ? 1 : -1 })),
    entryAttempts: 20,
    entryFills: 10,
    entryTimeouts: 10,
    rejects: {},
  });
  const good = scoreConfigV2({ id: "a", strategy: "swing_combined" }, [fold(10), fold(10), fold(10), fold(10), fold(10), fold(-1), fold(-1), fold(-1)]);
  good.oosTrades = 100;
  expect(eligibilityV2(good).pass).toBe(true);
  const thin = scoreConfigV2({ id: "b", strategy: "swing_combined" }, [fold(10), fold(10), fold(10), fold(10), fold(-1), fold(-1), fold(-1), fold(-1)]);
  thin.oosTrades = 100;
  expect(eligibilityV2(thin).reasons.join(" ")).toContain("60%");
  expect(selectTestable(19).testable).toBe(false);
  expect(selectTestable(19).label).toBe("not testable on this sample");
  expect(selectTestable(20).testable).toBe(true);
});

test("jev veto needs the fold margin above that fold's cost and a higher total", () => {
  expect(foldBeats(10, 8, 1)).toBe(true);
  expect(foldBeats(10, 9, 1)).toBe(false);
  const folds = [
    { fold: 1, jevGrossUsd: 20, twinUsd: 8, costUsd: 1, marginUsd: 12, beats: true },
    { fold: 2, jevGrossUsd: 20, twinUsd: 8, costUsd: 1, marginUsd: 12, beats: true },
    { fold: 3, jevGrossUsd: 20, twinUsd: 8, costUsd: 1, marginUsd: 12, beats: true },
    { fold: 4, jevGrossUsd: 1, twinUsd: 8, costUsd: 1, marginUsd: -7, beats: false },
    { fold: 5, jevGrossUsd: 1, twinUsd: 8, costUsd: 1, marginUsd: -7, beats: false },
  ];
  const won = vetoMargin(folds, 2);
  expect(won.passShare).toBeCloseTo(0.6);
  expect(won.wins).toBe(true);
  const lost = vetoMargin(folds, 40);
  expect(lost.wins).toBe(false);
});

test("BTC clause flag trips above 40 percent of pair-days", () => {
  const under = { ...emptyClauses(), pairDays: 10, btcPairDays: 4 };
  const over = { ...emptyClauses(), pairDays: 10, btcPairDays: 5 };
  expect(btcClauseFlag(under)).toBe(false);
  expect(btcClauseFlag(over)).toBe(true);
});

test("1h target 3 is the turn-1 band and 4R stays a fixed multiple", () => {
  expect(harnessTarget("swing_combined", 3)).toBeUndefined();
  expect(harnessTarget("swing_A", 4)).toBe(4);
  expect(harnessTarget("swing_4h", 3)).toBe(3);
  expect(harnessTarget("swing_4h", 4)).toBe(4);
  expect(harnessTarget("repo_breakout_4h", null)).toBeUndefined();
});

test("drop timestamp is earlier than the first P&L, and swing stays unapproved", () => {
  expect(dropsBeforePnl("2026-10-10T12:00:00.000Z", null)).toBe(true);
  expect(dropsBeforePnl("2026-10-10T12:00:00.000Z", "2026-10-10T12:00:01.000Z")).toBe(true);
  expect(dropsBeforePnl("2026-10-10T12:00:01.000Z", "2026-10-10T12:00:00.000Z")).toBe(false);
  expect(SWING_APPROVED).toBe(false);
  const plan = planForward({ PAPERDAY_SWING_APPROVED: "true" }, null);
  expect(plan.swingApprovedConstant).toBe(false);
  expect(plan.launchSwing).toBe(true);
  expect(plan.clockStarted).toBe(false);
  expect(plan.jevStage).toBe(0);
  expect(forwardCommand()).toContain("PAPERDAY_SWING_APPROVED=true");
  expect(forwardCommand()).toContain("paperday/src/forward-paper.ts");
});

test("holdout v1 still cannot be opened a second time", () => {
  const dir = mkdtempSync(join(tmpdir(), "holdout-v2-"));
  const lock = join(dir, "holdout-open.json");
  expect(existsSync(lock)).toBe(false);
  openHoldout(lock, new Date("2026-10-10T12:36:02.935Z"), "hash");
  expect(() => openHoldout(lock, new Date(), "hash")).toThrow(/already opened/);
});
