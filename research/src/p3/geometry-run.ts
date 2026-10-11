/**
 * Geometry scan over the D1 daily supplement and the D2 15m lift.
 * Counts, widths, shares, and coverage only.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { deriveBars } from "../data/derive";
import type { MinuteRow } from "../data/candles";
import { readPairMonth } from "../data/store";
import { ema, wilderAtr } from "../p2/indicators";
import { csMedianBps, corwinSchultzBps, medianUsdWithGaps } from "../p2/liquidity";
import { passCountFlag, type VolumeTierDecision } from "../p2/universe";
import { classBScore, type DailyBar } from "./classes";
import { buildMembership, type NameDateSample } from "./membership-build";
import { countClassA, countClassB, countClassC, countClassD, countClassE, emptyCounts, CLASS_A_STOP_K, type BtcDay, type ClassCounts } from "./signals";
import { membershipDates, monthlyRebalanceDates, OVERLAP_TOLERANCE } from "./schedule";
import type { BarOHLC } from "./signals";

export const SUPPLEMENT_BEFORE = "2025-10-11";
const DAY = 86400;
const Q = 900;

export function supplementApplies(date: string): boolean {
  return date < SUPPLEMENT_BEFORE;
}

interface DayRow {
  date: string;
  ts: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quote: number;
  empty: boolean;
}

export interface PairFacts {
  productId: string;
  days: DayRow[];
  listedDate: string | null;
  leftCensored: boolean;
  hour: BarOHLC[];
  /** Non-empty 15m bars, used by class E. */
  quarter: BarOHLC[];
  /** Every stored 15m slot, including empty placeholders, used by the liquidity legs. */
  quarterSlots: QuarterSlot[];
  four: BarOHLC[];
  overlapFlags: number;
  overlapDays: number;
  overlapDetail: OverlapFlag[];
}

export interface OverlapFlag {
  productId: string;
  date: string;
  closeRel: number;
  highRel: number;
  lowRel: number;
  volumeRel: number;
}

export interface QuarterSlot {
  ts: number;
  empty: boolean;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function num(value: string | null): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function rowsOf(dir: string, pair: string): MinuteRow[] {
  const folder = join(dir, pair);
  let names: string[] = [];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith(".sqlite") && !name.includes("partial"));
  } catch {
    return [];
  }
  const rows: MinuteRow[] = [];
  for (const name of names.sort()) rows.push(...readPairMonth(join(folder, name)).rows);
  rows.sort((a, b) => a.minuteSec - b.minuteSec);
  return rows;
}

function dayFrom(ts: number, high: number, low: number, close: number, volume: number, empty: boolean): DayRow {
  const date = new Date(ts * 1000).toISOString().slice(0, 10);
  const quote = empty ? 0 : volume * close;
  return { date, ts, high, low, close, volume, quote, empty };
}

