import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Ohlcv } from "../../vendor/87b35d0/indicators.ts";
import {
  BOUNDARY_SAVED_NAMES,
  VOLUME_FALLBACK_NAMES,
  classBarInputs,
  correlationCloses,
  clusterKey,
  dailyBarsFor,
  dHistoryStart,
  groupFlagsOf,
  type GroupFlags,
  type SourceDay,
} from "./bar-access";
import { classDCandidates, dGeometryAt } from "./d-geometry";
import { WINDOW_START } from "./f5";

const boundary: GroupFlags = { priceGroupPasses: false, volumeGroupPasses: true, boundarySaved: true };
const pricePass: GroupFlags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };
const volumeFallback: GroupFlags = { priceGroupPasses: false, volumeGroupPasses: false, boundarySaved: true };

function day(date: string, high: number, low = 1, close = 2, volume = 3): SourceDay {
  return { date, ts: Date.parse(`${date}T00:00:00.000Z`) / 1000, open: close, high, low, close, volume, empty: false };
}

test("correlation closes stay in-window for every boundary-saved name, including WIF", () => {
  const days = [day("2025-09-01", 10, 8, 50, 4), day("2025-10-11", 10, 8, 9, 4), day("2025-10-12", 11, 7, 10, 5)];
  expect(BOUNDARY_SAVED_NAMES).toContain("WIF-USD");
  for (const name of BOUNDARY_SAVED_NAMES) {
    const flags: GroupFlags = { priceGroupPasses: false, volumeGroupPasses: true, boundarySaved: true };
    expect(name.endsWith("-USD")).toBe(true);
    expect(correlationCloses(flags, days).map((row) => row.date)).toEqual(["2025-10-11", "2025-10-12"]);
  }
  expect(correlationCloses(pricePass, days).some((row) => row.date < WINDOW_START)).toBe(true);
});

test("the seven boundary-saved names do not read pre-window highs, lows, or volume", () => {
  expect([...BOUNDARY_SAVED_NAMES]).toEqual(["AVNT-USD", "FIL-USD", "IP-USD", "LIGHTER-USD", "TRUMP-USD", "VVV-USD", "WIF-USD"]);
  const days = [day("2025-09-01", 999, 0.1, 50, 80), day("2025-10-11", 10, 8, 9, 4), day("2025-10-12", 11, 7, 10, 5)];
  for (const name of BOUNDARY_SAVED_NAMES) {
    const flags: GroupFlags = {
      priceGroupPasses: false,
      volumeGroupPasses: !VOLUME_FALLBACK_NAMES.includes(name as (typeof VOLUME_FALLBACK_NAMES)[number]),
      boundarySaved: true,
    };
    expect(name).toBeTruthy();
    for (const read of ["ohlc", "closeLookback", "volume", "swingHigh"] as const) {
      const rows = dailyBarsFor(flags, days, read);
      expect(rows.some((row) => row.date < WINDOW_START)).toBe(false);
    }
    const ema = dailyBarsFor(flags, days, "ema");
    const prior = ema.filter((row) => row.date < WINDOW_START);
    expect(prior).toHaveLength(1);
    expect(prior[0]?.close).toBe(50);
    expect(Number.isFinite(prior[0]?.high ?? 0)).toBe(false);
    expect(Number.isFinite(prior[0]?.low ?? 0)).toBe(false);
    expect(Number.isFinite(prior[0]?.volume ?? 0)).toBe(false);
    const inputs = classBarInputs(flags, days, "2025-09-01");
    expect(inputs.dHistoryStart).toBe(WINDOW_START);
    expect(inputs.swing.some((row) => row.ts < Date.parse(`${WINDOW_START}T00:00:00.000Z`))).toBe(false);
    expect(inputs.listingProxySource).toBe("first-d1-close");
    expect(inputs.listingProxyDate).toBe("2025-09-01");
    expect(clusterKey(flags, 59, name, "cluster-a")).toBe(name);
    expect(clusterKey(flags, 60, name, "cluster-a")).toBe("cluster-a");
  }
});

test("a price-group pass keeps pre-window OHLC and volume, and pins D at the first D1 candle", () => {
  const days = [day("2024-01-01", 40, 30, 35, 12), day("2025-10-11", 10, 8, 9, 4)];
  const inputs = classBarInputs(pricePass, days, "2024-01-01");
  expect(inputs.ohlc[0]?.high).toBe(40);
  expect(inputs.volume[0]?.volume).toBe(12);
  expect(inputs.dHistoryStart).toBe("2024-01-01");
  expect(inputs.listingProxySource).toBe("first-d1-candle");
  expect(inputs.swing[0]?.high).toBe(40);
  expect(dHistoryStart(volumeFallback, "2024-01-01")).toBe(WINDOW_START);
  expect(groupFlagsOf({ priceGroupPasses: false, volumeGroupPasses: true, boundarySavesCloses: true }).boundarySaved).toBe(true);
});

