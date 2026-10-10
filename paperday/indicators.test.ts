import { expect, test } from "bun:test";
import {
  atrSeries,
  donchianPriorHigh,
  emaSeries,
  EmaState,
  indicatorSeries,
  macdSeries,
  rsiSeries,
  sessionVwapSeries,
  trueRange,
  type Ohlcv,
} from "./src/indicators";

function barsFromCloses(closes: number[], volume = 10): Ohlcv[] {
  return closes.map((close, i) => ({
    ts: Date.parse("2026-06-01T14:00:00.000Z") + i * 60_000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume,
  }));
}

test("SMA-seeded EMA matches the hand calculation", () => {
  const series = emaSeries([1, 2, 3, 4, 5], 3);
  expect(series[0]).toBeNull();
  expect(series[1]).toBeNull();
  expect(series[2]).toBeCloseTo(2, 8);
  expect(series[3]).toBeCloseTo(3, 8);
  expect(series[4]).toBeCloseTo(4, 8);
});

test("incremental EMA matches the batch EMA", () => {
  const values = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5];
  const batch = emaSeries(values, 4);
  const state = new EmaState(4);
  values.forEach((v, i) => {
    expect(state.push(v)).toEqual(batch[i] ?? null);
  });
});

test("Wilder RSI is 100 on a strictly rising series and 0 on a strictly falling series", () => {
  const up = rsiSeries(Array.from({ length: 20 }, (_, i) => 10 + i), 14);
  const down = rsiSeries(Array.from({ length: 20 }, (_, i) => 50 - i), 14);
  expect(up[14]).toBe(100);
  expect(down[14]).toBe(0);
  expect(up[13]).toBeNull();
});

test("ATR uses Wilder smoothing of true range", () => {
  const bars = barsFromCloses([10, 10, 10, 10, 10]);
  expect(trueRange(11, 9, 10)).toBe(2);
  const atr = atrSeries(bars, 3);
  expect(atr[2]).toBeCloseTo(2, 8);
  expect(atr[4]).toBeCloseTo(2, 8);
});

test("MACD is the fast EMA minus the slow EMA", () => {
  const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3));
  const macd = macdSeries(closes, 12, 26, 9);
  const fast = emaSeries(closes, 12);
  const slow = emaSeries(closes, 26);
  expect(macd.macd[25]).toBeCloseTo(fast[25]! - slow[25]!, 8);
  expect(macd.signal[25]).toBeNull();
  expect(macd.signal[33]).not.toBeNull();
  expect(macd.hist[33]).toBeCloseTo(macd.macd[33]! - macd.signal[33]!, 8);
});

test("session VWAP is hlc3 and resets on the Chicago date", () => {
  const late = Date.parse("2026-10-07T04:30:00.000Z");
  const early = Date.parse("2026-10-07T05:30:00.000Z");
  const bars: Ohlcv[] = [
    { ts: late, open: 10, high: 12, low: 8, close: 10, volume: 2 },
    { ts: early, open: 20, high: 20, low: 14, close: 20, volume: 2 },
  ];
  const vwap = sessionVwapSeries(bars);
  expect(vwap[0]).toBeCloseTo((12 + 8 + 10) / 3, 8);
  expect(vwap[1]).toBeCloseTo((20 + 14 + 20) / 3, 8);
});

test("Donchian prior high excludes the current bar", () => {
  const bars = barsFromCloses([1, 2, 3, 4, 5]);
  bars[3]!.high = 50;
  bars[4]!.high = 1;
  expect(donchianPriorHigh(bars, 4, 3)).toBe(50);
  expect(donchianPriorHigh(bars, 2, 3)).toBeNull();
});

test("indicator parity across 2 pairs and 4 timeframes has no lookahead", () => {
  const pairs = ["UNI-USD", "NEAR-USD"];
  const timeframes = [60_000, 300_000, 14_400_000, 86_400_000];
  for (const pair of pairs) {
    for (const step of timeframes) {
      const closes = Array.from({ length: 80 }, (_, i) => 100 + (pair === "UNI-USD" ? 1 : -1) * Math.sin(i / 5) + i * 0.01);
      const bars: Ohlcv[] = closes.map((close, i) => ({
        ts: Date.parse("2026-06-01T00:00:00.000Z") + i * step,
        open: close - 0.2,
        high: close + 0.4,
        low: close - 0.5,
        close,
        volume: 100 + (i % 7),
      }));
      const full = indicatorSeries(bars);
      const ema = emaSeries(closes, 9);
      const rsi = rsiSeries(closes, 14);
      const atr = atrSeries(bars, 14);
      expect(full).toHaveLength(80);
      expect(full[20]?.ema9).toBeCloseTo(ema[20]!, 8);
      expect(full[20]?.rsi14).toBeCloseTo(rsi[20]!, 8);
      expect(full[20]?.atr14).toBeCloseTo(atr[20]!, 8);
      const cut = indicatorSeries(bars.slice(0, 21));
      expect(cut[20]?.ema9).toBeCloseTo(full[20]!.ema9!, 8);
      expect(cut[20]?.rsi14).toBeCloseTo(full[20]!.rsi14!, 8);
      expect(cut[20]?.donchian20PriorHigh).toBe(full[20]?.donchian20PriorHigh ?? null);
      expect(cut[20]?.vwap).toBeCloseTo(full[20]!.vwap!, 8);
    }
  }
});
