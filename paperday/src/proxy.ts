/**
 * Market-proxy sentiment for backtests. This is not an X read and it is not Jev.
 * Veto (no longs on that pair for the rest of the UTC day) if the 24h return
 * z-score versus the prior 30 daily returns is <= -2, or the 1h bar's range is
 * > 3× its ATR and its volume is > 3× the prior 20-bar average and the close
 * is in the bottom third, or BTC-USD is below its 4h EMA50 with a negative 24h return.
 * Caution (setup A only, one idea on that pair) if z >= +2.5 and 1h relative volume > 3×.
 * Funding and open interest are skipped: no public series is loaded.
 */

import { aggregate, type Candle } from "./bars";
import { biasEmaNext } from "./bias";
import { atrSeries } from "./indicators";

const H1 = 3_600_000;
const H4 = 14_400_000;
const D1 = 86_400_000;

export interface ProxyMark {
  ts: number;
  veto: boolean;
  caution: boolean;
}

export interface ClauseShare {
  pairDays: number;
  vetoPairDays: number;
  zScorePairDays: number;
  crashPairDays: number;
  btcPairDays: number;
}

export interface ProxyBook {
  byPair: Record<string, ProxyMark[]>;
  /** Pair-days, not bars. A clause counts when it fires on any hour of that UTC day. */
  clauses: ClauseShare;
}

export function emptyClauses(): ClauseShare {
  return { pairDays: 0, vetoPairDays: 0, zScorePairDays: 0, crashPairDays: 0, btcPairDays: 0 };
}

/** Trader flag. No rule change. About 40% of pair-days. */
export function btcClauseFlag(clauses: ClauseShare): boolean {
  if (!(clauses.pairDays > 0)) return false;
  return clauses.btcPairDays / clauses.pairDays > 0.4;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function meanStd(xs: number[]): { mean: number; std: number } | null {
  if (xs.length < 30) return null;
  const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
  let v = 0;
  for (const x of xs) v += (x - mean) * (x - mean);
  const std = Math.sqrt(v / xs.length);
  if (!(std > 0)) return null;
  return { mean, std };
}

function lastIndexClosed(bars: Candle[], tf: number, atMs: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.ts + tf <= atMs) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** BTC clause. EMA uses the first-value seed and does not fire until 50 completed 4h bars exist. */
export function btcVetoAt(btc4h: Candle[], atMs: number): boolean {
  const i = lastIndexClosed(btc4h, H4, atMs);
  if (i < 50) return false;
  let ema: number | null = null;
  for (let k = 0; k <= i; k++) ema = biasEmaNext(ema, btc4h[k]!.close, 50);
  const last = btc4h[i]!;
  const ago = btc4h[i - 6];
  if (ema == null || ago == null || !(ago.close > 0)) return false;
  const ret = (last.close - ago.close) / ago.close;
  return last.close < ema && ret < 0;
}

function priorVolAvg(bars: Candle[], index: number): number | null {
  if (index < 20) return null;
  let s = 0;
  for (let k = index - 20; k < index; k++) s += bars[k]!.volume;
  const avg = s / 20;
  return avg > 0 ? avg : null;
}

function btcVetoTimeline(btc4h: Candle[]): boolean[] {
  const out: boolean[] = [];
  let ema: number | null = null;
  for (let i = 0; i < btc4h.length; i++) {
    ema = biasEmaNext(ema, btc4h[i]!.close, 50);
    const ago = i >= 6 ? btc4h[i - 6] : undefined;
    out.push(i >= 50 && ema != null && ago != null && ago.close > 0 && btc4h[i]!.close < ema && btc4h[i]!.close < ago.close);
  }
  return out;
}

export function buildMarketProxy(pairCandles: Record<string, Candle[]>, btc: Candle[], toMs: number): ProxyBook {
  const btc4h = aggregate(btc.filter((c) => c.ts < toMs), H4, toMs);
  const btcVeto = btcVetoTimeline(btc4h);
  const btcVetoNow = (atMs: number): boolean => {
    const i = lastIndexClosed(btc4h, H4, atMs);
    return i >= 0 && btcVeto[i] === true;
  };
  const byPair: Record<string, ProxyMark[]> = {};
  const clauses = emptyClauses();
  for (const [pair, raw] of Object.entries(pairCandles)) {
    const m1 = raw.filter((c) => c.ts < toMs && c.close > 0);
    const h1 = aggregate(m1, H1, toMs);
    const d1 = aggregate(m1, D1, toMs);
    const atr = atrSeries(h1, 14);
    const dailyRet: number[] = [];
    for (let i = 1; i < d1.length; i++) {
      const prev = d1[i - 1]!.close;
      dailyRet.push(prev > 0 ? d1[i]!.close / prev - 1 : 0);
    }
    const marks: ProxyMark[] = [];
    let day = "";
    let dayVeto = false;
    let dayCaution = false;
    let dayZ = false;
    let dayCrash = false;
    let dayBtc = false;
    const flushDay = () => {
      if (!day) return;
      clauses.pairDays += 1;
      if (dayVeto) clauses.vetoPairDays += 1;
      if (dayZ) clauses.zScorePairDays += 1;
      if (dayCrash) clauses.crashPairDays += 1;
      if (dayBtc) clauses.btcPairDays += 1;
    };
    for (let i = 0; i < h1.length; i++) {
      const closeTs = h1[i]!.ts + H1;
      const d = utcDay(closeTs);
      if (d !== day) {
        flushDay();
        day = d;
        dayVeto = false;
        dayCaution = false;
        dayZ = false;
        dayCrash = false;
        dayBtc = false;
      }
      const bar = h1[i]!;
      const shockAtr = i > 0 ? atr[i - 1] : null;
      const volAvg = priorVolAvg(h1, i);
      const range = bar.high - bar.low;
      const bottomThird = range > 0 && bar.close <= bar.low + range / 3;
      const shock =
        shockAtr != null &&
        shockAtr > 0 &&
        volAvg != null &&
        range > 3 * shockAtr &&
        bar.volume > 3 * volAvg &&
        bottomThird;
      let z: number | null = null;
      if (i >= 24) {
        const ago = h1[i - 24]!.close;
        if (ago > 0) {
          const r24 = bar.close / ago - 1;
          const dClosed = lastIndexClosed(d1, D1, closeTs);
          const retEnd = dClosed;
          const retStart = Math.max(0, retEnd - 30);
          const window = dailyRet.slice(retStart, retEnd);
          const stats = meanStd(window);
          if (stats) z = (r24 - stats.mean) / stats.std;
        }
      }
      const relVol = volAvg != null && bar.volume > 3 * volAvg;
      const zHit = z != null && z <= -2;
      const btcHit = btcVetoNow(closeTs);
      if (zHit) dayZ = true;
      if (shock) dayCrash = true;
      if (btcHit) dayBtc = true;
      if (shock || zHit || btcHit) dayVeto = true;
      if (!dayVeto && z != null && z >= 2.5 && relVol) dayCaution = true;
      marks.push({ ts: closeTs, veto: dayVeto, caution: dayCaution && !dayVeto });
    }
    flushDay();
    byPair[pair] = marks;
  }
  return { byPair, clauses };
}

export function proxyAt(book: ProxyBook, pair: string, ts: number): { veto: boolean; caution: boolean } {
  const marks = book.byPair[pair];
  if (!marks || marks.length === 0) return { veto: false, caution: false };
  let lo = 0;
  let hi = marks.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid]!.ts <= ts) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (ans < 0) return { veto: false, caution: false };
  return { veto: marks[ans]!.veto, caution: marks[ans]!.caution };
}
