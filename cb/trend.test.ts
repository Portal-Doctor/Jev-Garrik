import { expect, test } from "bun:test";
import { msUntilRefresh, trendFromHourlies, type TrendAnswer } from "./trend";
import type { Candle } from "./backtest";

const HOUR = 3_600_000;
const FOUR = 14_400_000;

function hour(ts: number, close: number, high = close, low = close): Candle {
  return { ts, open: close, high, low, close, volume: 1 };
}

function hours(count: number, start: number, closeAt: (i: number) => number): Candle[] {
  return Array.from({ length: count }, (_, i) => hour(start + i * HOUR, closeAt(i)));
}

function up(answer: TrendAnswer): void {
  expect(answer.known).toBe(true);
  expect(answer.up).toBe(true);
}

test("trendUp ignores a running 4 hour bucket, and a spike inside it does not flip the answer", () => {
  const start = 1_700_000_000_000;
  const aligned = Math.floor(start / FOUR) * FOUR;
  const rising = hours(7 * 4 + 2, aligned, (i) => 100 + i);
  const closedAt = aligned + (7 * 4 + 2) * HOUR;
  const before = trendFromHourlies(rising, 50, closedAt);
  up(before);

  const spikeTs = aligned + (7 * 4 + 2) * HOUR;
  const withSpike = [...rising, hour(spikeTs, 10_000, 10_000, 10_000)];
  const during = trendFromHourlies(withSpike, 50, spikeTs + 30 * 60_000);
  expect(during.known).toBe(before.known);
  expect(during.up).toBe(before.up);
  expect(during.lastClose).toBe(before.lastClose);
});

test("a completed 4 hour close above the EMA with a positive 24 hour return is up", () => {
  const start = Math.floor(1_700_000_000_000 / FOUR) * FOUR;
  const bars = hours(80, start, (i) => 100 + i * 0.5);
  const now = start + 80 * HOUR;
  const answer = trendFromHourlies(bars, 50, now);
  expect(answer.known).toBe(true);
  expect(answer.up).toBe(true);
});

test("a completed 4 hour close below the EMA is not up", () => {
  const start = Math.floor(1_700_000_000_000 / FOUR) * FOUR;
  const bars = hours(80, start, (i) => (i < 60 ? 100 + i : 100 + 60 - (i - 60) * 3));
  const now = start + 80 * HOUR;
  const answer = trendFromHourlies(bars, 50, now);
  expect(answer.known).toBe(true);
  expect(answer.up).toBe(false);
});

test("too few completed 4 hour buckets stay unknown", () => {
  const start = Math.floor(1_700_000_000_000 / FOUR) * FOUR;
  const bars = hours(8, start, () => 100);
  expect(trendFromHourlies(bars, 50, start + 8 * HOUR).known).toBe(false);
});

test("refresh waits until a few minutes after the hour", () => {
  const at = Date.UTC(2026, 8, 25, 14, 10, 0);
  expect(msUntilRefresh(at)).toBe(Date.UTC(2026, 8, 25, 15, 3, 0) - at);
  const justAfter = Date.UTC(2026, 8, 25, 15, 1, 0);
  expect(msUntilRefresh(justAfter)).toBe(Date.UTC(2026, 8, 25, 15, 3, 0) - justAfter);
});
