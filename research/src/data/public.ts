/** Public market-data URLs. No account, key, or order route. */

import { BAR_SEC } from "./time";

export const EXCHANGE_REST = "https://api.exchange.coinbase.com";
export const USER_AGENT = "research-v3";

export function productsUrl(): string {
  return `${EXCHANGE_REST}/products`;
}

export function statsUrl(pair: string): string {
  return `${EXCHANGE_REST}/products/${encodeURIComponent(pair)}/stats`;
}

/** `endSecInclusive` is the last bar open the exchange endpoint may return. */
export function candlesUrl(pair: string, startSec: number, endSecInclusive: number, granularitySec = BAR_SEC): string {
  const params = new URLSearchParams({
    granularity: String(granularitySec),
    start: String(startSec),
    end: String(endSecInclusive),
  });
  return `${EXCHANGE_REST}/products/${encodeURIComponent(pair)}/candles?${params}`;
}

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function publicHeaders(): Record<string, string> {
  return { "User-Agent": USER_AGENT, Accept: "application/json" };
}
