/**
 * Registered historical book for classes A and B.
 * One A config is chosen in sample by the lower 80 percent bound of mean net dollars per month.
 * C, D, and E stay forward-only. No Jev call is made.
 * Beta, equity halts, and the 20R kill are in the book. Pauses and Jev guards are not.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStamp } from "../manifest";
import { readPairMonth } from "../data/store";
import { dataPaths } from "../data/paths";
import { wilderAtr, ema } from "../p2/indicators";
import { FIRST_UNIVERSE_DATE, OOS_END } from "../p2/universe";
import { classATrigger, classBScore } from "../p3/classes";
import {
  CLASS_B_DISASTER_ATR,
  classAChaseSkip,
  classATenDayExit,
  classBHeld,
  classBSelected,
  classKill,
} from "../p3/design-rules";
import { classBarInputs, correlationCloses, type ClassBarInputs, type GroupFlags } from "../p3/bar-access";
import { registeredFlags } from "./flags";
import { WINDOW_START } from "../p3/f5";
import { foldStartDates } from "../p3/schedule";
import { loadPair, type PairFacts } from "../p3/geometry-run";
import { btcVeto, type BtcDay } from "../p3/signals";
import {
  BOOTSTRAP_REPS,
  BOOTSTRAP_SEED,
  DSR_TRIALS_REGISTERED,
  expandingFolds,
  HOLM_ALPHA,
  HOLM_FAMILIES,
  isPrefix,
  KILL_HURDLE_BPS,
  MAX_OF_N_REGISTERED,
  meanHurdleBps,
  N_CUM_SENSITIVITY,
  N_CUM_V31,
  netR,
  netRStreamP,
  oosSlice,
  purgedAtBoundary,
  WEEKS_PER_MONTH,
  addDays,
  bhAdjusted,
  boundaryPurge,
  cents,
  daysBetween,
  deflatedSharpe,
  expectedMaxSharpe,
  foldOf,
  forwardStreamP,
  historicalFolds,
  holmAdjusted,
  mondayWeeks,
  oneSided80,
  oneSided80TradeMean,
  selectByFold,
  tradeMoments,
  weekKey,
  weeklyGroups,
  weeklyValues,
} from "./stats";
import type { PxBar } from "./walk";
import {
  concentration,
  dateOfTs,
  monthlyClusters,
  runBook,
  trailingReturns,
  type BookCandidate,
  type BookPair,
  type BookResult,
  type ClosedTrade,
  type ClosePoint,
} from "./book";
import { breadthByEntryDate, breadthIncludes, type BreadthLabel } from "./guards";
import { RESOLVED_DEFAULTS } from "./questions";
import { alignedBeta, assignBetas, sizingCostBps } from "./risk";

const REGISTRATION_SHA = "49bc506092114e2dec3e3ec73faa1adad4afdf04b0941d4c7b01bd22cd2317f3";
const SCAN_SHA = "7c8901dbd891e7343aa0713ac3724a907480cf9e51da344f295050b3b52dbd44";
const WINDOW_END_TS = Date.parse("2026-10-10T00:00:00.000Z") / 1000;

const A_CONFIGS = [
  { id: "A20-k2", lookback: 20, k: 2 },
  { id: "A20-k2.5", lookback: 20, k: 2.5 },
  { id: "A20-k3", lookback: 20, k: 3 },
  { id: "A55-k2", lookback: 55, k: 2 },
  { id: "A55-k2.5", lookback: 55, k: 2.5 },
  { id: "A55-k3", lookback: 55, k: 3 },
] as const;

export interface TradeRow extends ClosedTrade {
  path: "base" | "stress";
  book: string;
  entryDate: string;
  exitDate: string;
  fold: string | null;
  sample: "IS" | "OOS" | null;
  purged: boolean;
}

interface ASignal {
  lookback: 20 | 55;
  date: string;
  entryDate: string;
  entryTs: number;
  atr: number;
}

interface PairState {
  productId: string;
  ohlc: { date: string; low: number; close: number }[];
  atrByDate: Map<string, number>;
  daily: Map<string, { close: number; low: number; atr: number }>;
  hourAtr: { ts: number; atr: number | null }[];
  aSignals: ASignal[];
  flags: GroupFlags;
  closes: ClosePoint[];
  emaByDate: Map<string, { close: number; ema50: number | null }>;
  bars: PxBar[];
}

interface WeekBook {
  date: string;
  selected: Set<string>;
  held: Set<string>;
}

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function dayTs(date: string): number {
  return Date.parse(`${date}T00:00:00.000Z`) / 1000;
}

/** Next 1h open after the 00:00 close of an open-dated daily bar. */
export function x1EntryTs(signalBarDate: string): number {
  return dayTs(addDays(signalBarDate, 1)) + 3_600;
}

