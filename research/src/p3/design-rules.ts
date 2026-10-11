/**
 * Design rules that the geometry scan and the registration both need.
 * Numbers come from trading-design §1, §3 and §6, the addendum, and the P3 review.
 * The $20 paper minimum when the Kelly bound is non-positive is Brian's choice and is not applied here.
 */

import { perTradeFloor } from "../../vendor/87b35d0/fees.ts";
import { buildPacket, type PacketInput } from "../../vendor/87b35d0/jev.ts";
import { spreadCost } from "../p2/costs";
import { TIE_ORDER, type ClassId } from "./portfolio";

export const OPEN_RISK_CAP_USD = 480;
export const GROSS_NOTIONAL_CAP_USD = 6_000;
export const DAILY_HALT_USD = 240;
export const WEEKLY_HALT_USD = 480;
export const BOOK_HALT_USD = -1_600;
export const BACKSTOP_DAILY_USD = 900;
export const BACKSTOP_PAIR_USD = 500;
export const BACKSTOP_BOOK_USD = 8_000;
export const CLASS_C_MAX_HOLD_MS = 72 * 3_600_000;
export const CLASS_E_MAX_HOLD_MS = 24 * 3_600_000;
export const NO_REENTRY_MS = 24 * 3_600_000;
/** Class B holds at most four names, the highest scores first. */
export const CLASS_B_MAX_NAMES = 4;
/** Disaster stop is entry minus 3 × daily ATR. k = 4 is the name cap, not this multiple. */
export const CLASS_B_DISASTER_ATR = 3;
/** At most two open positions in one correlation cluster. */
export const CLUSTER_MAX_OPEN = 2;
/** BTC-beta-weighted notional cap, in dollars. */
export const BETA_WEIGHTED_NOTIONAL_CAP_USD = 6_000;
/** Risk fraction ceiling: min(0.75%, half Kelly). */
export const KELLY_RISK_FRACTION_CAP = 0.0075;

export interface FeeProfile {
  id: string;
  makerBps: number | null;
  takerBps: number | null;
}

/** Section 1 profiles. The Coinbase tier is Brian's placeholder and is not a number. */
export const FEE_PROFILES: readonly FeeProfile[] = [
  { id: "zero", makerBps: 0, takerBps: 0 },
  { id: "10-10", makerBps: 10, takerBps: 10 },
  { id: "25-40", makerBps: 25, takerBps: 40 },
  { id: "kraken-40-80", makerBps: 40, takerBps: 80 },
  { id: "coinbase-at-brian-tier", makerBps: null, takerBps: null },
];

/**
 * §1 cost: C = 50 + q·50 + (1−q)·(90 + s).
 * q is the share of exits that are resting maker targets. s is the taker spread in bps.
 */
export function section1CostBps(makerExitShare: number, spreadBps: number): number {
  if (!(makerExitShare >= 0) || !(makerExitShare <= 1) || !Number.isFinite(spreadBps)) {
    throw new Error("maker exit share must be in [0, 1] and spread must be finite");
  }
  return 50 + makerExitShare * 50 + (1 - makerExitShare) * (90 + spreadBps);
}

/** §1 hurdle: cost plus the larger of 25 bps and 0.15R. */
export function section1HurdleBps(costBps: number, stopBps: number): number {
  return costBps + Math.max(25, 0.15 * stopBps);
}

export function classAChaseSkip(close: number, priorHigh: number, atr: number): boolean {
  return atr > 0 && close - priorHigh > 0.5 * atr;
}

export function classAExit(close: number, prior10DayLow: number, heldDays: number, unrealizedR: number): boolean {
  if (close < prior10DayLow) return true;
  return heldDays >= 30 && unrealizedR < 1;
}

export interface ClassBRow {
  id: string;
  score: number;
  member: boolean;
}

/** Top 20% of the eligible universe, then score > 0, then at most k = 4. */
export function classBSelected(rows: readonly ClassBRow[]): ClassBRow[] {
  const universe = rows.filter((row) => row.member);
  const ranked = universe.slice().sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const keep = Math.ceil(universe.length * 0.2);
  return ranked.slice(0, keep).filter((row) => row.score > 0).slice(0, CLASS_B_MAX_NAMES);
}

