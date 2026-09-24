/**
 * Tick accumulator for the Coinbase paper book. Updated on each book or trade event.
 * Recurrences run on wall time.
 */

export const RSI_PERIOD = 14;
export const EMA_FAST = 8;
export const EMA_SLOW = 21;
export const SPREAD_EMA = 8;
/** Signed taker volume kept for the model, in 1 second buckets. */
export const VOLUME_WINDOW_SEC = 900;

export function levelImbalance(bidQty: number, askQty: number): number {
  const t = bidQty + askQty;
  return t > 0 ? (bidQty - askQty) / t : 0;
}

/** Sum the first `n` levels (best first) and return (bid - ask) / (bid + ask). */
export function topImbalance(bids: Array<[number, number]>, asks: Array<[number, number]>, n: number): number {
  let bid = 0;
  let ask = 0;
  const bn = Math.min(n, bids.length);
  const an = Math.min(n, asks.length);
  for (let i = 0; i < bn; i++) bid += bids[i]![1];
  for (let i = 0; i < an; i++) ask += asks[i]![1];
  return levelImbalance(bid, ask);
}

/** USD resting on the first `n` levels of the side we join. Buy joins bids, sell joins asks. */
export function depthUsd(
  book: { bidsDesc(): Array<[number, number]>; asksAsc(): Array<[number, number]> },
  side: "buy" | "sell",
  levels = 3,
): number {
  const rows = side === "buy" ? book.bidsDesc() : book.asksAsc();
  let usd = 0;
  const n = Math.min(levels, rows.length);
  for (let i = 0; i < n; i++) usd += rows[i]![0] * rows[i]![1];
  return usd;
}

/** Wilder RSI. `prevClose` is the prior close; gains and losses seed over `period` samples. */
export function rsiNext(
  prevClose: number,
  close: number,
  avgGain: number,
  avgLoss: number,
  samples: number,
  period: number,
): { rsi: number | null; avgGain: number; avgLoss: number; samples: number } {
  const ch = close - prevClose;
  const gain = ch > 0 ? ch : 0;
  const loss = ch < 0 ? -ch : 0;
  const n = samples + 1;
  if (n < period) {
    return { rsi: null, avgGain: avgGain + gain, avgLoss: avgLoss + loss, samples: n };
  }
  if (n === period) {
    const g = (avgGain + gain) / period;
    const l = (avgLoss + loss) / period;
    return { rsi: rsiFrom(g, l), avgGain: g, avgLoss: l, samples: n };
  }
  const g = (avgGain * (period - 1) + gain) / period;
  const l = (avgLoss * (period - 1) + loss) / period;
  return { rsi: rsiFrom(g, l), avgGain: g, avgLoss: l, samples: n };
}

export function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function emaNext(prev: number | null, x: number, period: number): number {
  const k = 2 / (period + 1);
  return prev == null ? x : k * x + (1 - k) * prev;
}

/** Online mean and sample variance (Welford). */
export class Welford {
  n = 0;
  mean = 0;
  private m2 = 0;

  push(x: number): void {
    this.n += 1;
    const d = x - this.mean;
    this.mean += d / this.n;
    this.m2 += d * (x - this.mean);
  }

  variance(): number {
    return this.n > 1 ? this.m2 / (this.n - 1) : 0;
  }

  stdev(): number {
    return Math.sqrt(this.variance());
  }
}

/**
 * Parkinson high-low vol, in bps, scaled from 1 minute candles to `horizonSec`.
 * `sumLogHl2` is the sum of ln(high/low)^2 over `n` closed candles.
 */
export function parkinsonVolBps(sumLogHl2: number, n: number, horizonSec: number): number {
  if (n < 1 || !(horizonSec > 0) || !(sumLogHl2 >= 0)) return 0;
  const perMin = Math.sqrt(sumLogHl2 / (4 * n * Math.LN2));
  return perMin * Math.sqrt(horizonSec / 60) * 10_000;
}

export interface BookView {
  bidsDesc(): Array<[number, number]>;
  asksAsc(): Array<[number, number]>;
  mid(): number | null;
  spreadBps(): number | null;
}

export interface FeatureSnapshot {
  imbalance5: number;
  imbalance20: number;
  spreadBps: number;
  spreadEmaBps: number;
  /** Welford stdev of 1 second mid returns, scaled to the traded horizon, in bps. */
  volBps: number;
  parkinsonBps: number;
  emaFast: number | null;
  emaSlow: number | null;
  emaCross: "above" | "below" | "flat";
  emaGapBps: number;
  rsi: number | null;
  volumeDelta: number;
  volumeGross: number;
}

export function emptySnapshot(): FeatureSnapshot {
  return {
    imbalance5: 0,
    imbalance20: 0,
    spreadBps: 0,
    spreadEmaBps: 0,
    volBps: 0,
    parkinsonBps: 0,
    emaFast: null,
    emaSlow: null,
    emaCross: "flat",
    emaGapBps: 0,
    rsi: null,
    volumeDelta: 0,
    volumeGross: 0,
  };
}

/**
 * O(1) book and trade updates. Imbalance and spread move on every book event.
 * Realized vol samples once per second. EMA, RSI, and Parkinson close on the minute.
 */
export class FeatureAccumulator {
  private imb5 = 0;
  private imb20 = 0;
  private spreadBps = 0;
  private spreadEma: number | null = null;
  private readonly welford = new Welford();
  private secTs: number | null = null;
  private secMid: number | null = null;
  private minute: number | null = null;
  private candleHigh = 0;
  private candleLow = 0;
  private candleClose = 0;
  private parkSum = 0;
  private parkN = 0;
  private emaFast: number | null = null;
  private emaSlow: number | null = null;
  private prevClose: number | null = null;
  private avgGain = 0;
  private avgLoss = 0;
  private rsiSamples = 0;
  private rsi: number | null = null;
  private readonly volBuy = new Float64Array(VOLUME_WINDOW_SEC);
  private readonly volSell = new Float64Array(VOLUME_WINDOW_SEC);
  private volSec = -1;
  private buySum = 0;
  private sellSum = 0;

