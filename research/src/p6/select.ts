/**
 * R7 pick for the forward A book.
 * The IS is anchored at 2025-11-10 and runs through the last completed day
 * before forward bar 1. Only the six registered configs are scored.
 * The statistic is the one-sided lower-80% weekly-block bound of mean net
 * dollars per month. Ties break on higher IS total net dollars, then
 * registration order.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../manifest";
import { addDays, cents, mondayWeeks, oneSided80, selectInSample, weeklyValues, weekKey, WEEKS_PER_MONTH } from "../p5/stats";

export const V31_REGISTRATION_SHA = "f4f7657329237bd29a3fe8f752daca82d4ef2a2b887346772e112146e7272c1d";
export const ANCHORED_IS_START = "2025-11-10";
/** First forward bar. The anchored IS ends on the previous completed day. */
export const FORWARD_BAR_1 = "2026-10-10T00:00:00.000Z";
export const FORWARD_PICK_FILE = "p6-forward-a.json";

export const A_REGISTRATION = [
  { id: "A20-k2", lookback: 20, k: 2 },
  { id: "A20-k2.5", lookback: 20, k: 2.5 },
  { id: "A20-k3", lookback: 20, k: 3 },
  { id: "A55-k2", lookback: 55, k: 2 },
  { id: "A55-k2.5", lookback: 55, k: 2.5 },
  { id: "A55-k3", lookback: 55, k: 3 },
] as const;

export type ALookback = (typeof A_REGISTRATION)[number]["lookback"];

export interface ScoredTrade {
  book: string;
  classId: string;
  path?: string;
  entryDate: string;
  exitDate: string;
  exitTs: number;
  netUsd: number;
  windowMark?: boolean;
}

export interface AIsStat {
  config: string;
  lookback: ALookback;
  k: number;
  kept: number;
  purgedOpen: number;
  l80NetUsdPerMonth: number;
  totalNetUsd: number;
}

export interface APickStat {
  config: string;
  l80NetUsdPerMonth: number;
  totalNetUsd: number;
  kept: number;
  purgedOpen: number;
}

export interface APick {
  config: string;
  lookback: ALookback;
  k: number;
  at: string;
  stats: APickStat[];
}

export interface APickLog extends APick {
  reason: "forward-bar-1" | "month";
}

export function anchoredIsEnd(forwardBar1 = FORWARD_BAR_1): string {
  return addDays(forwardBar1.slice(0, 10), -1);
}

function stillOpen(trade: ScoredTrade, boundarySec: number): boolean {
  return trade.windowMark === true || trade.exitTs >= boundarySec;
}

/** Score the six configs. Open trades are dropped from the mean and counted. */
export function scoreAnchoredIs(
  trades: readonly ScoredTrade[],
  opts?: { forwardBar1?: string; isStart?: string },
): { chosen: AIsStat; configs: AIsStat[] } {
  const forward = opts?.forwardBar1 ?? FORWARD_BAR_1;
  const boundaryDay = forward.slice(0, 10);
  const boundarySec = Date.parse(forward) / 1000;
  const isStart = opts?.isStart ?? ANCHORED_IS_START;
  const weeks = mondayWeeks(isStart, anchoredIsEnd(forward));
  const configs: AIsStat[] = A_REGISTRATION.map((config) => {
    const rows = trades.filter(
      (trade) =>
        trade.book === config.id &&
        trade.classId === "A" &&
        (trade.path ?? "base") === "base" &&
        trade.entryDate >= isStart &&
        trade.entryDate < boundaryDay,
    );
    const purgedOpen = rows.filter((trade) => stillOpen(trade, boundarySec)).length;
    const kept = rows.filter((trade) => !stillOpen(trade, boundarySec));
    const bound = oneSided80(
      weeklyValues(
        kept.map((trade) => ({ week: weekKey(trade.entryDate), value: trade.netUsd })),
        weeks,
      ),
      { scale: WEEKS_PER_MONTH },
    );
    return {
      config: config.id,
      lookback: config.lookback,
      k: config.k,
      kept: kept.length,
      purgedOpen,
      l80NetUsdPerMonth: bound?.l80 ?? -1_000_000_000,
      totalNetUsd: kept.reduce((sum, trade) => sum + trade.netUsd, 0),
    };
  });
  return { chosen: selectInSample(configs, (row) => row.l80NetUsdPerMonth, (row) => row.totalNetUsd), configs };
}

export function pickFromStats(chosen: AIsStat, configs: readonly AIsStat[], at: string): APick {
  return {
    config: chosen.config,
    lookback: chosen.lookback,
    k: chosen.k,
    at,
    stats: configs.map((row) => ({
      config: row.config,
      l80NetUsdPerMonth: row.l80NetUsdPerMonth,
      totalNetUsd: row.totalNetUsd,
      kept: row.kept,
      purgedOpen: row.purgedOpen,
    })),
  };
}

export function loadCappedTrades(root = repoRoot()): ScoredTrade[] {
  const doc = JSON.parse(readFileSync(join(root, "research/data/reports/p5-v31-results.json"), "utf8")) as {
    results: { trades: ScoredTrade[] };
  };
  return doc.results.trades;
}

/** The step-1 pick. Monthly re-selection stays off until it is approved. */
export function forwardPickBody(root = repoRoot()): Record<string, unknown> {
  const scored = scoreAnchoredIs(loadCappedTrades(root));
  return {
    registrationSha256: V31_REGISTRATION_SHA,
    engine: "v3.1 capped book, base path, class A",
    isStart: ANCHORED_IS_START,
    isEnd: anchoredIsEnd(),
    forwardBar1: FORWARD_BAR_1,
    purge: "count trades that exited before forward bar 1; drop and count trades still open",
    monthlyReselect: false,
    chosen: scored.chosen.config,
    lookback: scored.chosen.lookback,
    k: scored.chosen.k,
    kept: scored.chosen.kept,
    purgedOpen: scored.chosen.purgedOpen,
    l80NetUsdPerMonth: scored.chosen.l80NetUsdPerMonth,
    totalNetUsd: scored.chosen.totalNetUsd,
    l80Cents: cents(scored.chosen.l80NetUsdPerMonth),
    totalCents: cents(scored.chosen.totalNetUsd),
    configs: scored.configs,
  };
}

export function readForwardPick(root = repoRoot()): APick {
  const body = JSON.parse(readFileSync(join(root, "research/data/reports", FORWARD_PICK_FILE), "utf8")) as {
    chosen: string;
    isEnd: string;
    configs: AIsStat[];
  };
  const row = A_REGISTRATION.find((item) => item.id === body.chosen);
  if (!row) throw new Error(`forward A pick ${body.chosen} is not a registered config`);
  const scored = body.configs.map((item) => {
    const known = A_REGISTRATION.find((config) => config.id === item.config);
    if (!known) throw new Error(`forward A stat ${item.config} is not a registered config`);
    return item;
  });
  if (scored.length !== A_REGISTRATION.length) throw new Error("forward A pick is missing a registered config");
  return pickFromStats(
    scored.find((item) => item.config === row.id) ?? {
      config: row.id,
      lookback: row.lookback,
      k: row.k,
      kept: 0,
      purgedOpen: 0,
      l80NetUsdPerMonth: 0,
      totalNetUsd: 0,
    },
    scored,
    body.isEnd,
  );
}