/** Monday 00:00 UTC is the close of the Sunday-dated bar in this store. */
export function isMondayCloseBar(date: string): boolean {
  return new Date(`${date}T00:00:00.000Z`).getUTCDay() === 0;
}

function dateOf(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

function log(line: string): void {
  writeSync(1, `${line}\n`);
}

function btcDaysOf(pair: PairFacts): Map<string, BtcDay> {
  const out = new Map<string, BtcDay>();
  const filled = pair.days.filter((row) => !row.empty);
  const closes = filled.map((row) => row.close);
  const ema50 = ema(closes, 50);
  const level = ema(pair.four.map((bar) => bar.close), 50);
  const fourBelow = new Map<string, boolean>();
  pair.four.forEach((bar, index) => {
    const value = level[index];
    if (value == null) return;
    fourBelow.set(new Date(bar.ts * 1000).toISOString().slice(0, 10), bar.close < value);
  });
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

function emaPoint(inputs: ClassBarInputs): Map<string, { e50: number | null; e200: number | null; e50TenAgo: number | null; index: number }> {
  const ema50 = ema(inputs.ema.map((row) => row.close), 50);
  const ema200 = ema(inputs.ema.map((row) => row.close), 200);
  const out = new Map<string, { e50: number | null; e200: number | null; e50TenAgo: number | null; index: number }>();
  inputs.ema.forEach((row, index) => {
    out.set(row.date, { e50: ema50[index] ?? null, e200: ema200[index] ?? null, e50TenAgo: index >= 10 ? (ema50[index - 10] ?? null) : null, index });
  });
  return out;
}

function collectA(
  productId: string,
  inputs: ClassBarInputs,
  atrByDate: Map<string, number>,
  hour: readonly { ts: number; open: number }[],
  memberOn: (date: string) => boolean,
  young: boolean,
  veto: (date: string) => boolean,
): ASignal[] {
  const bars = inputs.closeLookback;
  const points = emaPoint(inputs);
  const hourOpen = new Map(hour.map((bar) => [bar.ts, bar.open]));
  const out: ASignal[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    if (!memberOn(bar.date) || veto(bar.date)) continue;
    const dailyAtr = atrByDate.get(bar.date);
    if (dailyAtr == null || !(dailyAtr > 0)) continue;
    const point = points.get(bar.date);
    if (!point) continue;
    const entryTs = x1EntryTs(bar.date);
    const entryOpen = hourOpen.get(entryTs);
    if (entryOpen == null || !(entryOpen > 0)) continue;
    for (const lookback of [20, 55] as const) {
      if (!classATrigger(bars, i, lookback, young, undefined, point)) continue;
      if (classAChaseSkip(entryOpen, bar.close, dailyAtr)) continue;
      const entryDate = addDays(bar.date, 1);
      if (entryDate > OOS_END) continue;
      out.push({ lookback, date: bar.date, entryDate, entryTs, atr: dailyAtr });
    }
  }
  return out;
}

export function aRuleDate(ohlc: readonly { date: string; low: number; close: number }[], entryDate: string, entry: number, stop: number): { date: string; at: "open" } | null {
  for (let i = 0; i < ohlc.length; i += 1) {
    const day = ohlc[i]!;
    if (day.date <= entryDate || day.date > OOS_END) continue;
    const priorCloses = ohlc.slice(Math.max(0, i - 10), i).map((row) => row.close).filter((close) => Number.isFinite(close));
    const held = daysBetween(entryDate, day.date);
    const risk = entry - stop;
    const unrealized = risk > 0 ? (day.close - entry) / risk : 0;
    if (classATenDayExit(day.close, priorCloses)) return { date: day.date, at: "open" };
    if (held >= 30 && unrealized < 1) return { date: day.date, at: "open" };
  }
  return null;
}

/** Held-set exit is the next 1h open after that Monday 00:00 close, minus s_bt at the open fill. */
export function bHeldExitTs(ruleDate: string): { ts: number; at: "open" } {
  return { ts: x1EntryTs(ruleDate), at: "open" };
}

function bRuleDate(weeks: readonly WeekBook[], productId: string, entryDate: string): string | null {
  for (const week of weeks) {
    if (week.date <= entryDate || week.date > OOS_END) continue;
    if (!week.held.has(productId)) return week.date;
  }
  return null;
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

function loadPx(candleDir: string, productId: string): PxBar[] {
  const folder = join(candleDir, productId);
  let names: string[] = [];
  try {
    names = readdirSync(folder).filter((name) => name.endsWith(".sqlite") && !name.includes("partial"));
  } catch {
    return [];
  }
  const out: PxBar[] = [];
  for (const name of names.sort()) {
    for (const row of readPairMonth(join(folder, name)).rows) {
      if (row.empty || row.open == null || row.high == null || row.low == null || row.close == null) continue;
      const open = Number(row.open);
      const high = Number(row.high);
      const low = Number(row.low);
      const close = Number(row.close);
      if (!(open > 0) || !(high > 0) || !(low > 0) || !(close > 0)) continue;
      out.push({ ts: row.minuteSec, open, high, low, close });
    }
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

function tagTrade(path: TradeRow["path"], book: string, trade: ClosedTrade): TradeRow {
  const entryDate = dateOfTs(trade.entryTs);
  const exitDate = dateOfTs(trade.exitTs);
  const fold = foldOf(entryDate);
  return {
    ...trade,
    path,
    book,
    entryDate,
    exitDate,
    fold: fold?.id ?? null,
    sample: fold?.sample ?? null,
    purged: boundaryPurge(entryDate, exitDate),
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(rows: readonly TradeRow[], sample: "IS" | "OOS", weeks: readonly string[]) {
  const kept = rows.filter((row) => row.sample === sample && !row.purged);
  const gross = kept.map((row) => row.grossBps);
  const net = kept.map((row) => row.netBps);
  const points = kept.map((row) => ({ week: weekKey(row.entryDate) }));
  const grossBound = oneSided80TradeMean(weeklyGroups(points.map((point, index) => ({ week: point.week, value: gross[index]! })), weeks));
  const netBound = oneSided80TradeMean(weeklyGroups(points.map((point, index) => ({ week: point.week, value: net[index]! })), weeks));
  const dollarBound = oneSided80(weeklyValues(kept.map((row) => ({ week: weekKey(row.entryDate), value: row.netUsd })), weeks), { scale: WEEKS_PER_MONTH });
  const rValues = kept.map((row) => netR(row.netUsd, row.entryRiskUsd)).filter((value): value is number => value != null);
  const meanGrossBps = mean(gross);
  const hurdle = meanHurdleBps(kept);
  const verdict = meanGrossBps == null || grossBound == null || hurdle == null ? "insufficient" : classKill({ n: kept.length, meanGrossBps, upper80Bps: grossBound.u80, hurdleBps: hurdle });
  const moments = tradeMoments(rValues);
  const dsr = (trials: number) => moments == null ? null : deflatedSharpe({ sharpe: moments.sharpe, nObs: moments.n, skew: moments.skew, kurtosis: moments.kurtosis, nTrials: trials });
  return {
    n: kept.length,
    meanGrossBps,
    l80GrossBps: grossBound?.l80 ?? null,
    u80GrossBps: grossBound?.u80 ?? null,
    meanNetBps: mean(net),
    l80NetBps: netBound?.l80 ?? null,
    u80NetBps: netBound?.u80 ?? null,
    totalGrossUsd: kept.reduce((sum, row) => sum + row.grossUsd, 0),
    totalNetUsd: kept.reduce((sum, row) => sum + row.netUsd, 0),
    l80NetUsdPerMonth: dollarBound?.l80 ?? null,
    u80NetUsdPerMonth: dollarBound?.u80 ?? null,
    meanNetR: mean(rValues),
    hurdleBps: hurdle,
    perTradeSharpe: moments?.sharpe ?? null,
    skew: moments?.skew ?? null,
    kurtosis: moments?.kurtosis ?? null,
    verdict,
    dsrAt157: dsr(N_CUM_V31),
    dsrAt135: dsr(DSR_TRIALS_REGISTERED),
    dsrAt154: dsr(N_CUM_SENSITIVITY),
    windowMarks: kept.filter((row) => row.windowMark).length,
  };
}

function aCandidates(state: PairState, lookback: 20 | 55, k: number): BookCandidate[] {
  return state.aSignals.filter((row) => row.lookback === lookback).map((row) => ({
    classId: "A" as const,
    productId: state.productId,
    signalDate: row.date,
    entryTs: row.entryTs,
    stopDistance: k * row.atr,
  }));
}

function bCandidates(state: PairState, weeks: readonly WeekBook[], veto: (date: string) => boolean): BookCandidate[] {
  const out: BookCandidate[] = [];
  for (const week of weeks) {
    if (!week.selected.has(state.productId) || veto(week.date)) continue;
    const entryTs = x1EntryTs(week.date);
    if (dateOf(entryTs) > OOS_END) continue;
    const atr = state.atrByDate.get(week.date);
    if (atr == null || !(atr > 0)) continue;
    out.push({
      classId: "B",
      productId: state.productId,
      signalDate: week.date,
      entryTs,
      stopDistance: CLASS_B_DISASTER_ATR * atr,
    });
  }
  return out;
}

function ruleExitTs(state: PairState, weeks: readonly WeekBook[], candidate: BookCandidate, rawEntry: number, initialStop: number): { ts: number; at: "open" | "close" } | null {
  const entryDate = dateOf(candidate.entryTs);
  if (candidate.classId === "A") {
    const rule = aRuleDate(state.ohlc, entryDate, rawEntry, initialStop);
    if (rule == null) return null;
    const ts = dayTs(addDays(rule.date, 1));
    return ts <= WINDOW_END_TS ? { ts, at: rule.at } : null;
  }
  const ruleDate = bRuleDate(weeks, candidate.productId, entryDate);
  if (ruleDate == null) return null;
  const exit = bHeldExitTs(ruleDate);
  return exit.ts <= WINDOW_END_TS ? exit : null;
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

export function buildP5Report(stamp: ArtifactStamp, dataDir: string): Record<string, unknown> {
  const paths = dataPaths(dataDir);
  const registrationBytes = readFileSync(join(paths.reports, "p4-registration.json"));
  const scanBytes = readFileSync(join(paths.reports, "geometry-scan.json"));
  if (sha256(registrationBytes) !== REGISTRATION_SHA) throw new Error("p4-registration.json is not the approved file");
  if (sha256(scanBytes) !== SCAN_SHA) throw new Error("geometry-scan.json hash changed");
  const registration = JSON.parse(registrationBytes.toString()) as {
    execution: { sBt: { baseBps: number; stressBps: number } };
    validation: { maxOfN: number; nCum: number; label: string };
    feeTier: { makerBps: number; takerBps: number };
    overlap?: { priceGroupFailNames?: string[]; volumeGroupFailNames?: string[]; boundarySavesCloses?: string[] };
    barAccess?: { names?: { productId: string; priceGroupPasses: boolean; volumeGroupPasses: boolean; boundarySaved: boolean }[] };
  };
  if (registration.execution.sBt.baseBps !== 5 || registration.execution.sBt.stressBps !== 10) {
    throw new Error("registered s_bt is not base 5 and stress 10");
  }
  if (registration.validation.maxOfN !== MAX_OF_N_REGISTERED || registration.validation.nCum !== DSR_TRIALS_REGISTERED) {
    throw new Error("registered maxOfN or nCum changed");
  }
  if (registration.feeTier.makerBps !== 50 || registration.feeTier.takerBps !== 90) {
    throw new Error("registered fee tier is not 50/90");
  }
  const scan = JSON.parse(scanBytes.toString()) as {
    signalCounts: Record<string, { signals: number; oosSignals: number }>;
    projectedOos: { classC: { oosEntries: number; distinctUtcDays: number; meetsRule: boolean } };
  };
  const membership = JSON.parse(readFileSync(join(paths.reports, "universe-membership.json"), "utf8")) as {
    members: { date: string; names: string[] }[];
  };
  const isMember = memberFn(membership.members);
  const names = [...new Set(membership.members.flatMap((row) => row.names))].sort();
  const flagBook = registeredFlags(registration, names);
  const ids = ["BTC-USD", ...names.filter((id) => id !== "BTC-USD")];
  const dailyDir = join(dataDir, "daily", "candles");
  const states = new Map<string, PairState>();
  const bScores: { id: string; date: string; score: number; member: boolean }[] = [];
  let btcCloses: ClosePoint[] = [];
  let veto = (_date: string) => false;
  for (const id of ids) {
    log(`p5 load ${id}`);
    const pair = loadPair(id, dailyDir, paths.candles);
    if (!pair) continue;
    if (id === "BTC-USD") {
      const days = btcDaysOf(pair);
      veto = (date) => btcVeto(days.get(date));
      btcCloses = pair.days.filter((row) => !row.empty && row.close > 0).map((row) => ({ date: row.date, close: row.close }));
    }
    if (!membership.members.some((row) => row.names.includes(id))) continue;
    const flags = flagBook.byId.get(id);
    if (!flags) continue;
    const inputs = classBarInputs(flags, pair.days, pair.listedDate ?? WINDOW_START);
    const atrOn = wilderAtr(inputs.ohlc.map((row) => row.high), inputs.ohlc.map((row) => row.low), inputs.ohlc.map((row) => row.close), 14);
    const atrByDate = new Map<string, number>();
    const daily = new Map<string, { close: number; low: number; atr: number }>();
    inputs.ohlc.forEach((row, index) => {
      const value = atrOn[index];
      if (value != null && value > 0) atrByDate.set(row.date, value);
      if (row.close > 0) daily.set(row.date, { close: row.close, low: row.low, atr: value != null && value > 0 ? value : 0 });
    });
    const hourAtrSeries = wilderAtr(pair.hour.map((bar) => bar.high), pair.hour.map((bar) => bar.low), pair.hour.map((bar) => bar.close), 14);
    const young = pair.listedDate != null && pair.days.filter((row) => !row.empty && row.date < "2025-11-10").length < 200;
    const closes = inputs.closeLookback.map((row) => row.close);
    inputs.closeLookback.forEach((bar, index) => {
      if (!isMondayCloseBar(bar.date)) return;
      const score = classBScore(closes, index);
      if (score == null || !isMember(id, bar.date)) return;
      bScores.push({ id, date: bar.date, score, member: true });
    });
    states.set(id, {
      productId: id,
      ohlc: inputs.ohlc.map((row) => ({ date: row.date, low: row.low, close: row.close })),
      atrByDate,
      daily,
      hourAtr: pair.hour.map((bar, index) => ({ ts: bar.ts, atr: hourAtrSeries[index] ?? null })),
      aSignals: collectA(id, inputs, atrByDate, pair.hour, (date) => isMember(id, date), young, veto),
      flags,
      closes: correlationCloses(flags, pair.days),
      emaByDate: (() => {
        const level = ema(inputs.ema.map((row) => row.close), 50);
        const byDate = new Map<string, { close: number; ema50: number | null }>();
        inputs.ema.forEach((row, index) => {
          if (!(row.close > 0)) return;
          byDate.set(row.date, { close: row.close, ema50: level[index] ?? null });
        });
        return byDate;
      })(),
      bars: [],
    });
  }
  const byWeek = new Map<string, { id: string; date: string; score: number; member: boolean }[]>();
  for (const row of bScores) {
    const list = byWeek.get(row.date) ?? [];
    list.push(row);
    byWeek.set(row.date, list);
  }
  const weeks: WeekBook[] = [...byWeek.keys()].sort().map((date) => {
    const rows = byWeek.get(date)!;
    return {
      date,
      selected: new Set(classBSelected(rows).map((row) => row.id)),
      held: new Set(rows.filter((row) => classBHeld(rows, row.id)).map((row) => row.id)),
    };
  });
  const ordered = [...states.values()].sort((a, b) => (a.productId < b.productId ? -1 : 1));
  for (const state of ordered) {
    log(`p5 bars ${state.productId}`);
    state.bars = loadPx(paths.candles, state.productId);
  }
  const months: string[] = [];
  for (let year = 2025, month = 11; ; ) {
    const key = `${year}-${String(month).padStart(2, "0")}-01`;
    if (key > "2026-10-01") break;
    months.push(key);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  const clusterDates = [...new Set([...months, ...foldStartDates()])].sort();
  const clusterNames = ordered.map((state) => ({ productId: state.productId, flags: state.flags, days: state.closes }));
  const clusterMaps = monthlyClusters(clusterNames, clusterDates, (productId, date) => isMember(productId, date));
  const clusterAsOf = (productId: string, entryDate: string) => {
    let chosen = productId;
    let asOf = "";
    for (const [date, map] of clusterMaps) {
      if (date <= entryDate && date >= asOf) {
        asOf = date;
        chosen = map.get(productId) ?? productId;
      }
    }
    return chosen;
  };
  const betaMaps = new Map<string, Map<string, number | null>>();
  for (const date of clusterDates) {
    const rows = ordered
      .filter((state) => isMember(state.productId, date))
      .map((state) => ({ id: state.productId, beta: alignedBeta(state.closes, btcCloses, date, trailingReturns) }));
    betaMaps.set(date, assignBetas(rows));
  }
  const betaOf = (productId: string, entryDate: string) => {
    let chosen: number | null = null;
    let asOf = "";
    let found = false;
    for (const [date, map] of betaMaps) {
      if (date <= entryDate && date >= asOf && map.has(productId)) {
        asOf = date;
        chosen = map.get(productId) ?? null;
        found = true;
      }
    }
    return found ? chosen : null;
  };
  const breadthDates: string[] = [];
  for (let cursor = FIRST_UNIVERSE_DATE; cursor <= OOS_END; cursor = addDays(cursor, 1)) breadthDates.push(cursor);
  const breadthLabels: Map<string, BreadthLabel> = breadthByEntryDate(breadthDates, (entryDate) => {
    const closeDate = addDays(entryDate, -1);
    return ordered.filter((state) => breadthIncludes(state.productId) && isMember(state.productId, entryDate)).map((state) => {
      const point = state.emaByDate.get(closeDate);
      return { member: true, close: point?.close ?? null, ema50: point?.ema50 ?? null };
    });
  });
  const bookPairs: BookPair[] = ordered.map((state) => ({
    productId: state.productId,
    bars: new Map(state.bars.map((bar) => [bar.ts, bar])),
    daily: state.daily,
    atr1h: (ts) => atrAt(state.hourAtr, ts),
    clusterOf: (entryDate) => clusterAsOf(state.productId, entryDate),
  }));
  const classB = ordered.flatMap((state) => bCandidates(state, weeks, veto));
  const ran = new Map<string, { result: BookResult; trades: TradeRow[] }>();
  for (const config of A_CONFIGS) {
    const candidates = [...ordered.flatMap((state) => aCandidates(state, config.lookback, config.k)), ...classB];
    for (const path of ["base", "stress"] as const) {
      log(`p5 book ${config.id} ${path} candidates ${candidates.length}`);
      const result = runBook({
        pairs: bookPairs,
        candidates,
        ruleExitTs: (candidate, rawEntry, initialStop) => ruleExitTs(states.get(candidate.productId)!, weeks, candidate, rawEntry, initialStop),
        sBtBps: path === "base" ? 5 : 10,
        endTs: WINDOW_END_TS,
        betaOf,
        breadthOf: (entryDate) => breadthLabels.get(entryDate) ?? "on",
      });
      ran.set(`${config.id}|${path}`, { result, trades: result.trades.map((trade) => tagTrade(path, config.id, trade)) });
    }
  }
  const folds = historicalFolds();
  const isFold = folds[0]!;
  const oosFolds = folds.filter((fold) => fold.sample === "OOS");
  const isWeeks = mondayWeeks(isFold.start, isFold.end);
  const oosWeeks = mondayWeeks(oosFolds[0]!.start, oosFolds[oosFolds.length - 1]!.end);
  const configRows = A_CONFIGS.map((config) => {
    const base = ran.get(`${config.id}|base`)!;
    const stress = ran.get(`${config.id}|stress`)!;
    const baseA = base.trades.filter((row) => row.classId === "A");
    const stressA = stress.trades.filter((row) => row.classId === "A");
    return {
      config: config.id,
      classId: "A" as const,
      lookback: config.lookback,
      k: config.k,
      base: { is: summarize(baseA, "IS", isWeeks), oos: summarize(baseA, "OOS", oosWeeks) },
      stress: { is: summarize(stressA, "IS", isWeeks), oos: summarize(stressA, "OOS", oosWeeks) },
      blocked: { base: base.result.hitsByClass.A, stress: stress.result.hitsByClass.A },
    };
  });
  const foldList = expandingFolds();
  const l80Of = (trades: readonly { entryDate: string; netUsd: number }[], fold: (typeof foldList)[number]) => {
    const weeks = mondayWeeks(fold.isStart, fold.isEnd);
    const bound = oneSided80(weeklyValues(trades.map((trade) => ({ week: weekKey(trade.entryDate), value: trade.netUsd })), weeks), { scale: WEEKS_PER_MONTH });
    return bound?.l80 ?? -1_000_000_000;
  };
  const picks = selectByFold(
    configRows,
    foldList,
    (row) => ran.get(`${row.config}|base`)!.trades.filter((trade) => trade.classId === "A"),
    l80Of,
    (trades) => trades.reduce((sum, trade) => sum + trade.netUsd, 0),
  );
  const stitch = (path: "base" | "stress", classId: "A" | "B") => picks.flatMap((pick) => oosSlice(ran.get(`${pick.chosen.config}|${path}`)!.trades.filter((trade) => trade.classId === classId), pick.fold));
  const stitchedA = stitch("base", "A");
  const stitchedB = stitch("base", "B");
  const stitchedAStress = stitch("stress", "A");
  const stitchedBStress = stitch("stress", "B");
  const classARow = { base: summarize(stitchedA, "OOS", oosWeeks), stress: summarize(stitchedAStress, "OOS", oosWeeks) };
  const classBRow = { base: summarize(stitchedB, "OOS", oosWeeks), stress: summarize(stitchedBStress, "OOS", oosWeeks) };
  const streamOf = (rows: readonly TradeRow[]) => {
    const values = rows.map((row) => netR(row.netUsd, row.entryRiskUsd)).filter((value): value is number => value != null);
    const stream = netRStreamP(values);
    return { id: "", n: stream.n, p: stream.p, status: stream.status };
  };
  const historicalStreams = [
    { ...streamOf(stitchedA), id: "A" },
    { ...streamOf(stitchedB), id: "B" },
  ];
  const withDecision = (rows: { id: string; n: number; p: number; status: string }[], promotes: boolean) => {
    const holm = holmAdjusted(rows.map((row) => ({ id: row.id, p: row.p })));
    const bh = bhAdjusted(rows.map((row) => ({ id: row.id, p: row.p })));
    return holm.map((row) => {
      const source = rows.find((item) => item.id === row.id)!;
      const bhRow = bh.find((item) => item.id === row.id)!;
      const pass = source.status !== "not testable" && row.adjusted < HOLM_ALPHA;
      return {
        id: row.id,
        n: source.n,
        status: source.status,
        p: row.p,
        holmAdjusted: row.adjusted,
        decision: promotes ? (pass ? "pass" : "fail") : "reported",
        bhAdjusted: bhRow.adjusted,
        bhAt010: source.status === "not testable" ? "not testable" : bhRow.adjusted < 0.1 ? "below" : "not below",
      };
    });
  };
  const forward = ["A", "B", "C", "D", "E"].map((id) => ({ id, n: 0, ...forwardStreamP(0, null) }));
  const guardStreams = ["3a", "3b"].map((id) => ({ id, n: 0, ...forwardStreamP(0, null) }));
  const clusterMonths = months.map((month) => {
    const assigned = clusterMaps.get(month)!;
    const groups = new Map<string, number>();
    for (const cluster of assigned.values()) groups.set(cluster, (groups.get(cluster) ?? 0) + 1);
    const linked = [...groups.values()].filter((size) => size > 1);
    return { month, multiNameClusters: linked.length, namesInMultiNameClusters: linked.reduce((sum, size) => sum + size, 0) };
  });
  const trades = [...ran.values()].flatMap((book) => book.trades);
  trades.sort((a, b) => a.book.localeCompare(b.book) || a.path.localeCompare(b.path) || a.classId.localeCompare(b.classId) || a.entryDate.localeCompare(b.entryDate) || a.productId.localeCompare(b.productId));
  const droppedOnFolds = picks.reduce((sum, pick) => {
    const book = ran.get(`${pick.chosen.config}|base`)!.trades;
    return sum + book.filter((trade) => purgedAtBoundary(trade.entryDate, trade.exitDate, pick.fold.oosStart)).length;
  }, 0);
  const foldPicks = picks.map((pick) => {
    const trades = isPrefix(ran.get(`${pick.chosen.config}|base`)!.trades.filter((trade) => trade.classId === "A"), pick.fold);
    const l80 = l80Of(trades, pick.fold);
    const total = trades.reduce((sum, trade) => sum + trade.netUsd, 0);
    return { fold: pick.fold.id, config: pick.chosen.config, isN: trades.length, l80NetUsdPerMonth: l80, totalNetUsd: total, l80Cents: cents(l80), totalCents: cents(total) };
  });
  const results = {
    label: registration.validation.label,
    role: "v3.1 code path, not run",
    v3HurdleBps: KILL_HURDLE_BPS,
    sBt: { baseBps: 5, stressBps: 10 },
    feeBps: { entry: 90, exit: 90, note: "X1 and the rule, stop, or window-end exit are taker legs. Dollar net uses the same bps, charged on entry notional." },
    sizing: { riskUsd: 60, notionalCapUsd: 1500, costBps: { base: sizingCostBps(5), stress: sizingCostBps(10) }, costNote: "C is 2 times (90 + s_bt). The spread stays in the fill." },
    intrabar: "stop first; A's daily chandelier moves after the 15m bar that completes the UTC day",
    trail: "highest daily close since entry minus 3 times that day's Wilder ATR14",
    stops: "A's initial stop and B's disaster stop use daily Wilder ATR14. The 1h Wilder ATR14 is only the stop-fill deduction.",
    nLabel: "after slots, caps, clusters, and halts",
    bootstrap: {
      seed: BOOTSTRAP_SEED,
      reps: BOOTSTRAP_REPS,
      blocks: "non-overlapping 7-day blocks aligned to Monday 00:00 UTC",
      resampling: "with replacement",
      zeroTradeWeeks: "counted as $0 in the dollar bounds",
      interpolation: "linear, index (n-1)*p",
      bounds: "U80 is p80 and L80 is p20",
    },
    folds,
    purge: {
      rule: "A trade belongs to its entry fold. IS trades open at the OOS boundary are dropped from both and counted. OOS trades are scored to their real exit. A trade open at the window end is marked to the last 15m close and flagged. Embargo is 0.",
      embargoDays: 0,
      droppedOnFolds,
      windowMarks: {
        base: [...stitchedA, ...stitchedB].filter((row) => row.windowMark).length,
        stress: [...stitchedAStress, ...stitchedBStress].filter((row) => row.windowMark).length,
      },
    },
    geometry: {
      C: { ...scan.signalCounts.C, distinctUtcDays: scan.projectedOos.classC.distinctUtcDays, meetsRule: scan.projectedOos.classC.meetsRule, returns: null },
      D: { ...scan.signalCounts.D, returns: null },
      E: { returns: null },
    },
    selection: {
      statistic: "highest L80 of the expanding IS mean net dollars per month at fixed caps",
      tieBreak: "higher IS total net dollars after rounding to $0.01, then registration order",
      registrationOrder: A_CONFIGS.map((row) => row.id),
      folds: foldPicks,
    },
    configs: configRows,
    classA: classARow,
    classB: classBRow,
    concentration: {
      dollarShare: "share of the sum of gross dollars on the stitched OOS",
      A: concentration(stitchedA),
      B: concentration(stitchedB),
    },
    blocked: {
      note: "A rejected attempt increments every gate that failed. Hits belong to each config's full-window book. Beta weight is max(beta, 0). A missing beta is 1 and the cap is applied.",
      configs: A_CONFIGS.map((config) => ({
        config: config.id,
        base: ran.get(`${config.id}|base`)!.result.hits,
        stress: ran.get(`${config.id}|stress`)!.result.hits,
      })),
    },
    clusters: clusterMonths,
    holm: {
      alpha: HOLM_ALPHA,
      historicalFamily: ["A", "B"],
      historicalFirstStep: HOLM_FAMILIES.historical.firstStep,
      historicalPromotes: HOLM_FAMILIES.historical.promotes,
      historical: withDecision(historicalStreams, false),
      classFamily: forward.map((row) => row.id),
      classFirstStep: HOLM_FAMILIES.classFamily.firstStep,
      classStreams: withDecision(forward, true),
      jevFamilyStreams: HOLM_FAMILIES.jevFamily.streams,
      jevFirstStep: HOLM_FAMILIES.jevFamily.firstStep,
      jevGuardIds: guardStreams.map((row) => row.id),
      jevGuardFirstStep: HOLM_FAMILIES.jevGuardFamily.firstStep,
      jevGuards: withDecision(guardStreams, true),
      pValue: "one-sided t test that mean OOS realized net R is above zero, on the stitched book. The same test is on the stress row.",
    },
    maxOfN: {
      registered: MAX_OF_N_REGISTERED,
      expectedMaxSharpe: expectedMaxSharpe(MAX_OF_N_REGISTERED),
      note: "7 stays the trial count. It is not 8.",
    },
    dsr: {
      governingTrials: N_CUM_V31,
      registeredTrials: DSR_TRIALS_REGISTERED,
      sensitivityTrials: N_CUM_SENSITIVITY,
      A: { dsrAt157: classARow.base.dsrAt157, dsrAt135: classARow.base.dsrAt135, dsrAt154: classARow.base.dsrAt154 },
      B: { dsrAt157: classBRow.base.dsrAt157, dsrAt135: classBRow.base.dsrAt135, dsrAt154: classBRow.base.dsrAt154 },
      stressA: { dsrAt157: classARow.stress.dsrAt157, dsrAt135: classARow.stress.dsrAt135, dsrAt154: classARow.stress.dsrAt154 },
      stressB: { dsrAt157: classBRow.stress.dsrAt157, dsrAt135: classBRow.stress.dsrAt135, dsrAt154: classBRow.stress.dsrAt154 },
    },
    registeredFlags: {
      source: "p4-registration.json barAccess.names",
      recomputed: false,
      missing: flagBook.missing,
      conflicts: flagBook.conflicts,
    },
    resolvedDefaults: RESOLVED_DEFAULTS.map((row) => ({ ...row })),
    breadthReview: { label: "diagnostic, no selection", selects: false },
    trades,
  };
  return {
    commitSha: stamp.commitSha,
    dataRootHash: stamp.dataRootHash,
    createdAt: stamp.createdAt,
    phaseId: stamp.phaseId,
    registrationSha256: REGISTRATION_SHA,
    amendmentSha256: sha256(readFileSync(join(paths.reports, "p4-amendment-1.json"))),
    geometryScanSha256: SCAN_SHA,
    jevCalls: 0,
    resultsHash: sha256(JSON.stringify(results)),
    results,
  };
}
