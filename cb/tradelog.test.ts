import { expect, test } from "bun:test";
import { runBacktest, type Candle } from "./backtest";
import { runBreakout } from "./breakout";

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

test("the fixed-target trade log records both notional legs and the net of each round trip", () => {
  // A 10% bar trades through the 250 bps target, so the exit leg is the target, not the close.
  const result = runBacktest([hour(0, 100), hour(1, 110)], opts, (state) => (state.ts === 0 ? "long" : "flat"));
  expect(result.fixedTradeLog).toHaveLength(1);
  const t = result.fixedTradeLog[0]!;
  expect(t.openedTs).toBe(0);
  expect(t.closedTs).toBe(3_600_000);
  const entryPx = 100 * (1 + 50 / 10_000);
  const takePx = entryPx * (1 + 250 / 10_000);
  expect(t.entryNotionalUsd).toBeCloseTo(1_000);
  expect(t.exitNotionalUsd).toBeCloseTo((1_000 / 100) * takePx);
  expect(t.netUsd).toBeCloseTo(result.score.netUsd);
});

test("the trade log nets sum to the scored net across several round trips", () => {
  const candles = [hour(0, 100), hour(1, 96, 100, 96), hour(2, 100), hour(3, 94, 100, 94)];
  const result = runBacktest(candles, opts, (state) => (state.ts % 7_200_000 === 0 ? "long" : "flat"));
  expect(result.fixedTradeLog.length).toBe(result.score.trades);
  const summed = result.fixedTradeLog.reduce((s, t) => s + t.netUsd, 0);
  expect(summed).toBeCloseTo(result.score.netUsd);
});

test("an open position at the end of the tape is not in the trade log", () => {
  const result = runBacktest([hour(0, 100), hour(1, 101)], opts, () => "long");
  expect(result.fixedTradeLog).toHaveLength(0);
});

test("the breakout trade log nets sum to the book return", () => {
  const candles: Candle[] = [];
  let ts = 0;
  const push = (close: number, high = close, low = close) => {
    candles.push({ ts, open: close, high, low, close, volume: 10 });
    ts += 300_000;
  };
  // Long enough to warm the 4 hour EMA and ATR, rising so a Donchian break fires.
  for (let i = 0; i < 1_200; i++) push(100 + i * 0.05, 100 + i * 0.05 + 0.5, 100 + i * 0.05 - 0.5);
  // A sharp drop trips the trailing stop and closes the round trip.
  for (let i = 0; i < 100; i++) push(120 - i * 0.6, 120 - i * 0.6 + 0.5, 120 - i * 0.6 - 0.5);

  const bo = runBreakout(candles, {
    pair: "TEST-USD",
    windowStartTs: 0,
    barSec: 300,
    notionalUsd: 600,
    bankrollUsd: 2_000,
    makerFeeBps: 50,
    takerFeeBps: 90,
    stopLossBps: 300,
    minSizeUsd: 25,
    breakoutBars: 20,
    trendEmaBars: 50,
    atrBars: 14,
    trailAtr: 3,
    maxHoldSec: 1_209_600,
  });
  expect(bo.tradeLog.length).toBe(bo.trades);
  if (bo.trades > 0) {
    for (const t of bo.tradeLog) {
      expect(t.closedTs).toBeGreaterThan(t.openedTs);
      expect(t.entryNotionalUsd).toBeGreaterThan(0);
      expect(t.exitNotionalUsd).toBeGreaterThan(0);
    }
  }
});
