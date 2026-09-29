/**
 * Disk cache for the Coinbase Exchange candle tape.
 *
 * A 6 month 5 minute tape is about 52,000 bars per pair and roughly 175 REST pages. The fee
 * tier replay walks the same tape once per tier, so refetching it every time is the slow part
 * of the run. Candles for a closed bucket never change, so caching them under `data/tape` is
 * safe. Only the tail past the newest cached bar is refetched.
 */

import { fetchCandles, type Candle } from "./backtest";

const DIR = "data/tape";

function cachePath(pair: string, barSec: number): string {
  return `${DIR}/${pair}-${barSec}.json`;
}

async function readCache(pair: string, barSec: number): Promise<Candle[]> {
  const file = Bun.file(cachePath(pair, barSec));
  if (!(await file.exists())) return [];
  try {
    const rows = (await file.json()) as unknown;
    if (!Array.isArray(rows)) return [];
    return rows.filter((r): r is Candle => r != null && typeof r === "object" && Number.isFinite((r as Candle).ts));
  } catch {
    return [];
  }
}

async function writeCache(pair: string, barSec: number, candles: Candle[]): Promise<void> {
  await Bun.write(cachePath(pair, barSec), JSON.stringify(candles));
}

function merge(existing: Candle[], fresh: Candle[]): Candle[] {
  const byTs = new Map<number, Candle>();
  for (const c of existing) byTs.set(c.ts, c);
  for (const c of fresh) byTs.set(c.ts, c);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

/** Candles in `[fromMs, toMs)`, served from the cache where possible. */
export async function loadTape(pair: string, fromMs: number, toMs: number, barSec: number): Promise<Candle[]> {
  const cached = await readCache(pair, barSec);
  const oldest = cached.length ? cached[0]!.ts : null;
  const newest = cached.length ? cached[cached.length - 1]!.ts : null;
  let all = cached;

  if (oldest == null || newest == null) {
    all = await fetchCandles(pair, fromMs, toMs, barSec);
  } else {
    if (fromMs < oldest) all = merge(all, await fetchCandles(pair, fromMs, oldest, barSec));
    // One bar of overlap so a bucket that was still open when it was cached is refreshed.
    if (toMs > newest) all = merge(all, await fetchCandles(pair, newest, toMs, barSec));
  }

  if (all.length !== cached.length || newest == null) await writeCache(pair, barSec, all);
  return all.filter((c) => c.ts >= fromMs && c.ts < toMs);
}