export function loadPair(productId: string, dailyDir: string, candleDir: string): PairFacts | null {
  const dailyRows = rowsOf(dailyDir, productId);
  const fifteen = rowsOf(candleDir, productId);
  if (dailyRows.length === 0 && fifteen.length === 0) return null;
  const early: DayRow[] = [];
  for (const row of dailyRows) {
    const date = new Date(row.minuteSec * 1000).toISOString().slice(0, 10);
    if (!supplementApplies(date)) continue;
    if (row.empty || row.close == null || row.high == null || row.low == null) {
      early.push(dayFrom(row.minuteSec, 0, 0, 0, 0, true));
      continue;
    }
    early.push(dayFrom(row.minuteSec, num(row.high) ?? 0, num(row.low) ?? 0, num(row.close) ?? 0, num(row.volume) ?? 0, false));
  }
  const start = Date.parse(`${SUPPLEMENT_BEFORE}T00:00:00.000Z`) / 1000;
  const end = Date.parse("2026-10-11T00:00:00.000Z") / 1000;
  const derived = fifteen.length > 0 ? deriveBars(fifteen, "1d", start, end) : [];
  const inside: DayRow[] = derived.map((bar) => {
    if (bar.empty || bar.close == null || bar.high == null || bar.low == null) return dayFrom(bar.openTs, 0, 0, 0, 0, true);
    return dayFrom(bar.openTs, num(bar.high) ?? 0, num(bar.low) ?? 0, num(bar.close) ?? 0, num(bar.volume) ?? 0, false);
  });
  const byDate = new Map<string, DayRow>();
  for (const row of dailyRows) {
    const date = new Date(row.minuteSec * 1000).toISOString().slice(0, 10);
    if (supplementApplies(date)) continue;
    if (row.empty || row.close == null) continue;
    byDate.set(date, dayFrom(row.minuteSec, num(row.high) ?? 0, num(row.low) ?? 0, num(row.close) ?? 0, num(row.volume) ?? 0, false));
  }
  let overlapDays = 0;
  let overlapFlags = 0;
  const overlapDetail: OverlapFlag[] = [];
  for (const row of inside) {
    if (row.empty) continue;
    const other = byDate.get(row.date);
    if (!other || other.empty) continue;
    overlapDays += 1;
    if (!ohlcvDiffers(row, other)) continue;
    overlapFlags += 1;
    overlapDetail.push({
      productId,
      date: row.date,
      closeRel: relDiff(row.close, other.close),
      highRel: relDiff(row.high, other.high),
      lowRel: relDiff(row.low, other.low),
      volumeRel: relDiff(row.volume, other.volume),
    });
  }
  const days = [...early, ...inside].filter((row, index, all) => all.findIndex((item) => item.date === row.date) === index);
  days.sort((a, b) => (a.date < b.date ? -1 : 1));
  const listed = days.find((row) => !row.empty) ?? null;
  const toBar = (bar: { openTs: number; empty: boolean; open: string | null; high: string | null; low: string | null; close: string | null; volume: string | null }): BarOHLC | null => {
    if (bar.empty || bar.close == null || bar.high == null || bar.low == null || bar.open == null) return null;
    return { ts: bar.openTs, open: num(bar.open) ?? 0, high: num(bar.high) ?? 0, low: num(bar.low) ?? 0, close: num(bar.close) ?? 0, volume: num(bar.volume) ?? 0 };
  };
  const hour = fifteen.length > 0 ? deriveBars(fifteen, "1h", start, end).map(toBar).filter((bar): bar is BarOHLC => bar != null) : [];
  const four = fifteen.length > 0 ? deriveBars(fifteen, "4h", start, end).map(toBar).filter((bar): bar is BarOHLC => bar != null) : [];
  const quarterSlots: QuarterSlot[] = fifteen.map((row) => {
    if (row.empty || row.close == null || row.high == null || row.low == null) {
      return { ts: row.minuteSec, empty: true, high: 0, low: 0, close: 0, volume: 0 };
    }
    return {
      ts: row.minuteSec,
      empty: false,
      high: num(row.high) ?? 0,
      low: num(row.low) ?? 0,
      close: num(row.close) ?? 0,
      volume: num(row.volume) ?? 0,
    };
  });
  const quarter = quarterSlots
    .filter((row) => !row.empty)
    .map((row) => ({ ts: row.ts, open: row.close, high: row.high, low: row.low, close: row.close, volume: row.volume }));
  return {
    productId,
    days,
    listedDate: listed?.date ?? null,
    leftCensored: listed?.date === "2023-10-11",
    hour,
    quarter,
    quarterSlots,
    four,
    overlapFlags,
    overlapDays,
    overlapDetail,
  };
}

function relDiff(left: number, right: number): number {
  return Math.abs(left - right) / Math.max(Math.abs(right), 1e-12);
}

