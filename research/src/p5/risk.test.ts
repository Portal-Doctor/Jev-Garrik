import { expect, test } from "bun:test";
import { averageLinkage, assignBetas, classKillTripped, entryOpenRiskUsd, olsBeta, openRiskAfterMove, sizingCostBps } from "./risk";
import { breadthPaused, entryDecision, exitGuardFires, freshRCurve, jevReadPlan, momentumCrashOn, rolling20Paused, stepRCurve } from "./guards";

test("sizing cost is 190 and 200, and entry open risk is the risk budget", () => {
  expect(sizingCostBps(5)).toBe(190);
  expect(sizingCostBps(10)).toBe(200);
  const notional = 60 / ((1_000 + 190) / 10_000);
  expect(entryOpenRiskUsd(notional, 1_000, 190)).toBeCloseTo(60, 8);
  expect(openRiskAfterMove(1, 100, 90, 110, 5)).toBeCloseTo(10 + 110 * 0.0095, 8);
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
  expect(assignBetas([{ id: "DDD", beta: null }]).get("DDD")).toBeNull();
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
  expect(classKillTripped(0, -20, -100)).toBe(true);
  expect(classKillTripped(0, -19, -1_200)).toBe(true);
  expect(classKillTripped(0, -19, -1_199)).toBe(false);
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
  expect(entryDecision(["pause-2a"], false)).toEqual({ entries: false, riskUsd: 20 });
  expect(entryDecision(["halt"], false).entries).toBe(false);
  expect(entryDecision(["kill-switch"], true)).toEqual({ entries: true, riskUsd: 20 });
  expect(exitGuardFires({ toxicHigh: true, stressedHigh: true, consecutive: 3, unrealizedR: 1, warmed: true })).toBe(true);
  expect(exitGuardFires({ toxicHigh: true, stressedHigh: true, consecutive: 3, unrealizedR: 1.1, warmed: true })).toBe(false);
  expect(jevReadPlan(40).executed).toBe(0);
  expect(jevReadPlan(40).callsPerMonth).toBe(41 * 96 * 30);
});
