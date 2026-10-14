import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import type { MinuteRow } from "../data/candles";
import { rootHash } from "../data/hash";
import { scanCandleFiles } from "../data/manifest-file";
import { deriveBars, foldHours } from "../data/derive";
import { readPairMonth } from "../data/store";
import { ema, wilderAtr } from "../p2/indicators";
import type { SourceDay } from "../p3/bar-access";
import type { DailyBar } from "../p3/classes";
import { classCSetups, type BarOHLC } from "../p3/signals";
import { hourAtrAt, vetoFromBtc } from "./generate";
import { FOUR_KEEP, HOUR_KEEP } from "./warm-caps";

/** Frozen offline candle snapshot. The files are gitignored; the hash is not. */
const SNAPSHOT_HASH = "1ccc8879994d100896844b53a878e6570102046b35ebd6e40250857924eb30a8";
const candleRoot = fileURLToPath(new URL("../../data/candles", import.meta.url));
const dataDir = fileURLToPath(new URL("../../data", import.meta.url));
const btcDir = join(candleRoot, "BTC-USD");
const storePresent = existsSync(btcDir);
const diskFiles = storePresent ? scanCandleFiles(dataDir) : [];
const diskHash = diskFiles.length > 0 ? rootHash(diskFiles) : null;
const hashMatches = diskHash === SNAPSHOT_HASH;
const WINDOW_START = Date.parse("2026-10-04T00:00:00.000Z") / 1000;
const WINDOW_END = Date.parse("2026-10-11T00:00:00.000Z") / 1000;
const NAMES = ["BTC-USD", "ETH-USD", "SOL-USD", "ADA-USD", "AAVE-USD", "LINK-USD", "DOGE-USD", "XRP-USD", "AVAX-USD", "LTC-USD", "CRV-USD", "TRUMP-USD"];

function p95(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.floor(0.95 * (sorted.length - 1))]!;
}

function bps(left: number, right: number): number {
  return (Math.abs(left - right) / Math.abs(right)) * 10_000;
}

function minutesOf(productId: string): MinuteRow[] {
  const folder = join(candleRoot, productId);
  const names = readdirSync(folder).filter((name) => name.endsWith(".sqlite") && !name.includes("partial")).sort();
  const rows: MinuteRow[] = [];
  for (const name of names) rows.push(...readPairMonth(join(folder, name)).rows);
  rows.sort((a, b) => a.minuteSec - b.minuteSec);
  return rows;
}

function priceOf(value: string | null): number {
  return Number(value);
}

test.skipIf(!storePresent)("the pin checks the candle store hash on disk", () => {
  expect(diskFiles.length).toBeGreaterThan(0);
  expect(diskHash).toBe(SNAPSHOT_HASH);
});

