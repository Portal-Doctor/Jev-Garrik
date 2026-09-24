import { expect, test } from "bun:test";
import { backtestRisk, oracleTrades, roundTripPnl, runBacktest, type Candle } from "./backtest";

const hour = (i: number, close: number, high = close, low = close): Candle => ({
  ts: i * 3_600_000,
  open: close,
  high,
  low,
  close,
  volume: 10,
});

const opts = {
  pair: "TEST-USD",
  months: 1 as const,
  windowStartTs: 0,
  barSec: 3600,
  horizonSec: 14_400,
  notionalUsd: 1_000,
  bankrollUsd: 10_000,
  makerFeeBps: 50,
  takerFeeBps: 90,
  feeBuffer: 1,
  buyThreshold: 0.6,
  sellThreshold: 0.4,
  stopLossBps: 150,
  takeProfitBps: 250,
  depthParticipation: 0.25,
  minSizeUsd: 25,
  assumedSpreadBps: 2,
};

test("UNI backtest risk is the book stop and clip, not the old SOL defaults", () => {
  const uni = backtestRisk("UNI-USD");
  expect(uni.notionalUsd).toBe(600);
  expect(uni.stopLossBps).toBe(295);
  expect(uni.takeProfitBps).toBe(1180);
  expect(uni.stopLossBps).not.toBe(150);
  expect(uni.notionalUsd).not.toBe(1_000);
});

test("oracle buys the dip and sells the rip", () => {
  const prices = [100, 80, 120, 90];
  const trades = oracleTrades(prices, 1000, 50, 90);
  expect(trades).toEqual([{ buy: 1, sell: 2 }]);
  expect(roundTripPnl(80, 120, 1000, 50, 90)).toBeCloseTo(481.5);
});

test("oracle skips a flat tape that cannot clear fees", () => {
  expect(oracleTrades([100, 100, 100, 100], 1000, 50, 90)).toEqual([]);
});

test("a signal exit pays the maker fee, a stop pays the taker fee", () => {
  const flat = runBacktest([hour(0, 100), hour(1, 100)], opts, (state) => (state.ts === 0 ? "long" : "flat"));
  expect(flat.score.trades).toBe(1);
  expect(flat.score.makerFeesUsd).toBeCloseTo(10);
  expect(flat.score.takerFeesUsd).toBeCloseTo(0);
  expect(flat.diagnostics.lowFeeNetUsd).toBeGreaterThan(flat.score.netUsd);

  const stopped = runBacktest([hour(0, 100), hour(1, 96, 100, 96)], opts, (state) => (state.ts === 0 ? "long" : "flat"));
  expect(stopped.score.takerFeesUsd).toBeGreaterThan(0);
  expect(stopped.score.makerFeesUsd).toBeCloseTo(5);
});

test("a forced long stops out and the scorecard is attached", () => {
  const candles = [hour(0, 100), hour(1, 96, 100, 96)];
  const result = runBacktest(candles, opts, (state) => (state.ts === 0 ? "long" : "flat"));
  expect(result.strategy.buys).toHaveLength(1);
  expect(result.strategy.sells).toHaveLength(1);
  expect(result.strategy.sells[0]!.price).toBeLessThan(100);
  expect(result.score.trades).toBe(1);
  expect(result.score.hitRate1s).toBeNull();
  expect(result.diagnostics.hitRate10s).toBeNull();
  expect(result.diagnostics.feeTiers.length).toBe(4);
  expect(result.score.checks.some((c) => c.status === "unscored")).toBe(true);
  expect(result.oracle.buys.length).toBe(result.oracle.sells.length);
});
