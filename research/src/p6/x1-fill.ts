/**
 * X1 taker fill for live paper. Parity replay does not call this.
 * Positive bps are a cost. Nothing here takes an absolute value.
 */

import { corwinSchultzBps } from "../p2/liquidity";
import { PairBook } from "./mid-feed";

export const FRESH_L2_MS = 2_000;
export const MODEL_STRESS_BPS = 10;
export const MODELLED_SHARE_LIMIT = 0.1;
export const S_BT_FLOOR_BPS = 5;
export const S_BT_CAP_BPS = 15;
export const PRE_FIX_FILL_SRC = "pre-fix fill model" as const;
export const PRE_FIX_PRODUCTS = ["AERO-USD", "ENA-USD", "NEAR-USD", "SUI-USD"] as const;
/** Brian approved the shadow count at 7:07 AM CT on Oct 20 2026 (CDT, UTC−5). */
export const PRE_FIX_BEFORE_MS = Date.parse("2026-10-20T12:07:00.000Z");

export type FillSrc = "l2" | "modelled" | typeof PRE_FIX_FILL_SRC;
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
  return ageMs <= FRESH_L2_MS && src !== "rest_snapshot";
}

/** Ignore a book from before the open. A stale or REST book at/after it is modelled. */
export function classifyUpdate(input: { notBeforeMs: number; quoteTs: number; ageMs: number; src?: L2Src }): "ignore" | "l2" | "modelled" {
  if (!(input.quoteTs >= input.notBeforeMs)) return "ignore";
  return l2Fresh(input.ageMs, input.src) ? "l2" : "modelled";
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

/** max(5, 0.5 × Corwin-Schultz) capped at 15. Stress is 2× that cap result. */
export function sBtMagnitude(csBps: number): { magnitude: number; stress: number } {
  const cs = Number.isFinite(csBps) && csBps > 0 ? csBps : 0;
  const magnitude = Math.min(S_BT_CAP_BPS, Math.max(S_BT_FLOOR_BPS, 0.5 * cs));
  return { magnitude, stress: magnitude * 2 };
}

export function sBtFromBars(prev: { high: number; low: number } | undefined, high: number, low: number): { magnitude: number; stress: number } | null {
  if (!prev) return null;
  return sBtMagnitude(corwinSchultzBps(prev.high, prev.low, high, low));
}

export function liveCostBps(execCost: number, drift: number): number {
  return execCost + drift;
}

export function isPreFixB(row: { classId: string; productId: string; exitTs?: number; fillSrc?: string | null }): boolean {
  if (row.classId !== "B") return false;
  if (!(PRE_FIX_PRODUCTS as readonly string[]).includes(row.productId)) return false;
  if (row.fillSrc === "l2" || row.fillSrc === "modelled") return false;
  if (row.fillSrc === PRE_FIX_FILL_SRC) return true;
  if (row.exitTs != null && row.exitTs >= PRE_FIX_BEFORE_MS) return false;
  return true;
}

export function inSlippageStats(fillSrc: string | null | undefined): boolean {
  return fillSrc !== PRE_FIX_FILL_SRC;
}

/** Share of entry legs tagged modelled. Pre-fix legs are not in the denominator. */
export function modelledShare(rows: readonly { classId: string; side?: string; fillSrc?: string | null }[], classId: string): number {
  const mine = rows.filter((row) => row.classId === classId && (row.side == null || row.side === "entry") && row.fillSrc != null && row.fillSrc !== PRE_FIX_FILL_SRC);
  if (mine.length === 0) return 0;
  return mine.filter((row) => row.fillSrc === "modelled").length / mine.length;
}

export function execCostWord(share: number): "unreliable" | "ok" {
  return share > MODELLED_SHARE_LIMIT ? "unreliable" : "ok";
}

/**
 * Shadow P/L if the entry had been the modelled fill. The stored fill price stays.
 * netUsd is the actual round trip. The shadow replaces the entry fill only.
 */
export function shadowAtModelled(input: {
  netUsd: number;
  entryFill: number;
  units: number;
  riskUsd: number;
  anchor: number;
  bid: number;
  ask: number;
}): { shadowFill: number; shadowNetUsd: number; shadowNetR: number } {
  const shadowFill = modelledPx(input.anchor, input.bid, input.ask, "buy");
  const shadowNetUsd = input.netUsd + (input.entryFill - shadowFill) * input.units;
  const shadowNetR = input.riskUsd > 0 ? shadowNetUsd / input.riskUsd : 0;
  return { shadowFill, shadowNetUsd, shadowNetR };
}