export function ohlcvDiffers(left: { high: number; low: number; close: number; volume: number }, right: { high: number; low: number; close: number; volume: number }): boolean {
  const priceOff = (a: number, b: number) => relDiff(a, b) > OVERLAP_TOLERANCE.priceRelative;
  const volOff = Math.abs(left.volume - right.volume) / Math.max(right.volume, 1e-12) > OVERLAP_TOLERANCE.volumeRelative;
  return priceOff(left.high, right.high) || priceOff(left.low, right.low) || priceOff(left.close, right.close) || volOff;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function quoteAt(days: readonly DayRow[], date: string): number | null {
  const end = days.filter((row) => row.date < date).slice(-90);
  if (end.length < 90) return null;
  return median(end.map((row) => row.quote));
}

export function liquidityAt(quarter: readonly QuarterSlot[], date: string): { nonemptyShare: number; medianUsd: number; csMedianBps: number } | null {
  const end = Date.parse(`${date}T00:00:00.000Z`) / 1000;
  const start = end - 30 * DAY;
  const window = quarter.filter((bar) => bar.ts >= start && bar.ts < end);
  const expected = 30 * 24 * 4;
  if (window.length === 0 && expected === 0) return null;
  const nonempty = window.filter((bar) => !bar.empty).length;
  const usd = window.map((bar) => (bar.empty || !(bar.close > 0) ? 0 : bar.volume * bar.close));
  const estimates: number[] = [];
  for (let i = 1; i < window.length; i += 1) {
    const a = window[i - 1]!;
    const b = window[i]!;
    if (a.ts + Q !== b.ts || a.empty || b.empty) continue;
    estimates.push(corwinSchultzBps(a.high, a.low, b.high, b.low));
  }
  const cs = csMedianBps(estimates);
  if (cs == null) return null;
  return { nonemptyShare: nonempty / expected, medianUsd: medianUsdWithGaps(usd, expected), csMedianBps: cs };
}

function swingLow(bars: readonly BarOHLC[], index: number): number | null {
  if (index < 2) return null;
  const mid = bars[index - 1]!;
  if (mid.low < bars[index - 2]!.low && mid.low < bars[index]!.low) return mid.low;
  return null;
}

function addCounts(into: ClassCounts, extra: ClassCounts): void {
  into.signals += extra.signals;
  into.oosSignals += extra.oosSignals;
  into.stops.push(...extra.stops);
  into.vetoed += extra.vetoed;
  into.oldClause += extra.oldClause;
  into.caution += extra.caution;
}

function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? null;
}

export interface WarmupIndicator {
  indicator: "listing" | "ema50" | "ema200" | "atr14" | "cs15m";
  source: "D1" | "15m-derived" | "15m" | "unavailable";
  readyOn: string | null;
}

export interface WarmupRow {
  productId: string;
  listedDate: string | null;
  leftCensored: boolean;
  shortHistoryFallback: boolean;
  indicators: WarmupIndicator[];
}

export interface GeometryResult {
  volumeTier: VolumeTierDecision;
  above5m: number[];
  passCountFlag: ReturnType<typeof passCountFlag>;
  passCounts: { date: string; legA: number; legB: number; legC: number; tier: number; combined: number }[];
  universeSize: { date: string; names: number }[];
  signalCounts: Record<string, { signals: number; oosSignals: number }>;
  projectedOos: { layout: string; n: Record<string, number> };
  d3: {
    a: { available: false; reason: string };
    b: { label: string; isStart: string; isEnd: string; oosStart: string; oosEnd: string };
    c: { historicalOosN: 0; note: string };
  };
  stopWidths: Record<string, { p10: number | null; p50: number | null; p90: number | null }>;
  btcFilterShares: { veto: number; oldClause: number; caution: number };
  overlap: { days: number; flagged: number; tolerance: typeof OVERLAP_TOLERANCE; flaggedDays: OverlapFlag[] };
  warmup: { names: number; ema200ReadyByFirstUniverse: number; leftCensored: number };
  warmupRows: WarmupRow[];
  firstUniverseDate: "2025-11-10";
}

