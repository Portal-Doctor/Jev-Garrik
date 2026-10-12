/**
 * Capped book for one A config plus class B.
 * A's trail is the highest completed daily close minus 3 times that day's Wilder ATR14.
 * The trail is moved only after the 15m bar that completes the UTC day.
 * The 1h ATR is used only in the stop-fill deduction.
 * Halts use equity. The 20R kill is on the class net-R curve. Pauses and Jev guards are not applied.
 */

import { TAKER_FEE_BPS } from "../../vendor/87b35d0/config.ts";
import { CLUSTER_CORR_DAYS, clusterKey, type GroupFlags } from "../p3/bar-access";
import { WINDOW_START } from "../p3/f5";
import {
  BACKSTOP_BOOK_USD,
  BACKSTOP_DAILY_USD,
  BACKSTOP_PAIR_USD,
  BOOK_HALT_USD,
  DAILY_HALT_USD,
  WEEKLY_HALT_USD,
  betaAllows,
  onePerPairAllows,
  openRiskAllows,
  grossNotionalAllows,
  CLUSTER_MAX_OPEN,
  reentryAllowed,
  stopFillPrice,
  x1FillPrice,
} from "../p3/design-rules";
import { intrabarFill } from "../p3/fills";
import { MAX_POSITIONS, SLOT_CAPS, notionalUsd, tieRank } from "../p3/portfolio";
import { weekKey } from "./stats";
import type { BreadthLabel } from "./guards";
import { averageLinkage, betaWeight, classKillTripped, entryOpenRiskUsd, openRiskAfterMove, sizingCostBps } from "./risk";
import { grossBps, netBps } from "./walk";

const DAY = 86_400;
const BAR = 900;
/** Chandelier multiple. Daily ATR, not a 15m ATR. */
export const TRAIL_ATR = 3;

export interface BookBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface BookCandidate {
  classId: "A" | "B";
  productId: string;
  signalDate: string;
  entryTs: number;
  /** Price distance subtracted from the entry open. Daily ATR times the stop multiple. */
  stopDistance: number;
}

export interface BookPair {
  productId: string;
  bars: ReadonlyMap<number, BookBar>;
  daily: ReadonlyMap<string, { close: number; low: number; atr: number }>;
  atr1h: (ts: number) => number;
  clusterOf: (entryDate: string) => string;
}

export interface ClosedTrade {
  classId: "A" | "B";
  productId: string;
  signalDate: string;
  entryTs: number;
  exitTs: number;
  reason: "stop" | "gap" | "rule" | "window";
  windowMark: boolean;
  rawEntry: number;
  rawExit: number;
  fillEntry: number;
  fillExit: number;
  units: number;
  notionalUsd: number;
  grossBps: number;
  netBps: number;
  grossUsd: number;
  netUsd: number;
  spreadBps: number;
  entryFeeBps: number;
  exitFeeBps: number;
  entryRiskUsd: number;
  stopBps: number;
  costBps: number;
  breadth: BreadthLabel | null;
}

export interface GateHits {
  reentry: number;
  onePerPair: number;
  slotA: number;
  slotB: number;
  bookSlots: number;
  cluster: number;
  openRisk: number;
  grossNotional: number;
  dailyHalt: number;
  weeklyHalt: number;
  bookHalt: number;
  dailyBackstop: number;
  pairBackstop: number;
  bookBackstop: number;
  beta: number;
  classRKill: number;
}

export interface BookResult {
  trades: ClosedTrade[];
  attempts: number;
  taken: number;
  noBar: number;
  invalidStop: number;
  /** Every failed gate on a rejected attempt. A trade can add to more than one. */
  hits: GateHits;
  hitsByClass: { A: GateHits; B: GateHits };
  betaApplied: boolean;
  betaUnresolved: number;
  breadthLog: { productId: string; entryTs: number; taken: boolean; breadth: BreadthLabel | null; notionalUsd: number; riskUsd: number }[];
  /** Highest open-position count observed while this book was running. */
  maxOpen: number;
}

