/**
 * Capped book for one A config plus class B.
 * A's trail is the highest completed daily close minus 3 times that day's Wilder ATR14.
 * The trail is moved only after the 15m bar that completes the UTC day.
 * The 1h ATR is used only in the stop-fill deduction.
 * The beta-weighted notional cap is not applied: the registration names the dollar cap and not the beta.
 */

import { TAKER_FEE_BPS } from "../../vendor/87b35d0/config.ts";
import { clusterKey, CLUSTER_CORR_DAYS, type GroupFlags } from "../p3/bar-access";
import {
  BACKSTOP_BOOK_USD,
  BACKSTOP_DAILY_USD,
  BACKSTOP_PAIR_USD,
  BOOK_HALT_USD,
  DAILY_HALT_USD,
  WEEKLY_HALT_USD,
  onePerPairAllows,
  openRiskAllows,
  grossNotionalAllows,
  clusterAllows,
  reentryAllowed,
  stopFillPrice,
  x1FillPrice,
} from "../p3/design-rules";
import { intrabarFill } from "../p3/fills";
import { WINDOW_START } from "../p3/f5";
import { MAX_POSITIONS, SLOT_CAPS, notionalUsd, tieRank } from "../p3/portfolio";
import { weekKey } from "./stats";
import { grossBps, netBps } from "./walk";

const DAY = 86_400;
const BAR = 900;
/** Two taker legs. The spread stays in the fill price. */
export const SIZING_COST_BPS = TAKER_FEE_BPS * 2;
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
  betaApplied: false;
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
  cluster: string;
  lastBar: BookBar;
  spreadBps: number;
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
  };
}

export function dateOfTs(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export function isDayCloseBar(ts: number): boolean {
  return ts % DAY === DAY - BAR;
}

function positionRisk(pos: Position): number {
  return pos.units * Math.max(0, pos.fillEntry - pos.stop);
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
  };
}

