/**
 * Public product stats.
 * `open`, `high`, `low`, and `last` are the exchange 24h OHLC fields.
 * The universe cut uses `high`, `low`, and `last` only to compute a 24h range.
 * Those fields are not returns.
 */

import { assertNoBannedKeys } from "./banned";
import type { UsdSpotProduct } from "./products";
import { createPacer } from "./download";
import { publicHeaders, statsUrl, type FetchLike } from "./public";

export const PRODUCT_STATS_ENDPOINT = "https://api.exchange.coinbase.com/products/{productId}/stats";

/** Commit time of the bare-array capture. That file had no fetch timestamp of its own. */
export const CONVERTED_STATS_FETCHED_AT = "2026-10-11T00:08:06.000Z";

export const OHLC_NOTE =
  "open, high, low, and last are the exchange 24-hour stats. The cut uses high, low, and last only to form range_24h. They are not returns.";

export interface ProductStatRow {
  productId: string;
  status: string;
  httpStatus: number;
  stats: {
    open?: string;
    high?: string;
    low?: string;
    last?: string;
    volume?: string;
    volume_30day?: string;
    rfq_volume_24hour?: string;
    rfq_volume_30day?: string;
  } | null;
  error: string | null;
  /** Exact response body. Absent on the converted capture, which stored parsed JSON only. */
  raw?: string;
}

export interface ProductStatsFile {
  commitSha?: string;
  dataRootHash?: string | null;
  createdAt?: string;
  phaseId?: string;
  fetchedAt: string;
  fetchedAtNote: string;
  endpoint: string;
  ohlcNote: string;
  products: ProductStatRow[];
}

export function parseProductStats(text: string): ProductStatsFile {
  const parsed: unknown = JSON.parse(text);
  if (Array.isArray(parsed)) {
    throw new Error("product-stats.json is still the bare array. Run stats-convert. Do not re-fetch.");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("product stats payload is not an object");
  const body = parsed as ProductStatsFile;
  if (!Array.isArray(body.products)) throw new Error("product stats payload has no products array");
  assertNoBannedKeys(body, "product stats");
  return body;
}

/**
 * Wraps the original bare array. Product objects are re-serialized from the parsed JSON,
 * which keeps every field and does not invent wire bytes. The original capture had no `raw` body
 * and no timestamp; `fetchedAt` is the commit time of that array.
 */
export function convertBareProductStats(text: string): ProductStatsFile {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) throw new Error("stats-convert expected the original bare array");
  const file: ProductStatsFile = {
    fetchedAt: CONVERTED_STATS_FETCHED_AT,
    fetchedAtNote:
      "Converted losslessly from the bare array committed in a54ba663654d70f5663c9326d73d666f72288cbf. That array had no fetch timestamp and no raw response bodies. fetchedAt is that commit's time. Product objects keep the parsed fields; wire bytes were not stored, so they were not reconstructed.",
    endpoint: PRODUCT_STATS_ENDPOINT,
    ohlcNote: OHLC_NOTE,
    products: parsed as ProductStatRow[],
  };
  assertNoBannedKeys(file, "converted product stats");
  return file;
}

export async function fetchProductStats(opts: {
  products: readonly Pick<UsdSpotProduct, "productId" | "status">[];
  now: Date;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  intervalMs?: number;
}): Promise<ProductStatsFile> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowMs = opts.nowMs ?? Date.now;
  const pace = createPacer(opts.intervalMs ?? 100, nowMs, sleep);
  const products: ProductStatRow[] = [];
  for (const product of opts.products) {
    await pace();
    const res = await fetchImpl(statsUrl(product.productId), { headers: publicHeaders() });
    const raw = await res.text();
    let stats: ProductStatRow["stats"] = null;
    let error: string | null = null;
    if (res.status === 200) stats = JSON.parse(raw) as ProductStatRow["stats"];
    else error = raw;
    products.push({
      productId: product.productId,
      status: product.status,
      httpStatus: res.status,
      stats,
      error,
      raw,
    });
  }
  const file: ProductStatsFile = {
    fetchedAt: opts.now.toISOString(),
    fetchedAtNote: "Clock time of this fetch. raw is the exact response body.",
    endpoint: PRODUCT_STATS_ENDPOINT,
    ohlcNote: OHLC_NOTE,
    products,
  };
  assertNoBannedKeys(file, "fetched product stats");
  return file;
}
