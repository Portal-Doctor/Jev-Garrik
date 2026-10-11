import { expect, test } from "bun:test";
import { priceOff, summarizeOverlap, volumeOff, type F5Day, type F5Slot } from "./f5";

function day(date: string, close: number, volume = 10): F5Day {
  return { date, open: close, high: close + 1, low: close - 1, close, volume, empty: false };
}

function slotsFor(date: string, close: number): F5Slot[] {
  const start = Date.parse(`${date}T00:00:00.000Z`) / 1000;
  const out: F5Slot[] = [];
  for (let i = 0; i < 96; i += 1) {
    out.push({ ts: start + i * 900, empty: false, open: close, high: close + 1, low: close - 1, close, volume: 10 / 96 });
  }
  return out;
}

test("a price gap inside the tick or 10 bps passes, and open is reported on its own", () => {
  expect(priceOff(100.05, 100, 0.01)).toBe(false);
  expect(priceOff(100.2, 100, 0.01)).toBe(true);
  expect(priceOff(100.2, 100, 0.5)).toBe(false);
  expect(volumeOff(103, 100, 100_000)).toBe(true);
  expect(volumeOff(101, 100, 100_000)).toBe(false);
  const date = "2026-01-05";
  const derived = [day(date, 100)];
  const daily = [{ ...day(date, 100), open: 110 }];
  const summary = summarizeOverlap({ productId: "AAA-USD", tick: 0.01, derived, daily, slots: slotsFor(date, 100) });
  expect(summary.overlapDays).toBe(1);
  expect(summary.openFailDays).toBe(1);
  expect(summary.priceGroupPasses).toBe(true);
  expect(summary.closeFailDays).toBe(0);
});

test("one empty source fails, a missing slot is excluded, and a 00:00 gap can save closes", () => {
  const date = "2026-01-05";
  const derived = [day(date, 100), { ...day("2026-01-06", 0), empty: true, open: 0, high: 0, low: 0, volume: 0 }];
  const daily = [day(date, 100), day("2026-01-06", 50)];
  const slots = [...slotsFor(date, 100), ...slotsFor("2026-01-06", 100).slice(0, 10)];
  const summary = summarizeOverlap({ productId: "AAA-USD", tick: 0.01, derived, daily, slots });
  expect(summary.missingSlotDays).toBe(1);
  expect(summary.oneSidedEmptyDays).toBe(0);
  expect(summary.overlapDays).toBe(1);
  const nextDate = "2026-01-06";
  const both = summarizeOverlap({
    productId: "AAA-USD",
    tick: 0.01,
    derived: [
      { ...day(date, 0), empty: true, open: 0, high: 0, low: 0, close: 0, volume: 0 },
      { ...day(nextDate, 0), empty: true, open: 0, high: 0, low: 0, close: 0, volume: 0 },
    ],
    daily: [day(date, 100), day(nextDate, 100)],
    slots: [...slotsFor(date, 100), ...slotsFor(nextDate, 100)],
  });
  expect(both.oneSidedEmptyDays).toBe(2);
  expect(both.priceGroupPasses).toBe(false);
  const shifted = slotsFor(date, 100);
  const shiftedNext = slotsFor(nextDate, 100);
  const after = slotsFor("2026-01-07", 100);
  after[0] = { ...after[0]!, open: 100.05 };
  const boundary = summarizeOverlap({
    productId: "AAA-USD",
    tick: 0.01,
    derived: [
      { ...day(date, 100), close: 110 },
      { ...day(nextDate, 100), close: 110 },
    ],
    daily: [day(date, 100), day(nextDate, 100)],
    slots: [...shifted, ...shiftedNext, after[0]!],
  });
  expect(boundary.priceGroupPasses).toBe(false);
  expect(boundary.boundaryBestSide).toBe("before-00:00");
  expect(boundary.boundarySavesCloses).toBe(true);
  expect(boundary.dropPrewindowPrices).toBe(false);
});
