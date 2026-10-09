/**
 * Completed-bar builder. A bucket that has not closed is dropped.
 * Gaps are detected off the timestamp grid. Keys are pair|timeframe|openTs.
 */

export type Timeframe = "1m" | "5m" | "4h" | "1d";

export interface Candle {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const TF_MS: Record<Timeframe, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "4h": 14_400_000,
  "1d": 86_400_000,
};

export function barKey(pair: string, timeframe: Timeframe, openTs: number): string {
  return `${pair}|${timeframe}|${openTs}`;
}

export function aggregate(candles: Candle[], bucketMs: number, nowMs?: number): Candle[] {
  const ordered = candles.filter((c) => c.close > 0 && c.ts >= 0).slice().sort((a, b) => a.ts - b.ts);
  const groups = new Map<number, Candle>();
  for (const bar of ordered) {
    const key = Math.floor(bar.ts / bucketMs) * bucketMs;
    if (nowMs != null && key + bucketMs > nowMs) continue;
    const cur = groups.get(key);
    if (!cur) {
      groups.set(key, { ts: key, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume });
      continue;
    }
    cur.high = Math.max(cur.high, bar.high);
    cur.low = Math.min(cur.low, bar.low);
    cur.close = bar.close;
    cur.volume += bar.volume;
  }
  const keys = [...groups.keys()].sort((a, b) => a - b);
  if (nowMs == null && keys.length > 0) keys.pop();
  return keys.map((k) => groups.get(k)!);
}

export interface Gap {
  afterTs: number;
  missingMs: number;
}

export function findGaps(bars: Candle[], stepMs: number): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i]!.ts - bars[i - 1]!.ts;
    if (d > stepMs) gaps.push({ afterTs: bars[i - 1]!.ts, missingMs: d - stepMs });
  }
  return gaps;
}

/** Inserts fetched candles into a sorted series. Duplicate timestamps keep the first write. */
export function backfill(existing: Candle[], fetched: Candle[]): { bars: Candle[]; added: number } {
  const byTs = new Map<number, Candle>();
  for (const b of existing) byTs.set(b.ts, b);
  let added = 0;
  for (const b of fetched) {
    if (!byTs.has(b.ts) && b.close > 0) {
      byTs.set(b.ts, b);
      added += 1;
    }
  }
  return { bars: [...byTs.values()].sort((a, b) => a.ts - b.ts), added };
}

export function gapExceeds(prevTs: number | null, ts: number, maxSec: number): boolean {
  if (prevTs == null) return false;
  return ts - prevTs > maxSec * 1000;
}
