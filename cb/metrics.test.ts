import { expect, test } from "bun:test";
import {
  adverseAvoidance,
  breakevenRoundTripBps,
  directionalHitRate,
  evaluationChecklist,
  feeTierClears,
  hurdleProximity,
  maxDrawdown,
  netToGross,
  predictiveEdge,
  sortinoRatio,
  systemQuality,
} from "./metrics";

test("hit rate counts a long that rises and a flat that does not", () => {
  const closes = [100, 110, 110, 90];
  const long = [true, false, true];
  const hit = directionalHitRate(long, closes, 1);
  expect(hit.n).toBe(3);
  expect(hit.rate).toBeCloseTo(2 / 3);
});

test("edge ratio uses win and loss rates before fees", () => {
  const closes = [100, 110, 99];
  const long = [true, true];
  const edge = predictiveEdge(long, closes, 1);
  expect(edge.n).toBe(2);
  expect(edge.winRate).toBeCloseTo(0.5);
  expect(edge.avgWin).toBeCloseTo(1000);
  expect(edge.avgLoss).toBeCloseTo(1000);
  expect(edge.ratio).toBeCloseTo(1);
});

test("avoidance drops when a fake break is taken", () => {
  expect(adverseAvoidance(4, 1)).toBeCloseTo(0.75);
  expect(adverseAvoidance(0, 0)).toBeNull();
});

test("net to gross is net over positive gross", () => {
  expect(netToGross(60, 100)).toBeCloseTo(0.6);
  expect(netToGross(-10, -5)).toBeNull();
});

test("sortino is null when nothing falls, and positive when the path rises with a dip", () => {
  expect(sortinoRatio([100, 101, 102, 103], 3600)).toBeNull();
  const mixed = [100, 110, 90, 120, 130];
  const s = sortinoRatio(mixed, 3600);
  expect(s).not.toBeNull();
  expect(s!).toBeGreaterThan(0);
});

test("drawdown finds the trough and the bars back to the peak", () => {
  const dd = maxDrawdown([100, 120, 90, 120]);
  expect(dd.maxDrawdown).toBeCloseTo(0.25);
  expect(dd.recoveryBars).toBe(1);
});

test("system quality is zero for a zero-mean sample and high for a steady winner", () => {
  expect(systemQuality([1, -1])).toBeCloseTo(0);
  const sqn = systemQuality(Array.from({ length: 100 }, () => 2));
  expect(sqn).toBeNull();
  const noisy = Array.from({ length: 100 }, (_, i) => (i % 5 === 0 ? 1 : 3));
  expect(systemQuality(noisy)!).toBeGreaterThan(2);
});

test("checklist leaves the 1 second hit rate and maker fills unscored", () => {
  const rows = evaluationChecklist({
    hitRate1s: null,
    edge: 1.4,
    netToGross: 0.7,
    makerFillRate: null,
    sortino: 2.4,
    sqn: 2.2,
    trades: 40,
  });
  expect(rows.find((r) => r.area === "Prediction")!.status).toBe("unscored");
  expect(rows.find((r) => r.area === "Execution")!.status).toBe("unscored");
  expect(rows.find((r) => r.area === "Model edge")!.status).toBe("pass");
  expect(rows.find((r) => r.area === "Cost hurdle")!.status).toBe("pass");
  const blocked = evaluationChecklist({
    hitRate1s: null,
    edge: 1.4,
    netToGross: null,
    makerFillRate: null,
    sortino: null,
    sqn: null,
    trades: 0,
  });
  expect(blocked.find((r) => r.area === "Cost hurdle")!.status).toBe("unscored");
  expect(rows.find((r) => r.area === "Consistency")!.status).toBe("fail");
});

test("hurdle proximity keeps the closest shortfall", () => {
  const near = hurdleProximity([
    { expectedBps: 35, hurdleBps: 50 },
    { expectedBps: 10, hurdleBps: 50 },
    { expectedBps: 80, hurdleBps: 50 },
  ]);
  expect(near.refusals).toBe(2);
  expect(near.cleared).toBe(1);
  expect(near.closestGapBps).toBeCloseTo(15);
  expect(near.closest!.expectedBps).toBe(35);
});

test("breakeven round trip is median yield over the buffer, after half the spread", () => {
  expect(breakevenRoundTripBps([100, 250, 400], 2.5, 1)).toBeCloseTo(99);
});

test("fee tiers count only the yields that clear each schedule", () => {
  const tiers = feeTierClears([100, 200], [
    { name: "wide", makerBps: 50, takerBps: 90, buffer: 2.5, spreadBps: 2 },
    { name: "zero", makerBps: 0, takerBps: 0, buffer: 1, spreadBps: 2 },
  ]);
  expect(tiers[0]!.cleared).toBe(0);
  expect(tiers[1]!.cleared).toBe(2);
});
