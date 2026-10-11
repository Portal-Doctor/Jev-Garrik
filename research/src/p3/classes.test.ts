import { expect, test } from "bun:test";
import { classATrigger, classBScore, type DailyBar } from "./classes";

function rising(n: number): DailyBar[] {
  return Array.from({ length: n }, (_, i) => ({
    date: `2024-01-${String((i % 28) + 1).padStart(2, "0")}`,
    high: i + 2,
    low: i,
    close: i + 1,
    volume: 1,
  }));
}

test("class A requires a close above the lookback and EMA50 above EMA200", () => {
  const bars = rising(220);
  expect(classATrigger(bars, 210, 20, false)).toBe(true);
  expect(classATrigger(bars, 10, 20, false)).toBe(false);
  const flat = bars.map((bar) => ({ ...bar, close: 10, high: 11, low: 9 }));
  expect(classATrigger(flat, 210, 20, false)).toBe(false);
});

test("class B score skips the last three closes", () => {
  const closes = Array.from({ length: 40 }, (_, i) => i + 1);
  const score = classBScore(closes, 39);
  expect(score).toBe((closes[36]! - closes[8]!) / closes[8]!);
  expect(classBScore(closes, 10)).toBeNull();
});
