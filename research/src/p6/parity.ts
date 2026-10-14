/**
 * Replay frozen P5 candles through the P6 generator and the paper engine.
 * Parity is the A20-k2 base book: $60 open risk, s_bt 5, Jev guards off.
 * C, D, and E have no P5 historical trades.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rootHash } from "../data/hash";
import { scanCandleFiles } from "../data/manifest-file";
import { readPairMonth } from "../data/store";
import type { SourceDay } from "../p3/bar-access";
import { loadPair } from "../p3/geometry-run";
import { btcVeto, type BarOHLC, type BtcDay } from "../p3/signals";
import { ema, wilderAtr } from "../p2/indicators";
import { daysBetween } from "../p5/stats";
import { verifyDailyStore } from "./daily";
import { A_REGISTRATION, type APick } from "./select";
import { registeredFlags, type RegistrationFlagSource } from "../p5/flags";
import { applyForward, freshBook, type Book, type ForwardEvent } from "./engine";
import { generateForward, type FifteenBar, type GeneratedEntry } from "./generate";
import { WARM } from "./warm-caps";

/** The host caps 4h and 1h at these lengths. This replay keeps the full history. */
export function cappedLength(full: number, kind: "four" | "hour"): number {
  const keep = kind === "four" ? WARM.FOUR_KEEP : WARM.HOUR_KEEP;
  return Math.min(full, keep);
}

export { WARM };

const WINDOW_ENTRY_START = "2025-11-11";
const WINDOW_ENTRY_END = "2025-11-18";
const FIFTEEN_FROM = "2025-10-11";
const WALK_THROUGH = "2025-12-16";