test.skipIf(!hashMatches)("capped 4h bars match full history over the last 7 days", () => {
  const rows: string[] = [];
  for (const productId of NAMES) {
    const minutes = minutesOf(productId);
    expect(minutes.length, productId).toBeGreaterThan(0);
    const first = minutes[0]!.minuteSec;
    const derived = deriveBars(minutes, "4h", first, WINDOW_END)
      .filter((bar) => !bar.empty && bar.close != null && bar.high != null && bar.low != null && bar.open != null)
      .map((bar) => ({
        ts: bar.openTs,
        open: priceOf(bar.open),
        high: priceOf(bar.high),
        low: priceOf(bar.low),
        close: priceOf(bar.close),
        volume: priceOf(bar.volume),
      }));
    const full = derived.filter((bar) => bar.ts + 14_400 <= WINDOW_END);
    const cap = full.slice(-FOUR_KEEP);
    const capIndex = new Map(cap.map((bar, index) => [bar.ts, index]));
    const fullEma200 = ema(full.map((bar) => bar.close), 200);
    const capEma200 = ema(cap.map((bar) => bar.close), 200);
    const fullEma50 = ema(full.map((bar) => bar.close), 50);
    const capEma50 = ema(cap.map((bar) => bar.close), 50);
    const hourFull = deriveBars(minutes, "1h", first, WINDOW_END)
      .filter((bar) => !bar.empty && bar.close != null && bar.high != null && bar.low != null && bar.open != null)
      .map((bar) => ({
        ts: bar.openTs,
        open: priceOf(bar.open),
        high: priceOf(bar.high),
        low: priceOf(bar.low),
        close: priceOf(bar.close),
        volume: priceOf(bar.volume),
      }));
    const ema200Diffs: number[] = [];
    const ema50Diffs: number[] = [];
    const atrDiffs: number[] = [];
    const flags: string[] = [];
    let decisions = 0;
    const window = full.filter((bar) => bar.ts >= WINDOW_START && bar.ts < WINDOW_END);
    expect(window.length, productId).toBeGreaterThan(0);
    for (const bar of window) {
      const fullAt = full.findIndex((row) => row.ts === bar.ts);
      const capAt = capIndex.get(bar.ts);
      expect(typeof capAt, `${productId} ${bar.ts}`).toBe("number");
      const e200f = fullEma200[fullAt]!;
      const e200c = capEma200[capAt!]!;
      const e50f = fullEma50[fullAt]!;
      const e50c = capEma50[capAt!]!;
      expect(e200f).toBeTruthy();
      expect(e200c).toBeTruthy();
      expect(e50f).toBeTruthy();
      expect(e50c).toBeTruthy();
      const d200 = bps(e200c, e200f);
      const d50 = bps(e50c, e50f);
      ema200Diffs.push(d200);
      ema50Diffs.push(d50);
      if (d200 < 1 && 1 - d200 < 0.05) flags.push(`ema200 ${bar.ts} margin ${(1 - d200).toFixed(4)}bp`);
      if (d50 < 0.1 && 0.1 - d50 < 0.02) flags.push(`ema50 ${bar.ts} margin ${(0.1 - d50).toFixed(4)}bp`);
      const decisionTs = bar.ts + 14_400;
      const visible = hourFull.filter((hour) => hour.ts + 3_600 <= decisionTs);
      const atrF = hourAtrAt(visible, decisionTs);
      const atrC = hourAtrAt(visible.slice(-HOUR_KEEP), decisionTs);
      if (atrF > 0) {
        const rel = Math.abs(atrC - atrF) / atrF;
        atrDiffs.push(rel);
        expect(rel, `${productId} atr1h ${bar.ts}`).toBeLessThan(0.005);
      }
      const fullBits = [bar.close > e50f, bar.close > e200f, e50f > e200f, bar.close < e50f];
      const capBits = [bar.close > e50c, bar.close > e200c, e50c > e200c, bar.close < e50c];
      expect(capBits, `${productId} bits ${bar.ts}`).toEqual(fullBits);
      decisions += 1;
      for (const [label, left, right] of [
        ["close-ema50", bar.close, e50f],
        ["close-ema200", bar.close, e200f],
        ["ema50-ema200", e50f, e200f],
      ] as const) {
        if (right !== 0 && bps(left, right) < 1) flags.push(`${label} ${bar.ts} within 1bp`);
      }
    }
    expect(Math.max(...ema200Diffs), productId).toBeLessThan(1);
    expect(Math.max(...ema50Diffs), productId).toBeLessThan(0.1);

    const days = deriveBars(minutes, "1d", first, WINDOW_END).filter((bar) => !bar.empty && bar.close != null);
    const daily: DailyBar[] = days.map((bar) => ({
      date: new Date(bar.openTs * 1000).toISOString().slice(0, 10),
      high: priceOf(bar.high),
      low: priceOf(bar.low),
      close: priceOf(bar.close),
      volume: priceOf(bar.volume),
    }));
    const dailyAtr = wilderAtr(daily.map((bar) => bar.high), daily.map((bar) => bar.low), daily.map((bar) => bar.close), 14);
    const key = (row: { entryTs: number; stopBps: number; targetBps: number }) => `${row.entryTs}|${row.stopBps}|${row.targetBps}`;
    const inWindow = (row: { date: string }) => row.date >= "2026-10-04" && row.date < "2026-10-11";
    const fullEntries = classCSetups(productId, daily, full, () => true, dailyAtr).filter(inWindow).map(key);
    const capEntries = classCSetups(productId, daily, cap, () => true, dailyAtr).filter(inWindow).map(key);
    expect(capEntries, productId).toEqual(fullEntries);

    if (productId === "BTC-USD") {
      const source: SourceDay[] = days.map((bar) => ({
        date: new Date(bar.openTs * 1000).toISOString().slice(0, 10),
        ts: bar.openTs,
        open: priceOf(bar.open),
        high: priceOf(bar.high),
        low: priceOf(bar.low),
        close: priceOf(bar.close),
        volume: priceOf(bar.volume),
        empty: false,
      }));
      const fullVeto = vetoFromBtc(source, full as BarOHLC[]);
      const capVeto = vetoFromBtc(source, cap as BarOHLC[]);
      const dates = source.filter((day) => day.date >= "2026-10-04" && day.date < "2026-10-11").map((day) => day.date);
      expect(dates.map((date) => capVeto(date))).toEqual(dates.map((date) => fullVeto(date)));
    }
    rows.push(
      `${productId} ema200 max ${Math.max(...ema200Diffs).toFixed(4)} p95 ${p95(ema200Diffs).toFixed(4)} ema50 max ${Math.max(...ema50Diffs).toFixed(4)} p95 ${p95(ema50Diffs).toFixed(4)} atr max ${(Math.max(0, ...atrDiffs) * 100).toFixed(4)}% p95 ${(p95(atrDiffs) * 100).toFixed(4)}% bars ${decisions} flags ${flags.length}`,
    );
    if (flags.length > 0) console.log(`pin flags ${productId} ${flags.slice(0, 8).join("; ")}`);
  }
  console.log(rows.join("\n"));
}, 180_000);

