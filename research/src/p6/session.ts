/**
 * Paper decisions. Nothing here signs, posts, or opens a socket.
 * Jev has no authority: a guard fire logs a shadow exit and does not change the position.
 * An outage logs nothing and adds no trade.
 */

import {
  backstopTripped,
  betaAllows,
  clusterAllows,
  grossNotionalAllows,
  haltTripped,
  onePerPairAllows,
  openRiskAllows,
  reentryAllowed,
} from "../p3/design-rules";
import { MAX_POSITIONS, notionalUsd, SLOT_CAPS, type ClassId } from "../p3/portfolio";
import { entryOpenRiskUsd, sizingCostBps } from "../p5/risk";
import {
  breadthLabel,
  btcPauseFires,
  entryDecision,
  exitGuardFires,
  freshRCurve,
  momentumBlocked,
  momentumCrashOn,
  rolling20Paused,
  stepRCurve,
  twinExit,
  type Blocker,
  type BreadthLabel,
  type RCurve,
} from "../p5/guards";

export interface ClassCurve {
  netR: number[];
  curve: RCurve;
}

export function freshClassCurve(): ClassCurve {
  return { netR: [], curve: freshRCurve() };
}

/** The 20R kill stays latched after it fires. Later trades do not clear it. */
export function stepClass(state: ClassCurve, netR: number): ClassCurve {
  const values = [...state.netR, netR];
  const cum = values.reduce((sum, value) => sum + value, 0);
  return { netR: values, curve: stepRCurve(state.curve, cum) };
}

export function classBlockers(classId: ClassId, state: ClassCurve, opts: { halt: boolean; backstop: boolean; momentumBlocked: boolean; killSwitch: boolean }): Blocker[] {
  const blockers: Blocker[] = [];
  if (opts.halt) blockers.push("halt");
  if (opts.backstop) blockers.push("backstop");
  if (state.curve.killed) blockers.push("r-kill");
  if (opts.killSwitch) blockers.push("kill-switch");
  if (rolling20Paused(state.netR)) blockers.push("pause-1b");
  if (state.curve.paused && !state.curve.killed) blockers.push("pause-1c");
  if (classId === "B" && opts.momentumBlocked) blockers.push("pause-2b");
  return blockers;
}

export interface PaperDecision {
  entries: boolean;
  riskUsd: number;
  notionalUsd: number;
  openRiskUsd: number;
  breadth: BreadthLabel;
  entry: "X1";
  addedByJev: false;
}

/**
 * A and B use the registered $60 unless a pause or a kill says otherwise.
 * D is the registered $20 class. C and E use $60 until a pause shrinks them.
 * Breadth is logged and is not a blocker.
 */
export function paperDecision(opts: {
  classId: ClassId;
  blockers: readonly Blocker[];
  stopBps: number;
  sBtBps?: number;
  breadthPaused: boolean;
}): PaperDecision {
  const decision = entryDecision(opts.blockers, opts.classId === "D");
  const costBps = sizingCostBps(opts.sBtBps ?? 5);
  const notional = decision.entries ? notionalUsd(opts.stopBps, costBps, decision.riskUsd) : 0;
  const openRisk = decision.entries ? entryOpenRiskUsd(notional, opts.stopBps, costBps) : 0;
  return {
    entries: decision.entries,
    riskUsd: decision.riskUsd,
    notionalUsd: notional,
    openRiskUsd: openRisk,
    breadth: breadthLabel(opts.breadthPaused),
    entry: "X1",
    addedByJev: false,
  };
}

export function equityState(opts: { peakEquity: number; realizedUsd: number; openMtmUsd: number; dayStartEquity: number; weekStartEquity: number; pairLossUsd: number }): {
  equity: number;
  drawdown: number;
  halt: boolean;
  backstop: boolean;
} {
  const equity = opts.realizedUsd + opts.openMtmUsd;
  const drawdown = Math.max(0, opts.peakEquity - equity);
  const dailyLoss = Math.max(0, opts.dayStartEquity - equity);
  const weeklyLoss = Math.max(0, opts.weekStartEquity - equity);
  return {
    equity,
    drawdown,
    halt: haltTripped(dailyLoss, weeklyLoss, drawdown),
    backstop: backstopTripped(dailyLoss, opts.pairLossUsd, drawdown),
  };
}

export function momentumOnDate(conditionDates: readonly string[], date: string, btc60: number, btc10: number): { on: boolean; blocked: boolean } {
  const on = momentumCrashOn(btc60, btc10);
  const dates = on ? [...conditionDates, date] : conditionDates;
  return { on, blocked: momentumBlocked(dates, date) };
}

export interface GateInput {
  openPairs: readonly string[];
  pair: string;
  classId: ClassId;
  classOpen: number;
  bookOpen: number;
  openInCluster: number;
  openRiskUsd: number;
  addRiskUsd: number;
  grossUsd: number;
  addNotionalUsd: number;
  betaWeightedUsd: number;
  lastExitTsMs: number | null;
  nowTsMs: number;
}

export function entryGates(opts: GateInput): string[] {
  const failed: string[] = [];
  if (!reentryAllowed(opts.lastExitTsMs, opts.nowTsMs)) failed.push("reentry");
  if (!onePerPairAllows(opts.openPairs, opts.pair)) failed.push("onePerPair");
  if (opts.classOpen >= SLOT_CAPS[opts.classId]) failed.push("slot");
  if (opts.bookOpen >= MAX_POSITIONS) failed.push("bookSlots");
  if (!clusterAllows(opts.openInCluster)) failed.push("cluster");
  if (!openRiskAllows(opts.openRiskUsd, opts.addRiskUsd)) failed.push("openRisk");
  if (!grossNotionalAllows(opts.grossUsd, opts.addNotionalUsd)) failed.push("grossNotional");
  if (!betaAllows(opts.betaWeightedUsd)) failed.push("beta");
  return failed;
}

export interface ShadowGuardResult {
  position: "unchanged";
  shadowExit: boolean;
  pauseLogged: boolean;
  authority: false;
  addedTrade: false;
  twin: { resimulateBook: false; exitTs: number; reentryScope: "pair" } | null;
}

/** Shadow only. Outage, timeout, and a quiet read leave the position on its class rules. */
export function shadowGuard(opts: {
  outage: boolean;
  exit: { toxicHigh: boolean; stressedHigh: boolean; consecutive: number; unrealizedR: number; warmed: boolean; exitTs: number };
  btc: { toxicHigh: boolean; stressedHigh: boolean; consecutive: number; warmed: boolean };
}): ShadowGuardResult {
  if (opts.outage) return { position: "unchanged", shadowExit: false, pauseLogged: false, authority: false, addedTrade: false, twin: null };
  const exit = exitGuardFires(opts.exit);
  const pause = btcPauseFires(opts.btc);
  return {
    position: "unchanged",
    shadowExit: exit,
    pauseLogged: pause,
    authority: false,
    addedTrade: false,
    twin: exit ? twinExit(opts.exit.exitTs) : null,
  };
}
