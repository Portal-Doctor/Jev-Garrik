/**
 * X1 taker fill for live paper. Parity replay does not call this.
 * Positive bps are a cost. Nothing here takes an absolute value.
 * Frozen X1 2dd80f673396210f2c175e77d4abc102627bf485bcd63b60d989df16c8c966fc,
 * Erratum 1 d01c3e0bec84e7fc3f651a57656ea7b25139c2b693fb4648dec90089a2b0f732,
 * Erratum 2 e0e82d3617d7d9531ec98635c09c1cbe56505d849b5fafd0dc68426f29469d76.
 */

import { corwinSchultzBps } from "../p2/liquidity";
import { STALE_QUOTE_MS } from "./legs";
import { PairBook } from "./mid-feed";

export const FRESH_L2_MS = 2_000;
export const MODEL_STRESS_BPS = 10;
export const MODELLED_SHARE_YELLOW = 0.1;
export const MODELLED_SHARE_RED = 0.25;
export const S_BT_FLOOR_BPS = 5;
export const S_BT_CAP_BPS = 15;
export const PRE_FIX_FILL_SRC = "pre-fix fill model" as const;
export const STALE_QUOTE_FILL_SRC = "stale_quote_modelled" as const;
/** First quote at or after the open was older than 2s and no older than 15s. Modelled at the registered price. */
export const ENTRY_STALE_FILL_SRC = "entry_stale_quote" as const;
/** The shadow price is the modelled entry. It is not the book fill. */
export const SHADOW_FILL_KIND = "modelled" as const;
export const PRE_FIX_PRODUCTS = ["AERO-USD", "ENA-USD", "NEAR-USD", "SUI-USD"] as const;
/** Brian approved the shadow count at 7:07 AM CT on Oct 20 2026 (CDT, UTC−5). Frozen X1 2dd80f673396210f2c175e77d4abc102627bf485bcd63b60d989df16c8c966fc, Erratum 1 d01c3e0bec84e7fc3f651a57656ea7b25139c2b693fb4648dec90089a2b0f732, Erratum 2 e0e82d3617d7d9531ec98635c09c1cbe56505d849b5fafd0dc68426f29469d76. */
export const PRE_FIX_BEFORE_MS = Date.parse("2026-10-20T12:07:00.000Z");

export type FillSrc = "l2" | "modelled" | typeof STALE_QUOTE_FILL_SRC | typeof PRE_FIX_FILL_SRC | typeof ENTRY_STALE_FILL_SRC;
export type ExecWord = "ok" | "yellow" | "red";
export type StressGrade = "insufficient" | "indicative" | "decision-grade";
export type L2Src = "ws" | "rest_snapshot";

export function x1TakerOn(config: { parity?: unknown; liveQuotes?: boolean }): boolean {
  return config.liveQuotes === true && (config.parity == null);
}

export function halfSpreadPx(bid: number, ask: number): number {
  if (!(bid > 0) || !(ask >= bid) || !Number.isFinite(ask)) return 0;
  return (ask - bid) / 2;
}

/** Buy: open + half spread + 10 bps. Sell is the mirror. */
export function modelledPx(open: number, bid: number, ask: number, side: "buy" | "sell"): number {
  const half = halfSpreadPx(bid, ask);
  const stress = (open * MODEL_STRESS_BPS) / 10_000;
  return side === "buy" ? open + half + stress : open - half - stress;
}

export function l2Fresh(ageMs: number, src: L2Src | undefined): boolean {
  return ageMs >= 0 && ageMs <= FRESH_L2_MS && src !== "rest_snapshot";
}

/** A quote from before the open stays pending. The first update at or after it is taken, even when it is stale. */
export function classifyUpdate(input: { notBeforeMs: number; quoteTs: number; ageMs: number; src?: L2Src }): "ignore" | "l2" | "modelled" {
  if (!(input.quoteTs >= input.notBeforeMs)) return "ignore";
  return l2Fresh(input.ageMs, input.src) ? "l2" : "modelled";
}

