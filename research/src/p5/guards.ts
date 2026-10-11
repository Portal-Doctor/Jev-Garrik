/**
 * Forward decisions for S1–S6 and R11–R13.
 * These functions do not emit P&L rows and do not call Jev.
 * The historical book does not call them.
 */

import { PAPER_MINIMUM_USD, reentryAllowed } from "../p3/design-rules";
import { CLASS_R_KILL } from "./risk";

export interface BreadthRow {
  member: boolean;
  close: number | null;
  ema50: number | null;
}

/** Names with an undefined EMA50 are out of both the numerator and the denominator. */
export function breadthCount(rows: readonly BreadthRow[]): { above: number; defined: number } {
  let above = 0;
  let defined = 0;
  for (const row of rows) {
    if (!row.member || row.ema50 == null || row.close == null || !Number.isFinite(row.ema50) || !Number.isFinite(row.close)) continue;
    defined += 1;
    if (row.close > row.ema50) above += 1;
  }
  return { above, defined };
}

/** Pause below 25 percent. Resume above 35 percent. Hold the prior state in between. A missing share holds too. */
export function breadthPaused(share: number | null, paused: boolean): boolean {
  if (share == null || !(share >= 0)) return paused;
  if (share < 0.25) return true;
  if (share > 0.35) return false;
  return paused;
}

export type BreadthLabel = "on" | "off";

/** Off while the hysteresis pause is on. The label is a log. It does not size or block. */
export function breadthLabel(paused: boolean): BreadthLabel {
  return paused ? "off" : "on";
}

/** Entry-day labels. The pause starts off, so the first label is on until a share falls below 25 percent. */
export function breadthByEntryDate(dates: readonly string[], rowAt: (entryDate: string) => readonly BreadthRow[]): Map<string, BreadthLabel> {
  let paused = false;
  const out = new Map<string, BreadthLabel>();
  for (const date of dates) {
    const count = breadthCount(rowAt(date));
    const share = count.defined > 0 ? count.above / count.defined : null;
    paused = breadthPaused(share, paused);
    out.set(date, breadthLabel(paused));
  }
  return out;
}

/**
 * Forward review split. Diagnostic only: the label does not select a book.
 */
export function breadthNetRSplit(rows: readonly { breadth: BreadthLabel; netR: number }[]): {
  label: "diagnostic, no selection";
  selects: false;
  on: { n: number; sumNetR: number };
  off: { n: number; sumNetR: number };
} {
  const sum = (label: BreadthLabel) => {
    const kept = rows.filter((row) => row.breadth === label);
    return { n: kept.length, sumNetR: kept.reduce((total, row) => total + row.netR, 0) };
  };
  return { label: "diagnostic, no selection", selects: false, on: sum("on"), off: sum("off") };
}

export function momentumCrashOn(btc60: number, btc10: number): boolean {
  return btc60 <= -0.25 && btc10 >= 0.15;
}

/** Fourteen calendar dates beginning on the condition date. */
export function momentumBlocked(conditionDates: readonly string[], date: string): boolean {
  return conditionDates.some((start) => date >= start && date < addUtcDays(start, 14));
}

function addUtcDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** 1b. The latest 20 net-R values sum to -5R or worse. Fewer than 20 values do not pause. */
export function rolling20Paused(netR: readonly number[]): boolean {
  if (netR.length < 20) return false;
  const last = netR.slice(-20);
  return last.reduce((sum, value) => sum + value, 0) <= -5;
}

export interface RCurve {
  peak: number;
  trough: number;
  paused: boolean;
  killed: boolean;
}

/** 1c and the 20R kill, from the same peak. Resume after a 5R recovery from the trough. */
export function stepRCurve(state: RCurve, cumR: number): RCurve {
  const peak = Math.max(state.peak, cumR);
  const killed = state.killed || peak - cumR >= CLASS_R_KILL;
  let trough = state.trough;
  let paused = state.paused;
  if (!paused && peak - cumR >= 10) {
    paused = true;
    trough = cumR;
  }
  if (paused) {
    trough = Math.min(trough, cumR);
    if (cumR - trough >= 5) paused = false;
  }
  return { peak, trough, paused: paused || killed, killed };
}

export function freshRCurve(): RCurve {
  return { peak: 0, trough: 0, paused: false, killed: false };
}

/** 1d. Forward n at least 30, mean net R below 0, and net $/month L80 below 0. */
export function forwardAbKill(n: number, meanNetR: number, l80UsdPerMonth: number): "insufficient" | "kill" | "keep" {
  if (n < 30) return "insufficient";
  if (meanNetR < 0 && l80UsdPerMonth < 0) return "kill";
  return "keep";
}

const SPRT_BOUND = Math.log(4);

/** Sample standard deviation. Fewer than two observations has no realized sigma. */
export function sampleSigma(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return variance > 0 ? Math.sqrt(variance) : null;
}

/** Normal log likelihood of H1 against H0, known sigma. Positive favors H1. */
export function normalLlr(values: readonly number[], mu0: number, mu1: number, sigma: number): number | null {
  if (!(sigma > 0) || values.length === 0) return null;
  let far = 0;
  let near = 0;
  for (const value of values) {
    const from0 = value - mu0;
    const from1 = value - mu1;
    far += from0 * from0;
    near += from1 * from1;
  }
  return (far - near) / (2 * sigma * sigma);
}