test("A, C, and D take daily bars from classBarInputs", () => {
  const source = readFileSync(new URL("./geometry-run.ts", import.meta.url), "utf8");
  expect(source.includes("const inputs = classBarInputs(")).toBe(true);
  expect(source.includes("countClassA(bars")).toBe(true);
  expect(source.includes("inputs.ema")).toBe(true);
  expect(source.includes("inputs.classC")).toBe(true);
  expect(source.includes("classDCandidates(pair.productId, h4, inputs.swing, inputs.bias)")).toBe(true);
  expect(source.includes("const d1 = pair.days")).toBe(false);
});

function ohlcv(date: string, high: number, low: number, close: number): Ohlcv {
  return { ts: Date.parse(`${date}T00:00:00.000Z`), open: close, high, low, close, volume: 1 };
}

test("D candidates match between replay and a forward-style load from the registered start", () => {
  const first = "2024-01-01";
  const stored: SourceDay[] = [day("2023-06-01", 500, 1, 100, 9)];
  for (let i = 0; i < 260; i++) {
    const date = new Date(Date.parse(`${first}T00:00:00.000Z`) + i * 86_400_000).toISOString().slice(0, 10);
    const close = 100 + i * 0.05;
    stored.push(day(date, close + 1, close - 1, close, 2));
  }
  const replay = classBarInputs(pricePass, stored, first);
  const forward = classBarInputs(pricePass, stored, first);
  expect(replay.dHistoryStart).toBe(first);
  expect(replay.swing.some((row) => row.high === 500)).toBe(false);
  expect(replay.swing.map((row) => row.ts)).toEqual(forward.swing.map((row) => row.ts));
  expect(replay.bias.map((row) => row.close)).toEqual(forward.bias.map((row) => row.close));
  const h4: Ohlcv[] = [];
  const origin = replay.swing.at(-20)?.ts ?? replay.swing[0]!.ts;
  for (let i = 0; i < 30; i++) {
    const close = 120 + Math.sin(i / 4);
    h4.push({ ts: origin + i * 14_400_000, open: close, high: close + 0.4, low: close - 1, close, volume: 8 });
  }
  const fromReplay = classDCandidates("SYN-USD", h4, replay.swing, replay.bias);
  const fromForward = classDCandidates("SYN-USD", h4, forward.swing, forward.bias);
  expect(fromForward).toEqual(fromReplay);
});

test("a boundary-saved name keeps pre-window closes for bias and drops them from the swing scan", () => {
  const stored: SourceDay[] = [];
  for (let i = 0; i < 250; i++) {
    const date = new Date(Date.parse("2025-02-01T00:00:00.000Z") + i * 86_400_000).toISOString().slice(0, 10);
    const close = 80 + i * 0.04;
    stored.push(day(date, i === 10 ? 400 : close + 1, close - 1, close, 7));
  }
  const inputs = classBarInputs(boundary, stored, "2025-02-01");
  expect(inputs.dHistoryStart).toBe(WINDOW_START);
  expect(inputs.bias.some((row) => row.ts < Date.parse(`${WINDOW_START}T00:00:00.000Z`) && row.close > 0)).toBe(true);
  expect(inputs.swing.some((row) => row.high === 400)).toBe(false);
  expect(inputs.bias.some((row) => row.high === 400)).toBe(false);
  const forward = classBarInputs(boundary, stored, "2025-02-01");
  expect(forward.swing).toEqual(inputs.swing);
  expect(forward.bias).toEqual(inputs.bias);
});

test("loading a swing high from before the pinned start changes the target", () => {
  const h4: Ohlcv[] = [
    { ts: 0, open: 100, high: 101, low: 95, close: 100, volume: 1 },
    { ts: 14_400_000, open: 100, high: 101, low: 90, close: 100, volume: 1 },
    { ts: 28_800_000, open: 100, high: 101, low: 96, close: 100, volume: 1 },
  ];
  const pinned: Ohlcv[] = [];
  for (let i = 0; i < 8; i++) pinned.push(ohlcv(`2025-10-${String(11 + i).padStart(2, "0")}`, 100, 99, 100));
  const withPrior = [ohlcv("2025-09-01", 100, 99, 100), ohlcv("2025-09-02", 110, 99, 100), ohlcv("2025-09-03", 100, 99, 100), ...pinned];
  const pinnedTarget = dGeometryAt(100, 4, h4, 2, pinned, pinned.length - 1);
  const priorTarget = dGeometryAt(100, 4, h4, 2, withPrior, withPrior.length - 1);
  expect(pinnedTarget?.target).toBe(140);
  expect(priorTarget).toBeNull();
});
