/**
 * 4-hour bias gate. The math matches cb/trend.ts `trendFromFourHour`:
 * first-value EMA seed (not the TradingView SMA seed), at least 7 completed
 * buckets, close above the EMA, and a positive 24h return (6 buckets back).
 */

export interface BiasCandle {
  close: number;
}

export interface BiasAnswer {
  known: boolean;
  up: boolean;
  lastClose: number | null;
  ema: number | null;
}

/** Same recurrence as cb/features.ts emaNext, duplicated so the home-PC image does not import cb. */
export function biasEmaNext(prev: number | null, x: number, period: number): number {
  const k = 2 / (period + 1);
  return prev == null ? x : k * x + (1 - k) * prev;
}

export function biasFromFourHour(buckets: BiasCandle[], emaBars = 50): BiasAnswer {
  if (buckets.length < 7) return { known: false, up: false, lastClose: null, ema: null };
  let ema: number | null = null;
  for (const bar of buckets) ema = biasEmaNext(ema, bar.close, emaBars);
  const last = buckets[buckets.length - 1]!;
  const ago = buckets[buckets.length - 7]!;
  if (!(ago.close > 0) || ema == null) return { known: false, up: false, lastClose: last.close, ema };
  const ret24 = (last.close - ago.close) / ago.close;
  return { known: true, up: last.close > ema && ret24 > 0, lastClose: last.close, ema };
}
