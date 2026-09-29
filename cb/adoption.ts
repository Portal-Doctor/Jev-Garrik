/**
 * Breakout adoption scoring (breakout-trail plan section 8, re-scored by the profitability
 * work order item 3 after the NEAR clip change).
 *
 * The five rules were decided before the run and are not tunable here. In particular the
 * drawdown limit is a constant, not an argument, so no caller can widen it to force a pass.
 */

export interface AdoptionPair {
  pair: string;
  bankrollUsd: number;
  fixedTrades: number;
  fixedWinRate: number | null;
  fixedNetUsd: number;
  fixedMaxDrawdown: number | null;
  breakoutTrades: number;
  breakoutWinRate: number | null;
  breakoutNetUsd: number;
  breakoutMaxDrawdown: number | null;
  missedEntries: number;
  vetoedEntries: number;
  /** Filled breakout entries plus entries the post-only price never traded through. */
  signals: number;
}

export interface AdoptionRule {
  n: 1 | 2 | 3 | 4 | 5;
  text: string;
  passes: boolean;
  detail: string;
}

export interface AdoptionScore {
  pairs: AdoptionPair[];
  combinedBreakoutNetUsd: number;
  combinedFixedNetUsd: number;
  totalBreakoutTrades: number;
  totalMissed: number;
  totalSignals: number;
  rules: AdoptionRule[];
  passes: boolean;
}

/** Peak to trough drawdown a pair's breakout book may not exceed. Locked. Do not move. */
export const MAX_DRAWDOWN = 0.15;
/** Missed entries may not reach this share of breakout signals. */
export const MAX_MISS_RATE = 0.5;
/** Closed breakout trades needed across the six pairs before the sample counts. */
export const MIN_BREAKOUT_TRADES = 30;

const usd = (n: number) => `$${n.toFixed(2)}`;
const pct = (n: number) => `${(n * 100).toFixed(2)}%`;

export function scoreAdoption(pairs: AdoptionPair[]): AdoptionScore {
  const combinedBreakoutNetUsd = pairs.reduce((s, p) => s + p.breakoutNetUsd, 0);
  const combinedFixedNetUsd = pairs.reduce((s, p) => s + p.fixedNetUsd, 0);
  const totalBreakoutTrades = pairs.reduce((s, p) => s + p.breakoutTrades, 0);
  const totalMissed = pairs.reduce((s, p) => s + p.missedEntries, 0);
  const totalSignals = pairs.reduce((s, p) => s + p.signals, 0);

  const beats = pairs.filter((p) => p.breakoutNetUsd > p.fixedNetUsd);
  const overDrawdown = pairs.filter((p) => (p.breakoutMaxDrawdown ?? 0) >= MAX_DRAWDOWN);
  const overMiss = pairs.filter((p) => p.signals > 0 && p.missedEntries / p.signals >= MAX_MISS_RATE);

  const rules: AdoptionRule[] = [
    {
      n: 1,
      text: "Breakout net after fees above zero across the six pairs combined",
      passes: combinedBreakoutNetUsd > 0,
      detail: `Combined breakout net is ${usd(combinedBreakoutNetUsd)}.`,
    },
    {
      n: 2,
      text: "Breakout net beats the fixed-target net on at least 4 of the 6 pairs",
      passes: beats.length >= 4,
      detail: `Breakout beats the fixed target on ${beats.length} of ${pairs.length} pairs${beats.length < pairs.length ? ` (not ${pairs.filter((p) => !beats.includes(p)).map((p) => p.pair).join(", ")})` : ""}.`,
    },
    {
      n: 3,
      text: "Breakout max drawdown stays under 15% of each pair's bankroll",
      passes: overDrawdown.length === 0,
      detail:
        overDrawdown.length === 0
          ? `Worst pair drawdown is ${pct(Math.max(0, ...pairs.map((p) => p.breakoutMaxDrawdown ?? 0)))}.`
          : `${overDrawdown.map((p) => `${p.pair} ${pct(p.breakoutMaxDrawdown ?? 0)}`).join(", ")} at or above the 15% limit.`,
    },
    {
      n: 4,
      text: "Missed entries under half of breakout signals",
      passes: overMiss.length === 0 && (totalSignals === 0 || totalMissed / totalSignals < MAX_MISS_RATE),
      detail: `Missed ${totalMissed} of ${totalSignals} signals (${totalSignals > 0 ? pct(totalMissed / totalSignals) : "no signals"})${overMiss.length ? `, and ${overMiss.map((p) => p.pair).join(", ")} at or above half` : ", and no pair at or above half"}.`,
    },
    {
      n: 5,
      text: "At least 30 breakout trades across the six pairs",
      passes: totalBreakoutTrades >= MIN_BREAKOUT_TRADES,
      detail: `${totalBreakoutTrades} closed breakout trades.`,
    },
  ];

  return {
    pairs,
    combinedBreakoutNetUsd,
    combinedFixedNetUsd,
    totalBreakoutTrades,
    totalMissed,
    totalSignals,
    rules,
    passes: rules.every((r) => r.passes),
  };
}