function indicatorReady(days: readonly DayRow[], length: number): { date: string; source: "D1" | "15m-derived" } | null {
  const filled = days.filter((row) => !row.empty);
  const row = filled[length - 1];
  if (!row) return null;
  return { date: row.date, source: supplementApplies(row.date) ? "D1" : "15m-derived" };
}

export function warmupFor(pair: PairFacts): WarmupRow {
  const listing = pair.listedDate;
  const ema50 = indicatorReady(pair.days, 50);
  const ema200 = indicatorReady(pair.days, 200);
  const atr14 = indicatorReady(pair.days, 15);
  const firstSlot = pair.quarterSlots[0];
  const csReady = firstSlot ? new Date((firstSlot.ts + 30 * DAY) * 1000).toISOString().slice(0, 10) : null;
  const nonemptyBefore = pair.days.filter((row) => !row.empty && row.date < "2025-11-10").length;
  return {
    productId: pair.productId,
    listedDate: listing,
    leftCensored: pair.leftCensored,
    shortHistoryFallback: nonemptyBefore < 200,
    indicators: [
      { indicator: "listing", source: listing == null ? "unavailable" : supplementApplies(listing) ? "D1" : "15m-derived", readyOn: listing },
      { indicator: "ema50", source: ema50?.source ?? "unavailable", readyOn: ema50?.date ?? null },
      { indicator: "ema200", source: ema200?.source ?? "unavailable", readyOn: ema200?.date ?? null },
      { indicator: "atr14", source: atr14?.source ?? "unavailable", readyOn: atr14?.date ?? null },
      { indicator: "cs15m", source: "15m", readyOn: csReady },
    ],
  };
}

export function nextDailySwingHigh(days: readonly { date: string; high: number; empty: boolean }[], afterDate: string): number | null {
  const filled = days.filter((row) => !row.empty);
  for (let i = 1; i < filled.length - 1; i += 1) {
    const mid = filled[i]!;
    if (mid.date <= afterDate) continue;
    if (mid.high > filled[i - 1]!.high && mid.high > filled[i + 1]!.high && mid.high > 0) return mid.high;
  }
  return null;
}

function below4hByDate(four: readonly BarOHLC[]): Map<string, boolean> {
  const level = ema(four.map((bar) => bar.close), 50);
  const out = new Map<string, boolean>();
  four.forEach((bar, index) => {
    const ema50 = level[index];
    if (ema50 == null) return;
    out.set(new Date(bar.ts * 1000).toISOString().slice(0, 10), bar.close < ema50);
  });
  return out;
}

function rememberBtc(pair: PairFacts, btcByDate: Map<string, BtcDay>): void {
  if (pair.productId !== "BTC-USD") return;
  const filled = pair.days.filter((row) => !row.empty);
  const closes = filled.map((row) => row.close);
  const ema50 = ema(closes, 50);
  const fourBelow = below4hByDate(pair.four);
  filled.forEach((row, index) => {
    const prev = filled[index - 1];
    btcByDate.set(row.date, {
      date: row.date,
      close: row.close,
      ema50: ema50[index] ?? null,
      dailyMove: prev && prev.close > 0 ? (row.close - prev.close) / prev.close : null,
      below4hEma: fourBelow.get(row.date) ?? false,
    });
  });
}

function sampleOf(pair: PairFacts, date: string): NameDateSample {
  const listed = pair.listedDate == null ? 0 : Math.floor((Date.parse(`${date}T00:00:00.000Z`) - Date.parse(`${pair.listedDate}T00:00:00.000Z`)) / (DAY * 1000));
  return {
    productId: pair.productId,
    volumeUsd: quoteAt(pair.days, date),
    listedDays: listed,
    liquidity: liquidityAt(pair.quarterSlots, date),
  };
}

