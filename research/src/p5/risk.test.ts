import { expect, test } from "bun:test";
import { averageLinkage, assignBetas, classKillTripped, entryOpenRiskUsd, olsBeta, openRiskAfterMove, sizingCostBps } from "./risk";
import { breadthByEntryDate, breadthNetRSplit, breadthPaused, entryDecision, exitGuardFires, freshRCurve, jevReadPlan, momentumCrashOn, rolling20Paused, sprtReport, stepRCurve } from "./guards";

test("sizing cost is 190 and 200, and entry open risk is the risk budget", () => {
  expect(sizingCostBps(5)).toBe(190);
  expect(sizingCostBps(10)).toBe(200);
  const notional = 60 / ((1_000 + 190) / 10_000);
  expect(entryOpenRiskUsd(notional, 1_000, 190)).toBeCloseTo(60, 8);
  expect(openRiskAfterMove(1, 100, 90, 5)).toBeCloseTo(10 + 90 * 0.0095, 8);
});

test("OLS beta of a unit series is 1, and a short name takes the highest signed beta", () => {
  const bench = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.01));
  expect(olsBeta(bench, bench)).toBeCloseTo(1, 8);
  expect(olsBeta(bench.map((value) => -value), bench)).toBeCloseTo(-1, 8);
  const assigned = assignBetas([
    { id: "AAA", beta: 0.4 },
    { id: "BBB", beta: -0.2 },
    { id: "CCC", beta: null },
  ]);
  expect(assigned.get("CCC")).toBe(0.4);
  expect(assignBetas([{ id: "DDD", beta: null }]).get("DDD")).toBe(1);
});

test("average linkage keeps a negative series out and merges the pair with the higher rho", () => {
  const rho = (left: string, right: string) => {
    if (left === "C" || right === "C") return -0.2;
    return 0.9;
  };
  const clusters = averageLinkage(["B", "A", "C"], rho);
  expect(clusters.get("A")).toBe(clusters.get("B"));
  expect(clusters.get("C")).not.toBe(clusters.get("A"));
});

test("the 20R kill and the dollar backstop both trip", () => {
  expect(classKillTripped(0, -20, 0, -100)).toBe(true);
  expect(classKillTripped(0, -19, 0, -1_200)).toBe(true);
  expect(classKillTripped(0, -19, 500, -700)).toBe(true);
  expect(classKillTripped(0, -19, 0, -1_199)).toBe(false);
});

test("forward pauses shrink or block and do not call Jev", () => {
  expect(breadthPaused(0.2, false)).toBe(true);
  expect(breadthPaused(0.3, true)).toBe(true);
  expect(breadthPaused(0.36, true)).toBe(false);
  expect(momentumCrashOn(-0.25, 0.15)).toBe(true);
  expect(momentumCrashOn(-0.2, 0.2)).toBe(false);
  expect(rolling20Paused(Array(20).fill(-0.25))).toBe(true);
  expect(rolling20Paused(Array(19).fill(-1))).toBe(false);
  const killed = stepRCurve(freshRCurve(), -20);
  expect(killed.killed).toBe(true);
  expect(entryDecision(["pause-1b"], false)).toEqual({ entries: true, riskUsd: 20 });
  expect(entryDecision(["pause-2b"], false)).toEqual({ entries: false, riskUsd: 20 });
  expect(entryDecision(["pause-2a"], false)).toEqual(entryDecision([], false));
  expect(entryDecision(["pause-2a"], true)).toEqual(entryDecision([], true));
  expect(entryDecision(["halt"], false).entries).toBe(false);
  expect(entryDecision(["kill-switch"], true)).toEqual({ entries: false, riskUsd: 20 });
  expect(entryDecision(["r-kill"], true).entries).toBe(false);
  expect(entryDecision(["backstop"], true).entries).toBe(false);
  const sprt = sprtReport([0.2, -0.1, 0.4, -0.2, 0.1, -0.3, 0.2, -0.1]);
  expect(sprt.pauses).toBe(false);
  expect(sprt.reportOnly).toBe(true);
  expect(sprt.upper).toBeCloseTo(Math.log(4), 8);
  expect(sprt.fixedSigma).toBe(1.5);
  expect(sprt.llrFixed).not.toBeNull();
  expect(sprt.llrRealized).not.toBeNull();
  const labels = breadthByEntryDate(["2026-01-01", "2026-01-02"], () => [{ member: true, close: 1, ema50: 2 }]);
  expect(labels.get("2026-01-01")).toBe("off");
  expect(breadthNetRSplit([{ breadth: "on", netR: 1 }, { breadth: "off", netR: -2 }])).toEqual({
    label: "diagnostic, no selection",
    selects: false,
    on: { n: 1, sumNetR: 1 },
    off: { n: 1, sumNetR: -2 },
  });
  expect(exitGuardFires({ toxicHigh: true, stressedHigh: true, consecutive: 3, unrealizedR: 1, warmed: true })).toBe(true);
  expect(exitGuardFires({ toxicHigh: true, stressedHigh: true, consecutive: 3, unrealizedR: 1.1, warmed: true })).toBe(false);
  expect(jevReadPlan(40).executed).toBe(0);
  expect(jevReadPlan(40).callsPerMonth).toBe(41 * 96 * 30);
});
