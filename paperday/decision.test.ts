import { expect, test } from "bun:test";
import { SWING_APPROVED } from "./src/config";
import { classExpectancy, pStar, pStarAccepts } from "./src/expectancy";
import { F_LOSS_BPS, F_WIN_BPS, perTradeFloor, roundTripBps } from "./src/fees";
import { quarterNeeds, requiredGate, targetGate } from "./src/gate";
import { runBreakoutPaper } from "./src/higher";
import { lossToStopUsd, overnightAllows, swingEntryAllowed, swingStop, swingTarget } from "./src/swing";

test("round trip is 100 bps on a maker target and 140 bps on a taker exit", () => {
  expect(F_WIN_BPS).toBe(100);
  expect(F_LOSS_BPS).toBe(140);
  expect(roundTripBps("target")).toBe(100);
  expect(roundTripBps("stop")).toBe(140);
  expect(roundTripBps("market")).toBe(140);
});

test("per-trade floor and Trader p* examples", () => {
  expect(perTradeFloor(150, 450).pass).toBe(false);
  expect(perTradeFloor(500, 1500).pass).toBe(true);
  expect(Math.round(pStar(150, 450) * 100)).toBe(52);
  expect(pStarAccepts(150, 450)).toBe(false);
  expect(Math.round(pStar(500, 1500) * 100)).toBe(33);
  expect(pStarAccepts(500, 1500)).toBe(true);
  expect(pStar(150, 450)).toBeCloseTo(290 / 560, 8);
  expect(pStar(500, 1500)).toBeCloseTo(640 / 1960, 8);
});

test("walk-forward expectancy needs two positive out-of-sample splits", () => {
  const wins = Array.from({ length: 9 }, (_, i) => ({
    closeTs: 1_700_000_000_000 + i * 86_400_000,
    stopBps: 500,
    targetBps: 1500,
    win: true,
    rMultiple: 2,
  }));
  const good = classExpectancy(wins);
  expect(good.pStarPass).toBe(true);
  expect(good.positiveSplits).toBe(3);
  expect(good.pass).toBe(true);
  const losses = wins.map((t) => ({ ...t, win: false, rMultiple: -1 }));
  expect(classExpectancy(losses).pass).toBe(false);
  expect(classExpectancy([]).pass).toBe(false);
});

test("target gate prorates a mid-quarter window and fails an empty full quarter", () => {
  const from = Date.parse("2026-07-01T00:00:00.000Z");
  const to = Date.parse("2026-08-15T00:00:00.000Z");
  const needs = quarterNeeds(from, to);
  expect(needs).toHaveLength(1);
  expect(needs[0]?.quarter).toBe("2026Q3");
  expect(needs[0]?.full).toBe(false);
  expect(needs[0]?.daysOverlap).toBeCloseTo(45, 6);
  const need = 1_200 * (45 / 92);
  expect(
    targetGate({
      paceUsd: 0,
      fromMs: from,
      toMs: to,
      netUsd: need,
      quarters: [{ quarter: "2026Q3", netUsd: need }],
    }).pass,
  ).toBe(true);
  expect(
    targetGate({
      paceUsd: 0,
      fromMs: from,
      toMs: to,
      netUsd: need,
      quarters: [{ quarter: "2026Q3", netUsd: need - 0.02 }],
    }).pass,
  ).toBe(false);

  const wideFrom = Date.parse("2026-04-01T00:00:00.000Z");
  const wideTo = Date.parse("2026-10-01T00:00:00.000Z");
  const empty = targetGate({
    paceUsd: 0,
    fromMs: wideFrom,
    toMs: wideTo,
    netUsd: 5_000,
    quarters: [{ quarter: "2026Q3", netUsd: 5_000 }],
  });
  expect(empty.pass).toBe(false);
  expect(empty.reasons.some((r) => r.includes("2026Q2") && r.includes("full"))).toBe(true);
  const required = requiredGate({
    window: "6m",
    netUsd: 1,
    maxDrawdownUsd: 10,
    trades: 100,
    expectancyPass: true,
    pairHaltBreached: false,
    dailyHaltBreached: false,
    research: false,
  });
  expect(required.pass).toBe(true);
  expect(required.reasons.some((r) => r.includes("Q2"))).toBe(false);
});

test("min trade counts are 12, 40, and 100", () => {
  expect(requiredGate({
    window: "3m",
    netUsd: 1,
    maxDrawdownUsd: 1,
    trades: 39,
    expectancyPass: true,
    pairHaltBreached: false,
    dailyHaltBreached: false,
    research: false,
  }).sample).toBe("insufficient_sample");
  expect(requiredGate({
    window: "3m",
    netUsd: 1,
    maxDrawdownUsd: 1,
    trades: 40,
    expectancyPass: true,
    pairHaltBreached: false,
    dailyHaltBreached: false,
    research: false,
  }).sample).toBe("eligible");
  expect(requiredGate({
    window: "6m",
    netUsd: 1,
    maxDrawdownUsd: 1,
    trades: 99,
    expectancyPass: true,
    pairHaltBreached: false,
    dailyHaltBreached: false,
    research: false,
  }).pass).toBe(false);
  expect(requiredGate({
    window: "6m",
    netUsd: 1,
    maxDrawdownUsd: 1,
    trades: 100,
    expectancyPass: true,
    pairHaltBreached: false,
    dailyHaltBreached: false,
    research: false,
  }).pass).toBe(true);
});

test("swing stop is the wider of the swing low and 2x ATR, and the target stays inside 2.5R to 4R", () => {
  const bySwing = swingStop(100, 90, 3);
  expect(bySwing?.stop).toBe(90);
  const byAtr = swingStop(100, 98, 3);
  expect(byAtr?.stop).toBe(94);
  expect(swingStop(100, null, 3)).toBeNull();
  expect(swingStop(100, 101, 3)).toBeNull();
  expect(swingTarget(100, 90, 130)).toBe(130);
  expect(swingTarget(100, 90, 150)).toBe(140);
  expect(swingTarget(100, 90, 110)).toBe(125);
  expect(swingTarget(100, 90, null)).toBe(125);
});

test("overnight risk cap is $500 and forward swing stays unapproved", () => {
  expect(overnightAllows(400, 100)).toBe(true);
  expect(overnightAllows(400, 100.01)).toBe(false);
  expect(overnightAllows(0, 500)).toBe(true);
  expect(lossToStopUsd(100, 95, 10)).toBe(50);
  expect(SWING_APPROVED).toBe(false);
  expect(swingEntryAllowed(false)).toBe(false);
  expect(swingEntryAllowed(true)).toBe(true);
});

test("repo breakout uses the book take-profit and this sparse tape does not fill", async () => {
  const start = Date.parse("2026-04-01T00:00:00.000Z");
  const bars = Array.from({ length: 80 }, (_, i) => {
    const close = 100 + i;
    return {
      ts: start + i * 14_400_000,
      open: close - 0.4,
      high: close + 0.5,
      low: close - 0.6,
      close,
      volume: 10,
    };
  });
  const result = await runBreakoutPaper({
    candles: { "UNI-USD": bars },
    fromMs: start,
    toMs: start + 80 * 14_400_000,
    mode: "POOL",
    formula: "equal",
    strategy: "repo_breakout_4h",
    sentimentMode: "sentiment_blind",
    proxy: null,
    swingApproved: true,
    enabledPairs: ["UNI-USD"],
    variant: "jev_off",
  });
  expect(result.trades).toBe(0);
  expect(result.rejects.below_fee_floor ?? 0).toBe(0);
  expect(result.qualified).toBeGreaterThan(0);
  expect(result.netUsd).toBe(0);
});
