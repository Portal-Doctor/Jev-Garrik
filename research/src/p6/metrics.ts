/**
 * Amendment 2 report definitions. Colours do not promote or kill.
 * Percentiles are percentileLinear. Wilson uses one-sided z, not 1.96.
 */

import { createHash } from "node:crypto";
import { percentileLinear, weekKey } from "../p5/stats";
import type { BreadthLabel } from "../p5/guards";

export const WILSON_Z80 = 0.8416;
export const WILSON_Z95 = 1.645;
export const MASTER_SEED = 4_109_854_067;
export const BOOTSTRAP_DRAWS = 2_000;

export const BOOTSTRAP_SEEDS = {
  "3a:placebo": 2_613_899_018,
  "3b:placebo": 3_177_882_488,
  "A:bootstrap": 422_918_504,
  "B:bootstrap": 3_151_362_213,
  "C:bootstrap": 1_047_788_147,
  "D:bootstrap": 821_766_163,
  "E:bootstrap": 2_319_709_643,
  "book:bootstrap": 921_260_057,
} as const;

export type Colour = "GREEN" | "YELLOW" | "RED" | "GREY";

export function subSeed(stream: string, purpose: string, master = MASTER_SEED): number {
  const hex = createHash("sha256").update(`${master}:${stream}:${purpose}`).digest("hex").slice(0, 8);
  return Number.parseInt(hex, 16);
}

/** One-sided Wilson lower bound, floored at 0. */
export function wilsonLower(successes: number, n: number, z: number): number | null {
  if (!(n > 0) || successes < 0 || successes > n) return null;
  const p = successes / n;
  const z2 = z * z;
  const centre = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (centre - margin) / (1 + z2 / n));
}

export interface Payoff {
  pHat: number | null;
  pStar: number | null;
  margin: number | null;
  wilsonMargin80: number | null;
  wilsonMargin95: number | null;
  l80: number | null;
  l95: number | null;
  colour: Colour;
}

export function payoffBreakEven(netR: readonly number[]): Payoff {
  const n = netR.length;
  if (n === 0) {
    return { pHat: null, pStar: null, margin: null, wilsonMargin80: null, wilsonMargin95: null, l80: null, l95: null, colour: "GREY" };
  }
  const winners = netR.filter((value) => value > 0);
  const losers = netR.filter((value) => value <= 0);
  const pHat = winners.length / n;
  const l80 = wilsonLower(winners.length, n, WILSON_Z80);
  const l95 = wilsonLower(winners.length, n, WILSON_Z95);
  let pStar: number | null;
  if (winners.length === 0) pStar = null;
  else if (losers.length === 0) pStar = 0;
  else {
    const w = winners.reduce((sum, value) => sum + value, 0) / winners.length;
    const l = losers.reduce((sum, value) => sum + Math.abs(value), 0) / losers.length;
    pStar = w + l === 0 ? 0 : l / (w + l);
  }
  const margin = pStar == null ? null : pHat - pStar;
  const wilsonMargin80 = pStar == null || l80 == null ? null : l80 - pStar;
  const wilsonMargin95 = pStar == null || l95 == null ? null : l95 - pStar;
  let colour: Colour = "GREY";
  if (n >= 30) {
    if (pStar == null || (margin != null && margin < 0)) colour = "RED";
    else if (l80 != null && pStar != null && l80 > pStar) colour = "GREEN";
    else colour = "YELLOW";
  }
  return { pHat, pStar, margin, wilsonMargin80, wilsonMargin95, l80, l95, colour };
}

export interface CostDrag {
  cd: number | null;
  status: "ok" | "n/a";
  colour: Colour;
  meanCostR: number | null;
  meanCostBps: number | null;
}

export function costDrag(trades: readonly { costUsd: number; grossUsd: number; riskUsd: number; notionalUsd: number }[]): CostDrag {
  const n = trades.length;
  const positive = trades.reduce((sum, trade) => sum + Math.max(trade.grossUsd, 0), 0);
  const gross = trades.reduce((sum, trade) => sum + trade.grossUsd, 0);
  const costs = trades.reduce((sum, trade) => sum + trade.costUsd, 0);
  const meanCostR = n === 0 ? null : trades.reduce((sum, trade) => sum + (trade.riskUsd > 0 ? trade.costUsd / trade.riskUsd : 0), 0) / n;
  const meanCostBps = n === 0 ? null : trades.reduce((sum, trade) => sum + (trade.notionalUsd > 0 ? (10_000 * trade.costUsd) / trade.notionalUsd : 0), 0) / n;
  if (n === 0) return { cd: null, status: "n/a", colour: "GREY", meanCostR, meanCostBps };
  if (!(positive > 0) || gross <= 0) return { cd: null, status: "n/a", colour: n >= 10 ? "RED" : "GREY", meanCostR, meanCostBps };
  const cd = costs / positive;
  let colour: Colour = "GREY";
  if (n >= 10) {
    if (cd >= 0.5) colour = "RED";
    else if (cd >= 0.25) colour = "YELLOW";
    else colour = "GREEN";
  }
  return { cd, status: "ok", colour, meanCostR, meanCostBps };
}

