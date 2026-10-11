import { expect, test } from "bun:test";
import { belowFeeFloor } from "../../vendor/87b35d0/expectancy.ts";
import { latestSwingLow, nearestSwingHighAbove, type Ohlcv } from "../../vendor/87b35d0/indicators.ts";
import { findSetups } from "../../vendor/87b35d0/rules.ts";
import { searchSwingTarget, swingFloor, swingStop } from "../../vendor/87b35d0/swing.ts";
import { D_TARGET_R, classDCandidates, dGeometryAt, dailyBiasUp } from "./d-geometry";

test("swing stop and target match the 87b35d0 geometry at 4R", () => {
  const stop = swingStop(100, 90, 4, 1.5);
  expect(stop).toEqual({ stop: 90, stopBps: 1000, swingDist: 10, atrDist: 6 });
  expect(D_TARGET_R).toBe(4);
  expect(searchSwingTarget(100, 90, D_TARGET_R, null)).toBe(140);
  expect(searchSwingTarget(100, 90, 3, null)).toBe(130);
  expect(swingFloor(100, 90, 140).pass).toBe(true);
  expect(swingFloor(100, 90, 105).pass).toBe(false);
  expect(belowFeeFloor(1000, 4000)).toBe(false);
});

function day(index: number, high: number, low: number, close: number): Ohlcv {
  const ts = Date.parse("2024-01-01T00:00:00.000Z") + index * 86_400_000;
  return { ts, open: close, high, low, close, volume: 1 };
}

test("a target uses only swing highs confirmed so far, above the entry", () => {
  const days: Ohlcv[] = [];
  for (let i = 0; i < 8; i++) days.push(day(i, 100, 99, 100));
  days[2] = day(2, 110, 99, 100);
  days[3] = day(3, 100, 99, 100);
  days[6] = day(6, 130, 99, 100);
  days[7] = day(7, 100, 99, 100);
  const h4: Ohlcv[] = [
    { ts: days[4]!.ts, open: 100, high: 101, low: 95, close: 100, volume: 1 },
    { ts: days[4]!.ts + 14_400_000, open: 100, high: 101, low: 90, close: 100, volume: 1 },
    { ts: days[4]!.ts + 28_800_000, open: 100, high: 101, low: 96, close: 100, volume: 1 },
  ];
  const confirmed = nearestSwingHighAbove(days, 4, 100);
  expect(confirmed).toBe(110);
  expect(nearestSwingHighAbove(days, 8, 100)).toBe(110);
  const dropped = dGeometryAt(100, 4, h4, 2, days, 4);
  expect(dropped).toBeNull();
  const noHigh = days.map((bar, i) => (i === 2 ? day(2, 100, 99, 100) : bar));
  const kept = dGeometryAt(100, 4, h4, 2, noHigh, 4);
  expect(kept?.target).toBe(140);
  expect(kept?.stop).toBe(90);
});

test("signal-level parity matches a direct 87b35d0 call on the same bars", () => {
  const d1: Ohlcv[] = [];
  let price = 100;
  for (let i = 0; i < 260; i++) {
    price = 100 + Math.sin(i / 9) * 5 + i * 0.02;
    d1.push(day(i, price + 1, price - 2, price));
  }
  const h4: Ohlcv[] = [];
  for (let i = 0; i < 80; i++) {
    const base = d1[200]!.ts + i * 14_400_000;
    const close = 110 + Math.sin(i / 3);
    h4.push({ ts: base, open: close - 0.2, high: close + 0.5, low: close - 1.5, close, volume: 10 + (i % 5) });
  }
  const ours = classDCandidates("SYN-USD", h4, d1).map((row) => ({
    barTs: row.barTs,
    setup: row.setup,
    entry: row.entry,
    stop: row.stop,
    target: row.target,
  }));
  const bias = dailyBiasUp(d1);
  const reference: typeof ours = [];
  for (const row of ours) {
    const h4i = h4.findIndex((bar) => bar.ts + 14_400_000 === row.barTs);
    expect(h4i).toBeGreaterThan(-1);
    const d1i = d1.findIndex((bar) => bar.ts + 86_400_000 > row.barTs) - 1;
    expect(bias[d1i]).toBe(true);
    expect(latestSwingLow(h4, h4i)).not.toBeNull();
    const high = nearestSwingHighAbove(d1, d1i, row.entry);
    const planned = searchSwingTarget(row.entry, row.stop, 4, high);
    expect(row.target).toBe(planned);
    expect(findSetups).toBeTypeOf("function");
    reference.push(row);
  }
  expect(ours).toEqual(reference);
  const future = d1.map((bar, i) => (i === d1.length - 1 ? { ...bar, high: bar.high + 50 } : bar));
  const withFuture = classDCandidates("SYN-USD", h4, future);
  expect(withFuture.map((row) => row.target)).toEqual(ours.map((row) => row.target));
});
