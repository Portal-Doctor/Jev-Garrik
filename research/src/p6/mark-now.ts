/**
 * Dashboard mark. Reads positions and the latest bid already on the hot snapshot.
 * No Redis read. The bid is the mark. The half spread is not added again.
 */

import { TAKER_FEE_BPS } from "../../vendor/87b35d0/config.ts";
import { formatCt } from "./pnl-block";
import { publicTicker } from "./rest-limit";
import { FRESH_L2_MS, vwapFill } from "./x1-fill";

export const MARK_LABEL = "marked to bid, taker 0.90% exit";
export const REST_LABEL = "REST mark";
export const MARK_STALE_MS = 60_000;
export const MARK_REST_MS = 15 * 60_000;
export const REST_CACHE_MS = 60_000;
const TAKER = TAKER_FEE_BPS / 10_000;
const PRODUCT_RE = /^[A-Z0-9]{2,10}-[A-Z]{2,5}$/;

export interface MarkPosition {
  productId: string;
  fillPrice: number;
  units: number;
  entryFeeUsd: number;
  riskUsd: number;
}

export interface MarkQuote {
  bid: number;
  tsMs: number;
  /** Bid ladder. Absent means the touch is the whole book. */
  bids?: readonly [number, number][];
}

export interface MarkNowRow {
  productId: string;
  pnl: number | null;
  grossUsd: number | null;
  grossR: number | null;
  netR: number | null;
}

export interface MarkNow {
  pnlNow: number | null;
  label: typeof MARK_LABEL;
  state: "live" | "stale" | "rest" | "na";
  staleText?: string;
  restLabel?: typeof REST_LABEL;
  openRGross: number | null;
  openRNet: number | null;
  grossUsd: number | null;
  riskUsd: number;
  /** False when a bid used for the mark is older than 2s. The 60s / 15 min display is `state`. */
  quoteFresh: boolean;
  rows: MarkNowRow[];
}

export function positionPnlNow(position: MarkPosition, bid: number): number {
  return (bid - position.fillPrice) * position.units - position.entryFeeUsd - bid * position.units * TAKER;
}

export function positionGrossUsd(position: MarkPosition, bid: number): number {
  return (bid - position.fillPrice) * position.units;
}

export function quoteAgeState(ageMs: number | null, disconnected: boolean): MarkNow["state"] {
  if (ageMs == null || !Number.isFinite(ageMs)) return "na";
  if (ageMs > MARK_REST_MS) return "rest";
  if (disconnected || ageMs > MARK_STALE_MS) return "stale";
  return "live";
}

function finitePosition(row: MarkPosition): boolean {
  return (
    typeof row.productId === "string" &&
    row.fillPrice > 0 &&
    Number.isFinite(row.fillPrice) &&
    Number.isFinite(row.units) &&
    Number.isFinite(row.entryFeeUsd) &&
    row.riskUsd > 0 &&
    Number.isFinite(row.riskUsd)
  );
}

/**
 * pnlNow and open R from the latest bid. A missing bid is n/a.
 * restBids replaces a bid only for the >15 min REST mark.
 */
export function closedNow(
  positions: readonly MarkPosition[],
  quotes: Readonly<Record<string, MarkQuote | undefined>>,
  nowMs: number,
  opts?: { disconnected?: boolean; restBids?: Readonly<Record<string, number>> },
): MarkNow {
  const rows: MarkNowRow[] = [];
  let missing = false;
  let worst: MarkNow["state"] = "live";
  let oldest = Number.POSITIVE_INFINITY;
  let pnl = 0;
  let gross = 0;
  let risk = 0;
  let quoteFresh = true;
  const rank = { live: 0, stale: 1, rest: 2, na: 3 };
  for (const position of positions) {
    if (!finitePosition(position)) {
      missing = true;
      rows.push({ productId: position.productId, pnl: null, grossUsd: null, grossR: null, netR: null });
      continue;
    }
    const quote = quotes[position.productId];
    const bid0 = quote && quote.bid > 0 && Number.isFinite(quote.bid) ? quote.bid : null;
    if (bid0 == null || quote == null) {
      missing = true;
      rows.push({ productId: position.productId, pnl: null, grossUsd: null, grossR: null, netR: null });
      continue;
    }
    const age = nowMs - quote.tsMs;
    const state = quoteAgeState(age, opts?.disconnected === true);
    if (!(age >= 0 && age <= FRESH_L2_MS)) quoteFresh = false;
    if (rank[state] > rank[worst]) worst = state;
    if (quote.tsMs < oldest) oldest = quote.tsMs;
    const rest = opts?.restBids?.[position.productId];
    const walked = vwapFill("sell", bid0, quote.bids ? [...quote.bids] : undefined, position.units);
    const bid = state === "rest" && rest != null && rest > 0 && Number.isFinite(rest) ? rest : walked;
    const pnlRow = positionPnlNow(position, bid);
    const grossRow = positionGrossUsd(position, bid);
    pnl += pnlRow;
    gross += grossRow;
    risk += position.riskUsd;
    rows.push({
      productId: position.productId,
      pnl: pnlRow,
      grossUsd: grossRow,
      grossR: grossRow / position.riskUsd,
      netR: pnlRow / position.riskUsd,
    });
  }
  if (positions.length === 0) {
    return { pnlNow: 0, label: MARK_LABEL, state: "live", openRGross: null, openRNet: null, grossUsd: 0, riskUsd: 0, quoteFresh: true, rows };
  }
  if (missing) {
    return { pnlNow: null, label: MARK_LABEL, state: "na", openRGross: null, openRNet: null, grossUsd: null, riskUsd: risk, quoteFresh: false, rows };
  }
  const staleText = worst === "stale" || worst === "rest" ? `stale since ${formatCt(oldest, false)}` : undefined;
  return {
    pnlNow: pnl,
    label: MARK_LABEL,
    state: worst,
    ...(staleText ? { staleText } : {}),
    ...(worst === "rest" ? { restLabel: REST_LABEL } : {}),
    openRGross: risk > 0 ? gross / risk : null,
    openRNet: risk > 0 ? pnl / risk : null,
    grossUsd: gross,
    riskUsd: risk,
    quoteFresh,
    rows,
  };
}

const restCache = new Map<string, { bid: number; at: number }>();

/** Public ticker. Cached at least 60s. No API key. */
export async function fetchRestBids(
  productIds: readonly string[],
  nowMs: number,
  fetchImpl?: (url: string) => Promise<Pick<Response, "ok" | "json">>,
): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const productId of productIds) {
    if (!PRODUCT_RE.test(productId)) continue;
    const hit = restCache.get(productId);
    if (hit && nowMs - hit.at < REST_CACHE_MS) {
      out[productId] = hit.bid;
      continue;
    }
    try {
      const response = await (fetchImpl ?? publicTicker)(`https://api.exchange.coinbase.com/products/${productId}/ticker`);
      if (!response.ok) continue;
      const body = (await response.json()) as { bid?: unknown };
      const bid = typeof body.bid === "string" || typeof body.bid === "number" ? Number(body.bid) : Number.NaN;
      if (!(bid > 0) || !Number.isFinite(bid)) continue;
      restCache.set(productId, { bid, at: nowMs });
      out[productId] = bid;
    } catch {
      // Keep the last hot bid. The caller still labels the mark stale.
    }
  }
  return out;
}

/** Test hook. Production calls do not clear this except through time. */
export function clearRestCache(): void {
  restCache.clear();
}
