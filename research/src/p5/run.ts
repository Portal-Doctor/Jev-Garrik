/**
 * Historical folds for classes A and B.
 * C, D, and E stay forward-only. No Jev call is made.
 * n is before slots. The registration's in-sample choice among A's six configs
 * has no statistic, so every config is reported and none is dropped.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStamp } from "../manifest";
import { readPairMonth } from "../data/store";
import { dataPaths } from "../data/paths";
import { wilderAtr, ema } from "../p2/indicators";
import { OOS_END } from "../p2/universe";
import { classATrigger, classBScore } from "../p3/classes";
import {
  NO_REENTRY_MS,
  classAChaseSkip,
  classAExit,
  classBDisasterStop,
  classBHeld,
  classBSelected,
} from "../p3/design-rules";
import { classBarInputs, groupFlagsOf, type ClassBarInputs } from "../p3/bar-access";
import { WINDOW_START } from "../p3/f5";
import { loadPair, type PairFacts } from "../p3/geometry-run";
import { btcVeto, type BtcDay } from "../p3/signals";
import {
  DSR_TRIALS_REGISTERED,
  DSR_TRIALS_REQUESTED,
  KILL_HURDLE_BPS,
  MAX_OF_N_REGISTERED,
  MAX_OF_N_REQUESTED,
  addDays,
  bhAdjusted,
  boundaryPurge,
  daysBetween,
  deflatedSharpe,
  expectedMaxSharpe,
  foldOf,
  historicalFolds,
  holmAdjusted,
  killVerdict,
  meanAboveZeroP,
  tradeMoments,
  upper80Mean,
  weekKey,
} from "./stats";
import { walkLong, type PxBar, type WalkLeg } from "./walk";

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

export interface TradeRow {
  path: "base" | "stress";
  config: string;
  classId: "A" | "B";
  productId: string;
  signalDate: string;
  entryDate: string;
  exitDate: string;
  reason: WalkLeg["reason"];
  fold: string | null;
  sample: "IS" | "OOS" | null;
  purged: boolean;
  grossBps: number;
  netBps: number;
  entryFeeBps: number;
  exitFeeBps: number;
  spreadBps: number;
}

interface ASignal {
  lookback: 20 | 55;
  date: string;
  entryDate: string;
  atr: number;
}

interface PairState {
  productId: string;
  ohlc: { date: string; low: number; close: number }[];
  atrByDate: Map<string, number>;
  hourAtr: { ts: number; atr: number | null }[];
  aSignals: ASignal[];
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

function collectA(productId: string, inputs: ClassBarInputs, atrByDate: Map<string, number>, memberOn: (date: string) => boolean, young: boolean, veto: (date: string) => boolean): ASignal[] {
  const bars = inputs.closeLookback;
  const points = emaPoint(inputs);
  const out: ASignal[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    if (!memberOn(bar.date) || veto(bar.date)) continue;
    const dailyAtr = atrByDate.get(bar.date);
    if (dailyAtr == null || !(dailyAtr > 0)) continue;
    const point = points.get(bar.date);
    if (!point) continue;
    for (const lookback of [20, 55] as const) {
      if (!classATrigger(bars, i, lookback, young, undefined, point)) continue;
      const prior = bars.slice(i - lookback, i);
      const priorHigh = Math.max(...prior.map((row) => row.close));
      if (classAChaseSkip(bar.close, priorHigh, dailyAtr)) continue;
      const entryDate = addDays(bar.date, 1);
      if (entryDate > OOS_END) continue;
      out.push({ lookback, date: bar.date, entryDate, atr: dailyAtr });
    }
  }
  return out;
}

function aRuleDate(ohlc: readonly { date: string; low: number; close: number }[], entryDate: string, entry: number, stop: number): string | null {
  for (let i = 0; i < ohlc.length; i += 1) {
    const day = ohlc[i]!;
    if (day.date <= entryDate || day.date > OOS_END) continue;
    const prior = ohlc.slice(Math.max(0, i - 10), i).filter((row) => Number.isFinite(row.low));
    const priorLow = prior.length >= 10 ? Math.min(...prior.slice(-10).map((row) => row.low)) : day.close;
    const held = daysBetween(entryDate, day.date);
    const risk = entry - stop;
    const unrealized = risk > 0 ? (day.close - entry) / risk : 0;
    if (classAExit(day.close, priorLow, held, unrealized)) return day.date;
  }
  return null;
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

function toRow(path: TradeRow["path"], config: string, classId: TradeRow["classId"], productId: string, signalDate: string, entryDate: string, leg: WalkLeg): TradeRow {
  const exitDate = dateOf(leg.exitTs);
  const fold = foldOf(entryDate);
  return {
    path,
    config,
    classId,
    productId,
    signalDate,
    entryDate,
    exitDate,
    reason: leg.reason,
    fold: fold?.id ?? null,
    sample: fold?.sample ?? null,
    purged: boundaryPurge(entryDate, exitDate),
    grossBps: leg.grossBps,
    netBps: leg.netBps,
    entryFeeBps: leg.entryFeeBps,
    exitFeeBps: leg.exitFeeBps,
    spreadBps: leg.spreadBps,
  };
}

function walkConfig(
  bars: readonly PxBar[],
  hour: readonly { ts: number; atr: number | null }[],
  entryDate: string,
  stop: number,
  sBtBps: number,
  ruleDate: string | null,
): WalkLeg | null {
  const entryTs = dayTs(entryDate);
  const ruleExitTs = ruleDate == null ? null : dayTs(addDays(ruleDate, 1));
  const endTs = Math.min(ruleExitTs ?? WINDOW_END_TS, WINDOW_END_TS);
  return walkLong({
    bars,
    entryTs,
    endTs,
    stop,
    sBtBps,
    atr1h: (ts) => atrAt(hour, ts),
    ruleExitTs: ruleExitTs != null && ruleExitTs <= WINDOW_END_TS ? ruleExitTs : null,
  });
}

function runA(state: PairState, bars: readonly PxBar[], sBt: number, path: TradeRow["path"]): TradeRow[] {
  const out: TradeRow[] = [];
  for (const config of A_CONFIGS) {
    const signals = state.aSignals.filter((row) => row.lookback === config.lookback).slice().sort((a, b) => (a.entryDate < b.entryDate ? -1 : 1));
    let lastExit = Number.NEGATIVE_INFINITY;
    for (const signal of signals) {
      const entryTs = dayTs(signal.entryDate);
      if (entryTs <= lastExit) continue;
      if (entryTs * 1000 < lastExit * 1000 + NO_REENTRY_MS) continue;
      const entry = bars.find((bar) => bar.ts === entryTs);
      if (!entry) continue;
      const stop = entry.open - config.k * signal.atr;
      if (!(stop > 0) || !(stop < entry.open)) continue;
      const rule = aRuleDate(state.ohlc, signal.entryDate, entry.open, stop);
      const leg = walkConfig(bars, state.hourAtr, signal.entryDate, stop, sBt, rule);
      if (!leg) continue;
      out.push(toRow(path, config.id, "A", state.productId, signal.date, signal.entryDate, leg));
      lastExit = leg.exitTs;
    }
  }
  return out;
}

function runB(state: PairState, weeks: readonly WeekBook[], bars: readonly PxBar[], sBt: number, path: TradeRow["path"], veto: (date: string) => boolean): TradeRow[] {
  const out: TradeRow[] = [];
  let lastExit = Number.NEGATIVE_INFINITY;
  for (const week of weeks) {
    if (!week.selected.has(state.productId) || veto(week.date)) continue;
    const entryDate = addDays(week.date, 1);
    if (entryDate > OOS_END) continue;
    const entryTs = dayTs(entryDate);
    if (entryTs <= lastExit) continue;
    if (entryTs * 1000 < lastExit * 1000 + NO_REENTRY_MS) continue;
    const atr = state.atrByDate.get(week.date);
    const entry = bars.find((bar) => bar.ts === entryTs);
    if (atr == null || !(atr > 0) || !entry) continue;
    const stop = classBDisasterStop(entry.open, atr);
    if (!(stop > 0) || !(stop < entry.open)) continue;
    const rule = bRuleDate(weeks, state.productId, entryDate);
    const leg = walkConfig(bars, state.hourAtr, entryDate, stop, sBt, rule);
    if (!leg) continue;
    out.push(toRow(path, "B", "B", state.productId, week.date, entryDate, leg));
    lastExit = leg.exitTs;
  }
  return out;
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function summarize(rows: readonly TradeRow[], sample: "IS" | "OOS") {
  const kept = rows.filter((row) => row.sample === sample && !row.purged);
  const gross = kept.map((row) => row.grossBps);
  const net = kept.map((row) => row.netBps);
  const weeks = kept.map((row) => weekKey(row.entryDate));
  const moments = tradeMoments(gross);
  const meanGrossBps = mean(gross);
  const upper80GrossBps = upper80Mean(gross, weeks);
  const verdict = meanGrossBps == null || upper80GrossBps == null ? "insufficient" : killVerdict(kept.length, meanGrossBps, upper80GrossBps);
  return {
    n: kept.length,
    meanGrossBps,
    upper80GrossBps,
    meanNetBps: mean(net),
    upper80NetBps: upper80Mean(net, weeks, undefined, 20261012),
    perTradeSharpe: moments?.sharpe ?? null,
    skew: moments?.skew ?? null,
    kurtosis: moments?.kurtosis ?? null,
    verdict,
    dsrAt136: moments == null ? null : deflatedSharpe({ sharpe: moments.sharpe, nObs: moments.n, skew: moments.skew, kurtosis: moments.kurtosis, nTrials: DSR_TRIALS_REQUESTED }),
    dsrAt135: moments == null ? null : deflatedSharpe({ sharpe: moments.sharpe, nObs: moments.n, skew: moments.skew, kurtosis: moments.kurtosis, nTrials: DSR_TRIALS_REGISTERED }),
  };
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
  const ids = ["BTC-USD", ...names.filter((id) => id !== "BTC-USD")];
  const dailyDir = join(dataDir, "daily", "candles");
  const states = new Map<string, PairState>();
  const bScores: { id: string; date: string; score: number; member: boolean }[] = [];
  let veto = (_date: string) => false;
  for (const id of ids) {
    log(`p5 load ${id}`);
    const pair = loadPair(id, dailyDir, paths.candles);
    if (!pair) continue;
    if (id === "BTC-USD") {
      const days = btcDaysOf(pair);
      veto = (date) => btcVeto(days.get(date));
    }
    if (!membership.members.some((row) => row.names.includes(id))) continue;
    const flags = groupFlagsOf(pair.f5);
    const inputs = classBarInputs(flags, pair.days, pair.listedDate ?? WINDOW_START);
    const atrOn = wilderAtr(inputs.ohlc.map((row) => row.high), inputs.ohlc.map((row) => row.low), inputs.ohlc.map((row) => row.close), 14);
    const atrByDate = new Map<string, number>();
    inputs.ohlc.forEach((row, index) => {
      const value = atrOn[index];
      if (value != null && value > 0) atrByDate.set(row.date, value);
    });
    const hourAtrSeries = wilderAtr(pair.hour.map((bar) => bar.high), pair.hour.map((bar) => bar.low), pair.hour.map((bar) => bar.close), 14);
    const young = pair.listedDate != null && pair.days.filter((row) => !row.empty && row.date < "2025-11-10").length < 200;
    const closes = inputs.closeLookback.map((row) => row.close);
    inputs.closeLookback.forEach((bar, index) => {
      if (new Date(`${bar.date}T00:00:00.000Z`).getUTCDay() !== 1) return;
      const score = classBScore(closes, index);
      if (score == null || !isMember(id, bar.date)) return;
      bScores.push({ id, date: bar.date, score, member: true });
    });
    states.set(id, {
      productId: id,
      ohlc: inputs.ohlc.map((row) => ({ date: row.date, low: row.low, close: row.close })),
      atrByDate,
      hourAtr: pair.hour.map((bar, index) => ({ ts: bar.ts, atr: hourAtrSeries[index] ?? null })),
      aSignals: collectA(id, inputs, atrByDate, (date) => isMember(id, date), young, veto),
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
  const trades: TradeRow[] = [];
  for (const state of [...states.values()].sort((a, b) => (a.productId < b.productId ? -1 : 1))) {
    log(`p5 fill ${state.productId}`);
    const bars = loadPx(paths.candles, state.productId);
    for (const path of ["base", "stress"] as const) {
      const sBt = path === "base" ? 5 : 10;
      trades.push(...runA(state, bars, sBt, path));
      trades.push(...runB(state, weeks, bars, sBt, path, veto));
    }
  }
  trades.sort((a, b) => a.path.localeCompare(b.path) || a.config.localeCompare(b.config) || a.productId.localeCompare(b.productId) || a.entryDate.localeCompare(b.entryDate));
  const configs = [...A_CONFIGS.map((row) => row.id), "B"];
  const byConfig = configs.map((config) => {
    const rows = trades.filter((row) => row.config === config);
    return {
      config,
      classId: config === "B" ? "B" : "A",
      base: { is: summarize(rows.filter((row) => row.path === "base"), "IS"), oos: summarize(rows.filter((row) => row.path === "base"), "OOS") },
      stress: { is: summarize(rows.filter((row) => row.path === "stress"), "IS"), oos: summarize(rows.filter((row) => row.path === "stress"), "OOS") },
    };
  });
  const holmRows = byConfig
    .map((row) => {
      const sample = trades.filter((trade) => trade.path === "base" && trade.config === row.config && trade.sample === "OOS" && !trade.purged);
      const p = meanAboveZeroP(sample.map((trade) => trade.grossBps));
      return p == null ? null : { id: row.config, p };
    })
    .filter((row): row is { id: string; p: number } => row != null);
  const sharpes = byConfig
    .map((row) => ({ id: row.config, sharpe: row.base.oos.perTradeSharpe }))
    .filter((row): row is { id: string; sharpe: number } => row.sharpe != null);
  const best = sharpes.slice().sort((a, b) => b.sharpe - a.sharpe || (a.id < b.id ? -1 : 1))[0] ?? null;
  const purged = trades.filter((row) => row.purged);
  const results = {
    label: registration.validation.label,
    hurdleBps: KILL_HURDLE_BPS,
    sBt: { baseBps: 5, stressBps: 10 },
    feeBps: { entry: 90, exit: 90, note: "X1 and the rule or stop exit are taker legs" },
    intrabar: "stop first",
    nLabel: "before slots",
    folds: historicalFolds(),
    purge: {
      rule: "A trade belongs to its entry fold. IS trades open at the OOS boundary are dropped from both and counted. OOS trades are scored to their real exit. A trade open at the window end is marked to the last 15m close and flagged. Embargo is 0.",
      embargoDays: 0,
      dropped: purged.length,
      droppedByPath: {
        base: purged.filter((row) => row.path === "base").length,
        stress: purged.filter((row) => row.path === "stress").length,
      },
      windowMarked: trades.filter((row) => row.reason === "window").length,
    },
    geometry: {
      C: { ...scan.signalCounts.C, distinctUtcDays: scan.projectedOos.classC.distinctUtcDays, meetsRule: scan.projectedOos.classC.meetsRule, returns: null },
      D: { ...scan.signalCounts.D, returns: null },
      E: { returns: null },
    },
    configs: byConfig,
    holm: {
      familyRequested: ["A", "B", "C"],
      computedOn: "six A configs and B, OOS base gross, one-sided mean above zero",
      adjusted: holmAdjusted(holmRows),
      bh: bhAdjusted(holmRows),
    },
    maxOfN: {
      requested: MAX_OF_N_REQUESTED,
      registered: MAX_OF_N_REGISTERED,
      best,
      expectedMaxSharpeAt8: expectedMaxSharpe(MAX_OF_N_REQUESTED),
      expectedMaxSharpeAt7: expectedMaxSharpe(MAX_OF_N_REGISTERED),
    },
    dsr: { requestedTrials: DSR_TRIALS_REQUESTED, registeredTrials: DSR_TRIALS_REGISTERED, perConfig: byConfig.map((row) => ({ config: row.config, dsrAt136: row.base.oos.dsrAt136, dsrAt135: row.base.oos.dsrAt135 })) },
    questions: [
      "The statistic that chooses one of A's six configs in sample is not in the registration. All six are reported and none was dropped. Holm has no single A stream.",
      "The registration records maxOfN 7 and nCum 135. This turn also asked for max-of-N at 8 and DSR at 136. Both are reported. The registration was not edited.",
      "Holm alpha is not in the registration. Adjusted p-values are reported with no pass or fail cut.",
      "Class C is geometry only, so it has no return and no Holm p-value. D and E have no historical row.",
      "The ATR used by a 15m trail is not specified for A or B. Trails were not applied.",
      "The correlation level that assigns a cluster is not in the registration. The cluster cap was not applied. Slot caps were not applied because n is before slots. Dollar halts were not applied.",
      "X1 is a taker entry: s_bt on the open and the 90 bp taker fee. A stop, a rule exit, and a window-end mark are taker exits. The per-trade floor's maker entry is not this historical entry.",
      "The stop model's 1h ATR uses the existing Wilder length of 14.",
      "The upper 80 percent bound is the 90th percentile of a 2000-draw weekly block bootstrap of the mean. The seed is 20261011 for gross and 20261012 for net.",
    ],
    trades,
  };
  return {
    commitSha: stamp.commitSha,
    dataRootHash: stamp.dataRootHash,
    createdAt: stamp.createdAt,
    phaseId: stamp.phaseId,
    registrationSha256: REGISTRATION_SHA,
    geometryScanSha256: SCAN_SHA,
    jevCalls: 0,
    resultsHash: sha256(JSON.stringify(results)),
    results,
  };
}