/**
 * Entry tag for that first update. ≤2s and not a REST snapshot is a taker walk.
 * Older than 2s and no older than 15s is entry_stale_quote. Older than 15s is the stale-quote miss.
 * A REST snapshot that is still ≤2s stays modelled. It is not a walked book.
 */
export function entryQuoteFillSrc(ageMs: number, fresh: boolean): FillSrc {
  if (fresh) return "l2";
  if (ageMs > STALE_QUOTE_MS) return STALE_QUOTE_FILL_SRC;
  if (ageMs > FRESH_L2_MS) return ENTRY_STALE_FILL_SRC;
  return "modelled";
}

/** Walk when the order is larger than the touch. A one-level book returns the touch. */
export function vwapFill(side: "buy" | "sell", touch: number, levels: readonly [number, number][] | undefined, units: number): number {
  const book = new PairBook();
  const name = side === "buy" ? "offer" : "bid";
  if (levels) {
    for (const [price, qty] of levels) if (price > 0 && qty > 0) book.set(name, price, qty);
  }
  const top = side === "buy" ? book.bestAsk() : book.bestBid();
  if (top == null && touch > 0) book.set(name, touch, Number.POSITIVE_INFINITY);
  if (!(units > 0)) return touch;
  return book.walk(side, units) ?? touch;
}

/** (fill − mid) / mid × 1e4. Sells flip so a fill through the mid is a positive cost. */
export function execCostBps(side: "buy" | "sell", fill: number, mid: number): number | null {
  if (!(mid > 0) || !Number.isFinite(fill)) return null;
  const raw = ((fill - mid) / mid) * 10_000;
  return side === "sell" ? -raw : raw;
}

/** (mid − fillAnchorOpen) / fillAnchorOpen × 1e4. GREY. Not versus the decision. */
export function driftBps(mid: number, fillAnchorOpen: number): number | null {
  if (!(fillAnchorOpen > 0) || !Number.isFinite(mid)) return null;
  return ((mid - fillAnchorOpen) / fillAnchorOpen) * 10_000;
}

/** (mid − decision mid) / decision mid × 1e4. GREY. No check reads it. */
export function infoDelayBps(mid: number, midAtDecision: number): number | null {
  if (!(midAtDecision > 0) || !Number.isFinite(mid)) return null;
  return ((mid - midAtDecision) / midAtDecision) * 10_000;
}

/**
 * max(5, 0.5 × Corwin-Schultz) with no ceiling is sBtUncappedBps.
 * sBtMagnitudeBps is that value capped at 15. Live cost is compared with the cap.
 * The registered 2× stress uses 2 × the uncapped value, not 2 × after the cap.
 */
export function sBtMagnitude(csBps: number): { magnitude: number; uncapped: number } {
  const cs = Number.isFinite(csBps) && csBps > 0 ? csBps : 0;
  const uncapped = Math.max(S_BT_FLOOR_BPS, 0.5 * cs);
  const magnitude = Math.min(S_BT_CAP_BPS, uncapped);
  return { magnitude, uncapped };
}

export function sBtFromBars(prev: { high: number; low: number } | undefined, high: number, low: number): { magnitude: number; uncapped: number } | null {
  if (!prev) return null;
  return sBtMagnitude(corwinSchultzBps(prev.high, prev.low, high, low));
}

export function liveCostBps(execCost: number, drift: number): number {
  return execCost + drift;
}

/** Keyed on the entry time. An exit after the cutoff does not clear a pre-fix entry. */
export function isPreFixB(row: { classId: string; productId: string; entryTs?: number; fillSrc?: string | null }): boolean {
  if (row.classId !== "B") return false;
  if (!(PRE_FIX_PRODUCTS as readonly string[]).includes(row.productId)) return false;
  if (row.fillSrc === "l2" || row.fillSrc === "modelled" || row.fillSrc === STALE_QUOTE_FILL_SRC || row.fillSrc === ENTRY_STALE_FILL_SRC) return false;
  if (row.fillSrc === PRE_FIX_FILL_SRC) return true;
  if (row.entryTs == null || row.entryTs >= PRE_FIX_BEFORE_MS) return false;
  return true;
}

