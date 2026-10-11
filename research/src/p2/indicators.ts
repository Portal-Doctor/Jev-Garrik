/** Wilder ATR, EMA, and a prior-window z-score. No forward values. */

export function ema(values: readonly number[], length: number): (number | null)[] {
  const out: (number | null)[] = [];
  if (length < 1) throw new Error("EMA length must be positive");
  const k = 2 / (length + 1);
  let prev: number | null = null;
  let seed = 0;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i]!;
    if (i < length) {
      seed += value;
      if (i === length - 1) {
        prev = seed / length;
        out.push(prev);
      } else out.push(null);
      continue;
    }
    prev = value * k + prev! * (1 - k);
    out.push(prev);
  }
  return out;
}

export function wilderAtr(high: readonly number[], low: readonly number[], close: readonly number[], length = 14): (number | null)[] {
  if (high.length !== low.length || high.length !== close.length) throw new Error("ATR inputs differ in length");
  const out: (number | null)[] = [];
  let prev: number | null = null;
  let seed = 0;
  for (let i = 0; i < close.length; i += 1) {
    const tr = i === 0 ? high[i]! - low[i]! : Math.max(high[i]! - low[i]!, Math.abs(high[i]! - close[i - 1]!), Math.abs(low[i]! - close[i - 1]!));
    if (i < length) {
      seed += tr;
      if (i === length - 1) {
        prev = seed / length;
        out.push(prev);
      } else out.push(null);
      continue;
    }
    prev = (prev! * (length - 1) + tr) / length;
    out.push(prev);
  }
  return out;
}

/** Z-score of `value` versus the prior `length` observations, excluding value itself. */
export function priorZ(history: readonly number[], value: number, length: number): number | null {
  if (history.length < length) return null;
  const window = history.slice(history.length - length);
  const mean = window.reduce((sum, item) => sum + item, 0) / length;
  const variance = window.reduce((sum, item) => sum + (item - mean) ** 2, 0) / length;
  const sd = Math.sqrt(variance);
  if (!(sd > 0)) return null;
  return (value - mean) / sd;
}
