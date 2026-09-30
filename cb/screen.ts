/**
 * High-vol pair screen for Coinbase Advanced Trade USD spot.
 *
 * Vol definition (locked for this pass, same window as adoption-run.ts):
 *   trailing sample standard deviation of close-to-close simple returns on completed
 *   4-hour bars, over the last 180 days, expressed in bps of price. Not annualized.
 *   4-hour bars are aggregated from Exchange hourly candles so the close matches the
 *   4-hour bucket the live books already use. The last (possibly open) bucket is dropped.
 *
 * Liquidity: 30-day USD notional is sum(close * base volume) on those hourly candles
 *   inside the last 30 days. A pair is too thin to fill the live clips ($300 to $600)
 *   when that 30-day notional is below the thinnest currently live pair (ARB-USD),
 *   measured on the same tape and window.
 *
 * Listing source: Coinbase Advanced Trade public SPOT products with quote USD and
 *   venue CBE, which is the Exchange USD book the engine already trades.
 */

import { Welford } from "./features";
import { aggregate } from "./breakout";
import type { Candle } from "./backtest";

export const SCREEN_WINDOW_DAYS = 180;
export const SCREEN_BUCKET_SEC = 14_400;
export const MIN_CLIP_USD = 300;
export const MAX_CLIP_USD = 600;
export const LIVE_PAIRS = ["UNI-USD", "NEAR-USD", "BCH-USD", "SUI-USD", "AVAX-USD", "ARB-USD"] as const;
export const LIQUIDITY_FLOOR_PAIR = "ARB-USD";

/** Quote-stable or dollar-pegged bases. USD quote of these is a stable/stable or wrapper of cash. */
export const STABLE_BASES = new Set([
  "USDC",
  "USDT",
  "DAI",
  "PYUSD",
  "GUSD",
  "PAX",
  "USDP",
  "TUSD",
  "BUSD",
  "FDUSD",
  "RLUSD",
  "USDS",
  "USD1",
  "EURC",
  "AEUR",
  "GYEN",
  "CADC",
  "GBP",
  "EUR",
  "USD",
]);

/**
 * Wrapped, staked, or receipt tokens. The underlying already has (or is) a USD book.
 * Keep the list tight: native L1/L2 coins stay in. If a listing is genuinely ambiguous,
 * the screen records `ask` instead of dropping it silently.
 */
export const WRAPPER_BASES = new Set([
  "WBTC",
  "WETH",
  "CBETH",
  "CBBTC",
  "STETH",
  "WSTETH",
  "RETH",
  "WEETH",
  "SUSDE",
  "TBTC",
  "MSOL",
  "BSOL",
  "LSETH",
  "SWETH",
  "RSETH",
  "EZETH",
]);

export type DropReason =
  | "not_usd_spot"
  | "disabled"
  | "stable"
  | "wrapper"
  | "illiquid"
  | "short_tape"
  | "live_book";

export interface SpotProduct {
  productId: string;
  base: string;
  quote: string;
  status: string;
  tradingDisabled: boolean;
  productType: string;
  venue: string;
  /** 24h quote volume from the listing, when Coinbase sends it. */
  quoteVolume24h: number | null;
}

export interface ScreenRow {
  pair: string;
  volBps: number | null;
  notional30dUsd: number | null;
  bars4h: number;
  keep: boolean;
  reason: DropReason | "kept" | "ask";
  note: string;
}

export function parseSpotProduct(raw: Record<string, unknown>): SpotProduct | null {
  const productId = str(raw.product_id) ?? str(raw.id);
  const base = str(raw.base_currency_id) ?? str(raw.base_currency);
  const quote = str(raw.quote_currency_id) ?? str(raw.quote_currency);
  if (!productId || !base || !quote) return null;
  const volume = num(raw.approximate_quote_24h_volume);
  return {
    productId,
    base: base.toUpperCase(),
    quote: quote.toUpperCase(),
    status: (str(raw.status) ?? "").toLowerCase(),
    tradingDisabled: raw.trading_disabled === true || raw.is_disabled === true,
    productType: (str(raw.product_type) ?? "SPOT").toUpperCase(),
    venue: (str(raw.product_venue) ?? "CBE").toUpperCase(),
    quoteVolume24h: volume,
  };
}

export function listingReason(p: SpotProduct): DropReason | "kept" | "ask" {
  if (p.quote !== "USD") return "not_usd_spot";
  if (p.productType && p.productType !== "SPOT") return "not_usd_spot";
  if (p.venue && p.venue !== "CBE") return "not_usd_spot";
  if (p.tradingDisabled || (p.status && p.status !== "online")) return "disabled";
  if (STABLE_BASES.has(p.base)) return "stable";
  if (WRAPPER_BASES.has(p.base)) return "wrapper";
  if (LIVE_PAIRS.includes(p.productId as (typeof LIVE_PAIRS)[number])) return "live_book";
  return "kept";
}