export function maxDrawdownR(netR: readonly number[]): number {
  let cum = 0;
  let peak = 0;
  let worst = 0;
  for (const value of netR) {
    cum += value;
    peak = Math.max(peak, cum);
    worst = Math.max(worst, peak - cum);
  }
  return worst;
}

export function colourDrawdown(classId: string, drawdownR: number, n: number): { colour: Colour; killed: boolean } {
  const killed = drawdownR >= 20;
  if (n < 1) return { colour: "GREY", killed };
  const greenBelow = classId === "A" || classId === "B" ? 7 : 5;
  if (drawdownR >= 10) return { colour: "RED", killed };
  if (drawdownR >= greenBelow) return { colour: "YELLOW", killed };
  return { colour: "GREEN", killed };
}

export function colourMean(n: number, mean: number | null, l80: number | null): Colour {
  if (n < 30 || mean == null || l80 == null) return "GREY";
  if (mean <= 0) return "RED";
  if (l80 > 0) return "GREEN";
  return "YELLOW";
}

export function colourMonthly(n: number, point: number | null, l80: number | null): Colour {
  if (n < 30 || point == null || l80 == null) return "GREY";
  if (point <= 0) return "RED";
  if (l80 > 0) return "GREEN";
  return "YELLOW";
}

export function colourN(n: number, forwardDays: number): Colour {
  return n >= 30 && forwardDays >= 90 ? "GREEN" : "YELLOW";
}

export function colourRolling(n: number, sum: number | null): Colour {
  if (n < 20 || sum == null) return "GREY";
  if (sum <= -5) return "RED";
  if (sum <= 0) return "YELLOW";
  return "GREEN";
}

export function colourIndeterminate(submitted: number, share: number | null): Colour {
  if (share == null || submitted < 10) return "GREY";
  if (share > 0.1) return "RED";
  if (share > 0.05) return "YELLOW";
  return "GREEN";
}

/** Ex-top-3 net dollars: total net minus the three largest net-dollar trades. */
export function exTop3Net(netUsd: readonly number[]): number {
  const ranked = netUsd.slice().sort((a, b) => b - a);
  const dropped = ranked.slice(0, 3).reduce((sum, value) => sum + value, 0);
  return netUsd.reduce((sum, value) => sum + value, 0) - dropped;
}

export function colourExTop3(classId: string, n: number, exNet: number, medianNetR: number | null): { colour: Colour; scored: boolean; flag: boolean } {
  if (n < 30 || medianNetR == null) return { colour: "GREY", scored: false, flag: false };
  const red = exNet < 0 && medianNetR < -0.5;
  if (red) return { colour: "RED", scored: true, flag: true };
  if (exNet <= 0 && (classId === "A" || classId === "B")) return { colour: "GREY", scored: false, flag: true };
  if (exNet <= 0) return { colour: "YELLOW", scored: true, flag: true };
  return { colour: "GREEN", scored: true, flag: false };
}

export function top2PairShare(trades: readonly { productId: string; grossUsd: number }[]): number | null {
  const positive = trades.reduce((sum, trade) => sum + Math.max(trade.grossUsd, 0), 0);
  if (!(positive > 0)) return null;
  const byPair = new Map<string, number>();
  for (const trade of trades) byPair.set(trade.productId, (byPair.get(trade.productId) ?? 0) + trade.grossUsd);
  const ranked = [...byPair.values()].sort((a, b) => b - a);
  return ((ranked[0] ?? 0) + (ranked[1] ?? 0)) / positive;
}

export function largestTradeShare(netUsd: readonly number[]): number | null {
  const total = netUsd.reduce((sum, value) => sum + value, 0);
  if (!(total > 0) || netUsd.length === 0) return null;
  return Math.max(...netUsd) / total;
}

export function colourTop2(n: number, share: number | null, largest: number | null): Colour {
  if (n < 30 || share == null) return "GREY";
  if (share > 0.8) return "RED";
  if (share > 0.5 || (largest != null && largest > 0.6)) return "YELLOW";
  return "GREEN";
}

