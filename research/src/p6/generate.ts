/**
 * A–E entries from completed REST 15-minute bars.
 * Daily, 1h, and 4h bars are derived with the same bucket function as P5.
 * Class bars go through classBarInputs. B enters at the Monday 01:00 open.
 */

import type { MinuteRow } from "../data/candles";
import { deriveBars } from "../data/derive";
import { BAR_SEC } from "../data/time";
import { classBarInputs, type GroupFlags, type SourceDay } from "../p3/bar-access";
import { classBScore } from "../p3/classes";
import { CLASS_B_DISASTER_ATR } from "../p3/design-rules";
import { classDCandidates } from "../p3/d-geometry";
import { btcVeto, classCSetups, classEEntries, type BarOHLC, type BtcDay } from "../p3/signals";
import { ema, wilderAtr } from "../p2/indicators";
import type { Ohlcv } from "../../vendor/87b35d0/indicators.ts";
import { isDayCloseBar } from "../p5/book";
import { collectA, isMondayCloseBar, weekSelection, x1EntryTs } from "../p5/run";
import { addDays } from "../p5/stats";
import type { ClassId } from "../p3/portfolio";
import type { ClassBRow } from "../p3/design-rules";
import { WINDOW_START } from "../p3/f5";
import type { ForwardEvent } from "./engine";
import { A_REGISTRATION, readForwardPick, type ALookback } from "./select";

