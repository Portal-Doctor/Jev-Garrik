import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { summarizeOverlap } from "./f5";
import { liquidityAt, ohlcvDiffers, scanFacts, warmupFor, type PairFacts, type QuarterSlot } from "./geometry-run";
import { assertScanSchema } from "./scan-schema";

test("overlap flags a 2 bp price gap and ignores a 0.5 bp gap", () => {
  const right = { high: 100, low: 90, close: 95, volume: 10 };
  expect(ohlcvDiffers({ ...right, close: 95 * 1.0002 }, right)).toBe(true);
  expect(ohlcvDiffers({ ...right, close: 95 * 1.00005 }, right)).toBe(false);
  expect(ohlcvDiffers({ ...right, volume: 10.2 }, right)).toBe(true);
});

test("empty 15m slots count as zero dollars and are not Corwin-Schultz pairs", () => {
  const start = Date.parse("2025-10-12T00:00:00.000Z") / 1000;
  const slots: QuarterSlot[] = [];
  for (let i = 0; i < 30 * 96; i += 1) {
    const filled = i === 10 || i === 11;
    slots.push(filled
      ? { ts: start + i * 900, empty: false, high: 11, low: 10, close: 10, volume: 1 }
      : { ts: start + i * 900, empty: true, high: 0, low: 0, close: 0, volume: 0 });
  }
  const sample = liquidityAt(slots, "2025-11-11");
  expect(sample).not.toBeNull();
  expect(sample!.nonemptyShare).toBeCloseTo(2 / 2880, 6);
  expect(sample!.medianUsd).toBe(0);
});

test("warmup names the source that completed each indicator", () => {
  const days = Array.from({ length: 210 }, (_, i) => {
    const ts = Date.parse("2024-01-01T00:00:00.000Z") / 1000 + i * 86400;
    const date = new Date(ts * 1000).toISOString().slice(0, 10);
    return { date, ts, open: 1, high: 2, low: 1, close: 1, volume: 1, quote: 1, empty: false };
  });
  const pair: PairFacts = {
    productId: "AAA-USD",
    days,
    listedDate: days[0]!.date,
    leftCensored: false,
    hour: [],
    quarter: [],
    quarterSlots: [],
    four: [],
    overlapFlags: 0,
    overlapDays: 0,
    overlapDetail: [],
    f5: summarizeOverlap({ productId: "AAA-USD", tick: 0.01, derived: [], daily: [], slots: [] }),
  };
  const row = warmupFor(pair);
  expect(row.indicators.find((item) => item.indicator === "ema200")?.source).toBe("D1");
  expect(row.shortHistoryFallback).toBe(false);
  expect(row.indicators.find((item) => item.indicator === "cs15m")?.source).toBe("15m");
});

test("class D does not take a swing high that is not confirmed yet", () => {
  const source = readFileSync(new URL("./geometry-run.ts", import.meta.url), "utf8");
  expect(source.includes("nextDailySwingHigh")).toBe(false);
  expect(source.includes("classDCandidates")).toBe(true);
});

test("an empty book still records D3 comparisons and a tolerance that predates the scan", () => {
  const result = scanFacts([], new Set());
  expect(result.firstUniverseDate).toBe("2025-11-10");
  expect(result.volumeTier.tier).toBe("3M/2M");
  expect(result.d3.a.available).toBe(false);
  expect(result.d3.c.historicalOosN).toBe(0);
  expect(result.d3.b.label).toContain("EXPLORATORY");
  expect(result.passCountFlag.flagged).toBe(true);
  const createdAt = "2026-10-11T03:00:00.000Z";
  expect(Date.parse(result.overlap.tolerance.recordedAt)).toBeLessThan(Date.parse(createdAt));
  assertScanSchema({ ...result, createdAt, signalCounts: result.signalCounts });
});

test("the fill path has no indeterminate feed-gap fallback", () => {
  const fills = readFileSync(new URL("./fills.ts", import.meta.url), "utf8");
  expect(fills.includes("indeterminate")).toBe(false);
  const costs = readFileSync(new URL("../p2/costs.ts", import.meta.url), "utf8");
  expect(costs.includes("CS-1h")).toBe(false);
  expect(costs.includes("corwinSchultz1h")).toBe(false);
});
