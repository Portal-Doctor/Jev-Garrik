import { expect, test } from "bun:test";
import {
  KILL_HURDLE_BPS,
  addDays,
  bhAdjusted,
  boundaryPurge,
  cents,
  deflatedSharpe,
  expectedMaxSharpe,
  foldOf,
  forwardStreamP,
  historicalFolds,
  holmAdjusted,
  killVerdict,
  meanAboveZeroP,
  mondayWeeks,
  normCdf,
  normInv,
  expandingFolds,
  HOLM_FAMILIES,
  isPrefix,
  meanHurdleBps,
  N_CUM_V31,
  netR,
  netRStreamP,
  oneSided80,
  oosSlice,
  percentileLinear,
  purgedAtBoundary,
  selectByFold,
  selectInSample,
  studentTCdf,
  tradeMoments,
  upper80Mean,
  weekKey,
} from "./stats";

test("folds follow the registered D3b dates and the purge drops an IS trade open at the boundary", () => {
  const folds = historicalFolds();
  expect(folds).toHaveLength(9);
  expect(folds[0]).toEqual({ id: "IS", start: "2025-11-10", end: "2026-02-09", sample: "IS" });
  expect(folds[1]?.start).toBe("2026-02-10");
  expect(folds[8]?.end).toBe("2026-10-09");
  expect(foldOf("2026-02-09")?.sample).toBe("IS");
  expect(foldOf("2026-02-10")?.sample).toBe("OOS");
  expect(boundaryPurge("2026-02-01", "2026-02-10")).toBe(true);
  expect(boundaryPurge("2026-02-01", "2026-02-09")).toBe(false);
  expect(boundaryPurge("2026-03-01", "2026-04-01")).toBe(false);
  expect(addDays("2026-02-10", -1)).toBe("2026-02-09");
  expect(weekKey("2026-02-11")).toBe("2026-02-09");
});

test("the kill screen uses 150 bps and n of 30", () => {
  expect(KILL_HURDLE_BPS).toBe(150);
  expect(killVerdict(29, -10, -10)).toBe("insufficient");
  expect(killVerdict(30, -1, 100)).toBe("kill");
  expect(killVerdict(30, -1, 150)).toBe("keep");
  expect(killVerdict(30, 1, 10)).toBe("keep");
});

test("normal and t helpers sit on known points", () => {
  expect(normCdf(0)).toBeCloseTo(0.5, 5);
  expect(normInv(0.9)).toBeCloseTo(1.28155156554, 4);
  expect(studentTCdf(0, 10)).toBeCloseTo(0.5, 6);
  expect(studentTCdf(1.812461, 10)).toBeCloseTo(0.95, 3);
  const p = meanAboveZeroP([1, 2, 3, 4]);
  expect(p).not.toBeNull();
  expect(p!).toBeLessThan(0.05);
});

test("Holm and BH adjusted values are monotone and capped at 1", () => {
  const holm = holmAdjusted([
    { id: "b", p: 0.04 },
    { id: "a", p: 0.01 },
    { id: "c", p: 0.03 },
  ]);
  expect(holm.map((row) => row.id)).toEqual(["a", "c", "b"]);
  expect(holm[0]?.adjusted).toBeCloseTo(0.03, 10);
  expect(holm[1]?.adjusted).toBeCloseTo(0.06, 10);
  expect(holm[2]?.adjusted).toBeCloseTo(0.06, 10);
  const bh = bhAdjusted([
    { id: "a", p: 0.01 },
    { id: "b", p: 0.04 },
    { id: "c", p: 0.03 },
  ]);
  expect(bh.every((row) => row.adjusted <= 1)).toBe(true);
  expect(bh[0]?.adjusted).toBeLessThanOrEqual(bh[1]!.adjusted);
});

test("the weekly block bootstrap is deterministic and DSR is a probability", () => {
  const values = [1, 2, -1, 4, 0, 3];
  const keys = ["2026-01-05", "2026-01-05", "2026-01-12", "2026-01-12", "2026-01-19", "2026-01-19"];
  expect(upper80Mean(values, keys, 50, 7)).toBe(upper80Mean(values, keys, 50, 7));
  const moments = tradeMoments(values);
  expect(moments).not.toBeNull();
  const dsr = deflatedSharpe({ sharpe: moments!.sharpe, nObs: moments!.n, skew: moments!.skew, kurtosis: moments!.kurtosis, nTrials: 136 });
  expect(dsr).not.toBeNull();
  expect(dsr!).toBeGreaterThanOrEqual(0);
  expect(dsr!).toBeLessThanOrEqual(1);
  expect(expectedMaxSharpe(8)).toBeGreaterThan(expectedMaxSharpe(7)!);
});

