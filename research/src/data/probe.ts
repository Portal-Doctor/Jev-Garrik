import type { ArtifactStamp } from "../manifest";
import { parseCandlePayload } from "./candles";
import { candlesUrl, publicHeaders, type FetchLike } from "./public";
import { isProbeTarget, type UsdSpotProduct } from "./products";
import { isoFromSec, latestCompletedDayEndSec, MINUTE_SEC } from "./time";

/** Fixed sample spans. These are not an inferred listing-to-delist interval. */
export const PROBE_SAMPLE_DAYS = ["2019-01-01", "2021-01-01", "2023-10-01", "2025-01-01"] as const;
const PROBE_MINUTES = 299;

export interface ProbeWindowResult {
  label: string;
  start: string;
  end: string;
  httpStatus: number | null;
  candleCount: number | null;
  error: string | null;
}

export interface ProbeProductResult {
  productId: string;
  status: UsdSpotProduct["status"];
  statusRaw: string;
  candlesServed: boolean | null;
  windows: ProbeWindowResult[];
}

export interface DelistedProbeReport extends ArtifactStamp {
  note: string;
  sampleDays: string[];
  products: ProbeProductResult[];
}

export function probeWindows(now: Date): { label: string; startSec: number; endSec: number }[] {
  const latestCompletedStart = latestCompletedDayEndSec(now) - 24 * 60 * 60;
  const starts = [
    ...PROBE_SAMPLE_DAYS.map((day) => ({ label: day, startSec: Date.parse(`${day}T00:00:00.000Z`) / 1000 })),
    { label: isoFromSec(latestCompletedStart).slice(0, 10), startSec: latestCompletedStart },
  ];
  return starts.map((item) => ({
    label: item.label,
    startSec: item.startSec,
    endSec: item.startSec + PROBE_MINUTES * MINUTE_SEC,
  }));
}

export async function probeDelisted(opts: {
  products: readonly UsdSpotProduct[];
  now: Date;
  stamp: ArtifactStamp;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  pace?: () => Promise<void>;
}): Promise<DelistedProbeReport> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const pace = opts.pace ?? (async () => {});
  const windows = probeWindows(opts.now);
  const targets = opts.products.filter(isProbeTarget);
  const products: ProbeProductResult[] = [];
  for (const product of targets) {
    const rows: ProbeWindowResult[] = [];
    for (const window of windows) {
      rows.push(await requestWindow(product.productId, window, fetchImpl, pace, sleep));
    }
    products.push({
      productId: product.productId,
      status: product.status,
      statusRaw: product.statusRaw,
      candlesServed: servedFrom(rows),
      windows: rows,
    });
  }
  return {
    ...opts.stamp,
    note: "Sample windows only. The exchange product payload has no listing or delist timestamp, so this does not decide whether candles exist across a product's whole trading life.",
    sampleDays: windows.map((window) => window.label),
    products,
  };
}

function servedFrom(rows: readonly ProbeWindowResult[]): boolean | null {
  if (rows.some((row) => (row.candleCount ?? 0) > 0)) return true;
  if (rows.every((row) => row.httpStatus === 200 && row.candleCount === 0)) return false;
  if (rows.every((row) => row.httpStatus === 404)) return false;
  return null;
}

async function requestWindow(
  pair: string,
  window: { label: string; startSec: number; endSec: number },
  fetchImpl: FetchLike,
  pace: () => Promise<void>,
  sleep: (ms: number) => Promise<void>,
): Promise<ProbeWindowResult> {
  const base = {
    label: window.label,
    start: isoFromSec(window.startSec),
    end: isoFromSec(window.endSec),
  };
  const url = candlesUrl(pair, window.startSec, window.endSec - MINUTE_SEC);
  for (let attempt = 0; attempt < 6; attempt++) {
    await pace();
    try {
      const res = await fetchImpl(url, { headers: publicHeaders() });
      if (res.status === 404) return { ...base, httpStatus: 404, candleCount: 0, error: null };
      if (res.status === 429 || res.status >= 500) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (!res.ok) return { ...base, httpStatus: res.status, candleCount: null, error: `http ${res.status}` };
      const candles = parseCandlePayload(await res.text()).filter(
        (candle) => candle.minuteSec >= window.startSec && candle.minuteSec < window.endSec,
      );
      return { ...base, httpStatus: 200, candleCount: candles.length, error: null };
    } catch (err) {
      if (attempt === 5) {
        return { ...base, httpStatus: null, candleCount: null, error: err instanceof Error ? err.message : String(err) };
      }
      await sleep(500 * 2 ** attempt);
    }
  }
  return { ...base, httpStatus: null, candleCount: null, error: "retries exhausted" };
}
