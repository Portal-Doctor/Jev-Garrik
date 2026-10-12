/**
 * Replay frozen P5 candles through the P6 generator and the paper engine.
 * Parity is the A20-k2 base book: $60 open risk, s_bt 5, Jev guards off.
 * C, D, and E have no P5 historical trades.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readPairMonth } from "../data/store";
import type { SourceDay } from "../p3/bar-access";
import { btcVeto, type BtcDay } from "../p3/signals";
import { ema, wilderAtr } from "../p2/indicators";
import { registeredFlags, type RegistrationFlagSource } from "../p5/flags";
import { dateOfTs, isDayCloseBar } from "../p5/book";
import { applyForward, freshBook, type Book, type ForwardEvent } from "./engine";
import { generateForward, type FifteenBar, type GeneratedEntry } from "./generate";

const WINDOW_ENTRY_START = "2025-11-11";
const WINDOW_ENTRY_END = "2025-11-18";
const FIFTEEN_FROM = "2025-10-11";
const WALK_THROUGH = "2025-12-16";

export interface PublishedTrade {
  classId: "A" | "B";
  productId: string;
  entryTs: number;
  exitTs: number;
  reason: string;
  fillEntry: number;
  fillExit: number;
  netUsd: number;
  entryRiskUsd: number;
  units: number;
  entryDate: string;
}

export interface ParityDiff {
  productId: string;
  classId: string;
  entryTs: number;
  field: string;
  published: string | number | null;
  engine: string | number | null;
}

interface PxBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function dataDir(): string {
  return join(import.meta.dir, "..", "..", "data");
}

function months(from: string, to: string): string[] {
  const out: string[] = [];
  let year = Number(from.slice(0, 4));
  let month = Number(from.slice(5, 7));
  const endYear = Number(to.slice(0, 4));
  const endMonth = Number(to.slice(5, 7));
  while (year < endYear || (year === endYear && month <= endMonth)) {
    out.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return out;
}

function dayOf(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function readMonths(root: string, productId: string, names: readonly string[]): { ts: number; open: number; high: number; low: number; close: number; volume: number; empty: boolean }[] {
  const folder = join(root, productId);
  const out: { ts: number; open: number; high: number; low: number; close: number; volume: number; empty: boolean }[] = [];
  for (const name of names) {
    const path = join(folder, `${name}.sqlite`);
    if (!existsSync(path)) throw new Error(`missing data file ${path}`);
    const rows = readPairMonth(path).rows;
    for (const row of rows) {
      if (row.empty || row.open == null || row.high == null || row.low == null || row.close == null) {
        out.push({ ts: row.minuteSec, open: 0, high: 0, low: 0, close: 0, volume: 0, empty: true });
        continue;
      }
      out.push({
        ts: row.minuteSec,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume ?? 0),
        empty: false,
      });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function earlierDays(productId: string, dailyRoot: string): SourceDay[] {
  const folder = join(dailyRoot, productId);
  let files: string[] = [];
  try {
    files = readdirSync(folder).filter((name) => name.endsWith(".sqlite"));
  } catch {
    return [];
  }
  const rows = readMonths(dailyRoot, productId, files.map((name) => name.slice(0, 7)));
  return rows
    .filter((row) => dayOf(row.ts) < FIFTEEN_FROM)
    .map((row) => ({
      date: dayOf(row.ts),
      ts: row.ts,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
      empty: row.empty || !(row.close > 0),
    }));
}

function fifteenBars(productId: string, candleRoot: string): FifteenBar[] {
  const rows = readMonths(candleRoot, productId, months("2025-10", "2025-12"));
  const out: FifteenBar[] = [];
  for (const row of rows) {
    if (row.empty || !(row.open > 0) || dayOf(row.ts) < FIFTEEN_FROM || dayOf(row.ts) > WALK_THROUGH) continue;
    out.push({ productId, startSec: row.ts, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
  }
  return out;
}

function pxBars(productId: string, candleRoot: string): PxBar[] {
  return fifteenBars(productId, candleRoot).map((bar) => ({ ts: bar.startSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close }));
}

function memberFn(rows: readonly { date: string; names: string[] }[]): (productId: string, date: string) => boolean {
  const dates = rows.map((row) => row.date).slice().sort();
  const sets = new Map(rows.map((row) => [row.date, new Set(row.names)]));
  return (productId, date) => {
    let prior: string | null = null;
    for (const item of dates) {
      if (item <= date) prior = item;
      else break;
    }
    if (!prior) return false;
    return sets.get(prior)?.has(productId) ?? false;
  };
}

function btcDays(days: readonly SourceDay[], four: readonly PxBar[]): Map<string, BtcDay> {
  const filled = days.filter((row) => !row.empty && row.close > 0);
  const closes = filled.map((row) => row.close);
  const ema50 = ema(closes, 50);
  const level = ema(four.map((bar) => bar.close), 50);
  const fourBelow = new Map<string, boolean>();
  four.forEach((bar, index) => {
    const value = level[index];
    if (value == null) return;
    fourBelow.set(dayOf(bar.ts), bar.close < value);
  });
  const out = new Map<string, BtcDay>();
  filled.forEach((row, index) => {
    const prev = filled[index - 1];
    out.set(row.date, {
      date: row.date,
      close: row.close,
      ema50: ema50[index] ?? null,
      dailyMove: prev && prev.close > 0 ? (row.close - prev.close) / prev.close : null,
      below4hEma: fourBelow.get(row.date) ?? false,
    });
  });
  return out;
}

function atrAt(series: readonly { ts: number; atr: number | null }[], ts: number): number {
  let lo = 0;
  let hi = series.length - 1;
  let value = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const row = series[mid]!;
    if (row.ts + 3600 <= ts) {
      value = row.atr ?? 0;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return value > 0 ? value : 0;
}

function hourAtr(bars: readonly PxBar[]): { ts: number; atr: number | null }[] {
  const hour = new Map<number, PxBar>();
  for (const bar of bars) {
    const open = bar.ts - (bar.ts % 3600);
    const slot = hour.get(open);
    if (!slot) hour.set(open, { ts: open, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    else {
      slot.high = Math.max(slot.high, bar.high);
      slot.low = Math.min(slot.low, bar.low);
      slot.close = bar.close;
    }
  }
  const ordered = [...hour.values()].sort((a, b) => a.ts - b.ts);
  const atr = wilderAtr(ordered.map((bar) => bar.high), ordered.map((bar) => bar.low), ordered.map((bar) => bar.close), 14);
  return ordered.map((bar, index) => ({ ts: bar.ts, atr: atr[index] ?? null }));
}

function dailyAtr(bars: readonly PxBar[]): Map<string, number> {
  const days = new Map<string, PxBar>();
  for (const bar of bars) {
    const date = dayOf(bar.ts);
    const slot = days.get(date);
    if (!slot) days.set(date, { ts: bar.ts, open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    else {
      slot.high = Math.max(slot.high, bar.high);
      slot.low = Math.min(slot.low, bar.low);
      slot.close = bar.close;
    }
  }
  const ordered = [...days.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const atr = wilderAtr(
    ordered.map((row) => row[1].high),
    ordered.map((row) => row[1].low),
    ordered.map((row) => row[1].close),
    14,
  );
  const out = new Map<string, number>();
  ordered.forEach((row, index) => {
    const value = atr[index];
    if (value != null && value > 0) out.set(row[0], value);
  });
  return out;
}

export function publishedA20Trades(): PublishedTrade[] {
  const doc = JSON.parse(readFileSync(join(dataDir(), "reports/p5-v31-results.json"), "utf8")) as {
    results: { trades: (PublishedTrade & { book: string; path: string })[] };
  };
  return doc.results.trades.filter(
    (trade) => trade.book === "A20-k2" && trade.path === "base" && trade.entryDate >= WINDOW_ENTRY_START && trade.entryDate < WINDOW_ENTRY_END,
  );
}

export function replayFrozenWindow(): { diffs: ParityDiff[]; published: PublishedTrade[]; engine: Book["closed"] } {
  const root = dataDir();
  const registration = JSON.parse(readFileSync(join(root, "reports/p4-registration.json"), "utf8")) as RegistrationFlagSource;
  const membership = JSON.parse(readFileSync(join(root, "reports/universe-membership.json"), "utf8")) as { members: { date: string; names: string[] }[] };
  const isMember = memberFn(membership.members);
  const names = [...new Set(membership.members.flatMap((row) => row.names))].filter((id) => isMember(id, "2025-11-16") || isMember(id, "2025-11-10"));
  const flags = registeredFlags(registration, names);
  const candleRoot = join(root, "candles");
  const dailyRoot = join(root, "daily", "candles");
  const bars: FifteenBar[] = [];
  const earlier = new Map<string, SourceDay[]>();
  const px = new Map<string, PxBar[]>();
  for (const id of ["BTC-USD", ...names.filter((id) => id !== "BTC-USD")]) {
    const prior = earlierDays(id, dailyRoot);
    const fifteen = fifteenBars(id, candleRoot);
    if (id === "BTC-USD") {
      earlier.set(id, prior);
      px.set(id, fifteen.map((bar) => ({ ts: bar.startSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
      continue;
    }
    if (!flags.byId.get(id)) continue;
    earlier.set(id, prior);
    bars.push(...fifteen);
    px.set(id, fifteen.map((bar) => ({ ts: bar.startSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
  }
  const btcPrior = earlier.get("BTC-USD") ?? [];
  const btcPx = px.get("BTC-USD") ?? [];
  const btcDaily = [
    ...btcPrior,
    ...(() => {
      const days = new Map<string, SourceDay>();
      for (const bar of btcPx) {
        const date = dayOf(bar.ts);
        const slot = days.get(date);
        if (!slot) days.set(date, { date, ts: bar.ts, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: 0, empty: false });
        else {
          slot.high = Math.max(slot.high, bar.high);
          slot.low = Math.min(slot.low, bar.low);
          slot.close = bar.close;
        }
      }
      return [...days.values()];
    })(),
  ];
  const hour = new Map<number, PxBar>();
  for (const bar of btcPx) {
    const open = bar.ts - (bar.ts % 14400);
    const slot = hour.get(open);
    if (!slot) hour.set(open, { ...bar, ts: open });
    else {
      slot.high = Math.max(slot.high, bar.high);
      slot.low = Math.min(slot.low, bar.low);
      slot.close = bar.close;
    }
  }
  const vetoDays = btcDays(btcDaily, [...hour.values()].sort((a, b) => a.ts - b.ts));
  const veto = (date: string) => btcVeto(vetoDays.get(date));
  const generated = generateForward({
    bars,
    nowSec: Date.parse(`${WALK_THROUGH}T00:00:00.000Z`) / 1000,
    flags: { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false },
    flagsByProduct: flags.byId,
    earlierDays: earlier,
    memberOn: (productId, date) => isMember(productId, date),
    veto,
    lookback: 20,
    k: 2,
  });
  let entries: GeneratedEntry[] = generated.entries;
  entries = entries.filter((entry) => {
    const date = dayOf(Math.floor(entry.tsMs / 1000));
    return (entry.classId === "A" || entry.classId === "B") && date >= WINDOW_ENTRY_START && date < WINDOW_ENTRY_END;
  });
  entries.sort((a, b) => a.tsMs - b.tsMs || (a.classId < b.classId ? -1 : 1) || (a.productId < b.productId ? -1 : 1));
  const atr1h = new Map<string, { ts: number; atr: number | null }[]>();
  const atrDay = new Map<string, Map<string, number>>();
  for (const id of new Set(entries.map((entry) => entry.productId))) {
    const barsFor = px.get(id) ?? [];
    atr1h.set(id, hourAtr(barsFor));
    atrDay.set(id, dailyAtr(barsFor));
  }
  const events: ForwardEvent[] = [];
  const byTs = new Map<number, GeneratedEntry[]>();
  let lastTs = 0;
  for (const entry of entries) {
    const list = byTs.get(entry.tsMs) ?? [];
    list.push(entry);
    byTs.set(entry.tsMs, list);
    const exit = Math.floor(entry.tsMs / 1000) + 40 * 86_400;
    if (exit > lastTs) lastTs = exit;
  }
  const published = publishedA20Trades();
  for (const trade of published) if (trade.exitTs + 900 > lastTs) lastTs = trade.exitTs + 900;
  const firstTs = entries.reduce((min, entry) => Math.min(min, Math.floor(entry.tsMs / 1000)), lastTs);
  const traded = new Set(entries.map((entry) => entry.productId));
  for (const id of traded) {
    for (const bar of px.get(id) ?? []) {
      if (bar.ts < firstTs || bar.ts > lastTs) continue;
      const date = dayOf(bar.ts);
      const week = [...generated.weeks].reverse().find((row) => row.date <= date);
      events.push({
        kind: "bar15",
        productId: id,
        startSec: bar.ts,
        nowSec: bar.ts + 900,
        open: bar.open,
        high: bar.high,
        low: bar.low,
        close: bar.close,
        atr1h: atrAt(atr1h.get(id) ?? [], bar.ts),
        dailyAtr: generated.atrByProduct.get(id)?.get(date) ?? (isDayCloseBar(bar.ts) ? atrDay.get(id)?.get(date) : undefined),
        bScores: week?.rows,
      });
    }
  }
  for (const [ts, list] of byTs) {
    list.sort((a, b) => (a.classId < b.classId ? -1 : 1) || (a.productId < b.productId ? -1 : 1));
    for (const entry of list) {
      const openSec = Math.floor(entry.tsMs / 1000);
      const bar = (px.get(entry.productId) ?? []).find((row) => row.ts === openSec);
      const nextOpen = bar?.open ?? entry.nextOpen;
      events.push({
        kind: "x1",
        id: `${entry.classId}-${entry.productId}-${entry.tsMs}`,
        classId: entry.classId,
        productId: entry.productId,
        tsMs: entry.tsMs,
        nextOpen,
        stop: nextOpen - (entry.nextOpen - entry.stop),
        atr1h: atrAt(atr1h.get(entry.productId) ?? [], openSec),
        bid: nextOpen,
        ask: nextOpen * (2.001 / 1.999),
        bookTsMs: entry.tsMs,
        sendTsMs: entry.tsMs,
        decisionMid: nextOpen,
        dailyAtr: entry.dailyAtr,
        priorDailyCloses: entry.priorDailyCloses,
      });
    }
  }
  events.sort((a, b) => {
    const ta = a.kind === "x1" ? a.tsMs : a.kind === "bar15" ? a.startSec * 1000 : 0;
    const tb = b.kind === "x1" ? b.tsMs : b.kind === "bar15" ? b.startSec * 1000 : 0;
    if (ta !== tb) return ta - tb;
    if (a.kind === "x1" && b.kind !== "x1") return -1;
    if (b.kind === "x1" && a.kind !== "x1") return 1;
    return 0;
  });
  const book = freshBook({ members: [...traded], parity: { riskUsd: 60, sBtBps: 5 } });
  for (const event of events) applyForward(book, event);
  const diffs: ParityDiff[] = [];
  const used = new Set<number>();
  for (const trade of published) {
    const match = book.closed.findIndex(
      (row, index) => !used.has(index) && row.productId === trade.productId && row.classId === trade.classId && Math.abs(row.exitTs / 1000 - trade.exitTs) < 1,
    );
    if (match < 0) {
      diffs.push({ productId: trade.productId, classId: trade.classId, entryTs: trade.entryTs, field: "missing", published: trade.reason, engine: null });
      continue;
    }
    used.add(match);
    const row = book.closed[match]!;
    const entryLeg = book.legs.find((leg) => leg.id === row.id && leg.side === "entry");
    const exitLeg = book.legs.find((leg) => leg.id === `${row.id}:exit`);
    const compare = (field: string, left: number, right: number, tol: number) => {
      if (Math.abs(left - right) > tol) diffs.push({ productId: trade.productId, classId: trade.classId, entryTs: trade.entryTs, field, published: left, engine: right });
    };
    compare("units", trade.units, entryLeg?.units ?? Number.NaN, 1e-4);
    compare("fillEntry", trade.fillEntry, entryLeg?.fillPrice ?? Number.NaN, 1e-8);
    compare("fillExit", trade.fillExit, exitLeg?.fillPrice ?? Number.NaN, 1e-6);
    compare("netUsd", trade.netUsd, row.netUsd, 1e-4);
    compare("netR", trade.netUsd / trade.entryRiskUsd, row.netR, 1e-6);
    compare("exitTs", trade.exitTs, row.exitTs / 1000, 0);
    if (trade.reason !== row.exitKind) diffs.push({ productId: trade.productId, classId: trade.classId, entryTs: trade.entryTs, field: "reason", published: trade.reason, engine: row.exitKind });
  }
  book.closed.forEach((row, index) => {
    if (used.has(index)) return;
    if (row.entryDate >= WINDOW_ENTRY_START && row.entryDate < WINDOW_ENTRY_END) {
      diffs.push({ productId: row.productId, classId: row.classId, entryTs: row.exitTs / 1000, field: "extra", published: null, engine: row.exitKind });
    }
  });
  return { diffs, published, engine: book.closed };
}