export function colour3a(positionDaysWithFire: number, positionDays: number): Colour {
  if (!(positionDays >= 20)) return "GREY";
  const share = positionDaysWithFire / positionDays;
  if (share > 0.1) return "RED";
  if (share > 0.05) return "YELLOW";
  return "GREEN";
}

export function colour3b(blockedHours: number, hours: number): Colour {
  if (!(hours >= 24 * 7)) return "GREY";
  const share = blockedHours / hours;
  if (share > 0.15) return "RED";
  if (share > 0.075) return "YELLOW";
  return "GREEN";
}

export interface Scored {
  name: string;
  colour: Colour;
  scored: boolean;
}

/** No RED, at least two-thirds of the scored metrics GREEN (round up), and at least 6 scored. */
export function mostlyGreen(metrics: readonly Scored[]): boolean {
  const scored = metrics.filter((metric) => metric.scored && metric.colour !== "GREY");
  if (scored.length < 6) return false;
  if (scored.some((metric) => metric.colour === "RED")) return false;
  const green = scored.filter((metric) => metric.colour === "GREEN").length;
  return green >= Math.ceil((scored.length * 2) / 3);
}

export function placeboP(guardStat: number, draws: readonly number[]): number {
  const ge = draws.filter((value) => value >= guardStat).length;
  return (1 + ge) / (draws.length + 1);
}

export function medianNetR(netR: readonly number[]): number | null {
  if (netR.length === 0) return null;
  return percentileLinear(netR.slice().sort((a, b) => a - b), 0.5);
}

export function rolling20Sum(netR: readonly number[]): number | null {
  if (netR.length < 20) return null;
  return netR.slice(-20).reduce((sum, value) => sum + value, 0);
}

export interface ReviewTrade {
  classId: string;
  productId: string;
  netR: number;
  netUsd: number;
  grossUsd: number;
  costUsd: number;
  riskUsd: number;
  notionalUsd: number;
  entryDate: string;
  breadth: BreadthLabel;
}

export function classPanel(opts: {
  classId: string;
  trades: readonly ReviewTrade[];
  forwardDays: number;
  meanNetR: number | null;
  l80NetR: number | null;
  monthlyPoint: number | null;
  monthlyL80: number | null;
  indeterminateSubmitted: number;
  indeterminateShare: number | null;
}): { metrics: Scored[]; mostlyGreen: boolean; payoff: Payoff; cost: CostDrag; drawdownR: number } {
  const trades = opts.trades.filter((trade) => trade.classId === opts.classId);
  const netR = trades.map((trade) => trade.netR);
  const n = trades.length;
  const payoff = payoffBreakEven(netR);
  const cost = costDrag(trades);
  const drawdownR = maxDrawdownR(netR);
  const drawdown = colourDrawdown(opts.classId, drawdownR, n);
  const ex = exTop3Net(trades.map((trade) => trade.netUsd));
  const median = medianNetR(netR);
  const exColour = colourExTop3(opts.classId, n, ex, median);
  const share = top2PairShare(trades);
  const largest = largestTradeShare(trades.map((trade) => trade.netUsd));
  const metrics: Scored[] = [
    { name: "n", colour: colourN(n, opts.forwardDays), scored: true },
    { name: "mean", colour: colourMean(n, opts.meanNetR, opts.l80NetR), scored: n >= 30 },
    { name: "monthly", colour: colourMonthly(n, opts.monthlyPoint, opts.monthlyL80), scored: n >= 30 },
    { name: "wilson", colour: payoff.colour, scored: n >= 30 },
    { name: "cost", colour: cost.colour, scored: n >= 10 && cost.colour !== "GREY" },
    { name: "exTop3", colour: exColour.colour, scored: exColour.scored },
    { name: "top2", colour: colourTop2(n, share, largest), scored: n >= 30 && share != null },
    { name: "drawdown", colour: drawdown.colour, scored: n >= 1 },
    { name: "rolling", colour: colourRolling(n, rolling20Sum(netR)), scored: n >= 20 },
    { name: "indeterminate", colour: colourIndeterminate(opts.indeterminateSubmitted, opts.indeterminateShare), scored: opts.indeterminateSubmitted >= 10 && opts.indeterminateShare != null },
  ];
  return { metrics, mostlyGreen: mostlyGreen(metrics), payoff, cost, drawdownR };
}

export function entryWeek(date: string): string {
  return weekKey(date);
}
