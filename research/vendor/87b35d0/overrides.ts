/**
 * Hard override layer. Runs after Jev. Every rule is evaluated.
 * A single failure refuses the idea. Nothing upstream is consulted again.
 */

import {
  BOOK_DRAWDOWN_HALT_USD,
  CAUTION_MAX_CONCURRENT,
  DAILY_LOSS_HALT_USD,
  DEPLOYABLE_USD,
  MAKER_FEE_BPS,
  MAX_CONCURRENT,
  MAX_IDEAS_WEEKDAY,
  MAX_IDEAS_WEEKEND,
  OVERNIGHT_RISK_CAP_USD,
  PAIR_LOSS_HALT_USD,
  STARTING_BUDGET_USD,
  TAKER_FEE_BPS,
} from "./config";
import { clockStatus } from "./clock";
import { perTradeFloor } from "./fees";
import type { Sentiment, SetupId } from "./rules";

export const OVERRIDE_RULES = [
  "fee_gate",
  "daily_two_losses",
  "daily_minus_2r",
  "daily_loss_halt",
  "kill_switch",
  "long_only",
  "flat_before_utc_midnight",
  "one_per_pair",
  "max_concurrent",
  "ideas_per_day",
  "total_cap",
  "no_stop_widening",
  "no_averaging_down",
  "no_chasing",
  "disabled_pair",
  "x_veto_only",
  "paper_only",
  "pair_loss_gate",
  "book_drawdown",
  "outside_session",
  "macro_blackout",
  "data_gap",
  "sentiment_caution",
  "overnight_risk",
] as const;

export type OverrideRule = (typeof OVERRIDE_RULES)[number];

export interface OverrideCandidate {
  pair: string;
  setup: SetupId;
  side: "long" | "short";
  barTs: number;
  entry: number;
  stop: number;
  signalClose: number;
  atr: number;
  rsi: number | null;
  originatedFromSentiment: boolean;
  /** Explicit add to an open long. Always refused. */
  addOn?: boolean;
  /** Planned target distance in bps. The 4h breakout passes the book take-profit. */
  plannedTargetBps?: number | null;
  /** Swing replaces the UTC flat rule with the overnight cap. Breakout is not a day-trade card. */
  entryProfile?: "intraday" | "swing" | "breakout";
  /** Loss-to-stop of this idea if it would be held through the next UTC midnight. */
  lossToStopUsd?: number;
}

export interface OverrideBook {
  openPairs: string[];
  openCount: number;
  restingCount: number;
  ideasTodayCt: number;
  lossesTodayUtc: number;
  rTodayUtc: number;
  realizedUsdTodayUtc: number;
  /** Cumulative positive loss dollars per pair. Wins do not reduce this. */
  pairLossUsd: Record<string, number>;
  equityUsd: number;
  openNotionalUsd: number;
  /** Cash still free above the $2,000 reserve and open notionals. */
  allocatableUsd: number;
  /** Existing long stop, if any. A lower proposed stop is a widen. */
  pairStop: Record<string, number>;
  /** Existing entry price, if any. */
  pairEntry: Record<string, number>;
  sentiment: Sentiment;
  gapPairs: string[];
  enabledPairs: string[];
  kill: boolean;
  paper: boolean;
  macroCalendarPresent: boolean;
  /** Sum of open loss-to-stop on positions that are still open at the next UTC midnight. */
  overnightOpenRiskUsd?: number;
  /**
   * Chicago activity window. Intraday keeps it. Swing and breakout search rows set this
   * false: those windows were an intraday rule and are not part of the swing or breakout book.
   * Omitted means the window still applies.
   */
  enforceActivityWindow?: boolean;
}

export interface OverrideCheck {
  rule: OverrideRule;
  pass: boolean;
  detail: string;
}

export interface OverrideResult {
  pass: boolean;
  checks: OverrideCheck[];
  failed: OverrideRule[];
}

export interface Payoff {
  stopBps: number;
  targetBps: number;
  winnerBps: number;
  loserBps: number;
  pass: boolean;
}

/**
 * Per-trade floor at 50/90. Default target is 3R for the intraday research arm.
 * Winner pays maker+maker. Loser pays maker+taker. Pass when winner >= 1.5 × loser.
 */