test("amendment c uses one-sided percentiles, Monday weeks, and zero weeks", () => {
  expect(percentileLinear([0, 10], 0.2)).toBeCloseTo(2, 8);
  expect(percentileLinear([0, 10], 0.8)).toBeCloseTo(8, 8);
  expect(mondayWeeks("2026-02-10", "2026-02-16")).toEqual(["2026-02-09", "2026-02-16"]);
  const bound = oneSided80([0, 0, 10], { reps: 200, seed: 7 });
  expect(bound).not.toBeNull();
  expect(bound!.zeroWeeks).toBe(2);
  expect(bound!.l80).toBeLessThan(10);
  expect(bound!.u80).toBeLessThanOrEqual(10);
  expect(bound!.l80).toBeLessThanOrEqual(bound!.u80);
  expect(oneSided80([0, 0, 10], { reps: 200, seed: 7 })).toEqual(bound);
});

test("the in-sample tie breaks on cents, then keeps registration order", () => {
  const rows = [
    { id: "A20-k2", l80: 1.004, total: 10 },
    { id: "A20-k2.5", l80: 1.001, total: 12.004 },
    { id: "A20-k3", l80: 2, total: 1 },
  ];
  expect(selectInSample(rows, (row) => row.l80, (row) => row.total).id).toBe("A20-k3");
  const tied = rows.slice(0, 2);
  expect(selectInSample(tied, (row) => row.l80, (row) => row.total).id).toBe("A20-k2.5");
  expect(cents(1.004)).toBe(cents(1.001));
  expect(selectInSample(
    [{ id: "first", l80: 1, total: 5.004 }, { id: "second", l80: 1, total: 5.001 }],
    (row) => row.l80,
    (row) => row.total,
  ).id).toBe("first");
  expect(forwardStreamP(29, 0.01)).toEqual({ p: 1, status: "not testable" });
  expect(forwardStreamP(30, 0.01)).toEqual({ p: 0.01, status: "testable" });
});

test("each fold re-selects A on its expanding in-sample prefix and purges the boundary trade", () => {
  const folds = expandingFolds();
  expect(folds).toHaveLength(8);
  expect(folds[0]).toEqual({ id: "OOS-2026-02-10", isStart: "2025-11-10", isEnd: "2026-02-09", oosStart: "2026-02-10", oosEnd: "2026-03-09" });
  expect(folds[7]?.oosEnd).toBe("2026-10-09");
  expect(purgedAtBoundary("2026-02-01", "2026-02-10", "2026-02-10")).toBe(true);
  expect(HOLM_FAMILIES.historical).toEqual({ streams: 2, firstStep: 0.025, promotes: false });
  expect(HOLM_FAMILIES.classFamily.firstStep).toBeCloseTo(0.01, 10);
  expect(HOLM_FAMILIES.jevFamily.firstStep).toBeCloseTo(0.0125, 10);
  expect(N_CUM_V31).toBe(157);
  const early = { entryDate: "2026-01-05", exitDate: "2026-01-20", netUsd: 10 };
  const crossing = { entryDate: "2026-02-01", exitDate: "2026-02-12", netUsd: 99 };
  const oos = { entryDate: "2026-02-12", exitDate: "2026-02-20", netUsd: 3 };
  expect(isPrefix([early, crossing, oos], folds[0]!)).toEqual([early]);
  expect(oosSlice([early, crossing, oos], folds[0]!)).toEqual([oos]);
  const picks = selectByFold(
    ["low", "high"],
    [folds[0]!],
    (id) => (id === "high" ? [{ ...early, netUsd: 50 }] : [early]),
    (trades) => trades.reduce((sum, trade) => sum + trade.netUsd, 0),
    (trades) => trades.reduce((sum, trade) => sum + trade.netUsd, 0),
  );
  expect(picks[0]?.chosen).toBe("high");
  expect(netR(30, 60)).toBeCloseTo(0.5, 8);
  expect(netRStreamP([1, 2]).status).toBe("not testable");
  expect(netRStreamP(Array.from({ length: 30 }, () => 1)).p).toBe(0);
  expect(meanHurdleBps([{ costBps: 190, stopBps: 100 }])).toBe(215);
  expect(meanHurdleBps([{ costBps: 190, stopBps: 200 }])).toBe(220);
});
