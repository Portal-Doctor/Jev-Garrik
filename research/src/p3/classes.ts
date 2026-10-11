import { ema } from "../p2/indicators";

export interface DailyBar {
  date: string;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Class A at one daily close. L is 20 or 55. No signal before EMA200 exists unless the short-history fallback is allowed. */
export function classATrigger(bars: readonly DailyBar[], index: number, lookback: 20 | 55, shortHistoryFallback: boolean): boolean {
  const bar = bars[index];
  if (!bar || index < lookback) return false;
  const closes = bars.map((row) => row.close);
  const ema50 = ema(closes, 50);
  const ema200 = ema(closes, 200);
  const priorHigh = Math.max(...closes.slice(index - lookback, index));
  if (!(bar.close > priorHigh)) return false;
  const e50 = ema50[index];
  const e200 = ema200[index];
  if (e50 == null || !(bar.close > e50)) return false;
  if (e200 != null) return e50 > e200;
  if (!shortHistoryFallback || index < 60) return false;
  const earlier = ema50[index - 10];
  return earlier != null && e50 > earlier;
}

/** 28-day score skipping the last 3 days. Null until 31 closes exist. */
export function classBScore(closes: readonly number[], index: number): number | null {
  if (index < 31) return null;
  const recent = closes[index - 3];
  const base = closes[index - 31];
  if (recent == null || base == null || !(base > 0)) return null;
  return (recent - base) / base;
}