  onBook(now: number, book: BookView): void {
    this.imb5 = topImbalance(book.bidsDesc(), book.asksAsc(), 5);
    this.imb20 = topImbalance(book.bidsDesc(), book.asksAsc(), 20);
    this.spreadBps = book.spreadBps() ?? 0;
    const mid = book.mid();
    if (mid == null || !(mid > 0)) return;
    this.noteMinute(now, mid);
    this.noteSecond(now, mid);
  }

  onTrade(ts: number, size: number, takerSide: "buy" | "sell"): void {
    if (!(size > 0) || !Number.isFinite(ts)) return;
    const sec = Math.floor(ts / 1000);
    this.rollVol(sec);
    const i = ((sec % VOLUME_WINDOW_SEC) + VOLUME_WINDOW_SEC) % VOLUME_WINDOW_SEC;
    if (takerSide === "buy") {
      this.volBuy[i] = (this.volBuy[i] ?? 0) + size;
      this.buySum += size;
    } else {
      this.volSell[i] = (this.volSell[i] ?? 0) + size;
      this.sellSum += size;
    }
  }

  snapshot(horizonSec: number): FeatureSnapshot {
    const volBps = this.welford.n > 1 ? this.welford.stdev() * Math.sqrt(Math.max(0, horizonSec)) : 0;
    const fast = this.emaFast;
    const slow = this.emaSlow;
    let emaCross: FeatureSnapshot["emaCross"] = "flat";
    let emaGapBps = 0;
    if (fast != null && slow != null && slow > 0) {
      emaGapBps = ((fast - slow) / slow) * 10_000;
      emaCross = fast > slow ? "above" : fast < slow ? "below" : "flat";
    }
    return {
      imbalance5: this.imb5,
      imbalance20: this.imb20,
      spreadBps: this.spreadBps,
      spreadEmaBps: this.spreadEma ?? this.spreadBps,
      volBps,
      parkinsonBps: parkinsonVolBps(this.parkSum, this.parkN, horizonSec),
      emaFast: fast,
      emaSlow: slow,
      emaCross,
      emaGapBps,
      rsi: this.rsi,
      volumeDelta: this.buySum - this.sellSum,
      volumeGross: this.buySum + this.sellSum,
    };
  }

  private noteSecond(now: number, mid: number): void {
    if (this.secTs == null || this.secMid == null) {
      this.secTs = now;
      this.secMid = mid;
      return;
    }
    const dtMs = now - this.secTs;
    if (dtMs < 1000) return;
    const steps = dtMs / 1000;
    const retBps = this.secMid > 0 ? ((mid - this.secMid) / this.secMid) * 10_000 : 0;
    this.welford.push(retBps / Math.sqrt(steps));
    this.secTs = now;
    this.secMid = mid;
  }

  private noteMinute(now: number, mid: number): void {
    const minute = Math.floor(now / 60_000);
    if (this.minute == null) {
      this.minute = minute;
      this.candleHigh = mid;
      this.candleLow = mid;
      this.candleClose = mid;
      return;
    }
    if (minute !== this.minute) {
      this.finishMinute(this.candleClose);
      this.minute = minute;
      this.candleHigh = mid;
      this.candleLow = mid;
      this.candleClose = mid;
      return;
    }
    if (mid > this.candleHigh) this.candleHigh = mid;
    if (mid < this.candleLow) this.candleLow = mid;
    this.candleClose = mid;
  }

  private finishMinute(close: number): void {
    if (this.candleHigh > 0 && this.candleLow > 0 && this.candleHigh >= this.candleLow) {
      const x = Math.log(this.candleHigh / this.candleLow);
      if (Number.isFinite(x)) {
        this.parkSum += x * x;
        this.parkN += 1;
      }
    }
    this.emaFast = emaNext(this.emaFast, close, EMA_FAST);
    this.emaSlow = emaNext(this.emaSlow, close, EMA_SLOW);
    this.spreadEma = emaNext(this.spreadEma, this.spreadBps, SPREAD_EMA);
    if (this.prevClose != null) {
      const next = rsiNext(this.prevClose, close, this.avgGain, this.avgLoss, this.rsiSamples, RSI_PERIOD);
      this.rsi = next.rsi;
      this.avgGain = next.avgGain;
      this.avgLoss = next.avgLoss;
      this.rsiSamples = next.samples;
    }
    this.prevClose = close;
  }

  private rollVol(sec: number): void {
    if (this.volSec < 0) {
      this.volSec = sec;
      return;
    }
    const gap = sec - this.volSec;
    if (gap <= 0) return;
    if (gap >= VOLUME_WINDOW_SEC) {
      this.volBuy.fill(0);
      this.volSell.fill(0);
      this.buySum = 0;
      this.sellSum = 0;
    } else {
      for (let k = 1; k <= gap; k++) {
        const i = (this.volSec + k) % VOLUME_WINDOW_SEC;
        this.buySum -= this.volBuy[i] ?? 0;
        this.sellSum -= this.volSell[i] ?? 0;
        this.volBuy[i] = 0;
        this.volSell[i] = 0;
      }
      if (this.buySum < 1e-12) this.buySum = 0;
      if (this.sellSum < 1e-12) this.sellSum = 0;
    }
    this.volSec = sec;
  }
}