/** Still held while the name remains in the top 40% of the eligible universe. */
export function classBHeld(rows: readonly ClassBRow[], id: string): boolean {
  const universe = rows.filter((row) => row.member);
  const ranked = universe.slice().sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
  const keep = Math.ceil(universe.length * 0.4);
  return ranked.slice(0, keep).some((row) => row.id === id);
}

export function classBDisasterStop(entry: number, atr: number): number {
  return entry - CLASS_B_DISASTER_ATR * atr;
}

export interface ClassCEvent {
  pair: string;
  eventTs: number;
  eventLow: number;
  eventHigh: number;
  dailyAtr: number;
  dropHigh: number;
  dropLow: number;
}

export interface ClassCBar {
  ts: number;
  high: number;
  close: number;
}

export interface ClassCEntry {
  pair: string;
  eventTs: number;
  entryTs: number;
  entry: number;
  stop: number;
  target: number;
  stopBps: number;
  targetBps: number;
}

/**
 * First 4h close above the event-low candle's high, within 48h. One candidate per event.
 * Stop is the event low minus 0.25 × daily ATR. Drop the candidate when that stop is
 * more than 1.5 × daily ATR below the entry, or when the per-trade floor fails.
 */
export function classCEntry(event: ClassCEvent, bars: readonly ClassCBar[]): ClassCEntry | null {
  const limit = event.eventTs + 48 * 3_600_000;
  const trigger = bars.find((bar) => bar.ts > event.eventTs && bar.ts <= limit && bar.close > event.eventHigh);
  if (!trigger || !(event.dailyAtr > 0) || !(trigger.close > 0)) return null;
  const stop = event.eventLow - 0.25 * event.dailyAtr;
  if (!(trigger.close > stop)) return null;
  const stopDist = trigger.close - stop;
  if (stopDist > 1.5 * event.dailyAtr) return null;
  const stopBps = (stopDist / trigger.close) * 10_000;
  const retrace = 0.5 * (event.dropHigh - event.dropLow);
  const threeR = 3 * stopDist;
  const targetDist = Math.min(retrace, threeR);
  if (!(targetDist > 0)) return null;
  const target = trigger.close + targetDist;
  const targetBps = (targetDist / trigger.close) * 10_000;
  if (!perTradeFloor(stopBps, targetBps).pass) return null;
  return { pair: event.pair, eventTs: event.eventTs, entryTs: trigger.ts, entry: trigger.close, stop, target, stopBps, targetBps };
}

export function classCHoldExpired(entryTs: number, nowTs: number): boolean {
  return nowTs - entryTs >= CLASS_C_MAX_HOLD_MS;
}

/** First three book-wide entries per UTC day. Ties follow the design order. */
export function classCDayCap<T extends { entryTs: number; pair: string; classId?: ClassId }>(rows: readonly T[]): T[] {
  const sorted = rows.slice().sort((a, b) => a.entryTs - b.entryTs || tieIndex(a.classId) - tieIndex(b.classId) || (a.pair < b.pair ? -1 : 1));
  const kept: T[] = [];
  const perDay = new Map<string, number>();
  for (const row of sorted) {
    const day = new Date(row.entryTs).toISOString().slice(0, 10);
    const used = perDay.get(day) ?? 0;
    if (used >= 3) continue;
    perDay.set(day, used + 1);
    kept.push(row);
  }
  return kept;
}

function tieIndex(classId: ClassId | undefined): number {
  if (!classId) return 0;
  const index = TIE_ORDER.indexOf(classId);
  return index < 0 ? TIE_ORDER.length : index;
}

/** Nearer of a 50% retrace of the 6h high → event low, or 2.5R. */
export function classETarget(entry: number, stop: number, sixHourHigh: number, eventLow: number): number | null {
  const risk = entry - stop;
  const retrace = 0.5 * (sixHourHigh - eventLow);
  if (!(entry > 0) || !(risk > 0) || !(retrace > 0)) return null;
  return entry + Math.min(retrace, 2.5 * risk);
}

export function classEMoveToBreakEven(stop: number, entry: number, completedClose: number): number {
  if (completedClose - entry >= entry - stop && entry > stop) return Math.max(stop, entry);
  return stop;
}

