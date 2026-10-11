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

/** 1a. Boundaries are not specified. The function reports the count and never pauses. */
export function sprtReport(n: number): { reportOnly: true; pauses: false; n: number } {
  return { reportOnly: true, pauses: false, n };
}

export type Blocker = "halt" | "backstop" | "r-kill" | "kill-switch" | "pause-1b" | "pause-1c" | "pause-2a" | "pause-2b";

/**
 * Halts, backstops, the 20R kill, and kill switches block new entries.
 * 1b and 1c shrink the class to $20 and still allow entries.
 * 2a, and 2b for the class it covers, shrink to $20 and block new entries.
 * Overlapping pauses stay at $20. A class already at $20 is unchanged by 1b, 1c, or 1d.
 */
export function entryDecision(blockers: readonly Blocker[], alreadyMinimum: boolean): { entries: boolean; riskUsd: number } {
  const haltLike = blockers.some((item) => item === "halt" || item === "backstop" || item === "r-kill");
  const killOnly = blockers.includes("kill-switch") && !alreadyMinimum;
  const shrunk = alreadyMinimum || blockers.some((item) => item.startsWith("pause"));
  if (haltLike || killOnly) return { entries: false, riskUsd: shrunk ? PAPER_MINIMUM_USD : 60 };
  if (blockers.includes("pause-2a") || blockers.includes("pause-2b")) return { entries: false, riskUsd: PAPER_MINIMUM_USD };
  if (blockers.includes("pause-1b") || blockers.includes("pause-1c") || alreadyMinimum) return { entries: true, riskUsd: PAPER_MINIMUM_USD };
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