interface Position {
  classId: "A" | "B";
  productId: string;
  signalDate: string;
  entryTs: number;
  rawEntry: number;
  fillEntry: number;
  units: number;
  notionalUsd: number;
  stop: number;
  highestClose: number;
  ruleExitTs: number | null;
  ruleExitAt: "open" | "close";
  cluster: string;
  lastBar: BookBar;
  spreadBps: number;
  entryRiskUsd: number;
  stopBps: number;
  costBps: number;
  beta: number | null;
  stopMoved: boolean;
  breadth: BreadthLabel | null;
}

function emptyHits(): GateHits {
  return {
    reentry: 0,
    onePerPair: 0,
    slotA: 0,
    slotB: 0,
    bookSlots: 0,
    cluster: 0,
    openRisk: 0,
    grossNotional: 0,
    dailyHalt: 0,
    weeklyHalt: 0,
    bookHalt: 0,
    dailyBackstop: 0,
    pairBackstop: 0,
    bookBackstop: 0,
    beta: 0,
    classRKill: 0,
  };
}

export function dateOfTs(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function isDayCloseBar(ts: number): boolean {
  return ts % DAY === DAY - BAR;
}

function liveRisk(pos: Position, sBtBps: number): number {
  if (!pos.stopMoved) return pos.entryRiskUsd;
  return openRiskAfterMove(pos.units, pos.fillEntry, pos.stop, sBtBps);
}

function markUsd(pos: Position, sBtBps: number): number {
  const exitFill = x1FillPrice(pos.lastBar.close, "sell", sBtBps);
  return (netBps(pos.fillEntry, exitFill, TAKER_FEE_BPS, TAKER_FEE_BPS) / 10_000) * pos.units * pos.fillEntry;
}

function closeTrade(pos: Position, reason: ClosedTrade["reason"], exitTs: number, rawExit: number, fillExit: number, windowMark: boolean): ClosedTrade {
  const gross = grossBps(pos.rawEntry, rawExit);
  const net = netBps(pos.fillEntry, fillExit, TAKER_FEE_BPS, TAKER_FEE_BPS);
  return {
    classId: pos.classId,
    productId: pos.productId,
    signalDate: pos.signalDate,
    entryTs: pos.entryTs,
    exitTs,
    reason,
    windowMark,
    rawEntry: pos.rawEntry,
    rawExit,
    fillEntry: pos.fillEntry,
    fillExit,
    units: pos.units,
    notionalUsd: pos.notionalUsd,
    grossBps: gross,
    netBps: net,
    grossUsd: pos.units * (rawExit - pos.rawEntry),
    netUsd: (net / 10_000) * pos.units * pos.fillEntry,
    spreadBps: pos.spreadBps,
    entryFeeBps: TAKER_FEE_BPS,
    exitFeeBps: TAKER_FEE_BPS,
    entryRiskUsd: pos.entryRiskUsd,
    stopBps: pos.stopBps,
    costBps: pos.costBps,
    breadth: pos.breadth,
  };
}

export type RuleExit = { ts: number; at: "open" | "close" };

function ruleExitOf(value: number | RuleExit | null): RuleExit | null {
  if (value == null) return null;
  if (typeof value === "number") return { ts: value, at: "open" };
  return value;
}

export function runBook(opts: {
  pairs: readonly BookPair[];
  candidates: readonly BookCandidate[];
  ruleExitTs: (candidate: BookCandidate, rawEntry: number, initialStop: number) => number | RuleExit | null;
  sBtBps: number;
  endTs: number;
  costBps?: number;
  betaOf?: (productId: string, entryDate: string) => number | null;
  breadthOf?: (entryDate: string) => BreadthLabel;
  /** Open names allowed in one cluster. The v3.1 book uses 3. The registered comparison uses 2. */
  clusterMaxOpen?: number;
}): BookResult {
  const pairs = new Map(opts.pairs.map((pair) => [pair.productId, pair]));
  const costBps = opts.costBps ?? sizingCostBps(opts.sBtBps);
  const byTs = new Map<number, BookCandidate[]>();
  let start = opts.endTs;
  for (const candidate of opts.candidates) {
    const list = byTs.get(candidate.entryTs) ?? [];
    list.push(candidate);
    byTs.set(candidate.entryTs, list);
    if (candidate.entryTs < start) start = candidate.entryTs;
  }
  for (const list of byTs.values()) {
    list.sort((a, b) => tieRank(a.classId) - tieRank(b.classId) || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
  }
  const hits = emptyHits();
  const hitsByClass = { A: emptyHits(), B: emptyHits() };
  const trades: ClosedTrade[] = [];
  const open: Position[] = [];
  const lastExit = new Map<string, number>();
  let realized = 0;
  let peakEquity = 0;
  const pairPnl = new Map<string, number>();
  const classR = { A: 0, B: 0 };
  const classPeak = { A: 0, B: 0 };
  const classUsd = { A: 0, B: 0 };
  let attempts = 0;
  let taken = 0;
  let noBar = 0;
  let invalidStop = 0;
  let betaUnresolved = 0;
  const breadthLog: BookResult["breadthLog"] = [];
  const classUsdPeak = { A: 0, B: 0 };
  const classKilled = { A: false, B: false };
  const clusterMax = opts.clusterMaxOpen ?? CLUSTER_MAX_OPEN;
  let maxOpen = 0;
  let dayKey = "";
  let dayStart = 0;
  let weekStartKey = "";
  let weekStart = 0;

  const equity = () => realized + open.reduce((sum, pos) => sum + markUsd(pos, opts.sBtBps), 0);
  const bumpPeak = () => {
    peakEquity = Math.max(peakEquity, equity());
  };

  const realize = (trade: ClosedTrade, entryRiskUsd: number) => {
    trades.push(trade);
    realized += trade.netUsd;
    pairPnl.set(trade.productId, (pairPnl.get(trade.productId) ?? 0) + trade.netUsd);
    const r = entryRiskUsd > 0 ? trade.netUsd / entryRiskUsd : 0;
    classUsd[trade.classId] += trade.netUsd;
    classUsdPeak[trade.classId] = Math.max(classUsdPeak[trade.classId], classUsd[trade.classId]);
    classR[trade.classId] += r;
    classPeak[trade.classId] = Math.max(classPeak[trade.classId], classR[trade.classId]);
    if (classKillTripped(classPeak[trade.classId], classR[trade.classId], classUsdPeak[trade.classId], classUsd[trade.classId])) {
      classKilled[trade.classId] = true;
    }
    lastExit.set(trade.productId, trade.exitTs);
    bumpPeak();
  };

  const drop = (pos: Position, reason: ClosedTrade["reason"], rawExit: number, fillExit: number, windowMark: boolean) => {
    const index = open.indexOf(pos);
    if (index >= 0) open.splice(index, 1);
    realize(closeTrade(pos, reason, pos.lastBar.ts, rawExit, fillExit, windowMark), pos.entryRiskUsd);
  };

  for (let ts = start; ts < opts.endTs; ts += BAR) {
    const date = dateOfTs(ts);
    const week = weekKey(date);
    if (date !== dayKey) {
      dayStart = equity();
      dayKey = date;
    }
    if (week !== weekStartKey) {
      weekStart = equity();
      weekStartKey = week;
    }
    for (const pos of open.slice()) {
      const bar = pairs.get(pos.productId)?.bars.get(ts);
      if (!bar) continue;
      if (bar.open <= pos.stop) {
        pos.lastBar = bar;
        drop(pos, "gap", bar.open, bar.open, false);
      }
    }
    const due = byTs.get(ts) ?? [];
    for (const candidate of due) {
      attempts += 1;
      const pair = pairs.get(candidate.productId);
      const bar = pair?.bars.get(ts);
      if (!pair || !bar) {
        noBar += 1;
        continue;
      }
      const rawEntry = bar.open;
      const initialStop = rawEntry - candidate.stopDistance;
      if (!(initialStop > 0) || !(initialStop < rawEntry)) {
        invalidStop += 1;
        continue;
      }
      const stopBps = ((rawEntry - initialStop) / rawEntry) * 10_000;
      const notional = notionalUsd(stopBps, costBps);
      const fillEntry = x1FillPrice(rawEntry, "buy", opts.sBtBps);
      const units = notional / fillEntry;
      const addRisk = entryOpenRiskUsd(notional, stopBps, costBps);
      const entryDate = dateOfTs(ts);
      const cluster = pair.clusterOf(entryDate);
      const openRisk = open.reduce((sum, pos) => sum + liveRisk(pos, opts.sBtBps), 0);
      const gross = open.reduce((sum, pos) => sum + pos.notionalUsd, 0);
      const now = equity();
      const dailyLoss = Math.max(0, dayStart - now);
      const weeklyLoss = Math.max(0, weekStart - now);
      const pairMark = open.filter((pos) => pos.productId === candidate.productId).reduce((sum, pos) => sum + markUsd(pos, opts.sBtBps), 0);
      const pairLoss = Math.max(0, -((pairPnl.get(candidate.productId) ?? 0) + pairMark));
      const drawdown = Math.max(0, peakEquity - now);
      const rawBeta = opts.betaOf ? opts.betaOf(candidate.productId, entryDate) : null;
      const beta = opts.betaOf ? (rawBeta ?? 1) : null;
      const breadth = opts.breadthOf?.(entryDate) ?? null;
      const failed: (keyof GateHits)[] = [];
      if (!reentryAllowed(lastExit.has(candidate.productId) ? lastExit.get(candidate.productId)! * 1000 : null, ts * 1000)) failed.push("reentry");
      if (!onePerPairAllows(open.map((pos) => pos.productId), candidate.productId)) failed.push("onePerPair");
      const classOpen = open.filter((pos) => pos.classId === candidate.classId).length;
      if (candidate.classId === "A" && classOpen >= SLOT_CAPS.A) failed.push("slotA");
      if (candidate.classId === "B" && classOpen >= SLOT_CAPS.B) failed.push("slotB");
      if (open.length >= MAX_POSITIONS) failed.push("bookSlots");
      const openInCluster = open.filter((pos) => pos.cluster === cluster).length;
      if (openInCluster >= clusterMax) failed.push("cluster");
      if (!openRiskAllows(openRisk, addRisk)) failed.push("openRisk");
      if (!grossNotionalAllows(gross, notional)) failed.push("grossNotional");
      if (opts.betaOf) {
        if (rawBeta == null) betaUnresolved += 1;
        const weighted = open.reduce((sum, pos) => sum + pos.notionalUsd * betaWeight(pos.beta ?? 0), 0) + notional * betaWeight(beta ?? 1);
        if (!betaAllows(weighted)) failed.push("beta");
      }
      if (dailyLoss >= DAILY_HALT_USD) failed.push("dailyHalt");
      if (weeklyLoss >= WEEKLY_HALT_USD) failed.push("weeklyHalt");
      if (drawdown >= -BOOK_HALT_USD) failed.push("bookHalt");
      if (dailyLoss >= BACKSTOP_DAILY_USD) failed.push("dailyBackstop");
      if (pairLoss >= BACKSTOP_PAIR_USD) failed.push("pairBackstop");
      if (drawdown >= BACKSTOP_BOOK_USD) failed.push("bookBackstop");
      if (classKilled[candidate.classId] || classKillTripped(classPeak[candidate.classId], classR[candidate.classId], classUsdPeak[candidate.classId], classUsd[candidate.classId])) {
        classKilled[candidate.classId] = true;
        failed.push("classRKill");
      }
      breadthLog.push({ productId: candidate.productId, entryTs: ts, taken: failed.length === 0, breadth, notionalUsd: notional, riskUsd: addRisk });
      if (failed.length > 0) {
        for (const gate of failed) {
          hits[gate] += 1;
          hitsByClass[candidate.classId][gate] += 1;
        }
        continue;
      }
      taken += 1;
      maxOpen = Math.max(maxOpen, open.length + 1);
      const ruleExit = ruleExitOf(opts.ruleExitTs(candidate, rawEntry, initialStop));
      open.push({
        classId: candidate.classId,
        productId: candidate.productId,
        signalDate: candidate.signalDate,
        entryTs: ts,
        rawEntry,
        fillEntry,
        units,
        notionalUsd: notional,
        stop: initialStop,
        highestClose: Number.NEGATIVE_INFINITY,
        ruleExitTs: ruleExit?.ts ?? null,
        ruleExitAt: ruleExit?.at ?? "open",
        cluster,
        lastBar: bar,
        spreadBps: opts.sBtBps,
        entryRiskUsd: addRisk,
        stopBps,
        costBps,
        beta,
        stopMoved: false,
        breadth,
      });
    }
    for (const pos of open.slice()) {
      const bar = pos.lastBar.ts === ts ? pos.lastBar : pairs.get(pos.productId)?.bars.get(ts);
      if (!bar) continue;
      pos.lastBar = bar;
      const deduction = stopFillPrice(pos.stop, pos.rawEntry, opts.sBtBps, pairs.get(pos.productId)?.atr1h(ts) ?? 0);
      const fill = intrabarFill(bar, pos.stop, Number.POSITIVE_INFINITY);
      if (fill.kind === "stop" && fill.price != null && bar.open > pos.stop) {
        drop(pos, "stop", pos.stop, deduction, false);
        continue;
      }
      if (pos.ruleExitTs != null && pos.ruleExitAt === "open" && bar.ts === pos.ruleExitTs) {
        drop(pos, "rule", bar.open, x1FillPrice(bar.open, "sell", opts.sBtBps), false);
        continue;
      }
      if (pos.ruleExitTs != null && pos.ruleExitAt === "close" && bar.ts + BAR >= pos.ruleExitTs && bar.ts < pos.ruleExitTs) {
        drop(pos, "rule", bar.close, x1FillPrice(bar.close, "sell", opts.sBtBps), false);
        continue;
      }
      if (pos.classId === "A" && isDayCloseBar(bar.ts)) {
        const daily = pairs.get(pos.productId)?.daily.get(dateOfTs(bar.ts));
        if (daily && daily.close > 0 && daily.atr > 0) {
          pos.highestClose = Math.max(pos.highestClose, daily.close);
          const next = Math.max(pos.stop, pos.highestClose - TRAIL_ATR * daily.atr);
          if (next > pos.stop) pos.stopMoved = true;
          pos.stop = next;
        }
      }
    }
    bumpPeak();
  }
  for (const pos of open.slice()) {
    drop(pos, "window", pos.lastBar.close, x1FillPrice(pos.lastBar.close, "sell", opts.sBtBps), true);
  }
  trades.sort((a, b) => a.entryTs - b.entryTs || (a.productId < b.productId ? -1 : 1) || (a.classId < b.classId ? -1 : 1));
  return { trades, attempts, taken, noBar, invalidStop, hits, hitsByClass, betaApplied: opts.betaOf != null, betaUnresolved, breadthLog, maxOpen };
}

export interface ClosePoint {
  date: string;
  close: number;
}

export interface ClusterName {
  productId: string;
  flags: GroupFlags;
  days: readonly ClosePoint[];
}

/** Last 60 simple returns before `asOf`. The caller decides which closes are allowed. */
export function trailingReturns(days: readonly ClosePoint[], asOf: string): Map<string, number> {
  const prior = days.filter((row) => row.date < asOf && row.close > 0);
  const last = prior.slice(-CLUSTER_CORR_DAYS - 1);
  const out = new Map<string, number>();
  for (let i = 1; i < last.length; i += 1) {
    const prev = last[i - 1]!;
    const cur = last[i]!;
    if (prev.close > 0) out.set(cur.date, cur.close / prev.close - 1);
  }
  return out;
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length !== ys.length || xs.length < CLUSTER_CORR_DAYS) return null;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    sx += xs[i]!;
    sy += ys[i]!;
  }
  const mx = sx / xs.length;
  const my = sy / ys.length;
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (!(vx > 0) || !(vy > 0)) return null;
  return cov / Math.sqrt(vx * vy);
}

