/**
 * Live 4-hour breakout snapshot used by the pooled book.
 * Only completed buckets count. Hourly refresh matches TrendBook.
 */

import { aggregate, atrNext, trailNext, trueRange } from "./breakout";
import type { Candle } from "./backtest";
import { emaNext } from "./features";
import { config } from "./config";
import { fetchHourlies } from "./trend";
import { rankOf } from "./pool";

const HOUR_SEC = 3_600;
const FOUR_HOUR_SEC = 14_400;
const REFRESH_MINUTES_AFTER_HOUR = 3;

export interface PoolPairSnap {
  known: boolean;
  candidate: boolean;
  rank: number;
  close: number | null;
  prior20High: number | null;
  ema: number | null;
  emaPrev: number | null;
  atr: number | null;
  trail: number | null;
}

interface OpenMark {
  fill: number;
  highestClose: number;
  trail: number;
}

export class PoolBook {
  private snaps = new Map<string, PoolPairSnap>();
  private opens = new Map<string, OpenMark>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly pairs: string[],
    private readonly knobs = {
      breakoutBars: config.breakoutBars,
      trendEmaBars: config.trendEmaBars,
      atrBars: config.atrBars,
      trailAtr: config.trailAtr,
    },
    private readonly fetchHourliesFn: (pair: string, now?: number) => Promise<Candle[]> = fetchHourlies,
  ) {
    for (const pair of pairs) this.snaps.set(pair, emptySnap());
  }

  snap(pair: string): PoolPairSnap {
    return this.snaps.get(pair) ?? emptySnap();
  }

  trailPrice(pair: string): number | null {
    return this.opens.get(pair)?.trail ?? this.snaps.get(pair)?.trail ?? null;
  }

  noteFill(pair: string, fill: number): void {
    const s = this.snap(pair);
    const atr = s.atr;
    const trail = atr != null ? fill - this.knobs.trailAtr * atr : fill;
    this.opens.set(pair, { fill, highestClose: fill, trail });
  }

  noteFlat(pair: string): void {
    this.opens.delete(pair);
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
          const completed = hourlies.filter((c) => c.close > 0 && c.ts + HOUR_SEC * 1000 <= now);
          this.snaps.set(pair, snapFromFourHour(aggregate(completed, FOUR_HOUR_SEC), this.knobs, this.opens.get(pair)));
          const open = this.opens.get(pair);
          const s = this.snaps.get(pair);
          if (open && s?.atr != null && s.close != null) {
            open.highestClose = Math.max(open.highestClose, s.close);
            open.trail = trailNext(open.trail, open.highestClose, s.atr, this.knobs.trailAtr);
          }
        } catch (e) {
          console.error(`poolbook ${pair}:`, (e as Error).message);
        }
      }),
    );
  }
}

function emptySnap(): PoolPairSnap {
  return {
    known: false,
    candidate: false,
    rank: Number.NEGATIVE_INFINITY,
    close: null,
    prior20High: null,
    ema: null,
    emaPrev: null,
    atr: null,
    trail: null,
  };
}

export function snapFromFourHour(
  buckets: Candle[],
  knobs: { breakoutBars: number; trendEmaBars: number; atrBars: number; trailAtr: number },
  open?: OpenMark,
): PoolPairSnap {
  if (buckets.length < knobs.trendEmaBars) return emptySnap();
  let ema: number | null = null;
  let emaPrev: number | null = null;
  let atr: number | null = null;
  const atrSeed: number[] = [];
  let prevClose: number | null = null;
  let atrWarm = false;
  for (const bar of buckets) {
    emaPrev = ema;
    ema = emaNext(ema, bar.close, knobs.trendEmaBars);
    const tr = trueRange(bar.high, bar.low, prevClose);
    if (!atrWarm) {
      atrSeed.push(tr);
      if (atrSeed.length >= knobs.atrBars) {
        atr = atrSeed.reduce((s, x) => s + x, 0) / knobs.atrBars;
        atrWarm = true;
      }
    } else if (atr != null) {
      atr = atrNext(atr, bar, prevClose, knobs.atrBars);
    }
    prevClose = bar.close;
  }
  const last = buckets[buckets.length - 1]!;
  const prior = buckets.slice(-knobs.breakoutBars - 1, -1);
  const prior20High = prior.length >= knobs.breakoutBars ? Math.max(...prior.map((b) => b.high)) : null;
  const known = atrWarm && ema != null && emaPrev != null && prior20High != null;
  const candidate = known && last.close > prior20High! && last.close > ema!;
  const rank = known
    ? rankOf({
        atr: atr!,
        close: last.close,
        prior20High: prior20High!,
        ema: ema!,
        emaPrev: emaPrev!,
        fill: open?.fill,
        highestCloseSinceEntry: open?.highestClose,
      }).rank
    : Number.NEGATIVE_INFINITY;
  const trail = open && atr != null ? trailNext(open.trail, Math.max(open.highestClose, last.close), atr, knobs.trailAtr) : null;
  return { known, candidate, rank, close: last.close, prior20High, ema, emaPrev, atr, trail };
}

export function msUntilRefresh(now: number): number {
  const d = new Date(now);
  const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), REFRESH_MINUTES_AFTER_HOUR, 0, 0);
  if (next > now) return next - now;
  return next + 3_600_000 - now;
}
