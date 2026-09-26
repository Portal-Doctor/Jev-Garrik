/**
 * 4-hour trend from Coinbase hourly candles (hold-the-trend plan section 4).
 * A running 4-hour bucket never changes the answer.
 */

import { aggregate } from "./breakout";
import type { Candle } from "./backtest";
import { emaNext } from "./features";
import { config } from "./config";

const HOUR_SEC = 3_600;
const FOUR_HOUR_SEC = 14_400;
const LOOKBACK_MS = 12 * 86_400_000;
const REFRESH_MINUTES_AFTER_HOUR = 3;

export interface TrendAnswer {
  known: boolean;
  up: boolean;
  lastClose: number | null;
  ema: number | null;
}

export function trendFromHourlies(hourlies: Candle[], emaBars: number, now = Date.now()): TrendAnswer {
  const completed = hourlies.filter((c) => c.close > 0 && c.ts + HOUR_SEC * 1000 <= now);
  const buckets = aggregate(completed, FOUR_HOUR_SEC);
  if (buckets.length < 7) return { known: false, up: false, lastClose: null, ema: null };
  let ema: number | null = null;
  for (const bar of buckets) ema = emaNext(ema, bar.close, emaBars);
  const last = buckets[buckets.length - 1]!;
  const ago = buckets[buckets.length - 7]!;
  if (!(ago.close > 0) || ema == null) return { known: false, up: false, lastClose: last.close, ema };
  const ret24 = (last.close - ago.close) / ago.close;
  return { known: true, up: last.close > ema && ret24 > 0, lastClose: last.close, ema };
}

export async function fetchHourlies(pair: string, now = Date.now(), fetchImpl: typeof fetch = fetch): Promise<Candle[]> {
  const fromMs = now - LOOKBACK_MS;
  const out = new Map<number, Candle>();
  const chunk = 299 * HOUR_SEC * 1000;
  for (let cursor = fromMs; cursor < now; cursor += chunk) {
    const end = Math.min(now, cursor + chunk);
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(pair)}/candles?granularity=${HOUR_SEC}&start=${Math.floor(cursor / 1000)}&end=${Math.floor(end / 1000)}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Coinbase hourly candles ${res.status}`);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error("Coinbase hourly candles returned an unexpected payload");
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 6) continue;
      const ts = Number(row[0]) * 1000;
      const low = Number(row[1]);
      const high = Number(row[2]);
      const open = Number(row[3]);
      const close = Number(row[4]);
      const volume = Number(row[5]);
      if (!Number.isFinite(ts) || !(close > 0)) continue;
      out.set(ts, { ts, open, high, low, close, volume });
    }
  }
  return [...out.values()].sort((a, b) => a.ts - b.ts);
}

export interface TrendLike {
  known(pair: string): boolean;
  trendUp(pair: string): boolean;
}

export class TrendBook implements TrendLike {
  private answers = new Map<string, TrendAnswer>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pairs: string[],
    private readonly emaBars = config.trendEmaBars,
    private readonly fetchHourliesFn: (pair: string, now?: number) => Promise<Candle[]> = fetchHourlies,
  ) {
    for (const pair of pairs) this.answers.set(pair, { known: false, up: false, lastClose: null, ema: null });
  }

  known(pair: string): boolean {
    return this.answers.get(pair)?.known === true;
  }

  trendUp(pair: string): boolean {
    return this.answers.get(pair)?.up === true;
  }

  async start(): Promise<void> {
    await this.refresh();
    const delay = msUntilRefresh(Date.now());
    this.timer = setTimeout(() => {
      void this.refresh();
      this.interval = setInterval(() => void this.refresh(), 3_600_000);
    }, delay);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    if (this.interval) clearInterval(this.interval);
    this.timer = null;
    this.interval = null;
  }

  async refresh(now = Date.now()): Promise<void> {
    await Promise.all(
      this.pairs.map(async (pair) => {
        try {
          const hourlies = await this.fetchHourliesFn(pair, now);
          this.answers.set(pair, trendFromHourlies(hourlies, this.emaBars, now));
        } catch (e) {
          console.error(`trend ${pair}:`, (e as Error).message);
          const prev = this.answers.get(pair);
          if (!prev?.known) this.answers.set(pair, { known: false, up: false, lastClose: null, ema: null });
        }
      }),
    );
  }
}

export function msUntilRefresh(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), REFRESH_MINUTES_AFTER_HOUR, 0, 0);
  if (next > now) return next - now;
  return next + 3_600_000 - now;
}