/** Single linkage. The cluster id is the earliest product id in the component. */
export function singleLinkage(ids: readonly string[], linked: readonly [string, string][]): Map<string, string> {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    const next = parent.get(id) ?? id;
    if (next === id) return id;
    const root = find(next);
    parent.set(id, root);
    return root;
  };
  for (const [left, right] of linked) {
    const a = find(left);
    const b = find(right);
    if (a === b) continue;
    if (a < b) parent.set(b, a);
    else parent.set(a, b);
  }
  const out = new Map<string, string>();
  for (const id of ids) out.set(id, find(id));
  return out;
}

/**
 * Average linkage as of each date, using returns strictly before that day.
 * A name with fewer than 60 returns stays in its own cluster.
 * `memberOn`, when set, keeps the clustering to members on that date.
 */
export function monthlyClusters(
  names: readonly ClusterName[],
  months: readonly string[],
  memberOn?: (productId: string, date: string) => boolean,
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const month of months) {
    const active = names.filter((name) => memberOn == null || memberOn(name.productId, month));
    const returns = new Map(active.map((name) => [name.productId, trailingReturns(name.days, month)]));
    const eligible = active.filter((name) => (returns.get(name.productId)?.size ?? 0) >= CLUSTER_CORR_DAYS).map((name) => name.productId);
    const rhoOf = (left: string, right: string): number | null => {
      const a = returns.get(left);
      const b = returns.get(right);
      if (!a || !b) return null;
      const dates = [...a.keys()].filter((date) => b.has(date)).sort().slice(-CLUSTER_CORR_DAYS);
      if (dates.length < CLUSTER_CORR_DAYS) return null;
      return pearson(dates.map((date) => a.get(date)!), dates.map((date) => b.get(date)!));
    };
    const assigned = averageLinkage(eligible, rhoOf);
    const clusters = new Map<string, string>();
    for (const name of active) {
      const own = (returns.get(name.productId)?.size ?? 0) < CLUSTER_CORR_DAYS;
      clusters.set(name.productId, own ? name.productId : assigned.get(name.productId) ?? name.productId);
    }
    out.set(month, clusters);
  }
  return out;
}

