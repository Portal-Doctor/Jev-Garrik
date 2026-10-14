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
  PAPER_MINIMUM_USD,
  reentryAllowed,
  section1CostBps,
} from "../p3/design-rules";
import { MAX_POSITIONS, notionalUsd, SLOT_CAPS, type ClassId } from "../p3/portfolio";
import { CLASS_DOLLAR_BACKSTOP_USD, entryOpenRiskUsd, sizingCostBps } from "../p5/risk";
import {
  breadthLabel,
  btcPauseFires,
  exitGuardFires,
  momentumBlocked,
  momentumCrashOn,
  twinExit,
  type Blocker,
  type BreadthLabel,
  type RCurve,
} from "../p5/guards";
import { acceptBrianOk, freshBleed, stepBleed, type BleedState } from "./bleed";
import { freshClassPause, stepClassPause, type ClassPause } from "./rearm";

export interface ClassCurve {
  netR: number[];
  netUsd: number[];
  pause: ClassPause;
  bleed: BleedState;
  cumUsd: number;
  peakUsd: number;
  curve: RCurve;
}

function pauseView(pause: ClassPause): RCurve {
  return { peak: pause.peak, trough: pause.trough, paused: pause.paused, killed: pause.killed };
}

export function freshClassCurve(): ClassCurve {
  const pause = freshClassPause();
  return { netR: [], netUsd: [], pause, bleed: freshBleed(), cumUsd: 0, peakUsd: 0, curve: pauseView(pause) };
}

/**
 * Closed-trade step. The 10R pause is the confirmed re-arm rule. The 20R kill
 * latches. The $1,200 backstop is the closed-trade dollar drawdown from the
 * class peak. `minSize` counts toward the rolling-20 resume.
 */
export function stepClass(state: ClassCurve, netR: number, netUsd = 0, minSize = true): ClassCurve {
  const values = [...state.netR, netR];
  const dollars = [...state.netUsd, netUsd];
  const cum = values.reduce((sum, value) => sum + value, 0);
  const cumUsd = state.cumUsd + netUsd;
  const peakUsd = Math.max(state.peakUsd, cumUsd);
  const pause = stepClassPause(state.pause, cum);
  return {
    netR: values,
    netUsd: dollars,
    pause,
    bleed: stepBleed(state.bleed, state.netR, netR, minSize),
    cumUsd,
    peakUsd,
    curve: pauseView(pause),
  };
}

export function markBrianOk(state: ClassCurve): ClassCurve {
  return { ...state, bleed: acceptBrianOk(state.bleed) };
}

export function classDollarBackstop(state: ClassCurve): boolean {
  return state.peakUsd - state.cumUsd >= CLASS_DOLLAR_BACKSTOP_USD;
}

export function classBlockers(classId: ClassId, state: ClassCurve, opts: { halt: boolean; backstop: boolean; momentumBlocked: boolean; killSwitch: boolean }): Blocker[] {
  const blockers: Blocker[] = [];
  if (opts.halt) blockers.push("halt");
  if (opts.backstop || classDollarBackstop(state)) blockers.push("backstop");
  if (state.curve.killed) blockers.push("r-kill");
  if (opts.killSwitch) blockers.push("kill-switch");
  if (state.bleed.paused) blockers.push("pause-1b");
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
  entry: "X1" | "maker";
  costBps: number;
  addedByJev: false;
}

/**
 * Forward risk is the scheduled amount: $20 until a class is promoted, then
 * the forward Kelly size. A 1b or 1c pause shrinks a larger schedule to $20
 * and does not raise a schedule that is already under $20. Kills stop entries.
 * Class D is sized with TDF section 1 at q = 0: 50 + 90 + s_live. The entry
 * leg is still the maker fee. The taker exit is in the risk.
 * Breadth is logged and is not a blocker.
 */
export function paperDecision(opts: {
  classId: ClassId;
  blockers: readonly Blocker[];
  stopBps: number;
  sBtBps?: number;
  breadthPaused: boolean;
  scheduledRiskUsd: number;
}): PaperDecision {
  const kill = opts.blockers.some((item) => item === "halt" || item === "backstop" || item === "r-kill" || item === "kill-switch");
  const shrink = opts.blockers.some((item) => item === "pause-1b" || item === "pause-1c");
  const blockB = opts.blockers.includes("pause-2b");
  const entries = !kill && !blockB;
  const riskUsd = shrink || blockB ? Math.min(opts.scheduledRiskUsd, PAPER_MINIMUM_USD) : opts.scheduledRiskUsd;
  const maker = opts.classId === "D";
  const costBps = maker ? section1CostBps(0, opts.sBtBps ?? 0) : sizingCostBps(opts.sBtBps ?? 5);
  const notional = entries ? notionalUsd(opts.stopBps, costBps, riskUsd) : 0;
  const openRisk = entries ? entryOpenRiskUsd(notional, opts.stopBps, costBps) : 0;
  return {
    entries,
    riskUsd,
    notionalUsd: notional,
    openRiskUsd: openRisk,
    breadth: breadthLabel(opts.breadthPaused),
    entry: maker ? "maker" : "X1",
    costBps,
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
