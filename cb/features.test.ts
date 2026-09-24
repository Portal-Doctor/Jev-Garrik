import { test, expect } from "bun:test";
import { PairBook } from "./feed";
import {
  EMA_FAST,
  EMA_SLOW,
  FeatureAccumulator,
  RSI_PERIOD,
  Welford,
  emaNext,
  levelImbalance,
  parkinsonVolBps,
  rsiNext,
  topImbalance,
} from "./features";
import { buildState } from "./state";

test("top 5 and top 20 imbalance use (bidQty - askQty) / (bidQty + askQty)", () => {
  expect(levelImbalance(150, 50)).toBeCloseTo(0.5);
  expect(levelImbalance(50, 150)).toBeCloseTo(-0.5);
  expect(levelImbalance(0, 0)).toBe(0);

  const book = new PairBook();
  // Top 5: bids 50 vs asks 150 -> -0.5. Deeper bids then overwhelm the top 20.
  for (let i = 0; i < 5; i++) book.set("bid", 100 - i, 10);
  for (let i = 5; i < 20; i++) book.set("bid", 100 - i, 100);
  for (let i = 0; i < 5; i++) book.set("offer", 101 + i, 30);
  for (let i = 5; i < 20; i++) book.set("offer", 101 + i, 10);

  const bids = book.bidsDesc();
  const asks = book.asksAsc();
  expect(topImbalance(bids, asks, 5)).toBeCloseTo(-0.5);
  const bid20 = 5 * 10 + 15 * 100;
  const ask20 = 5 * 30 + 15 * 10;
  expect(topImbalance(bids, asks, 20)).toBeCloseTo((bid20 - ask20) / (bid20 + ask20));

  const acc = new FeatureAccumulator();
  acc.onBook(0, book);
  const snap = acc.snapshot(14_400);
  expect(snap.imbalance5).toBeCloseTo(-0.5);
  expect(snap.imbalance20).toBeCloseTo((bid20 - ask20) / (bid20 + ask20));
});

test("Welford sample variance and horizon scaling", () => {
  const w = new Welford();
  w.push(1);
  w.push(2);
  w.push(3);
  expect(w.variance()).toBeCloseTo(1);
  expect(w.stdev()).toBeCloseTo(1);
});

test("Parkinson vol scales a 1 minute high-low candle to the horizon", () => {
  const x = Math.log(110 / 100);
  const bps = parkinsonVolBps(x * x, 1, 60);
  const perMin = Math.sqrt((x * x) / (4 * Math.LN2));
  expect(bps).toBeCloseTo(perMin * 10_000, 6);
  expect(parkinsonVolBps(x * x, 1, 14_400)).toBeCloseTo(perMin * Math.sqrt(14_400 / 60) * 10_000, 4);
});

test("EMA and RSI recurrences match the time-clock formulas", () => {
  let fast: number | null = null;
  let slow: number | null = null;
  for (let i = 0; i < 5; i++) {
    fast = emaNext(fast, 10, EMA_FAST);
    slow = emaNext(slow, 10, EMA_SLOW);
  }
  expect(fast).toBeCloseTo(10);
  expect(slow).toBeCloseTo(10);
  fast = emaNext(fast, 20, EMA_FAST);
  slow = emaNext(slow, 20, EMA_SLOW);
  expect(fast).toBeGreaterThan(slow!);

  let avgGain = 0;
  let avgLoss = 0;
  let samples = 0;
  let prev = 100;
  let rsi: number | null = null;
  for (let i = 1; i <= RSI_PERIOD; i++) {
    const close = 100 + i;
    const next = rsiNext(prev, close, avgGain, avgLoss, samples, RSI_PERIOD);
    avgGain = next.avgGain;
    avgLoss = next.avgLoss;
    samples = next.samples;
    rsi = next.rsi;
    prev = close;
  }
  expect(samples).toBe(RSI_PERIOD);
  expect(rsi).toBe(100);
});

test("the accumulator closes EMA on the minute and samples vol once per second", () => {
  const book = new PairBook();
  book.set("bid", 100, 5);
  book.set("offer", 100.1, 5);
  const acc = new FeatureAccumulator();
  acc.onBook(0, book);
  book.set("bid", 101, 5);
  book.set("offer", 101.1, 5);
  acc.onBook(60_000, book);
  const snap = acc.snapshot(60);
  expect(snap.emaFast).toBeCloseTo(100.05);
  expect(snap.parkinsonBps).toBe(0);
  expect(snap.volBps).toBe(0);

  book.set("bid", 102, 5);
  book.set("offer", 102.2, 5);
  acc.onBook(61_000, book);
  expect(acc.snapshot(60).volBps).toBeGreaterThan(0);
});

test("model payload stays inside the 400 token budget", () => {
  const book = new PairBook();
  book.set("bid", 180.25, 12.5);
  book.set("offer", 180.3, 9.25);
  const acc = new FeatureAccumulator();
  acc.onBook(1_700_000_000_000, book);
  acc.onTrade(1_700_000_000_000, 4.5, "buy");
  acc.onTrade(1_700_000_000_000, 1.25, "sell");
  const state = buildState(
    {
      book: () => book,
      returnBps: () => 12.34,
      featureSnapshot: (_pair, horizonSec) => acc.snapshot(horizonSec),
    },
    "SOL-USD",
    "long",
    { horizonSec: 14_400, makerFeeBps: 50, takerFeeBps: 90 },
    1_700_000_000_000,
  );
  expect(state).not.toBeNull();
  const json = JSON.stringify(state);
  expect(json.length).toBeLessThan(1600);
  expect(json.includes("recentMids")).toBe(false);
  expect(state!.imbalance5).toBeCloseTo(levelImbalance(12.5, 9.25));
});