export function classEHoldExpired(entryTs: number, nowTs: number): boolean {
  return nowTs - entryTs >= CLASS_E_MAX_HOLD_MS;
}

/** At S = 250 bps the fee floor needs T >= 685. */
export function classEFloorPasses(stopBps: number, targetBps: number | null): boolean {
  return perTradeFloor(stopBps, targetBps).pass;
}

export function x1FillPrice(open: number, side: "buy" | "sell", sBtBps: number): number {
  const sign = side === "buy" ? 1 : -1;
  return open * (1 + (sign * sBtBps) / 10_000);
}

/** Long stop fill is the stop minus the larger of s_bt and 0.1 × 1h ATR, in price. */
export function stopFillPrice(stop: number, entry: number, sBtBps: number, atr1h: number): number {
  const spread = entry > 0 ? (entry * sBtBps) / 10_000 : 0;
  return stop - Math.max(spread, 0.1 * atr1h);
}

export function tradeThroughFill(limit: number, tradePrice: number, tick: number, volume: number): { filled: boolean; volume: number } | null {
  if (!(tick > 0) || !(volume > 0)) return null;
  const through = tradePrice <= limit - tick;
  if (!through) return { filled: false, volume: 0 };
  return { filled: true, volume: volume * 0.5 };
}

export function onePerPairAllows(openPairs: readonly string[], pair: string): boolean {
  return !openPairs.includes(pair);
}

export function reentryAllowed(lastExitTs: number | null, nowTs: number): boolean {
  if (lastExitTs == null) return true;
  return nowTs - lastExitTs >= NO_REENTRY_MS;
}

export function openRiskAllows(openRiskUsd: number, addUsd: number): boolean {
  return openRiskUsd + addUsd <= OPEN_RISK_CAP_USD;
}

export function grossNotionalAllows(grossUsd: number, addUsd: number): boolean {
  return grossUsd + addUsd <= GROSS_NOTIONAL_CAP_USD;
}

export function clusterAllows(openInCluster: number): boolean {
  return openInCluster < CLUSTER_MAX_OPEN;
}

export function betaAllows(betaWeightedNotionalUsd: number): boolean {
  return betaWeightedNotionalUsd <= BETA_WEIGHTED_NOTIONAL_CAP_USD;
}

export function haltTripped(dailyLossUsd: number, weeklyLossUsd: number, bookPnlUsd: number): boolean {
  return dailyLossUsd >= DAILY_HALT_USD || weeklyLossUsd >= WEEKLY_HALT_USD || bookPnlUsd <= BOOK_HALT_USD;
}

export function backstopTripped(dailyLossUsd: number, pairLossUsd: number, bookDrawdownUsd: number): boolean {
  return dailyLossUsd >= BACKSTOP_DAILY_USD || pairLossUsd >= BACKSTOP_PAIR_USD || bookDrawdownUsd >= BACKSTOP_BOOK_USD;
}

/**
 * Kelly = E/Var on the lower 80% bound of realized net R, then half of that, capped at 0.75%.
 * A non-positive bound or a non-positive variance returns null, so the hook adds no size.
 * Whether a non-positive bound trades at the $20 paper minimum is open (Brian's choice).
 */
export function kellyFraction(meanNetR: number, variance: number): number | null {
  if (!(meanNetR > 0) || !(variance > 0)) return null;
  const half = 0.5 * (meanNetR / variance);
  const capped = Math.min(KELLY_RISK_FRACTION_CAP, half);
  return capped > 0 ? capped : null;
}

export function kellyRiskUsd(riskUsd: number, fraction: number | null, bankrollUsd: number): number {
  if (fraction == null || !(bankrollUsd > 0)) return 0;
  return Math.min(riskUsd, fraction * bankrollUsd);
}

export function classKill(input: { n: number; meanGrossBps: number; upper80Bps: number; hurdleBps: number }): "kill" | "insufficient" | "keep" {
  if (input.n < 30) return "insufficient";
  if (input.meanGrossBps < 0 && input.upper80Bps < input.hurdleBps) return "kill";
  return "keep";
}

export function gap18Packet(input: PacketInput) {
  return buildPacket(input);
}

export function stressRow(csMedianBps: number): { baseBps: number; stressBps: number } {
  return spreadCost(csMedianBps);
}