export function inSlippageStats(fillSrc: string | null | undefined, anchorMissing?: boolean): boolean {
  if (anchorMissing === true) return false;
  return fillSrc !== PRE_FIX_FILL_SRC && fillSrc !== ENTRY_STALE_FILL_SRC;
}

export function countsAsModelled(row: { fillSrc?: string | null; anchorMissing?: boolean }): boolean {
  return row.fillSrc === "modelled" || row.fillSrc === STALE_QUOTE_FILL_SRC || row.fillSrc === ENTRY_STALE_FILL_SRC || row.anchorMissing === true;
}

/** Share of entry legs that are modelled, entry-stale, stale-quote modelled, or missing an anchor. Pre-fix legs are not in the denominator. */
export function modelledShare(rows: readonly { classId: string; side?: string; fillSrc?: string | null; anchorMissing?: boolean }[], classId: string): number {
  const mine = rows.filter((row) => row.classId === classId && (row.side == null || row.side === "entry") && row.fillSrc != null && row.fillSrc !== PRE_FIX_FILL_SRC);
  if (mine.length === 0) return 0;
  return mine.filter((row) => countsAsModelled(row)).length / mine.length;
}

/** YELLOW above 10%, RED above 25%. 10% itself stays ok. */
export function execCostWord(share: number): ExecWord {
  if (share > MODELLED_SHARE_RED) return "red";
  if (share > MODELLED_SHARE_YELLOW) return "yellow";
  return "ok";
}

export function quoteMissStats(rows: readonly { classId?: string; fillSrc?: string | null }[], classId?: string): { missCount: number; missRate: number } {
  const mine = rows.filter((row) => (classId == null || row.classId === classId) && row.fillSrc != null && row.fillSrc !== PRE_FIX_FILL_SRC);
  const missCount = mine.filter((row) => row.fillSrc === STALE_QUOTE_FILL_SRC).length;
  return { missCount, missRate: mine.length === 0 ? 0 : missCount / mine.length };
}

export type LegLiquidity = "maker" | "taker";

/** One round-trip leg. A maker leg adds 0 to the 2× stress. */
export interface StressLeg {
  liquidity: LegLiquidity;
}

export interface StressTrade {
  classId: string;
  netUsd: number;
  netR?: number;
  riskUsd: number;
  notionalUsd: number;
  exitNotionalUsd?: number;
  /** Raw spread charge. Each taker leg adds it once. Falls back to sBtUncappedBps. */
  sBtRawBps?: number | null;
  sBtUncappedBps?: number | null;
  sBtMagnitudeBps?: number | null;
  sBtCapped?: boolean;
  /** Entry then exit. Omitted means two taker legs. */
  legs?: readonly StressLeg[];
  fillSrc?: string | null;
  exitFillSrc?: string | null;
  anchorMissing?: boolean;
  parity?: boolean;
  gap?: boolean;
  gapSlippageBps?: number | null;
}

export interface ClassStress {
  n: number;
  grade: StressGrade;
  /** Null below n = 10. The label shows n only in that band. */
  netR2xUncapped: number | null;
  /** Report-only. Null below n = 10. Each taker leg adds sBtMagnitudeBps once. */
  netR2xCapped: number | null;
  capHitCount: number;
  spreadFragile: boolean;
}

export function stressGrade(n: number): StressGrade {
  if (n < 10) return "insufficient";
  if (n < 30) return "indicative";
  return "decision-grade";
}

/** Modelled, stale-quote, entry-stale, missing-anchor, and pre-fix rows stay out of the class mean, the review, and Kelly. */
export function countsInClassMean(row: { fillSrc?: string | null; anchorMissing?: boolean }): boolean {
  if (row.anchorMissing === true) return false;
  return row.fillSrc !== "modelled" && row.fillSrc !== STALE_QUOTE_FILL_SRC && row.fillSrc !== ENTRY_STALE_FILL_SRC && row.fillSrc !== PRE_FIX_FILL_SRC;
}

/**
 * Per-trade mean of net R inside one class. Eligible rows only. Null below n = 10.
 */
