/**
 * Required gate blocks a pass. Target gate is the $1,200/quarter pace and is reported only.
 * A row under the trade-count floor is "insufficient sample" and never a pass.
 */

import { BOOK_DRAWDOWN_HALT_USD } from "./config";

export type WindowId = "1m" | "3m" | "6m";

export const MIN_TRADES: Record<WindowId, number> = {
  "1m": 12,
  "3m": 40,
  "6m": 100,
};

export const TARGET_PACE_USD: Record<WindowId, number> = {
  "1m": 400,
  "3m": 1_200,
  "6m": 2_400,
};

export const QUARTER_TARGET_USD = 1_200;

export interface GateResult {
  pass: boolean;
  reasons: string[];
}

export type SampleStatus = "eligible" | "insufficient_sample" | "research_excluded";

export function sampleStatus(window: WindowId, trades: number, research: boolean): SampleStatus {
  if (research) return "research_excluded";
  return trades >= MIN_TRADES[window] ? "eligible" : "insufficient_sample";
}

export interface QuarterNeed {
  quarter: string;
  full: boolean;
  daysInQuarter: number;
  daysOverlap: number;
  needUsd: number;
}

function quarterStartMs(year: number, quarter: number): number {
  const month = (quarter - 1) * 3;
  return Date.UTC(year, month, 1, 0, 0, 0, 0);
}

/** Full and partial quarters overlapped by [fromMs, toMs). Partial need is prorated by days. */
export function quarterNeeds(fromMs: number, toMs: number): QuarterNeed[] {
  if (!(toMs > fromMs)) return [];
  const start = new Date(fromMs);
  const end = new Date(toMs - 1);
  const out: QuarterNeed[] = [];
  let year = start.getUTCFullYear();
  let quarter = Math.floor(start.getUTCMonth() / 3) + 1;
  const lastYear = end.getUTCFullYear();
  const lastQuarter = Math.floor(end.getUTCMonth() / 3) + 1;
  for (;;) {
    const qStart = quarterStartMs(year, quarter);
    const qEnd = quarter === 4 ? Date.UTC(year + 1, 0, 1) : quarterStartMs(year, quarter + 1);
    const overlapStart = Math.max(fromMs, qStart);
    const overlapEnd = Math.min(toMs, qEnd);
    const daysInQuarter = (qEnd - qStart) / 86_400_000;
    const daysOverlap = (overlapEnd - overlapStart) / 86_400_000;
    const full = overlapStart === qStart && overlapEnd === qEnd;
    const needUsd = full ? QUARTER_TARGET_USD : QUARTER_TARGET_USD * (daysOverlap / daysInQuarter);
    out.push({
      quarter: `${year}Q${quarter}`,
      full,
      daysInQuarter,
      daysOverlap,
      needUsd,
    });
    if (year === lastYear && quarter === lastQuarter) break;
    quarter += 1;
    if (quarter === 5) {
      quarter = 1;
      year += 1;
    }
  }
  return out;
}

export function requiredGate(opts: {
  window: WindowId;
  netUsd: number;
  maxDrawdownUsd: number;
  trades: number;
  expectancyPass: boolean;
  pairHaltBreached: boolean;
  dailyHaltBreached: boolean;
  research: boolean;
}): GateResult & { sample: SampleStatus } {
  const sample = sampleStatus(opts.window, opts.trades, opts.research);
  const reasons: string[] = [];
  if (opts.research) reasons.push("research arm excluded from the required gate");
  if (sample === "insufficient_sample") {
    reasons.push(`insufficient sample: ${opts.trades} closed < ${MIN_TRADES[opts.window]}`);
  }
  if (!(opts.netUsd > 0)) reasons.push(`net ${opts.netUsd.toFixed(2)} <= 0`);
  if (!opts.expectancyPass) reasons.push("expectancy criteria not met");
  if (!(opts.maxDrawdownUsd < BOOK_DRAWDOWN_HALT_USD)) {
    reasons.push(`max drawdown ${opts.maxDrawdownUsd.toFixed(2)} >= ${BOOK_DRAWDOWN_HALT_USD}`);
  }
  if (opts.pairHaltBreached) reasons.push("pair-loss halt breached");
  if (opts.dailyHaltBreached) reasons.push("daily-loss halt breached");
  const pass = reasons.length === 0 && sample === "eligible";
  return { pass, reasons, sample };
}

export function targetGate(opts: {
  paceUsd: number;
  fromMs: number;
  toMs: number;
  netUsd: number;
  quarters: Array<{ quarter: string; netUsd: number }>;
}): GateResult {
  const reasons: string[] = [];
  if (!(opts.netUsd >= opts.paceUsd)) reasons.push(`net ${opts.netUsd.toFixed(2)} < pace ${opts.paceUsd}`);
  const byQ = new Map(opts.quarters.map((q) => [q.quarter, q.netUsd]));
  for (const need of quarterNeeds(opts.fromMs, opts.toMs)) {
    const net = byQ.get(need.quarter) ?? 0;
    if (!(net >= need.needUsd - 1e-9)) {
      const kind = need.full ? "full" : "partial";
      reasons.push(
        `${need.quarter} ${kind} net ${net.toFixed(2)} < ${need.needUsd.toFixed(2)} (${need.daysOverlap.toFixed(2)}/${need.daysInQuarter.toFixed(0)} days)`,
      );
    }
  }
  return { pass: reasons.length === 0, reasons };
}
