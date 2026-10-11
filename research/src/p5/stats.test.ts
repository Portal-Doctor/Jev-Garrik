import { expect, test } from "bun:test";
import {
  KILL_HURDLE_BPS,
  addDays,
  bhAdjusted,
  boundaryPurge,
  deflatedSharpe,
  expectedMaxSharpe,
  foldOf,
  historicalFolds,
  holmAdjusted,
  killVerdict,
  meanAboveZeroP,
  normCdf,
  normInv,
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