/**
 * The registered v3 cluster rule. Single linkage, rho at least 0.80 on 60 shared
 * in-window return dates, recomputed on the first UTC day of the month.
 * A boundary-saved name with fewer than 60 in-window days stays alone.
 */
export function registeredSingleLinkageClusters(names: readonly ClusterName[], months: readonly string[]): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  for (const month of months) {
    const returns = new Map(names.map((name) => [name.productId, trailingReturns(name.days, month)]));
    const linked: [string, string][] = [];
    for (let i = 0; i < names.length; i += 1) {
      for (let j = i + 1; j < names.length; j += 1) {
        const left = names[i]!;
        const right = names[j]!;
        const a = returns.get(left.productId)!;
        const b = returns.get(right.productId)!;
        const dates = [...a.keys()].filter((date) => b.has(date)).sort();
        if (dates.length < CLUSTER_CORR_DAYS) continue;
        const used = dates.slice(-CLUSTER_CORR_DAYS);
        const rho = pearson(used.map((date) => a.get(date)!), used.map((date) => b.get(date)!));
        if (rho != null && rho >= 0.8) linked.push([left.productId, right.productId]);
      }
    }
    const assigned = singleLinkage(names.map((name) => name.productId), linked);
    const clusters = new Map<string, string>();
    for (const name of names) {
      const inWindowDays = name.days.filter((row) => row.date >= WINDOW_START && row.date < month).length;
      clusters.set(name.productId, clusterKey(name.flags, inWindowDays, name.productId, assigned.get(name.productId) ?? name.productId));
    }
    out.set(month, clusters);
  }
  return out;
}

export function monthKey(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

export function concentration(trades: readonly { productId: string; grossUsd: number }[]): {
  trades: number;
  grossUsd: number;
  top3TradeGrossUsd: number;
  top3TradeShare: number | null;
  top2PairGrossUsd: number;
  top2PairShare: number | null;
} {
  const total = trades.reduce((sum, trade) => sum + trade.grossUsd, 0);
  const ranked = trades.map((trade) => trade.grossUsd).sort((a, b) => b - a);
  const top3 = ranked.slice(0, 3).reduce((sum, value) => sum + value, 0);
  const byPair = new Map<string, number>();
  for (const trade of trades) byPair.set(trade.productId, (byPair.get(trade.productId) ?? 0) + trade.grossUsd);
  const pairs = [...byPair.values()].sort((a, b) => b - a);
  const top2 = pairs.slice(0, 2).reduce((sum, value) => sum + value, 0);
  return {
    trades: trades.length,
    grossUsd: total,
    top3TradeGrossUsd: top3,
    top3TradeShare: total === 0 ? null : top3 / total,
    top2PairGrossUsd: top2,
    top2PairShare: total === 0 ? null : top2 / total,
  };
}
