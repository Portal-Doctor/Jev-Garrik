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
import { classCSetups, classEEntries, type BarOHLC } from "../p3/signals";
import { wilderAtr } from "../p2/indicators";
import type { Ohlcv } from "../../vendor/87b35d0/indicators.ts";
import { collectA, isMondayCloseBar, weekSelection, x1EntryTs } from "../p5/run";
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

function deriveProduct(bars: readonly FifteenBar[], nowSec: number): DerivedBook | null {
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
  const ids = [...new Set([...(input.products?.keys() ?? []), ...input.bars.map((bar) => bar.productId)])].sort();
  const books = new Map<string, DerivedBook>();
  for (const id of ids) {
    const prepared = input.products?.get(id);
    if (prepared) {
      books.set(id, { days: [...prepared.days], hour: [...prepared.hour], four: [...prepared.four], quarter: [...prepared.quarter] });
      continue;
    }
    const derived = deriveProduct(input.bars.filter((bar) => bar.productId === id), input.nowSec);
    if (derived) books.set(id, derived);
  }
  const out: GeneratedEntry[] = [];
  const bRows: { id: string; date: string; score: number; member: boolean }[] = [];
  const atrByProduct = new Map<string, Map<string, number>>();
  for (const id of ids) {
    const book = books.get(id);
    if (!book) continue;
    const first = book.days[0]?.date ?? "9999-99-99";
    const prior = input.products?.has(id) ? [] : (input.earlierDays?.get(id) ?? []).filter((row) => row.date < "2025-10-11" && row.date < first);
    const days = [...prior, ...book.days].filter((row, index, all) => all.findIndex((item) => item.date === row.date) === index);
    days.sort((a, b) => (a.date < b.date ? -1 : 1));
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
      if (open == null) continue;
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