export function payoffAt5090(
  entry: number,
  stop: number,
  makerBps = MAKER_FEE_BPS,
  takerBps = TAKER_FEE_BPS,
  targetMultiple = 3,
): Payoff {
  if (!(entry > 0) || !(stop > 0) || !(entry > stop)) {
    return { stopBps: 0, targetBps: 0, winnerBps: 0, loserBps: 0, pass: false };
  }
  const stopBps = ((entry - stop) / entry) * 10_000;
  const targetBps = stopBps * targetMultiple;
  const winnerBps = targetBps - 2 * makerBps;
  const loserBps = stopBps + makerBps + takerBps;
  const floor = perTradeFloor(stopBps, targetBps);
  const pass =
    makerBps === MAKER_FEE_BPS && takerBps === TAKER_FEE_BPS
      ? floor.pass
      : loserBps > 0 && winnerBps >= 1.5 * loserBps;
  return { stopBps, targetBps, winnerBps, loserBps, pass };
}

export function evaluateOverrides(
  candidate: OverrideCandidate,
  book: OverrideBook,
  notionalUsd: number,
  nowMs: number,
): OverrideResult {
  const clock = clockStatus(nowMs, book.macroCalendarPresent);
  const profile = candidate.entryProfile ?? "intraday";
  const stopBps =
    candidate.entry > candidate.stop && candidate.entry > 0
      ? ((candidate.entry - candidate.stop) / candidate.entry) * 10_000
      : 0;
  const explicitTarget = candidate.plannedTargetBps;
  const targetBps = explicitTarget == null ? stopBps * 3 : explicitTarget;
  const missingBreakoutTarget = profile === "breakout" && explicitTarget == null;
  const payoff = missingBreakoutTarget
    ? { stopBps, targetBps: 0, winnerBps: 0, loserBps: stopBps + 140, pass: false }
    : explicitTarget == null
      ? payoffAt5090(candidate.entry, candidate.stop)
      : {
          stopBps,
          targetBps,
          winnerBps: targetBps - 100,
          loserBps: stopBps + 140,
          pass: perTradeFloor(stopBps, targetBps).pass,
        };
  const openOnPair = book.openPairs.includes(candidate.pair);
  const concurrentCap = book.sentiment === "unknown" ? CAUTION_MAX_CONCURRENT : MAX_CONCURRENT;
  const ideaCap = clock.weekend ? MAX_IDEAS_WEEKEND : MAX_IDEAS_WEEKDAY;
  const chaseByAtr = candidate.atr > 0 && candidate.entry - candidate.signalClose > candidate.atr;
  const chaseByRsi = candidate.rsi != null && candidate.rsi > 70;
  const existingStop = book.pairStop[candidate.pair];
  const existingEntry = book.pairEntry[candidate.pair];
  const widening = existingStop != null && candidate.stop < existingStop;
  const averaging =
    candidate.addOn === true ||
    (openOnPair && existingEntry != null && candidate.entry <= existingEntry);
  const capRoom = DEPLOYABLE_USD - book.openNotionalUsd;
  const drawdown = STARTING_BUDGET_USD - book.equityUsd;

  const checks: OverrideCheck[] = [
    {
      rule: "fee_gate",
      pass: payoff.pass,
      detail: missingBreakoutTarget
        ? "no resting maker target"
        : `winner ${payoff.winnerBps.toFixed(2)} bps vs 1.5x loser ${(1.5 * payoff.loserBps).toFixed(2)} bps`,
    },
    {
      rule: "daily_two_losses",
      pass: book.lossesTodayUtc < 2,
      detail: `losses today ${book.lossesTodayUtc}`,
    },
    {
      rule: "daily_minus_2r",
      pass: book.rTodayUtc > -2,
      detail: `R today ${book.rTodayUtc}`,
    },
    {
      rule: "daily_loss_halt",
      pass: book.realizedUsdTodayUtc > -DAILY_LOSS_HALT_USD,
      detail: `realized today ${book.realizedUsdTodayUtc}`,
    },
    {
      rule: "kill_switch",
      pass: book.kill !== true,
      detail: book.kill ? "kill on" : "kill off",
    },
    {
      rule: "long_only",
      pass: candidate.side === "long",
      detail: candidate.side,
    },
    {
      rule: "flat_before_utc_midnight",
      pass: profile !== "intraday" || !clock.mustFlatBeforeEntry,
      detail:
        profile === "intraday"
          ? `ms until UTC midnight ${clock.msUntilUtcMidnight}`
          : `${profile} uses max hold instead of the UTC flat`,
    },
    {
      rule: "one_per_pair",
      pass: !openOnPair,
      detail: openOnPair ? "pair already open" : "pair flat",
    },
    {
      rule: "max_concurrent",
      pass: book.openCount + book.restingCount < concurrentCap,
      detail: `open ${book.openCount} resting ${book.restingCount} cap ${concurrentCap}`,
    },
    {
      rule: "ideas_per_day",
      pass: book.ideasTodayCt < ideaCap,
      detail: `ideas ${book.ideasTodayCt} cap ${ideaCap} weekend ${clock.weekend}`,
    },
    {
      rule: "total_cap",
      pass: notionalUsd > 0 && notionalUsd <= capRoom + 1e-9 && notionalUsd <= book.allocatableUsd + 1e-9 && notionalUsd <= DEPLOYABLE_USD,
      detail: `notional ${notionalUsd} cap room ${capRoom} allocatable ${book.allocatableUsd}`,
    },
    {
      rule: "no_stop_widening",
      pass: !widening,
      detail: existingStop == null ? "no open stop" : `proposed ${candidate.stop} existing ${existingStop}`,
    },
    {
      rule: "no_averaging_down",
      pass: !averaging,
      detail: averaging ? "add or lower entry on an open pair" : "not an average-down",
    },
    {
      rule: "no_chasing",
      pass: !chaseByAtr && !chaseByRsi,
      detail: `extension ${candidate.entry - candidate.signalClose} atr ${candidate.atr} rsi ${candidate.rsi}`,
    },
    {
      rule: "disabled_pair",
      pass: book.enabledPairs.includes(candidate.pair),
      detail: candidate.pair,
    },
    {
      rule: "x_veto_only",
      pass: book.sentiment !== "veto" && candidate.originatedFromSentiment !== true,
      detail: `sentiment ${book.sentiment} fromSentiment ${candidate.originatedFromSentiment === true}`,
    },
    {
      rule: "paper_only",
      pass: book.paper === true,
      detail: book.paper ? "paper" : "not paper",
    },
    {
      rule: "pair_loss_gate",
      pass: (book.pairLossUsd[candidate.pair] ?? 0) < PAIR_LOSS_HALT_USD,
      detail: `pair loss ${book.pairLossUsd[candidate.pair] ?? 0}`,
    },
    {
      rule: "book_drawdown",
      pass: drawdown < BOOK_DRAWDOWN_HALT_USD,
      detail: `drawdown from start ${drawdown}`,
    },
    {
      rule: "outside_session",
      pass: profile === "breakout" || book.enforceActivityWindow === false || clock.inEntryWindow,
      detail: `ct ${clock.ctHour}:${String(clock.ctMinute).padStart(2, "0")} window ${clock.inEntryWindow} profile ${profile}`,
    },
    {
      rule: "macro_blackout",
      pass: !clock.inMacroBlackout,
      detail: clock.macroCalendarMissing ? "calendar missing; default slots" : "calendar loaded",
    },
    {
      rule: "data_gap",
      pass: !book.gapPairs.includes(candidate.pair),
      detail: book.gapPairs.includes(candidate.pair) ? "gap" : "contiguous",
    },
    {
      rule: "sentiment_caution",
      pass:
        book.sentiment !== "unknown" ||
        (candidate.setup === "A" && book.openCount + book.restingCount < CAUTION_MAX_CONCURRENT),
      detail: `sentiment ${book.sentiment} setup ${candidate.setup}`,
    },
    {
      rule: "overnight_risk",
      pass:
        (profile !== "swing" && profile !== "breakout") ||
        (book.overnightOpenRiskUsd ?? 0) + (candidate.lossToStopUsd ?? 0) <= OVERNIGHT_RISK_CAP_USD,
      detail: `open ${book.overnightOpenRiskUsd ?? 0} plus idea ${candidate.lossToStopUsd ?? 0} cap ${OVERNIGHT_RISK_CAP_USD}`,
    },
  ];

  const failed = checks.filter((c) => !c.pass).map((c) => c.rule);
  return { pass: failed.length === 0, checks, failed };
}