export interface ReplayOpts {
  book?: string;
  lookback?: 20 | 55;
  k?: number;
  entryStart?: string;
  entryEnd?: string;
  fifteenFrom?: string;
  walkThrough?: string;
  /** Full membership. The 7-day replay keeps the November cohort. */
  allNames?: boolean;
  signalsOnly?: boolean;
}

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
  if (!existsSync(folder)) throw new Error(`missing data file ${folder}`);
  const present = readdirSync(folder).filter((name) => name.endsWith(".sqlite")).map((name) => name.slice(0, 7)).sort();
  if (present.length > 0) {
    const first = present[0]!;
    const last = present[present.length - 1]!;
    for (const name of names) {
      if (name < first || name > last) continue;
      if (!present.includes(name)) throw new Error(`missing data file ${join(folder, `${name}.sqlite`)}`);
    }
  }
  const out: { ts: number; open: number; high: number; low: number; close: number; volume: number; empty: boolean }[] = [];
  for (const name of names) {
    const path = join(folder, `${name}.sqlite`);
    if (!existsSync(folder)) throw new Error(`missing data file ${folder}`);
    if (!existsSync(path)) continue;
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

function fifteenBars(productId: string, candleRoot: string, from: string, through: string): FifteenBar[] {
  const rows = readMonths(candleRoot, productId, months(from.slice(0, 7), through.slice(0, 7)));
  const out: FifteenBar[] = [];
  for (const row of rows) {
    if (row.empty || !(row.open > 0) || dayOf(row.ts) < from || dayOf(row.ts) > through) continue;
    out.push({ productId, startSec: row.ts, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume });
  }
  return out;
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

export function publishedTrades(opts: ReplayOpts = {}): (PublishedTrade & { windowMark?: boolean })[] {
  const book = opts.book ?? "A20-k2";
  const entryStart = opts.entryStart ?? WINDOW_ENTRY_START;
  const entryEnd = opts.entryEnd ?? WINDOW_ENTRY_END;
  const doc = JSON.parse(readFileSync(join(dataDir(), "reports/p5-v31-results.json"), "utf8")) as {
    results: { trades: (PublishedTrade & { book: string; path: string; windowMark?: boolean })[] };
  };
  return doc.results.trades.filter(
    (trade) => trade.book === book && trade.path === "base" && trade.entryDate >= entryStart && trade.entryDate < entryEnd,
  );
}

export function publishedA20Trades(): PublishedTrade[] {
  return publishedTrades();
}

export function replayFrozenWindow(opts: ReplayOpts = {}): { diffs: ParityDiff[]; published: PublishedTrade[]; engine: Book["closed"]; entries: GeneratedEntry[]; weeks: { date: string; rows: { id: string; score: number; member: boolean }[] }[] } {
  const entryStart = opts.entryStart ?? WINDOW_ENTRY_START;
  const entryEnd = opts.entryEnd ?? WINDOW_ENTRY_END;
  const fifteenFrom = opts.fifteenFrom ?? FIFTEEN_FROM;
  const walkThrough = opts.walkThrough ?? WALK_THROUGH;
  const lookback = opts.lookback ?? 20;
  const k = opts.k ?? 2;
  const bookId = opts.book ?? `A${lookback}-k${k}`;
  const root = dataDir();
  const registration = JSON.parse(readFileSync(join(root, "reports/p4-registration.json"), "utf8")) as RegistrationFlagSource;
  const membership = JSON.parse(readFileSync(join(root, "reports/universe-membership.json"), "utf8")) as { members: { date: string; names: string[] }[] };
  const isMember = memberFn(membership.members);
  const names = [...new Set(membership.members.flatMap((row) => row.names))].filter((id) => opts.allNames || isMember(id, "2025-11-16") || isMember(id, "2025-11-10"));
  verifyDailyStore(join(root, "daily"), names);
  const flags = registeredFlags(registration, names);
  const candleRoot = join(root, "candles");
  const dailyRoot = join(root, "daily", "candles");
  const px = new Map<string, PxBar[]>();
  const products = new Map<string, { days: SourceDay[]; hour: BarOHLC[]; four: BarOHLC[]; quarter: BarOHLC[] }>();
  const atr1h = new Map<string, { ts: number; atr: number | null }[]>();
  for (const id of ["BTC-USD", ...names.filter((name) => name !== "BTC-USD")]) {
    const pair = loadPair(id, dailyRoot, candleRoot);
    if (!pair) throw new Error(`missing data file ${join(candleRoot, id)}`);
    if (id !== "BTC-USD" && !flags.byId.get(id)) continue;
    products.set(id, { days: pair.days, hour: pair.hour, four: pair.four, quarter: pair.quarter });
    const series = wilderAtr(pair.hour.map((bar) => bar.high), pair.hour.map((bar) => bar.low), pair.hour.map((bar) => bar.close), 14);
    atr1h.set(id, pair.hour.map((bar, index) => ({ ts: bar.ts, atr: series[index] ?? null })));
    const fifteen = fifteenBars(id, candleRoot, fifteenFrom, walkThrough);
    px.set(id, fifteen.map((bar) => ({ ts: bar.startSec, open: bar.open, high: bar.high, low: bar.low, close: bar.close })));
  }
  const btc = products.get("BTC-USD");
  if (!btc) throw new Error(`missing data file ${join(candleRoot, "BTC-USD")}`);
  const vetoDays = btcDays(btc.days, btc.four);
  const veto = (date: string) => btcVeto(vetoDays.get(date));
  const generated = generateForward({
    bars: [],
    nowSec: Date.parse(`${walkThrough}T00:00:00.000Z`) / 1000,
    flags: { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false },
    flagsByProduct: flags.byId,
    products,
    memberOn: (productId, date) => isMember(productId, date),
    veto,
    lookback,
    k,
  });
  let entries: GeneratedEntry[] = generated.entries;
  if (opts.signalsOnly) return { diffs: [], published: [], engine: [], entries, weeks: generated.weeks };
  entries = entries.filter((entry) => {
    const date = dayOf(Math.floor(entry.tsMs / 1000));
    return (entry.classId === "A" || entry.classId === "B") && date >= entryStart && date < entryEnd;
  });
  entries.sort((a, b) => a.tsMs - b.tsMs || (a.classId < b.classId ? -1 : 1) || (a.productId < b.productId ? -1 : 1));
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
  const published = publishedTrades({ book: bookId, entryStart, entryEnd });
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
        dailyAtr: generated.atrByProduct.get(id)?.get(date),
        bScores: week?.rows,
        phase: "gap",
      });
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
        dailyAtr: generated.atrByProduct.get(id)?.get(date),
        bScores: week?.rows,
        phase: "rest",
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
        ...(entry.classId === "A" ? { aConfig: bookId } : {}),
      });
    }
  }
  const order = (event: ForwardEvent) => (event.kind === "bar15" && event.phase === "gap" ? 0 : event.kind === "x1" ? 1 : 2);
  events.sort((a, b) => {
    const ta = a.kind === "x1" ? a.tsMs : a.kind === "bar15" ? a.startSec * 1000 : 0;
    const tb = b.kind === "x1" ? b.tsMs : b.kind === "bar15" ? b.startSec * 1000 : 0;
    if (ta !== tb) return ta - tb;
    return order(a) - order(b);
  });
  const memberCloses = [...products.keys()].filter((id) => flags.byId.has(id)).sort().map((id) => ({
    productId: id,
    flags: flags.byId.get(id)!,
    days: products.get(id)?.days ?? [],
  }));
  const btcCloses = (products.get("BTC-USD")?.days ?? []).filter((row) => !row.empty && row.close > 0).map((row) => ({ date: row.date, close: row.close }));
  const book = freshBook({
    members: [...traded],
    parity: { riskUsd: 60, sBtBps: 5 },
    aPick: parityAPick(bookId, lookback, k),
    memberCloses,
    btcCloses,
    clusterMemberOn: (productId, date) => isMember(productId, date),
  });
  for (const event of events) applyForward(book, event);
  const diffs: ParityDiff[] = [];
  const used = new Set<number>();
  for (const trade of published) {
    if (trade.windowMark) continue;
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
  const windowed = new Set(published.filter((trade) => trade.windowMark).map((trade) => `${trade.classId}|${trade.productId}|${trade.entryDate}`));
  book.closed.forEach((row, index) => {
    if (used.has(index)) return;
    if (windowed.has(`${row.classId}|${row.productId}|${row.entryDate}`)) return;
    if (row.entryDate >= entryStart && row.entryDate < entryEnd) {
      diffs.push({ productId: row.productId, classId: row.classId, entryTs: row.exitTs / 1000, field: "extra", published: null, engine: row.exitKind });
    }
  });
  return { diffs, published, engine: book.closed, entries, weeks: generated.weeks };
}