/** Loads each pair twice so the bar arrays can be released between passes. */
export function scanTwoPass(load: () => Iterable<PairFacts>, excluded: ReadonlySet<string>): GeometryResult {
  const dates = membershipDates();
  const monthly = new Set(monthlyRebalanceDates());
  const sampleCache = new Map<string, NameDateSample[]>();
  for (const date of dates) sampleCache.set(date, []);
  const btcByDate = new Map<string, BtcDay>();
  const warmupRows: WarmupRow[] = [];
  let overlapDays = 0;
  let overlapFlagged = 0;
  const flaggedDays: OverlapFlag[] = [];
  for (const pair of load()) {
    warmupRows.push(warmupFor(pair));
    overlapDays += pair.overlapDays;
    overlapFlagged += pair.overlapFlags;
    flaggedDays.push(...pair.overlapDetail);
    rememberBtc(pair, btcByDate);
    for (const date of dates) sampleCache.get(date)!.push(sampleOf(pair, date));
  }
  const built = buildMembership({
    dates,
    monthlyDates: monthly,
    excluded,
    samplesFor: (date) => sampleCache.get(date) ?? [],
  });
  const { passCounts, members } = built;
  const tier = built.volumeTier;
  const universeSize = dates.map((date) => ({ date, names: members.get(date)?.size ?? 0 }));
  const memberOn = (productId: string, date: string) => {
    const prior = dates.filter((item) => item <= date).pop();
    if (!prior) return false;
    return members.get(prior)?.has(productId) ?? false;
  };
  const totals: Record<string, ClassCounts> = {
    A20: emptyCounts(),
    A55: emptyCounts(),
    B: emptyCounts(),
    C: emptyCounts(),
    D: emptyCounts(),
    E: emptyCounts(),
  };
  const bScores: { date: string; score: number; member: boolean }[] = [];
  const aStops: Record<"L20" | "L55", Record<(typeof CLASS_A_STOP_K)[number], number[]>> = {
    L20: { 2: [], 2.5: [], 3: [] },
    L55: { 2: [], 2.5: [], 3: [] },
  };
  for (const pair of load()) {
    const filled = pair.days.filter((row) => !row.empty);
    const bars: DailyBar[] = filled.map((row) => ({ date: row.date, high: row.high, low: row.low, close: row.close, volume: row.volume }));
    const atr = wilderAtr(bars.map((b) => b.high), bars.map((b) => b.low), bars.map((b) => b.close), 14);
    const young = pair.listedDate != null && pair.days.filter((row) => !row.empty && row.date < "2025-11-10").length < 200;
    const a = countClassA(bars, (date) => memberOn(pair.productId, date), atr, btcByDate, young);
    addCounts(totals.A20!, a.L20);
    addCounts(totals.A55!, a.L55);
    for (const k of CLASS_A_STOP_K) {
      aStops.L20[k].push(...a.stopBpsByK.L20[k]);
      aStops.L55[k].push(...a.stopBpsByK.L55[k]);
    }
    const closes = bars.map((bar) => bar.close);
    for (let i = 0; i < bars.length; i += 1) {
      const bar = bars[i]!;
      if (new Date(`${bar.date}T00:00:00.000Z`).getUTCDay() !== 1) continue;
      const score = classBScore(closes, i);
      if (score == null) continue;
      bScores.push({ date: bar.date, score, member: memberOn(pair.productId, bar.date) });
    }
    addCounts(totals.C!, countClassC(bars, (date) => memberOn(pair.productId, date), atr));
    addCounts(totals.E!, countClassE(pair.hour, pair.quarter, (date) => memberOn(pair.productId, date)));
    const fourAtr = wilderAtr(pair.four.map((b) => b.high), pair.four.map((b) => b.low), pair.four.map((b) => b.close), 14);
    for (let i = 0; i < pair.four.length; i += 1) {
      const bar = pair.four[i]!;
      const date = new Date(bar.ts * 1000).toISOString().slice(0, 10);
      if (!memberOn(pair.productId, date)) continue;
      const atr4 = fourAtr[i];
      if (atr4 == null) continue;
      addCounts(totals.D!, countClassD(bar.close, swingLow(pair.four, i), atr4, nextDailySwingHigh(pair.days, date), date, btcByDate.get(date)));
    }
  }
  addCounts(totals.B!, countClassB(bScores, btcByDate));
  const widths = (values: readonly number[]) => ({
    p10: percentile(values, 10),
    p50: percentile(values, 50),
    p90: percentile(values, 90),
  });
  const kKey = (k: number) => (k === 2.5 ? "k2_5" : `k${k}`);
  const vetoBase = (totals.A20?.signals ?? 0) + (totals.A55?.signals ?? 0) + (totals.B?.signals ?? 0) + (totals.D?.signals ?? 0);
  const share = (n: number) => (vetoBase === 0 ? 0 : n / vetoBase);
  const signalCounts = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, { signals: value.signals, oosSignals: value.oosSignals }]));
  const projected = Object.fromEntries(Object.entries(totals).map(([key, value]) => [key, value.oosSignals]));
  return {
    volumeTier: tier,
    above5m: built.above5m,
    passCountFlag: passCountFlag(passCounts.map((row) => row.combined)),
    passCounts,
    universeSize,
    signalCounts,
    projectedOos: { layout: "D3b", n: projected },
    d3: {
      a: { available: false, reason: "Three-year 15m history was not downloaded." },
      b: {
        label: "1-year, 15m, short-history, EXPLORATORY",
        isStart: "2025-11-10",
        isEnd: "2026-02-09",
        oosStart: "2026-02-10",
        oosEnd: "2026-10-09",
      },
      c: { historicalOosN: 0, note: "Historical OOS under option c is zero. That option is forward-only." },
    },
    stopWidths: {
      ...Object.fromEntries(CLASS_A_STOP_K.map((k) => [`A20_${kKey(k)}`, widths(aStops.L20[k])])),
      ...Object.fromEntries(CLASS_A_STOP_K.map((k) => [`A55_${kKey(k)}`, widths(aStops.L55[k])])),
      C: widths(totals.C!.stops.map((stop) => stop.bps)),
      D: widths(totals.D!.stops.map((stop) => stop.bps)),
      E: widths(totals.E!.stops.map((stop) => stop.bps)),
    },
    btcFilterShares: {
      veto: share((totals.A20?.vetoed ?? 0) + (totals.A55?.vetoed ?? 0) + (totals.B?.vetoed ?? 0) + (totals.D?.vetoed ?? 0)),
      oldClause: share((totals.A20?.oldClause ?? 0) + (totals.A55?.oldClause ?? 0) + (totals.B?.oldClause ?? 0) + (totals.D?.oldClause ?? 0)),
      caution: share((totals.A20?.caution ?? 0) + (totals.A55?.caution ?? 0) + (totals.B?.caution ?? 0) + (totals.D?.caution ?? 0)),
    },
    overlap: {
      days: overlapDays,
      flagged: overlapFlagged,
      tolerance: OVERLAP_TOLERANCE,
      flaggedDays,
    },
    warmup: {
      names: warmupRows.length,
      ema200ReadyByFirstUniverse: warmupRows.filter((row) => {
        const ema200 = row.indicators.find((item) => item.indicator === "ema200");
        return ema200?.readyOn != null && ema200.readyOn < "2025-11-10";
      }).length,
      leftCensored: warmupRows.filter((row) => row.leftCensored).length,
    },
    warmupRows,
    firstUniverseDate: "2025-11-10",
  };
}

export function scanFacts(pairs: readonly PairFacts[], excluded: ReadonlySet<string>): GeometryResult {
  return scanTwoPass(() => pairs, excluded);
}
