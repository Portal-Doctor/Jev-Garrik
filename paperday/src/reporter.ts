/**
 * Daily summary, quarter tracker versus $1,200, Jev scorecard, reject histogram.
 * Promotion math uses the thresholds written in config before any sample exists.
 */

import { JEV_PROMOTION } from "./config";
import { quarterKey, utcDayKey } from "./clock";

export interface OutcomeRow {
  closedTs: number;
  pair: string;
  netUsd: number;
  reason: string;
}

export interface RejectRow {
  ts: number;
  reason: string;
}

export interface DailySummary {
  utcDay: string;
  trades: number;
  netUsd: number;
  rejects: Record<string, number>;
}

export interface QuarterRow {
  quarter: string;
  netUsd: number;
  goalUsd: number;
  pass: boolean;
}

export interface ScorecardView {
  thresholds: typeof JEV_PROMOTION;
  jevOnTrades: number;
  jevOffTrades: number;
  jevOnNetUsd: number;
  jevOffNetUsd: number;
  jevOnMaxDrawdownUsd: number;
  jevOffMaxDrawdownUsd: number;
  eligible: boolean;
  reasons: string[];
}

export function rejectHistogram(rows: RejectRow[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    for (const part of r.reason.split(",").map((s) => s.trim()).filter(Boolean)) {
      out[part] = (out[part] ?? 0) + 1;
    }
  }
  return out;
}

export function dailySummary(outcomes: OutcomeRow[], rejects: RejectRow[], utcDay: string): DailySummary {
  const dayOut = outcomes.filter((o) => utcDayKey(o.closedTs) === utcDay);
  const dayRej = rejects.filter((r) => utcDayKey(r.ts) === utcDay);
  return {
    utcDay,
    trades: dayOut.length,
    netUsd: dayOut.reduce((s, o) => s + o.netUsd, 0),
    rejects: rejectHistogram(dayRej),
  };
}

export function quarterTracker(outcomes: OutcomeRow[]): QuarterRow[] {
  const nets = new Map<string, number>();
  for (const o of outcomes) {
    const q = quarterKey(o.closedTs);
    nets.set(q, (nets.get(q) ?? 0) + o.netUsd);
  }
  return [...nets.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([quarter, netUsd]) => ({ quarter, netUsd, goalUsd: 1_200, pass: netUsd >= 1_200 }));
}

export function scorecard(input: {
  jevOnTrades: number;
  jevOffTrades: number;
  jevOnNetUsd: number;
  jevOffNetUsd: number;
  jevOnMaxDrawdownUsd: number;
  jevOffMaxDrawdownUsd: number;
}): ScorecardView {
  const reasons: string[] = [];
  if (input.jevOnTrades < JEV_PROMOTION.minClosedTradesEachVariant) reasons.push("jev_on sample below 100");
  if (input.jevOffTrades < JEV_PROMOTION.minClosedTradesEachVariant) reasons.push("jev_off sample below 100");
  if (!(input.jevOnNetUsd > input.jevOffNetUsd)) reasons.push("jev_on net is not strictly greater");
  if (input.jevOnMaxDrawdownUsd > input.jevOffMaxDrawdownUsd) reasons.push("jev_on drawdown is worse");
  return {
    thresholds: JEV_PROMOTION,
    ...input,
    eligible: reasons.length === 0,
    reasons,
  };
}