export function runBook(opts: {
  pairs: readonly BookPair[];
  candidates: readonly BookCandidate[];
  ruleExitTs: (candidate: BookCandidate, rawEntry: number, initialStop: number) => number | null;
  sBtBps: number;
  endTs: number;
  costBps?: number;
}): BookResult {
  const pairs = new Map(opts.pairs.map((pair) => [pair.productId, pair]));
  const costBps = opts.costBps ?? SIZING_COST_BPS;
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
  let bookPnl = 0;
  let peak = 0;
  const dailyPnl = new Map<string, number>();
  const weeklyPnl = new Map<string, number>();
  const pairPnl = new Map<string, number>();
  let attempts = 0;
  let taken = 0;
  let noBar = 0;
  let invalidStop = 0;

  const realize = (trade: ClosedTrade) => {
    trades.push(trade);
    bookPnl += trade.netUsd;
    if (bookPnl > peak) peak = bookPnl;
    const date = dateOfTs(trade.exitTs);
    dailyPnl.set(date, (dailyPnl.get(date) ?? 0) + trade.netUsd);
    const week = weekKey(date);
    weeklyPnl.set(week, (weeklyPnl.get(week) ?? 0) + trade.netUsd);
    pairPnl.set(trade.productId, (pairPnl.get(trade.productId) ?? 0) + trade.netUsd);
    lastExit.set(trade.productId, trade.exitTs);
  };

  const drop = (pos: Position, reason: ClosedTrade["reason"], rawExit: number, fillExit: number, windowMark: boolean) => {
    const index = open.indexOf(pos);
    if (index >= 0) open.splice(index, 1);
    realize(closeTrade(pos, reason, pos.lastBar.ts, rawExit, fillExit, windowMark));
  };

  for (let ts = start; ts < opts.endTs; ts += BAR) {
    for (const pos of open.slice()) {
      const bar = pairs.get(pos.productId)?.bars.get(ts);
      if (!bar) continue;
      pos.lastBar = bar;
      const worsened = stopFillPrice(pos.stop, pos.rawEntry, opts.sBtBps, pairs.get(pos.productId)?.atr1h(ts) ?? 0);
      if (bar.open <= worsened) drop(pos, "gap", bar.open, bar.open, false);
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
      const addRisk = units * (fillEntry - initialStop);
      const entryDate = dateOfTs(ts);
      const cluster = pair.clusterOf(entryDate);
      const openRisk = open.reduce((sum, pos) => sum + positionRisk(pos), 0);
      const gross = open.reduce((sum, pos) => sum + pos.notionalUsd, 0);
      const dailyLoss = Math.max(0, -(dailyPnl.get(entryDate) ?? 0));
      const weeklyLoss = Math.max(0, -(weeklyPnl.get(weekKey(entryDate)) ?? 0));
      const pairLoss = Math.max(0, -(pairPnl.get(candidate.productId) ?? 0));
      const drawdown = peak - bookPnl;
      const failed: (keyof GateHits)[] = [];
      if (!reentryAllowed(lastExit.has(candidate.productId) ? lastExit.get(candidate.productId)! * 1000 : null, ts * 1000)) failed.push("reentry");
      if (!onePerPairAllows(open.map((pos) => pos.productId), candidate.productId)) failed.push("onePerPair");
      const classOpen = open.filter((pos) => pos.classId === candidate.classId).length;
      if (candidate.classId === "A" && classOpen >= SLOT_CAPS.A) failed.push("slotA");
      if (candidate.classId === "B" && classOpen >= SLOT_CAPS.B) failed.push("slotB");
      if (open.length >= MAX_POSITIONS) failed.push("bookSlots");
      if (!clusterAllows(open.filter((pos) => pos.cluster === cluster).length)) failed.push("cluster");
      if (!openRiskAllows(openRisk, addRisk)) failed.push("openRisk");
      if (!grossNotionalAllows(gross, notional)) failed.push("grossNotional");
      if (dailyLoss >= DAILY_HALT_USD) failed.push("dailyHalt");
      if (weeklyLoss >= WEEKLY_HALT_USD) failed.push("weeklyHalt");
      if (bookPnl <= BOOK_HALT_USD) failed.push("bookHalt");
      if (dailyLoss >= BACKSTOP_DAILY_USD) failed.push("dailyBackstop");
      if (pairLoss >= BACKSTOP_PAIR_USD) failed.push("pairBackstop");
      if (drawdown >= BACKSTOP_BOOK_USD) failed.push("bookBackstop");
      if (failed.length > 0) {
        for (const gate of failed) {
          hits[gate] += 1;
          hitsByClass[candidate.classId][gate] += 1;
        }
        continue;
      }
      taken += 1;
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
        ruleExitTs: opts.ruleExitTs(candidate, rawEntry, initialStop),
        cluster,
        lastBar: bar,
        spreadBps: opts.sBtBps,
      });
    }
    for (const pos of open.slice()) {
      const bar = pos.lastBar.ts === ts ? pos.lastBar : pairs.get(pos.productId)?.bars.get(ts);
      if (!bar) continue;
      pos.lastBar = bar;
      const worsened = stopFillPrice(pos.stop, pos.rawEntry, opts.sBtBps, pairs.get(pos.productId)?.atr1h(ts) ?? 0);
      const fill = intrabarFill(bar, worsened, Number.POSITIVE_INFINITY);
      if (fill.kind === "stop" && fill.price != null && bar.open > worsened) {
        drop(pos, "stop", pos.stop, fill.price, false);
        continue;
      }
      if (pos.ruleExitTs != null && bar.ts + BAR >= pos.ruleExitTs && bar.ts < pos.ruleExitTs) {
        drop(pos, "rule", bar.close, x1FillPrice(bar.close, "sell", opts.sBtBps), false);
        continue;
      }
      if (pos.classId === "A" && isDayCloseBar(bar.ts)) {
        const daily = pairs.get(pos.productId)?.daily.get(dateOfTs(bar.ts));
        if (daily && daily.close > 0 && daily.atr > 0) {
          pos.highestClose = Math.max(pos.highestClose, daily.close);
          pos.stop = Math.max(pos.stop, pos.highestClose - TRAIL_ATR * daily.atr);
        }
      }
    }
  }
  for (const pos of open.slice()) {
    drop(pos, "window", pos.lastBar.close, x1FillPrice(pos.lastBar.close, "sell", opts.sBtBps), true);
  }
  trades.sort((a, b) => a.entryTs - b.entryTs || (a.productId < b.productId ? -1 : 1) || (a.classId < b.classId ? -1 : 1));
  return { trades, attempts, taken, noBar, invalidStop, hits, hitsByClass, betaApplied: false };
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

/** Last 60 simple returns before `asOf`, using that name's own in-window closes. */
export function trailingReturns(days: readonly ClosePoint[], asOf: string): Map<string, number> {
  const prior = days.filter((row) => row.date >= WINDOW_START && row.date < asOf && row.close > 0);
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
 * Clusters as of each month start, using returns strictly before that day.
 * A boundary-saved name with fewer than 60 in-window days stays in its own cluster.
 * A pair is linked only when 60 shared return dates have rho >= 0.8.
 */
export function monthlyClusters(names: readonly ClusterName[], months: readonly string[]): Map<string, Map<string, string>> {
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