function parityAPick(bookId: string, lookback: 20 | 55, k: number): APick {
  return {
    config: bookId,
    lookback,
    k,
    at: "parity",
    stats: A_REGISTRATION.map((row) => ({
      config: row.id,
      l80NetUsdPerMonth: 0,
      totalNetUsd: 0,
      kept: 0,
      purgedOpen: 0,
    })),
  };
}

const WIDE = { entryStart: "2025-11-11", entryEnd: "2026-10-06", fifteenFrom: "2025-10-11", walkThrough: "2026-10-11", allNames: true };

interface RichTrade extends PublishedTrade {
  windowMark?: boolean;
  stopBps: number;
  rawEntry: number;
  rawExit: number;
  exitDate: string;
}

function exitClass(trade: RichTrade): string {
  const initial = trade.rawEntry * (1 - trade.stopBps / 10_000);
  if (trade.reason === "stop" && (trade.fillExit === trade.rawExit || trade.rawExit < initial - 1e-8)) return "gap-fill stop";
  if (trade.classId === "A" && trade.reason === "stop" && trade.rawExit > initial + 1e-8) return "A trail stop";
  if (trade.classId === "A" && trade.reason === "stop") return "A stop";
  if (trade.classId === "A" && trade.reason === "rule" && daysBetween(trade.entryDate, trade.exitDate) >= 30) return "A 30-day";
  if (trade.classId === "A" && trade.reason === "rule") return "A 10-day";
  if (trade.classId === "B" && trade.reason === "rule") return "B held-set";
  if (trade.classId === "B" && trade.reason === "stop") return "B disaster stop";
  return trade.reason;
}

/** All six A books plus B, from 2025-11-11 through 2026-10-05. The store hash is the candle bytes. */
export function wideParityReport(): Record<string, unknown> {
  const books = A_REGISTRATION.map((config) => {
    const result = replayFrozenWindow({ ...WIDE, book: config.id, lookback: config.lookback, k: config.k });
    const comparable = (result.published as RichTrade[]).filter((trade) => !trade.windowMark);
    const exits: Record<string, number> = {};
    let aCovered = 0;
    let aPublished = 0;
    for (const trade of result.published as RichTrade[]) {
      if (trade.classId !== "A") continue;
      aPublished += 1;
      const entry = result.entries.find((row) => row.classId === "A" && row.productId === trade.productId && new Date(row.tsMs).toISOString().slice(0, 10) === trade.entryDate);
      const bps = entry ? ((entry.nextOpen - entry.stop) / entry.nextOpen) * 10_000 : null;
      if (bps != null && Math.abs(bps - trade.stopBps) < 1e-6) aCovered += 1;
    }
    for (const trade of comparable) {
      const label = exitClass(trade);
      exits[label] = (exits[label] ?? 0) + 1;
    }
    return {
      book: config.id,
      published: result.published.length,
      windowMarked: result.published.length - comparable.length,
      comparable: comparable.length,
      matched: comparable.length - result.diffs.filter((diff) => diff.field === "missing").length - new Set(result.diffs.filter((diff) => diff.field !== "missing" && diff.field !== "extra").map((diff) => `${diff.productId}|${diff.classId}|${diff.entryTs}`)).size,
      diffs: result.diffs.length,
      aPublished,
      aCovered,
      exits,
    };
  });
  const files = scanCandleFiles(dataDir());
  const storeHash = rootHash(files);
  const exits: Record<string, number> = {};
  for (const book of books) {
    for (const [label, count] of Object.entries(book.exits)) exits[label] = (exits[label] ?? 0) + count;
  }
  const comparable = books.reduce((sum, book) => sum + book.comparable, 0);
  const diffCount = books.reduce((sum, book) => sum + book.diffs, 0);
  return {
    span: "2025-11-11 through 2026-10-05",
    storeHash,
    storeHashFiles: files.length,
    storeHashInput: "sha256 of each candles sqlite, then rootHash of sorted path TAB sha256 lines",
    comparable,
    diffs: diffCount,
    matched: comparable - diffCount,
    exits,
    gapFillStops: exits["gap-fill stop"] ?? 0,
    books,
  };
}
