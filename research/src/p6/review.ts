/**
 * Forward review. Wilson, cost drag, and the payoff break-even stay unset.
 * See open questions wilson, cost-drag, break-even, and guard-p.
 */

import { concentration } from "../p5/book";
import { breadthNetRSplit, forwardAbKill, sprtReport, type BreadthLabel } from "../p5/guards";
import { holmAdjusted, netRStreamP, oneSided80TradeMean, weeklyGroups, weekKey, type PValue } from "../p5/stats";

export const FORWARD_CLASSES = ["A", "B", "C", "D", "E"] as const;
export type ForwardClass = (typeof FORWARD_CLASSES)[number];

export interface ForwardTrade {
  classId: ForwardClass;
  productId: string;
  netR: number;
  grossUsd: number;
  netUsd: number;
  entryDate: string;
  breadth: BreadthLabel;
}

export interface ForwardReview {
  n: number;
  meanNetR: number | null;
  l80NetR: number | null;
  hitRate: number | null;
  payoffBreakEven: null;
  wilson: null;
  costDrag: null;
  breadth: ReturnType<typeof breadthNetRSplit>;
  concentration: ReturnType<typeof concentration>;
  exTop3: { n: number; meanNetR: number | null };
  flags: { concentration: boolean; singleTrade: boolean; exTop3: boolean };
  kill: ReturnType<typeof forwardAbKill> | "not a kill class";
  sprt: ReturnType<typeof sprtReport>;
  holm: {
    family: "5-stream";
    streams: { id: ForwardClass; n: number; p: number; status: string; adjusted: number }[];
  };
  jevGuards: {
    family: "2";
    streams: { id: "3a" | "3b"; n: number; p: 1; status: "not testable"; adjusted: number }[];
    note: string;
  };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export function forwardReview(opts: { classId: ForwardClass; trades: readonly ForwardTrade[]; weeks: readonly string[]; l80UsdPerMonth: number | null }): ForwardReview {
  const trades = opts.trades.filter((trade) => trade.classId === opts.classId);
  const netR = trades.map((trade) => trade.netR);
  const grouped = weeklyGroups(trades.map((trade) => ({ week: weekKey(trade.entryDate), value: trade.netR })), opts.weeks);
  const bound = oneSided80TradeMean(grouped);
  const ranked = [...trades].sort((a, b) => b.grossUsd - a.grossUsd || a.entryDate.localeCompare(b.entryDate) || a.productId.localeCompare(b.productId));
  const ex = netR.length <= 3 ? [] : ranked.slice(3).map((trade) => trade.netR);
  const exNet = ex.reduce((sum, value) => sum + value, 0);
  const gross = concentration(trades);
  const netSum = trades.reduce((sum, trade) => sum + trade.netUsd, 0);
  const largestNet = trades.reduce((best, trade) => Math.max(best, trade.netUsd), 0);
  const streams: PValue[] = FORWARD_CLASSES.map((id) => {
    const values = opts.trades.filter((trade) => trade.classId === id).map((trade) => trade.netR);
    const stream = netRStreamP(values);
    return { id, p: stream.p };
  });
  const adjusted = holmAdjusted(streams);
  const guard = holmAdjusted([
    { id: "3a", p: 1 },
    { id: "3b", p: 1 },
  ]);
  const wins = netR.filter((value) => value > 0).length;
  return {
    n: trades.length,
    meanNetR: mean(netR),
    l80NetR: bound?.l80 ?? null,
    hitRate: netR.length === 0 ? null : wins / netR.length,
    payoffBreakEven: null,
    wilson: null,
    costDrag: null,
    breadth: breadthNetRSplit(trades.map((trade) => ({ breadth: trade.breadth, netR: trade.netR }))),
    concentration: gross,
    exTop3: { n: ex.length, meanNetR: mean(ex) },
    flags: {
      concentration: gross.top2PairShare != null && gross.top2PairShare > 0.8,
      singleTrade: netSum !== 0 && largestNet / netSum > 0.6,
      exTop3: ex.length > 0 && exNet < 0 && (median(netR) ?? 0) < -0.5,
    },
    kill: opts.classId === "A" || opts.classId === "B" ? forwardAbKill(trades.length, mean(netR) ?? 0, opts.l80UsdPerMonth ?? 0) : "not a kill class",
    sprt: sprtReport(netR),
    holm: {
      family: "5-stream",
      streams: adjusted.map((row) => {
        const values = opts.trades.filter((trade) => trade.classId === row.id).map((trade) => trade.netR);
        const stream = netRStreamP(values);
        return { id: row.id as ForwardClass, n: stream.n, p: row.p, status: stream.status, adjusted: row.adjusted };
      }),
    },
    jevGuards: {
      family: "2",
      streams: guard.map((row) => ({ id: row.id as "3a" | "3b", n: 0, p: 1 as const, status: "not testable" as const, adjusted: row.adjusted })),
      note: "Both guards enter at p = 1. A valid p for 3a and 3b is not specified.",
    },
  };
}