/**
 * Sample stdev of 4-hour close-to-close simple returns, in bps.
 * Needs at least 20 completed 4-hour bars after aggregation.
 */
export function fourHourRealizedVolBps(hourly: Candle[], windowStartTs: number, nowTs: number): { volBps: number | null; bars: number } {
  const inWindow = hourly.filter((c) => c.ts >= windowStartTs && c.ts < nowTs && c.close > 0);
  const h4 = aggregate(inWindow, SCREEN_BUCKET_SEC);
  if (h4.length < 20) return { volBps: null, bars: h4.length };
  const w = new Welford();
  for (let i = 1; i < h4.length; i++) {
    const prev = h4[i - 1]!.close;
    const cur = h4[i]!.close;
    if (!(prev > 0) || !(cur > 0)) continue;
    w.push(((cur - prev) / prev) * 10_000);
  }
  if (w.n < 20) return { volBps: null, bars: h4.length };
  return { volBps: w.stdev(), bars: h4.length };
}

/** Sum of close * base volume over hourly candles inside the trailing 30 days. */
export function thirtyDayNotionalUsd(hourly: Candle[], nowTs: number): number {
  const from = nowTs - 30 * 86_400_000;
  let usd = 0;
  for (const c of hourly) {
    if (c.ts < from || c.ts >= nowTs) continue;
    if (!(c.close > 0) || !(c.volume >= 0)) continue;
    usd += c.close * c.volume;
  }
  return usd;
}

export function clipFromLiquidity(notional30dUsd: number, arb30dUsd: number, uni30dUsd: number): number {
  if (!(arb30dUsd > 0) || notional30dUsd < arb30dUsd) return MIN_CLIP_USD;
  if (!(uni30dUsd > arb30dUsd) || notional30dUsd >= uni30dUsd) {
    return notional30dUsd >= uni30dUsd ? MAX_CLIP_USD : MIN_CLIP_USD;
  }
  const t = (notional30dUsd - arb30dUsd) / (uni30dUsd - arb30dUsd);
  const raw = MIN_CLIP_USD + t * (MAX_CLIP_USD - MIN_CLIP_USD);
  return Math.round(raw / 100) * 100;
}

export function scoreRow(opts: {
  pair: string;
  listing: DropReason | "kept" | "ask";
  volBps: number | null;
  bars4h: number;
  notional30dUsd: number | null;
  arb30dUsd: number;
}): ScreenRow {
  if (opts.listing !== "kept") {
    return {
      pair: opts.pair,
      volBps: opts.volBps,
      notional30dUsd: opts.notional30dUsd,
      bars4h: opts.bars4h,
      keep: false,
      reason: opts.listing,
      note: dropNote(opts.listing),
    };
  }
  if (opts.volBps == null || opts.bars4h < 20) {
    return {
      pair: opts.pair,
      volBps: opts.volBps,
      notional30dUsd: opts.notional30dUsd,
      bars4h: opts.bars4h,
      keep: false,
      reason: "short_tape",
      note: "Fewer than 20 completed 4-hour bars in the 180-day window.",
    };
  }
  if (opts.notional30dUsd == null || opts.notional30dUsd < opts.arb30dUsd) {
    return {
      pair: opts.pair,
      volBps: opts.volBps,
      notional30dUsd: opts.notional30dUsd,
      bars4h: opts.bars4h,
      keep: false,
      reason: "illiquid",
      note: `30-day notional below ARB-USD floor ($${opts.arb30dUsd.toFixed(0)}).`,
    };
  }
  return {
    pair: opts.pair,
    volBps: opts.volBps,
    notional30dUsd: opts.notional30dUsd,
    bars4h: opts.bars4h,
    keep: true,
    reason: "kept",
    note: "USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB.",
  };
}

function dropNote(reason: DropReason | "kept" | "ask"): string {
  switch (reason) {
    case "not_usd_spot":
      return "Not an online CBE USD spot product.";
    case "disabled":
      return "Listing is disabled, cancel-only, or not online.";
    case "stable":
      return "Stable or cash-pegged base.";
    case "wrapper":
      return "Wrapped, staked, or receipt token.";
    case "illiquid":
      return "30-day notional below the live ARB-USD floor.";
    case "short_tape":
      return "Not enough completed 4-hour bars.";
    case "live_book":
      return "Already on the live six-pair book. Ranked for reference, not a new candidate.";
    case "ask":
      return "Listing is ambiguous. Do not keep or drop without Brian.";
    case "kept":
      return "Kept.";
  }
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
