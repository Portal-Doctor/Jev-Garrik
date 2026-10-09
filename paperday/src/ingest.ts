/**
 * Public Coinbase market data only. REST candle backfill and a public candles
 * subscribe frame. The user channel and any signed order frame are refused.
 */

import { backfill, findGaps, type Candle } from "./bars";

const REST = "https://api.exchange.coinbase.com";

export function publicCandlesUrl(pair: string, startSec: number, endSec: number, granularity = 60): string {
  return `${REST}/products/${encodeURIComponent(pair)}/candles?granularity=${granularity}&start=${startSec}&end=${endSec}`;
}

export function publicSubscribeFrame(pairs: string[]): string {
  return JSON.stringify({ type: "subscribe", product_ids: pairs, channel: "candles" });
}

export function assertPublicFrame(frame: string): void {
  const msg = JSON.parse(frame) as Record<string, unknown>;
  const channel = String(msg.channel ?? "");
  if (channel === "user") throw new Error("user channel is order-capable and is refused");
  if ("jwt" in msg || "api_key" in msg || "signature" in msg) {
    throw new Error("signed frame is refused");
  }
}

export function parseExchangeCandles(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) throw new Error("Coinbase candles returned an unexpected payload");
  const out: Candle[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 6) continue;
    const ts = Number(row[0]) * 1000;
    const low = Number(row[1]);
    const high = Number(row[2]);
    const open = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[5]);
    if (!Number.isFinite(ts) || !(close > 0)) continue;
    out.push({ ts, open, high, low, close, volume });
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export async function fetchPublicCandles(
  pair: string,
  fromMs: number,
  toMs: number,
  barSec = 60,
  fetchImpl: typeof fetch = fetch,
): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  const chunk = 299 * barSec * 1000;
  for (let cursor = fromMs; cursor < toMs; cursor += chunk) {
    const end = Math.min(toMs, cursor + chunk);
    const url = publicCandlesUrl(pair, Math.floor(cursor / 1000), Math.floor(end / 1000), barSec);
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Coinbase candles ${res.status}`);
    const rows = (await res.json()) as unknown;
    for (const bar of parseExchangeCandles(rows)) out.set(bar.ts, bar);
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

/** Fill holes with a REST fetch of the missing span. Existing timestamps stay. */
export async function backfillGaps(
  pair: string,
  bars: Candle[],
  stepMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<{ bars: Candle[]; added: number; gapsBefore: number }> {
  const gaps = findGaps(bars, stepMs);
  let current = bars;
  let added = 0;
  for (const gap of gaps) {
    const from = gap.afterTs + stepMs;
    const to = gap.afterTs + gap.missingMs + stepMs;
    const fetched = await fetchPublicCandles(pair, from, to, stepMs / 1000, fetchImpl);
    const next = backfill(current, fetched);
    current = next.bars;
    added += next.added;
  }
  return { bars: current, added, gapsBefore: gaps.length };
}