test("a committed mid-series hole keeps EMA200 within 1bp and zero decision diffs", () => {
  const start = Date.parse("2024-06-01T00:00:00.000Z") / 1000;
  const bars = 1_600;
  const holeAt = 1_200;
  const hours: { ts: number; open: number; high: number; low: number; close: number; volume: number }[] = [];
  for (let index = 0; index < bars * 4; index += 1) {
    const bucket = Math.floor(index / 4);
    if (bucket >= holeAt && bucket < holeAt + 3) continue;
    const close = 100 + index * 0.01 + Math.sin(index / 18) * 3;
    hours.push({ ts: start + index * 3_600, open: close - 0.4, high: close + 0.6, low: close - 0.8, close, volume: 10 + (index % 5) });
  }
  const full = foldHours(hours, 14_400, 3_600);
  const cap = full.slice(-FOUR_KEEP);
  const gapAt = full.findIndex((bar, index) => index > 0 && bar.ts - full[index - 1]!.ts > 14_400);
  expect(gapAt).toBeGreaterThan(0);
  expect(gapAt).toBeLessThan(full.length - 1);
  expect(cap.some((bar) => bar.ts === full[gapAt - 1]!.ts)).toBe(true);
  expect(cap.some((bar) => bar.ts === full[gapAt]!.ts)).toBe(true);
  expect(full[gapAt]!.ts - full[gapAt - 1]!.ts).toBe(4 * 14_400);
  const fullEma200 = ema(full.map((bar) => bar.close), 200);
  const capEma200 = ema(cap.map((bar) => bar.close), 200);
  const fullEma50 = ema(full.map((bar) => bar.close), 50);
  const capEma50 = ema(cap.map((bar) => bar.close), 50);
  const capIndex = new Map(cap.map((bar, index) => [bar.ts, index]));
  const window = cap.slice(-42);
  const diffs: number[] = [];
  let sawTrue = false;
  let sawFalse = false;
  for (const bar of window) {
    const fullAt = full.findIndex((row) => row.ts === bar.ts);
    const capAt = capIndex.get(bar.ts)!;
    const e200f = fullEma200[fullAt]!;
    const e200c = capEma200[capAt]!;
    const e50f = fullEma50[fullAt]!;
    const e50c = capEma50[capAt]!;
    const diff = bps(e200c, e200f);
    diffs.push(diff);
    const fullBits = [bar.close > e50f, bar.close > e200f, e50f > e200f, bar.close < e50f];
    const capBits = [bar.close > e50c, bar.close > e200c, e50c > e200c, bar.close < e50c];
    if (fullBits.some(Boolean)) sawTrue = true;
    if (fullBits.some((bit) => !bit)) sawFalse = true;
    expect(capBits, `${bar.ts}`).toEqual(fullBits);
  }
  expect(window.length).toBe(42);
  expect(Math.max(...diffs)).toBeLessThan(1);
  expect(sawTrue).toBe(true);
  expect(sawFalse).toBe(true);
  const days = new Map<string, DailyBar>();
  for (const bar of full) {
    const date = new Date(bar.ts * 1000).toISOString().slice(0, 10);
    const row = days.get(date);
    if (!row) days.set(date, { date, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
    else {
      row.high = Math.max(row.high, bar.high);
      row.low = Math.min(row.low, bar.low);
      row.close = bar.close;
      row.volume += bar.volume;
    }
  }
  const daily = [...days.values()];
  const dailyAtr = wilderAtr(daily.map((bar) => bar.high), daily.map((bar) => bar.low), daily.map((bar) => bar.close), 14);
  const key = (row: { entryTs: number; stopBps: number; targetBps: number }) => `${row.entryTs}|${row.stopBps}|${row.targetBps}`;
  const fullEntries = classCSetups("ICP-USD", daily, full, () => true, dailyAtr).map(key);
  const capEntries = classCSetups("ICP-USD", daily, cap, () => true, dailyAtr).map(key);
  expect(capEntries).toEqual(fullEntries);
});