export interface FifteenBar {
  productId: string;
  startSec: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface GeneratedEntry {
  kind: "x1" | "d-order";
  classId: ClassId;
  productId: string;
  tsMs: number;
  nextOpen: number;
  stop: number;
  target: number | null;
  dailyAtr: number;
  /** Ten daily closes strictly before the entry date. The engine rolls the 10-day exit from these. */
  priorDailyCloses: number[];
  signalDate: string;
  /** Registered A config that produced this entry. Other classes leave it unset. */
  aConfig?: string;
  /** True when the next open is not in the series yet. The host fills it at the entry time. */
  fillAtOpen?: boolean;
}

export interface GenerateResult {
  entries: GeneratedEntry[];
  /** One row per Monday-close week. Scores are known at that week's close bar. */
  weeks: { date: string; rows: ClassBRow[] }[];
  atrByProduct: Map<string, Map<string, number>>;
}

export interface GenerateInput {
  bars: readonly FifteenBar[];
  nowSec: number;
  flags: GroupFlags;
  flagsByProduct?: ReadonlyMap<string, GroupFlags>;
  memberOn?: (productId: string, date: string) => boolean;
  young?: (productId: string) => boolean;
  veto?: (date: string) => boolean;
  /**
   * A config under test. The forward book omits both and reads the stamped pick.
   * There is no built-in config.
   */
  lookback?: ALookback;
  k?: number;
  /** Overrides the stamped pick when lookback and k are omitted. */
  pick?: { lookback: ALookback; k: number };
  /** Daily bars before the 15m window. In-window days stay on the 15m derivation. */
  earlierDays?: ReadonlyMap<string, readonly SourceDay[]>;
  /**
   * Daily history loaded before the first live bar. Unlike earlierDays, this is
   * not cut at 2025-10-11. A prebuilt `products` book ignores it.
   */
  warmupDays?: ReadonlyMap<string, readonly SourceDay[]>;
  /**
   * Prebuilt class bars. When set, these replace 15m derivation so the series
   * matches loadPair, including empty days and the listing date.
   */
  products?: ReadonlyMap<string, { days: readonly SourceDay[]; hour: readonly BarOHLC[]; four: readonly BarOHLC[]; quarter: readonly BarOHLC[] }>;
}

function completed(bars: readonly FifteenBar[], nowSec: number): FifteenBar[] {
  return bars.filter((bar) => bar.startSec % BAR_SEC === 0 && bar.startSec + BAR_SEC <= nowSec && bar.open > 0 && bar.close > 0);
}

function minutesOf(bars: readonly FifteenBar[], nowSec: number): MinuteRow[] {
  const done = completed(bars, nowSec);
  if (done.length === 0) return [];
  const byTs = new Map(done.map((bar) => [bar.startSec, bar]));
  const start = Math.min(...done.map((bar) => bar.startSec));
  const rows: MinuteRow[] = [];
  for (let ts = start; ts + BAR_SEC <= nowSec; ts += BAR_SEC) {
    const bar = byTs.get(ts);
    if (!bar) {
      rows.push({ minuteSec: ts, empty: true, open: null, high: null, low: null, close: null, volume: null });
      continue;
    }
    rows.push({
      minuteSec: ts,
      empty: false,
      open: String(bar.open),
      high: String(bar.high),
      low: String(bar.low),
      close: String(bar.close),
      volume: String(bar.volume),
    });
  }
  return rows;
}

function num(value: string | null): number {
  const parsed = value == null ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface DerivedBook {
  days: SourceDay[];
  hour: BarOHLC[];
  four: BarOHLC[];
  quarter: BarOHLC[];
}

export function deriveForwardBook(bars: readonly FifteenBar[], nowSec: number): DerivedBook | null {
  const minutes = minutesOf(bars, nowSec);
  if (minutes.length === 0) return null;
  const start = minutes[0]!.minuteSec;
  const end = nowSec;
  const daily = deriveBars(minutes, "1d", start, end);
  const hour = deriveBars(minutes, "1h", start, end);
  const four = deriveBars(minutes, "4h", start, end);
  const days: SourceDay[] = [];
  for (const bar of daily) {
    const date = new Date(bar.openTs * 1000).toISOString().slice(0, 10);
    if (bar.empty || bar.close == null) {
      days.push({ date, ts: bar.openTs, open: 0, high: 0, low: 0, close: 0, volume: 0, empty: true });
      continue;
    }
    days.push({
      date,
      ts: bar.openTs,
      open: num(bar.open),
      high: num(bar.high),
      low: num(bar.low),
      close: num(bar.close),
      volume: num(bar.volume),
      empty: false,
    });
  }
  const asBar = (bar: (typeof hour)[number]): BarOHLC | null => {
    if (bar.empty || bar.open == null || bar.close == null) return null;
    return { ts: bar.openTs, open: num(bar.open), high: num(bar.high), low: num(bar.low), close: num(bar.close), volume: num(bar.volume) };
  };
  const quarter = completed(bars, nowSec).map((bar) => ({
    ts: bar.startSec,
    open: bar.open,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
  return {
    days,
    hour: hour.map(asBar).filter((bar): bar is BarOHLC => bar != null),
    four: four.map(asBar).filter((bar): bar is BarOHLC => bar != null),
    quarter,
  };
}

/** A missing calendar day stays in the series as an explicit empty day. */
export function withExplicitGaps(days: readonly SourceDay[]): SourceDay[] {
  if (days.length === 0) return [];
  const sorted = days.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  const out: SourceDay[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const row = sorted[index]!;
    if (index > 0) {
      let date = addDays(sorted[index - 1]!.date, 1);
      while (date < row.date) {
        out.push({ date, ts: Date.parse(`${date}T00:00:00.000Z`) / 1000, open: 0, high: 0, low: 0, close: 0, volume: 0, empty: true });
        date = addDays(date, 1);
      }
    }
    out.push(row);
  }
  return out;
}

/**
 * ATR of the latest completed day. An intraday bar uses the previous day.
 * The day-close bar may use that day's own ATR, which is complete at the close.
 */
export function lastCompletedDailyAtr(atrByDate: ReadonlyMap<string, number>, date: string, includeDate = false): number {
  let best = "";
  let value = 0;
  for (const [day, atr] of atrByDate) {
    if ((includeDate ? day <= date : day < date) && atr > 0 && (best === "" || day > best)) {
      best = day;
      value = atr;
    }
  }
  return value;
}

/** The registered BTC veto, from daily closes and 4h closes. */
export function vetoFromBtc(days: readonly SourceDay[], four: readonly BarOHLC[]): (date: string) => boolean {
  const filled = days.filter((row) => !row.empty && row.close > 0);
  const closes = filled.map((row) => row.close);
  const ema50 = ema(closes, 50);
  const level = ema(four.map((bar) => bar.close), 50);
  const fourBelow = new Map<string, boolean>();
  four.forEach((bar, index) => {
    const value = level[index];
    if (value == null) return;
    fourBelow.set(new Date(bar.ts * 1000).toISOString().slice(0, 10), bar.close < value);
  });
  const byDate = new Map<string, BtcDay>();
  filled.forEach((row, index) => {
    const prev = filled[index - 1];
    byDate.set(row.date, {
      date: row.date,
      close: row.close,
      ema50: ema50[index] ?? null,
      dailyMove: prev && prev.close > 0 ? (row.close - prev.close) / prev.close : null,
      below4hEma: fourBelow.get(row.date) ?? false,
    });
  });
  return (date) => btcVeto(byDate.get(date));
}

function priorCloses(ohlc: readonly { date: string; close: number }[], entryDate: string): number[] {
  const end = ohlc.findIndex((row) => row.date >= entryDate);
  const slice = ohlc.slice(0, end < 0 ? ohlc.length : end).slice(-10);
  return slice.map((row) => row.close).filter((close) => Number.isFinite(close));
}

/** Registered id for the lookback and k that produced a class A entry. */
export function registeredAConfig(lookback: ALookback, k: number): string {
  const row = A_REGISTRATION.find((item) => item.lookback === lookback && item.k === k);
  if (!row) throw new Error(`unregistered A config ${lookback} ${k}`);
  return row.id;
}

/** P5 young-listing flag: a known first print and fewer than 200 nonempty days before the universe date. */
export function p5Young(days: readonly SourceDay[]): boolean {
  const listed = days.some((row) => !row.empty);
  const before = days.filter((row) => !row.empty && row.date < "2025-11-10").length;
  return listed && before < 200;
}

export function generateForward(input: GenerateInput): GenerateResult {
  const chosen = input.lookback != null && input.k != null ? { lookback: input.lookback, k: input.k } : (input.pick ?? readForwardPick());
  const lookback = chosen.lookback;
  const k = chosen.k;
  const aConfig = registeredAConfig(lookback, k);
  const memberOn = input.memberOn ?? (() => true);
  const veto = input.veto ?? (() => false);
  const ids = [...new Set([...(input.products?.keys() ?? []), ...(input.warmupDays?.keys() ?? []), ...input.bars.map((bar) => bar.productId)])].sort();
  const books = new Map<string, DerivedBook>();
  for (const id of ids) {
    const prepared = input.products?.get(id);
    if (prepared) {
      books.set(id, { days: [...prepared.days], hour: [...prepared.hour], four: [...prepared.four], quarter: [...prepared.quarter] });
      continue;
    }
    const derived = deriveForwardBook(input.bars.filter((bar) => bar.productId === id), input.nowSec);
    if (derived) books.set(id, derived);
    else if ((input.warmupDays?.get(id)?.length ?? 0) > 0) books.set(id, { days: [], hour: [], four: [], quarter: [] });
  }
  const out: GeneratedEntry[] = [];
  const bRows: { id: string; date: string; score: number; member: boolean }[] = [];
  const atrByProduct = new Map<string, Map<string, number>>();
  for (const id of ids) {
    const book = books.get(id);
    if (!book) continue;
    const first = book.days[0]?.date ?? "9999-99-99";
    const fromProducts = input.products?.has(id) === true;
    const warmup = fromProducts ? [] : (input.warmupDays?.get(id) ?? []).filter((row) => row.date < first);
    const prior = fromProducts ? [] : (input.earlierDays?.get(id) ?? []).filter((row) => row.date < "2025-10-11" && row.date < first);
    const merged = new Map<string, SourceDay>();
    for (const row of [...warmup, ...prior, ...book.days]) merged.set(row.date, row);
    const days = fromProducts ? [...merged.values()].sort((a, b) => (a.date < b.date ? -1 : 1)) : withExplicitGaps([...merged.values()]);
    const listed = days.find((row) => !row.empty)?.date ?? null;
    const young = input.young ? input.young(id) : p5Young(days);
    const inputs = classBarInputs(input.flagsByProduct?.get(id) ?? input.flags, days, listed ?? WINDOW_START);
    const atrOn = wilderAtr(inputs.ohlc.map((row) => row.high), inputs.ohlc.map((row) => row.low), inputs.ohlc.map((row) => row.close), 14);
    const atrByDate = new Map<string, number>();
    inputs.ohlc.forEach((row, index) => {
      const value = atrOn[index];
      if (value != null && value > 0) atrByDate.set(row.date, value);
    });
    atrByProduct.set(id, atrByDate);
    const hour = book.hour.map((bar) => ({ ts: bar.ts, open: bar.open }));
    for (const signal of collectA(id, inputs, atrByDate, hour, (date) => memberOn(id, date), young, veto)) {
      if (signal.lookback !== lookback) continue;
      const open = hour.find((bar) => bar.ts === signal.entryTs)?.open;
      if (open == null) {
        if (signal.entryTs >= input.nowSec) {
          out.push({
            kind: "x1",
            classId: "A",
            productId: id,
            tsMs: signal.entryTs * 1000,
            nextOpen: 0,
            stop: 0,
            target: null,
            dailyAtr: signal.atr,
            priorDailyCloses: priorCloses(inputs.ohlc, new Date(signal.entryTs * 1000).toISOString().slice(0, 10)),
            signalDate: signal.date,
            aConfig,
            fillAtOpen: true,
          });
        }
        continue;
      }
      const stop = open - k * signal.atr;
      if (!(stop > 0) || !(stop < open)) continue;
      out.push({
        kind: "x1",
        classId: "A",
        productId: id,
        tsMs: signal.entryTs * 1000,
        nextOpen: open,
        stop,
        target: null,
        dailyAtr: signal.atr,
        priorDailyCloses: priorCloses(inputs.ohlc, new Date(signal.entryTs * 1000).toISOString().slice(0, 10)),
        signalDate: signal.date,
        aConfig,
      });
    }
    inputs.closeLookback.forEach((bar, index) => {
      if (!isMondayCloseBar(bar.date)) return;
      const score = classBScore(inputs.closeLookback.map((row) => row.close), index);
      if (score == null || !memberOn(id, bar.date)) return;
      bRows.push({ id, date: bar.date, score, member: true });
    });
    const cAtr = inputs.classC.map((row) => atrByDate.get(row.date) ?? null);
    for (const setup of classCSetups(id, inputs.classC, book.four, (date) => memberOn(id, date), cAtr)) {
      const closeSec = setup.entryTs / 1000;
      const bar = book.four.find((row) => row.ts + 14_400 === closeSec);
      if (!bar) continue;
      const stop = bar.close * (1 - setup.stopBps / 10_000);
      const target = bar.close * (1 + setup.targetBps / 10_000);
      out.push({
        kind: "x1",
        classId: "C",
        productId: id,
        tsMs: setup.entryTs,
        nextOpen: bar.close,
        stop,
        target,
        dailyAtr: atrByDate.get(setup.date) ?? 0,
        priorDailyCloses: [],
        signalDate: setup.date,
      });
    }
    const h4: Ohlcv[] = book.four.map((bar) => ({ ts: bar.ts * 1000, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume }));
    for (const signal of classDCandidates(id, h4, inputs.swing, inputs.bias)) {
      out.push({
        kind: "d-order",
        classId: "D",
        productId: id,
        tsMs: signal.barTs,
        nextOpen: signal.entry,
        stop: signal.stop,
        target: signal.target,
        dailyAtr: 0,
        priorDailyCloses: [],
        signalDate: new Date(signal.barTs).toISOString().slice(0, 10),
      });
    }
    for (const signal of classEEntries(book.hour, book.quarter, (date) => memberOn(id, date))) {
      out.push({
        kind: "x1",
        classId: "E",
        productId: id,
        tsMs: signal.entryTs * 1000,
        nextOpen: signal.entry,
        stop: signal.stop,
        target: signal.target,
        dailyAtr: 0,
        priorDailyCloses: [],
        signalDate: signal.date,
      });
    }
  }
  const byWeek = new Map<string, { id: string; date: string; score: number; member: boolean }[]>();
  for (const row of bRows) {
    const list = byWeek.get(row.date) ?? [];
    list.push(row);
    byWeek.set(row.date, list);
  }
  for (const date of [...byWeek.keys()].sort()) {
    const week = weekSelection(date, byWeek.get(date)!);
    for (const id of [...week.selected].sort()) {
      if (veto(date)) continue;
      const book = books.get(id);
      const atr = atrByProduct.get(id)?.get(date);
      if (!book || atr == null || !(atr > 0)) continue;
      const entryTs = x1EntryTs(date);
      const open = book.hour.find((bar) => bar.ts === entryTs)?.open;
      if (open == null || !(open > 0)) continue;
      const stop = open - CLASS_B_DISASTER_ATR * atr;
      if (!(stop > 0)) continue;
      out.push({
        kind: "x1",
        classId: "B",
        productId: id,
        tsMs: entryTs * 1000,
        nextOpen: open,
        stop,
        target: null,
        dailyAtr: atr,
        priorDailyCloses: [],
        signalDate: date,
      });
    }
  }
  out.sort((a, b) => a.tsMs - b.tsMs || (a.productId < b.productId ? -1 : 1) || (a.classId < b.classId ? -1 : 1));
  const weeks = [...byWeek.keys()].sort().map((date) => ({ date, rows: byWeek.get(date)! }));
  return { entries: out, weeks, atrByProduct };
}

/** Wilder ATR of the derived 1h bars, using only hours that have already closed. */
export function hourAtrAt(hour: readonly BarOHLC[], ts: number): number {
  if (hour.length === 0) return 0;
  const series = wilderAtr(hour.map((bar) => bar.high), hour.map((bar) => bar.low), hour.map((bar) => bar.close), 14);
  let value = 0;
  for (let index = 0; index < hour.length; index += 1) {
    const bar = hour[index]!;
    if (bar.ts + 3_600 <= ts) value = series[index] ?? 0;
    else break;
  }
  return value > 0 ? value : 0;
}

/** Fields a live 15m bar carries into the engine: 1h ATR, daily ATR, B scores, and the day-close flag. */
export function forwardBarAnnotation(
  generated: GenerateResult,
  hour: readonly BarOHLC[],
  productId: string,
  startSec: number,
): { atr1h: number; dailyAtr: number; bScores: ClassBRow[] | undefined; dailyClose: boolean } {
  const date = new Date(startSec * 1000).toISOString().slice(0, 10);
  let bScores: ClassBRow[] | undefined;
  for (const week of generated.weeks) if (week.date <= date) bScores = week.rows;
  return {
    atr1h: hourAtrAt(hour, startSec),
    dailyAtr: lastCompletedDailyAtr(generated.atrByProduct.get(productId) ?? new Map(), date, isDayCloseBar(startSec)),
    bScores,
    dailyClose: isDayCloseBar(startSec),
  };
}

export function generateEntries(input: GenerateInput): GeneratedEntry[] {
  return generateForward(input).entries;
}

/** Bid/ask whose half spread is 5 bps, so a non-parity fill matches s_bt base. */
export function quoteAt(price: number): { bid: number; ask: number } {
  const bid = price;
  const ask = price * (2.001 / 1.999);
  return { bid, ask };
}

export function entriesToEvents(entries: readonly GeneratedEntry[]): ForwardEvent[] {
  return entries.map((entry) => {
    const quote = quoteAt(entry.nextOpen);
    if (entry.kind === "d-order") {
      return {
        kind: "d-order" as const,
        id: `${entry.classId}-${entry.productId}-${entry.tsMs}`,
        productId: entry.productId,
        limit: entry.nextOpen,
        units: 1,
        placedTs: entry.tsMs,
        stop: entry.stop,
        bid: quote.bid,
        ask: quote.ask,
        bookTsMs: entry.tsMs,
        decisionMid: entry.nextOpen,
        tick: 0.01,
        target: entry.target ?? undefined,
      };
    }
    return {
      kind: "x1" as const,
      id: `${entry.classId}-${entry.productId}-${entry.tsMs}`,
      classId: entry.classId,
      productId: entry.productId,
      tsMs: entry.tsMs,
      nextOpen: entry.nextOpen,
      stop: entry.stop,
      atr1h: Math.max(entry.dailyAtr / 24, 0.01),
      bid: quote.bid,
      ask: quote.ask,
      bookTsMs: entry.tsMs,
      sendTsMs: entry.tsMs,
      decisionMid: entry.nextOpen,
      target: entry.target ?? undefined,
      dailyAtr: entry.dailyAtr,
      priorDailyCloses: entry.priorDailyCloses,
      ...(entry.aConfig ? { aConfig: entry.aConfig } : {}),
    };
  });
}
