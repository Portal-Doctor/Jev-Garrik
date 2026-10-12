/**
 * Report-only check of stitched base B in p5-v31-results.
 * Open risk is notional times (stop bps + cost bps). The registered target is $60.
 */

import { notionalUsd, NOTIONAL_CAP_USD, RISK_USD } from "../p3/portfolio";
import { entryOpenRiskUsd } from "../p5/risk";
import { expandingFolds, oosSlice } from "../p5/stats";

export interface TapeTrade {
  classId: string;
  productId: string;
  book: string;
  path: string;
  sample: "IS" | "OOS" | null;
  purged: boolean;
  entryDate: string;
  exitDate: string;
  stopBps: number;
  costBps: number;
  notionalUsd: number;
  entryRiskUsd: number;
  netBps: number;
  netUsd: number;
}

export interface FoldPick {
  fold: string;
  config: string;
}

export interface SizingRow {
  productId: string;
  entryDate: string;
  book: string;
  stopBps: number;
  costBps: number;
  notionalUsd: number;
  riskUsd: number;
  capBinds: boolean;
  netBps: number;
  netUsd: number;
  r: number;
  notionalOk: boolean;
  riskOk: boolean;
  dollarOk: boolean;
  openRiskIs60: boolean;
}

export function stitchedTrades(trades: readonly TapeTrade[], picks: readonly FoldPick[], classId: "A" | "B", path: "base" | "stress"): TapeTrade[] {
  const folds = expandingFolds();
  const rows = picks.flatMap((pick) => {
    const fold = folds.find((item) => item.id === pick.fold);
    if (!fold) return [];
    const book = trades.filter((trade) => trade.book === pick.config && trade.path === path && trade.classId === classId);
    return oosSlice(book, fold);
  });
  return rows.filter((trade) => trade.sample === "OOS" && !trade.purged);
}

export function sizingRow(trade: TapeTrade): SizingRow {
  const expected = notionalUsd(trade.stopBps, trade.costBps, RISK_USD);
  const uncapped = (RISK_USD * 10_000) / (trade.stopBps + trade.costBps);
  const risk = entryOpenRiskUsd(trade.notionalUsd, trade.stopBps, trade.costBps);
  const dollars = (trade.netBps / 10_000) * trade.notionalUsd;
  return {
    productId: trade.productId,
    entryDate: trade.entryDate,
    book: trade.book,
    stopBps: trade.stopBps,
    costBps: trade.costBps,
    notionalUsd: trade.notionalUsd,
    riskUsd: trade.entryRiskUsd,
    capBinds: uncapped > NOTIONAL_CAP_USD,
    netBps: trade.netBps,
    netUsd: trade.netUsd,
    r: trade.entryRiskUsd > 0 ? trade.netUsd / trade.entryRiskUsd : Number.NaN,
    notionalOk: Math.abs(trade.notionalUsd - expected) < 1e-6,
    riskOk: Math.abs(risk - trade.entryRiskUsd) < 1e-6,
    dollarOk: Math.abs(dollars - trade.netUsd) < 1e-6,
    openRiskIs60: Math.abs(trade.entryRiskUsd - RISK_USD) < 1e-9,
  };
}

export function bSizingCheck(trades: readonly TapeTrade[], picks: readonly FoldPick[]): {
  bug: boolean;
  n: number;
  capBinds: number;
  mismatches: number;
  meanNetBps: number;
  notionalWeightedBps: number;
  meanR: number;
  totalNetUsd: number;
  meanRTimesRisk: number;
  rows: SizingRow[];
} {
  const rows = stitchedTrades(trades, picks, "B", "base").map(sizingRow);
  const n = rows.length;
  const totalNetUsd = rows.reduce((sum, row) => sum + row.netUsd, 0);
  const meanNetBps = n === 0 ? 0 : rows.reduce((sum, row) => sum + row.netBps, 0) / n;
  const notional = rows.reduce((sum, row) => sum + row.notionalUsd, 0);
  const notionalWeightedBps = notional === 0 ? 0 : (totalNetUsd / notional) * 10_000;
  const meanR = n === 0 ? 0 : rows.reduce((sum, row) => sum + row.r, 0) / n;
  const mismatches = rows.filter((row) => !row.notionalOk || !row.riskOk || !row.dollarOk || !row.openRiskIs60).length;
  return {
    bug: mismatches > 0,
    n,
    capBinds: rows.filter((row) => row.capBinds).length,
    mismatches,
    meanNetBps,
    notionalWeightedBps,
    meanR,
    totalNetUsd,
    meanRTimesRisk: meanR * n * RISK_USD,
    rows,
  };
}