export function classMeanNetR(rows: readonly { classId: string; netR: number; fillSrc?: string | null; anchorMissing?: boolean }[], classId: string): { n: number; meanNetR: number | null } {
  const mine = rows.filter((row) => row.classId === classId && countsInClassMean(row) && Number.isFinite(row.netR));
  if (mine.length < 10) return { n: mine.length, meanNetR: null };
  return { n: mine.length, meanNetR: mine.reduce((sum, row) => sum + row.netR, 0) / mine.length };
}

function spreadBpsOf(row: StressTrade, which: "raw" | "capped"): number {
  const stored = which === "raw" ? (row.sBtRawBps != null ? row.sBtRawBps : row.sBtUncappedBps) : row.sBtMagnitudeBps;
  return stored != null && stored > 0 ? stored : S_BT_FLOOR_BPS;
}

/** Sum of the spread charge over taker legs. Each maker leg adds 0. */
export function takerSpreadBps(row: StressTrade, which: "raw" | "capped"): number {
  const legs = row.legs ?? [{ liquidity: "taker" as const }, { liquidity: "taker" as const }];
  const bps = spreadBpsOf(row, which);
  let sum = 0;
  for (const leg of legs) if (leg.liquidity === "taker") sum += bps;
  return sum;
}

/**
 * Per-trade mean of stressed net R.
 * Each trade is netR − (sum of taker-leg bps) × notional / riskUsd.
 * The bps are divided by 1e4. Maker legs add 0. Trades are not weighted by risk.
 */
export function stress2xNetR(rows: readonly StressTrade[], which: "raw" | "capped"): number | null {
  const values: number[] = [];
  for (const row of rows) {
    if (!(row.riskUsd > 0)) continue;
    const drag = (takerSpreadBps(row, which) / 10_000) * row.notionalUsd;
    values.push((row.netUsd - drag) / row.riskUsd);
  }
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Taker-leg spread stress on class net R. Shown at n ≥ 10.
 * The capped line uses sBtMagnitudeBps the same way. Spread-fragile is a label, not a gate.
 */
export function classStress(rows: readonly StressTrade[], classId: string): ClassStress {
  const mine = rows.filter((row) => row.classId === classId && row.parity !== true && countsInClassMean(row) && row.riskUsd > 0 && row.notionalUsd > 0);
  const n = mine.length;
  const capHitCount = mine.filter((row) => row.sBtCapped === true || (row.sBtUncappedBps != null && row.sBtUncappedBps > S_BT_CAP_BPS) || (row.sBtRawBps != null && row.sBtRawBps > S_BT_CAP_BPS)).length;
  const grade = stressGrade(n);
  if (n < 10) return { n, grade, netR2xUncapped: null, netR2xCapped: null, capHitCount, spreadFragile: false };
  const netR2xUncapped = stress2xNetR(mine, "raw");
  const netR2xCapped = stress2xNetR(mine, "capped");
  return {
    n,
    grade,
    netR2xUncapped,
    netR2xCapped,
    capHitCount,
    spreadFragile: netR2xUncapped != null && netR2xUncapped <= 0,
  };
}

/**
 * Shadow P/L if the entry had been the modelled fill. The stored fill and netUsd stay.
 * The shadow is recorded beside the book. It does not replace the round trip.
 */
export function shadowAtModelled(input: {
  netUsd: number;
  entryFill: number;
  units: number;
  riskUsd: number;
  anchor: number;
  bid: number;
  ask: number;
}): { shadowFillPx: number; shadowNetUsd: number; shadowNetR: number; shadowFillKind: typeof SHADOW_FILL_KIND } {
  const shadowFillPx = modelledPx(input.anchor, input.bid, input.ask, "buy");
  const shadowNetUsd = input.netUsd + (input.entryFill - shadowFillPx) * input.units;
  const shadowNetR = input.riskUsd > 0 ? shadowNetUsd / input.riskUsd : 0;
  return { shadowFillPx, shadowNetUsd, shadowNetR, shadowFillKind: SHADOW_FILL_KIND };
}
