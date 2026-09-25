import { expect, test } from "bun:test";
import { aggregate, atrNext, runBreakout, trailNext, type BreakoutOpts } from "./breakout";
import type { Candle } from "./backtest";
import type { DecisionVector } from "./gate";

const FIVE = 300_000;
const BUCKET = 48 * FIVE;

function bar(ts: number, close: number, high = close, low = close, open = close): Candle {
  return { ts, open, high, low, close, volume: 1 };
}

function bucket(index: number, close: number, high = close, low = close): Candle[] {
  const start = index * BUCKET;
  const out: Candle[] = [];
  for (let i = 0; i < 48; i++) out.push(bar(start + i * FIVE, close, high, low, close));
  return out;
}

const clearVector: DecisionVector = {
  market_regime: "expansion",
  direction_bias: "flat",
  toxic_flow_risk: "low",
  liquidity_stress: "normal",
  confidence: 0.4,
  toxicPHigh: 0,
  stressPStressed: 0,
};

function opts(over: Partial<BreakoutOpts> = {}): BreakoutOpts {
  return {
    pair: "TEST-USD",
    windowStartTs: 0,
    barSec: 300,
    notionalUsd: 1_000,
    bankrollUsd: 10_000,
    makerFeeBps: 50,
    takerFeeBps: 90,
    stopLossBps: 100,
    minSizeUsd: 25,
    breakoutBars: 20,
    trendEmaBars: 50,
    atrBars: 14,
    trailAtr: 3,
    maxHoldSec: 1_209_600,
    classify: () => ({ vector: clearVector }),
    ...over,
  };
}

test("aggregate builds one 4 hour bar from 48 five minute bars and drops a partial bucket", () => {
  const bars: Candle[] = [];
  for (let i = 0; i < 48; i++) {
    bars.push(bar(i * FIVE, 100 + i, 100 + i + 2, 100 + i - 1, 100 + i - 0.5));
  }
  bars.push(bar(48 * FIVE, 999, 1000, 998, 999));
  const out = aggregate(bars, 14_400);
  expect(out).toHaveLength(1);
  expect(out[0]!.open).toBe(99.5);
  expect(out[0]!.high).toBe(149);
  expect(out[0]!.low).toBe(99);
  expect(out[0]!.close).toBe(147);
  expect(out[0]!.volume).toBe(48);
});

test("a spike inside an open bucket does not enter until a later bucket closes above the high", () => {
  const bars = [...Array.from({ length: 60 }, (_, i) => bucket(i, 100)).flat()];
  const spike = bucket(60, 100);
  spike[10] = { ...spike[10]!, high: 180, close: 100 };
  bars.push(...spike);
  bars.push(...bucket(61, 100));
  const quiet = runBreakout(bars, opts());
  expect(quiet.buys).toHaveLength(0);

  bars.push(...bucket(62, 190, 190, 190));
  const fill = bucket(63, 189, 189, 188);
  bars.push(...fill);
  const entered = runBreakout(bars, opts());
  expect(entered.buys).toHaveLength(1);
  expect(entered.buys[0]!.ts).toBe(63 * BUCKET);
  expect(entered.buys[0]!.ts).toBeGreaterThan(61 * BUCKET);
});

test("a close above the 20 bar high but under the 50 bar EMA does not enter", () => {
  const bars = [
    ...Array.from({ length: 30 }, (_, i) => bucket(i, 200)).flat(),
    ...Array.from({ length: 20 }, (_, i) => bucket(30 + i, 100)).flat(),
    ...bucket(50, 110),
    ...bucket(51, 110),
  ];
  const result = runBreakout(bars, opts());
  expect(result.buys).toHaveLength(0);
  expect(result.vetoedEntries).toBe(0);
  expect(result.missedEntries).toBe(0);
});

