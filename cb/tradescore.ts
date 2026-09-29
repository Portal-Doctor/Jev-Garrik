import type { ClosedTrade } from "./backtest";
import { brier, wilson } from "./report";

export function closedTradeScore(trades: ClosedTrade[], wins: number) {
  const n = trades.length;
  const accuracy = n > 0 ? wins / n : null;
  const w = n > 0 ? wilson(wins, n) : null;
  const points = trades.map((t) => ({ pBuy: 1, up: t.netUsd > 0 ? 1 : 0 }));
  const edge =
    n > 0
      ? trades.reduce((s, t) => s + (t.entryNotionalUsd > 0 ? (t.netUsd / t.entryNotionalUsd) * 10_000 : 0), 0) / n
      : null;
  return {
    n,
    accuracy,
    wilson95: w ? { lower: w.lower, upper: w.upper } : null,
    brier: n > 0 ? brier(points) : null,
    edgeBps: edge,
  };
}

/** Drawdown fraction against a different pair bankroll. Dollar trough is unchanged. */
export function rescaleDrawdown(dd: number | null, fromBankroll: number, toBankroll: number): number | null {
  if (dd == null || !(fromBankroll > 0) || !(toBankroll > 0)) return dd;
  return (dd * fromBankroll) / toBankroll;
}
