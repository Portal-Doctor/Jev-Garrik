import { expect, test } from "bun:test";
import { wilderAtr } from "../p2/indicators";
import type { DailyBar } from "./classes";
import { countClassA, countClassB, countClassE, type BarOHLC } from "./signals";

test("class B keeps the top fifth of positive scores and counts an OOS date", () => {
  const rows = [1, 2, 3, 4, 5].map((score) => ({ date: "2026-03-02", score, member: true }));
  const counts = countClassB(rows, new Map());
  expect(counts.signals).toBe(1);
  expect(counts.oosSignals).toBe(1);
});

test("class E counts a 15m close above VWAP and a swing high", () => {
  const hour: BarOHLC[] = Array.from({ length: 30 }, (_, i) => ({
    ts: i * 3600,
    open: 10,
    high: 10.2,
    low: 9.8,
    close: 10,
    volume: 1,
  }));
  const event = 25;
  hour[event] = { ts: event * 3600, open: 10, high: 20, low: 8, close: 9, volume: 100 };
  const base = hour[event]!.ts;
  const inside: BarOHLC[] = [
    { ts: base, open: 9, high: 12, low: 8, close: 11, volume: 5 },
    { ts: base + 900, open: 11, high: 11.5, low: 8, close: 9, volume: 5 },
    { ts: base + 1800, open: 9, high: 14, low: 9, close: 13, volume: 5 },
  ];
  expect(countClassE(hour, inside, () => true).signals).toBe(0);
  const quarter: BarOHLC[] = inside.map((bar) => ({ ...bar, ts: bar.ts + 3600 }));
  const counts = countClassE(hour, quarter, () => true);
  expect(counts.signals).toBeGreaterThan(0);
  const releaseAt = new Date((quarter[2]!.ts + 900) * 1000).toISOString();
  expect(countClassE(hour, quarter, () => true, [{ releaseAt }]).signals).toBe(0);
});

test("class E skips a stop tighter than 250 bps", () => {
  const hour: BarOHLC[] = Array.from({ length: 30 }, (_, i) => ({
    ts: i * 3600,
    open: 100,
    high: 100.02,
    low: 99.98,
    close: 100,
    volume: 1,
  }));
  const event = 25;
  hour[event] = { ts: event * 3600, open: 100, high: 100.08, low: 99.98, close: 100, volume: 20 };
  const base = hour[event]!.ts;
  const quarter: BarOHLC[] = [
    { ts: base + 3600, open: 100, high: 100.2, low: 99.9, close: 100.1, volume: 5 },
    { ts: base + 4500, open: 100.1, high: 100.15, low: 99.9, close: 100, volume: 5 },
    { ts: base + 5400, open: 100, high: 100.4, low: 100, close: 100.3, volume: 5 },
  ];
  expect(countClassE(hour, quarter, () => true).signals).toBe(0);
});

test("class A records stop widths at k = 2, 2.5, and 3", () => {
  const bars: DailyBar[] = Array.from({ length: 220 }, (_, i) => ({
    date: `2024-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
    high: i + 2,
    low: i,
    close: i + 1,
    volume: 1,
  }));
  const atr = wilderAtr(bars.map((bar) => bar.high), bars.map((bar) => bar.low), bars.map((bar) => bar.close), 14);
  const counts = countClassA(bars, () => true, atr, new Map(), false);
  expect(counts.L20.signals).toBeGreaterThan(0);
  expect(counts.stopBpsByK.L20[2].length).toBe(counts.L20.signals);
  expect(counts.stopBpsByK.L20[2.5].length).toBe(counts.L20.signals);
  expect(counts.stopBpsByK.L20[3].length).toBe(counts.L20.signals);
  const index = counts.stopBpsByK.L20[2].length - 1;
  expect(counts.stopBpsByK.L20[3][index]).toBeCloseTo(counts.stopBpsByK.L20[2][index]! * 1.5, 6);
});
