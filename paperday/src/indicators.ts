/**
 * TradingView-default indicator math.
 * EMA is SMA-seeded. RSI and ATR use Wilder's smoothing.
 * Session VWAP uses hlc3 and resets on the America/Chicago calendar day.
 * The 4-hour bias gate does not use these EMAs; it matches cb/trend.ts.
 */

import { ctDayKey } from "./clock";

export interface Ohlcv {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface IndicatorPoint {
  ts: number;
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  vwap: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  atr14: number | null;
  volSma20: number | null;
  donchian20PriorHigh: number | null;
}

export function trueRange(high: number, low: number, prevClose: number | null): number {
  const span = Math.max(0, high - low);
  if (prevClose == null || !(prevClose > 0)) return span;
  return Math.max(span, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

export function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** SMA-seeded EMA. Index period-1 is the first value. Earlier slots are null. */
export function emaSeries(values: number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let ema = sum / period;
  out[period - 1] = ema;
  const k = 2 / (period + 1);
  for (let i = period; i < values.length; i++) {
    ema = values[i]! * k + ema * (1 - k);
    out[i] = ema;
  }
  return out;
}

export function rsiSeries(closes: number[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgG = gain / period;
  let avgL = loss / period;
  out[period] = rsiFrom(avgG, avgL);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    const g = ch > 0 ? ch : 0;
    const l = ch < 0 ? -ch : 0;
    avgG = (avgG * (period - 1) + g) / period;
    avgL = (avgL * (period - 1) + l) / period;
    out[i] = rsiFrom(avgG, avgL);
  }
  return out;
}

export function atrSeries(bars: Ohlcv[], period = 14): Array<number | null> {
  const out: Array<number | null> = new Array(bars.length).fill(null);
  if (bars.length < period) return out;
  const trs = bars.map((b, i) => trueRange(b.high, b.low, i > 0 ? bars[i - 1]!.close : null));
  let atr = 0;
  for (let i = 0; i < period; i++) atr += trs[i]!;
  atr /= period;
  out[period - 1] = atr;
  for (let i = period; i < bars.length; i++) {
    atr = (atr * (period - 1) + trs[i]!) / period;
    out[i] = atr;
  }
  return out;
}

export function macdSeries(closes: number[], fast = 12, slow = 26, signal = 9): {
  macd: Array<number | null>;
  signal: Array<number | null>;
  hist: Array<number | null>;
} {
  const emaFast = emaSeries(closes, fast);
  const emaSlow = emaSeries(closes, slow);
  const macd: Array<number | null> = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? emaFast[i]! - emaSlow[i]! : null,
  );
  const compact: number[] = [];
  const index: number[] = [];
  for (let i = 0; i < macd.length; i++) {
    if (macd[i] != null) {
      compact.push(macd[i]!);
      index.push(i);
    }
  }
  const sigCompact = emaSeries(compact, signal);
  const sig: Array<number | null> = new Array(closes.length).fill(null);
  const hist: Array<number | null> = new Array(closes.length).fill(null);
  for (let j = 0; j < index.length; j++) {
    const i = index[j]!;
    sig[i] = sigCompact[j] ?? null;
    if (sig[i] != null && macd[i] != null) hist[i] = macd[i]! - sig[i]!;
  }
  return { macd, signal: sig, hist };
}

export function smaLast(values: number[], end: number, period: number): number | null {
  if (end < period - 1) return null;
  let s = 0;
  for (let i = end - period + 1; i <= end; i++) s += values[i]!;
  return s / period;
}

/** Prior `period` highs, excluding the bar at `index`. */
export function donchianPriorHigh(bars: Ohlcv[], index: number, period = 20): number | null {
  if (index < period) return null;
  let m = -Infinity;
  for (let i = index - period; i < index; i++) m = Math.max(m, bars[i]!.high);
  return m;
}

/** Confirmed swing low at `index` once the next bar exists: low[index] < low[index-1] and low[index] < low[index+1]. */
export function confirmedSwingLow(bars: Ohlcv[], index: number): number | null {
  if (index < 1 || index + 1 >= bars.length) return null;
  const low = bars[index]!.low;
  if (low < bars[index - 1]!.low && low < bars[index + 1]!.low) return low;
  return null;
}

/** Most recent swing low confirmed at or before `index` (the confirming bar is index itself, so the swing bar is index-1). */
export function latestSwingLow(bars: Ohlcv[], index: number): number | null {
  for (let swing = index - 1; swing >= 1; swing--) {
    const low = confirmedSwingLow(bars, swing);
    if (low != null) return low;
  }
  return null;
}

export function sessionVwapSeries(bars: Ohlcv[]): Array<number | null> {
  const out: Array<number | null> = new Array(bars.length).fill(null);
  let day = "";
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const d = ctDayKey(b.ts);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    const hlc3 = (b.high + b.low + b.close) / 3;
    const v = Math.max(0, b.volume);
    pv += hlc3 * v;
    vol += v;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

export function indicatorSeries(bars: Ohlcv[]): IndicatorPoint[] {
  const closes = bars.map((b) => b.close);
  const volumes = bars.map((b) => b.volume);
  const ema9 = emaSeries(closes, 9);
  const ema20 = emaSeries(closes, 20);
  const ema50 = emaSeries(closes, 50);
  const ema200 = emaSeries(closes, 200);
  const rsi = rsiSeries(closes, 14);
  const macd = macdSeries(closes);
  const atr = atrSeries(bars, 14);
  const vwap = sessionVwapSeries(bars);
  return bars.map((b, i) => ({
    ts: b.ts,
    ema9: ema9[i] ?? null,
    ema20: ema20[i] ?? null,
    ema50: ema50[i] ?? null,
    ema200: ema200[i] ?? null,
    vwap: vwap[i] ?? null,
    rsi14: rsi[i] ?? null,
    macd: macd.macd[i] ?? null,
    macdSignal: macd.signal[i] ?? null,
    macdHist: macd.hist[i] ?? null,
    atr14: atr[i] ?? null,
    volSma20: smaLast(volumes, i, 20),
    donchian20PriorHigh: donchianPriorHigh(bars, i, 20),
  }));
}

/** Incremental EMA matching emaSeries, for callers that stream one bar at a time. */
export class EmaState {
  private n = 0;
  private sum = 0;
  private ema: number | null = null;
  constructor(private readonly period: number) {}

  push(x: number): number | null {
    this.n += 1;
    if (this.n < this.period) {
      this.sum += x;
      return null;
    }
    if (this.n === this.period) {
      this.sum += x;
      this.ema = this.sum / this.period;
      return this.ema;
    }
    const k = 2 / (this.period + 1);
    this.ema = x * k + this.ema! * (1 - k);
    return this.ema;
  }

  value(): number | null {
    return this.ema;
  }
}
