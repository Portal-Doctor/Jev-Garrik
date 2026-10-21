/**
 * Forward review built to amendment 2. Colours are a reading aid.
 * Wilson, cost drag, break-even, and the percentile are the frozen definitions.
 */

import { breadthNetRSplit, forwardAbKill, sprtReport, type BreadthLabel } from "../p5/guards";
import { holmAdjusted, netRStreamP, oneSided80, oneSided80TradeMean, weeklyGroups, weeklyValues, weekKey, WEEKS_PER_MONTH, type PValue } from "../p5/stats";
import { classPanel, costDrag, entryWeek, medianNetR, payoffBreakEven, placeboP, type ReviewTrade } from "./metrics";
import { countsInClassMean } from "./x1-fill";

export const FORWARD_CLASSES = ["A", "B", "C", "D", "E"] as const;
export type ForwardClass = (typeof FORWARD_CLASSES)[number];

export interface ForwardReview {
  n: number;
  meanNetR: number | null;
  l80NetR: number | null;
  hitRate: number | null;
  payoff: ReturnType<typeof payoffBreakEven>;
  cost: ReturnType<typeof costDrag>;
  breadth: ReturnType<typeof breadthNetRSplit>;
  drawdownR: number;
  medianNetR: number | null;
  colours: { name: string; colour: string; scored: boolean }[];
  mostlyGreen: boolean;
  kill: ReturnType<typeof forwardAbKill> | "not a kill class";
  sprt: ReturnType<typeof sprtReport>;
  holm: { family: "5-stream"; streams: { id: ForwardClass; n: number; p: number; status: string; adjusted: number }[] };
  jevGuards: { family: "2"; streams: { id: "3a" | "3b"; n: number; p: number; status: string; adjusted: number }[] };
  gates: { promote: boolean; coloursDoNotPromote: true; coloursDoNotKill: true };
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function forwardReview(opts: {
  classId: ForwardClass;
  trades: readonly ReviewTrade[];
  weeks: readonly string[];
  forwardDays?: number;
  monthlyL80?: number | null;
  monthlyPoint?: number | null;
  indeterminateSubmitted?: number;
  indeterminateShare?: number | null;
  jev?: { id: "3a" | "3b"; n: number; p: number }[];
  reps?: number;
  seed?: number;
}): ForwardReview {
  const eligible = opts.trades.filter((trade) => countsInClassMean(trade));
  const trades = eligible.filter((trade) => trade.classId === opts.classId);
  const netR = trades.map((trade) => trade.netR);
  const grouped = weeklyGroups(trades.map((trade) => ({ week: entryWeek(trade.entryDate), value: trade.netR })), opts.weeks);
  const bound = oneSided80TradeMean(grouped, { reps: opts.reps, seed: opts.seed });
  const dollars = weeklyValues(trades.map((trade) => ({ week: weekKey(trade.entryDate), value: trade.netUsd })), opts.weeks);
  const monthly = oneSided80(dollars, { reps: opts.reps, seed: opts.seed, scale: WEEKS_PER_MONTH });
  const monthlyPoint = opts.monthlyPoint ?? (dollars.length === 0 ? null : (dollars.reduce((sum, value) => sum + value, 0) / dollars.length) * WEEKS_PER_MONTH);
  const meanNetR = mean(netR);
  const l80 = bound?.l80 ?? null;
  const panel = classPanel({
    classId: opts.classId,
    trades: eligible,
    forwardDays: opts.forwardDays ?? 0,
    meanNetR,
    l80NetR: l80,
    monthlyPoint,
    monthlyL80: opts.monthlyL80 ?? monthly?.l80 ?? null,
    indeterminateSubmitted: opts.indeterminateSubmitted ?? 0,
    indeterminateShare: opts.indeterminateShare ?? null,
  });
  const streams: PValue[] = FORWARD_CLASSES.map((id) => {
    const values = eligible.filter((trade) => trade.classId === id).map((trade) => trade.netR);
    return { id, p: netRStreamP(values).p };
  });
  const adjusted = holmAdjusted(streams);
  const holmRow = adjusted.find((row) => row.id === opts.classId);
  const guardInput = opts.jev ?? [
    { id: "3a" as const, n: 0, p: 1 },
    { id: "3b" as const, n: 0, p: 1 },
  ];
  const guard = holmAdjusted(guardInput.map((row) => ({ id: row.id, p: row.n < 30 ? 1 : row.p })));
  const wins = netR.filter((value) => value > 0).length;
  const promote = (opts.forwardDays ?? 0) >= 90 && trades.length >= 30 && (meanNetR ?? 0) > 0 && (l80 ?? 0) > 0 && (holmRow?.adjusted ?? 1) < 0.05;
  return {
    n: trades.length,
    meanNetR,
    l80NetR: l80,
    hitRate: netR.length === 0 ? null : wins / netR.length,
    payoff: panel.payoff,
    cost: panel.cost,
    breadth: breadthNetRSplit(trades.map((trade) => ({ breadth: trade.breadth, netR: trade.netR }))),
    drawdownR: panel.drawdownR,
    medianNetR: medianNetR(netR),
    colours: panel.metrics,
    mostlyGreen: panel.mostlyGreen,
    kill: opts.classId === "A" || opts.classId === "B" ? forwardAbKill(trades.length, meanNetR ?? 0, opts.monthlyL80 ?? monthly?.l80 ?? 0) : "not a kill class",
    sprt: sprtReport(netR),
    holm: {
      family: "5-stream",
      streams: adjusted.map((row) => {
        const values = eligible.filter((trade) => trade.classId === row.id).map((trade) => trade.netR);
        const stream = netRStreamP(values);
        return { id: row.id as ForwardClass, n: stream.n, p: row.p, status: stream.status, adjusted: row.adjusted };
      }),
    },
    jevGuards: {
      family: "2",
      streams: guard.map((row) => {
        const source = guardInput.find((item) => item.id === row.id);
        const n = source?.n ?? 0;
        return { id: row.id as "3a" | "3b", n, p: row.p, status: n < 30 ? "not testable" : "testable", adjusted: row.adjusted };
      }),
    },
    gates: { promote, coloursDoNotPromote: true, coloursDoNotKill: true },
  };
}

export interface BookPanel {
  weeklyHaltsLast6: number;
  bookDrawdownUsd: number;
  parity7d: "match" | "break" | "n/a";
}

/** Book block of the review: halt count, equity drawdown, and the 7-day parity flag. */
export function bookPanel(input: BookPanel): BookPanel {
  return {
    weeklyHaltsLast6: input.weeklyHaltsLast6,
    bookDrawdownUsd: input.bookDrawdownUsd,
    parity7d: input.parity7d,
  };
}

/** Halt weeks whose Monday falls in the six weeks ending at `asOfWeek`. */
export function weeklyHaltsInLast6(haltWeeks: readonly string[], asOfWeek: string | null): number {
  if (asOfWeek == null) return 0;
  const end = Date.parse(`${asOfWeek}T00:00:00.000Z`);
  if (!Number.isFinite(end)) return 0;
  const start = end - 5 * 7 * 86_400_000;
  return haltWeeks.filter((week) => {
    const ts = Date.parse(`${week}T00:00:00.000Z`);
    return Number.isFinite(ts) && ts >= start && ts <= end;
  }).length;
}

/** Equal nets match. A missing replay is n/a. Any other difference is a break. */
export function parity7d(engineNetUsd: number | null, replayNetUsd: number | null): BookPanel["parity7d"] {
  if (engineNetUsd == null || replayNetUsd == null) return "n/a";
  return engineNetUsd === replayNetUsd ? "match" : "break";
}

export { placeboP };
export type { BreadthLabel };