test("toxic, stressed, and contraction each refuse a valid breakout", () => {
  const bars = [
    ...Array.from({ length: 60 }, (_, i) => bucket(i, 100)).flat(),
    ...bucket(60, 130),
    ...bucket(61, 129, 129, 128),
  ];
  for (const vector of [
    { ...clearVector, toxic_flow_risk: "high" as const },
    { ...clearVector, liquidity_stress: "stressed" as const },
    { ...clearVector, market_regime: "contraction" as const },
  ]) {
    const result = runBreakout(bars, opts({ classify: () => ({ vector }) }));
    expect(result.vetoedEntries).toBe(1);
    expect(result.buys).toHaveLength(0);
    expect(result.missedEntries).toBe(0);
  }
});

test("a post-only entry misses when the next bar stays above the limit", () => {
  const bars = [
    ...Array.from({ length: 60 }, (_, i) => bucket(i, 100)).flat(),
    ...bucket(60, 130),
    ...bucket(61, 140, 141, 131),
  ];
  const result = runBreakout(bars, opts());
  expect(result.missedEntries).toBe(1);
  expect(result.buys).toHaveLength(0);
});

test("the trail only rises when ATR falls after a new high", () => {
  const raised = trailNext(100, 140, 10, 3);
  expect(raised).toBe(110);
  const tighter = trailNext(raised, 140, 2, 3);
  expect(tighter).toBeGreaterThan(raised);
  expect(trailNext(tighter, 140, 30, 3)).toBe(tighter);
  const bar = { ts: 0, open: 10, high: 12, low: 9, close: 11, volume: 1 };
  expect(atrNext(10, bar, 10, 14)).toBeCloseTo((10 * 13 + 3) / 14, 6);
});

test("a gap through the stop fills at the bar open", () => {
  const bars = [
    ...Array.from({ length: 60 }, (_, i) => bucket(i, 100)).flat(),
    ...bucket(60, 130),
  ];
  const next = bucket(61, 129, 129, 128);
  next[1] = { ...next[1]!, open: 100, high: 100, low: 90, close: 95 };
  bars.push(...next);
  const result = runBreakout(bars, opts({ stopLossBps: 100 }));
  expect(result.buys).toHaveLength(1);
  expect(result.sells).toHaveLength(1);
  expect(result.sells[0]!.price).toBe(100);
});

test("entry pays the maker fee and the stop pays the taker fee, and 10/10 replays those fills", () => {
  const bars = [
    ...Array.from({ length: 60 }, (_, i) => bucket(i, 100)).flat(),
    ...bucket(60, 130),
  ];
  const next = bucket(61, 129, 129, 128);
  next[1] = { ...next[1]!, open: 100, high: 100, low: 90, close: 95 };
  bars.push(...next);
  const result = runBreakout(bars, opts({ makerFeeBps: 50, takerFeeBps: 90, notionalUsd: 1_000 }));
  const units = 1_000 / 130;
  const exitFee = units * 100 * 0.009;
  expect(result.feesUsd).toBeCloseTo(1_000 * 0.005 + exitFee, 6);
  expect(result.lowFeeNetUsd).toBeGreaterThan(result.returnUsd);

  const held = [
    ...Array.from({ length: 55 }, (_, i) => bucket(i, 100, 110, 90)).flat(),
    ...bucket(55, 130, 130, 130),
    ...bucket(56, 129, 131, 128),
  ];
  const maxHold = runBreakout(held, opts({ stopLossBps: 5_000, maxHoldSec: 300, makerFeeBps: 50, takerFeeBps: 90 }));
  expect(maxHold.buys).toHaveLength(1);
  expect(maxHold.sells).toHaveLength(1);
  const holdUnits = 1_000 / 130;
  const holdExit = holdUnits * maxHold.sells[0]!.price * 0.009;
  expect(maxHold.feesUsd).toBeCloseTo(1_000 * 0.005 + holdExit, 4);
  expect(maxHold.lowFeeNetUsd).not.toBe(maxHold.returnUsd);
});