function sprtCrossing(llr: number | null): "upper" | "lower" | null {
  if (llr == null) return null;
  if (llr >= SPRT_BOUND) return "upper";
  if (llr <= -SPRT_BOUND) return "lower";
  return null;
}

/**
 * 1a. Wald bounds at +/- ln 4. H0 is +0.25R and H1 is 0.
 * The realized-sigma path and the 1.5R path are both reported. Neither acts.
 */
export function sprtReport(values: readonly number[]): {
  reportOnly: true;
  pauses: false;
  lower: number;
  upper: number;
  h0: 0.25;
  h1: 0;
  fixedSigma: 1.5;
  realizedSigma: number | null;
  llrFixed: number | null;
  llrRealized: number | null;
  fixedCrossing: "upper" | "lower" | null;
  realizedCrossing: "upper" | "lower" | null;
} {
  const realizedSigma = sampleSigma(values);
  const llrFixed = normalLlr(values, 0.25, 0, 1.5);
  const llrRealized = realizedSigma == null ? null : normalLlr(values, 0.25, 0, realizedSigma);
  return {
    reportOnly: true,
    pauses: false,
    lower: -SPRT_BOUND,
    upper: SPRT_BOUND,
    h0: 0.25,
    h1: 0,
    fixedSigma: 1.5,
    realizedSigma,
    llrFixed,
    llrRealized,
    fixedCrossing: sprtCrossing(llrFixed),
    realizedCrossing: sprtCrossing(llrRealized),
  };
}

export type Blocker = "halt" | "backstop" | "r-kill" | "kill-switch" | "pause-1b" | "pause-1c" | "pause-2a" | "pause-2b";

/**
 * Halts, backstops, the 20R kill, and the 1d kill stop new entries at any size.
 * 1b and 1c shrink the class to $20 and still allow entries.
 * 2b shrinks B to $20 and blocks new entries. 2a is logged and does not change a decision.
 * Overlapping pauses stay at $20. Flag-only at $20 applies to pauses, not to kills.
 */
export function entryDecision(blockers: readonly Blocker[], alreadyMinimum: boolean): { entries: boolean; riskUsd: number } {
  const kill = blockers.some((item) => item === "halt" || item === "backstop" || item === "r-kill" || item === "kill-switch");
  if (kill) return { entries: false, riskUsd: alreadyMinimum ? PAPER_MINIMUM_USD : 60 };
  const pauses = blockers.filter((item) => item === "pause-1b" || item === "pause-1c" || item === "pause-2b");
  if (pauses.includes("pause-2b")) return { entries: false, riskUsd: PAPER_MINIMUM_USD };
  if (pauses.includes("pause-1b") || pauses.includes("pause-1c") || alreadyMinimum) return { entries: true, riskUsd: PAPER_MINIMUM_USD };
  return { entries: true, riskUsd: 60 };
}

export function exitGuardFires(opts: { toxicHigh: boolean; stressedHigh: boolean; consecutive: number; unrealizedR: number; warmed: boolean }): boolean {
  return opts.warmed && opts.toxicHigh && opts.stressedHigh && opts.consecutive >= 3 && opts.unrealizedR <= 1;
}

export function btcPauseFires(opts: { toxicHigh: boolean; stressedHigh: boolean; consecutive: number; warmed: boolean }): boolean {
  return opts.warmed && opts.toxicHigh && opts.stressedHigh && opts.consecutive >= 2;
}

export const BTC_PAUSE_SEC = 4 * 3_600;

export function guardExitBlocksReentry(lastGuardExitTsMs: number | null, nowTsMs: number): boolean {
  return !reentryAllowed(lastGuardExitTsMs, nowTsMs);
}

export function percentileLabel(day: number): "log-only" | "pooled baseline" | "per-pair" {
  if (day <= 6) return "log-only";
  if (day < 30) return "pooled baseline";
  return "per-pair";
}

export function degenerateRates(opts: { positionDays: number; exitGuardPositionDays: number; hours: number; btcPauseHours: number }): "not testable" | "open" {
  if (opts.positionDays > 0 && opts.exitGuardPositionDays / opts.positionDays > 0.1) return "not testable";
  if (opts.hours > 0 && opts.btcPauseHours / opts.hours > 0.15) return "not testable";
  return "open";
}

/** Numeric tests only. Authority stays off until a new registration and Brian. */
export function guardAuthorityEligible(opts: { triggers: number; twinEdgeUsd: number; takerCostUsd: number; beatsPlacebo: boolean; top3ShareLoss: number }): { eligible: boolean; authority: false } {
  const eligible = opts.triggers >= 30 && opts.twinEdgeUsd > opts.takerCostUsd && opts.beatsPlacebo && opts.top3ShareLoss <= 0.25;
  return { eligible, authority: false };
}

/** Members plus BTC-USD, one Fallback B call per completed 15m bar. Nothing is called. */
export function jevReadPlan(memberCount: number): { names: number; callsPerMonth: number; executed: 0; label: "not called" } {
  const names = memberCount + 1;
  return { names, callsPerMonth: names * 96 * 30, executed: 0, label: "not called" };
}

export function twinExit(exitTs: number): { resimulateBook: false; exitTs: number; reentryScope: "pair" } {
  return { resimulateBook: false, exitTs, reentryScope: "pair" };
}

export function regimeRecord(regime: "expansion" | "balance" | "contraction"): { logged: string; riskOff: false } {
  return { logged: regime, riskOff: false };
}
