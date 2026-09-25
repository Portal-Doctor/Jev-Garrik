/**
 * 4-hour Donchian breakout with a 3 ATR trailing stop.
 * Signals use only completed 4-hour buckets. Stops are checked on each 5-minute bar.
 */

import { emaNext, Welford } from "./features";
import { maxDrawdown } from "./metrics";
import { classifyDeterministic } from "./model";
import type { Candle, EquityPoint, Mark, SideSummary } from "./backtest";
import type { DecisionVector } from "./gate";
import type { MarketState } from "./state";

const FOUR_HOURS_MS = 14_400_000;

export interface BreakoutOpts {
  pair: string;
  windowStartTs: number;
  barSec: number;
  notionalUsd: number;
  bankrollUsd: number;
  makerFeeBps: number;
  takerFeeBps: number;
  stopLossBps: number;
  minSizeUsd: number;
  breakoutBars: number;
  trendEmaBars: number;
  atrBars: number;
  trailAtr: number;
  maxHoldSec: number;
  /** Completed-bar width. Default is 4 hours. */
  bucketSec?: number;
  /** Test hook. Production uses the deterministic classifier. */
  classify?: (state: MarketState) => { vector: DecisionVector };
}

export interface BreakoutSummary extends SideSummary {
  missedEntries: number;
  vetoedEntries: number;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  maxDrawdown: number | null;
  maxHoldHours: number;
  lowFeeNetUsd: number;
}

/** Completed buckets only. The last bucket is dropped because it may still be open. */
export function aggregate(candles: Candle[], bucketSec: number): Candle[] {
  const bucketMs = bucketSec * 1000;
  const ordered = candles.filter((c) => c.close > 0).slice().sort((a, b) => a.ts - b.ts);
  const groups = new Map<number, Candle>();
  for (const bar of ordered) {
    const key = Math.floor(bar.ts / bucketMs) * bucketMs;
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
  if (keys.length === 0) return [];
  keys.pop();
  return keys.map((k) => groups.get(k)!);
}

export function trueRange(high: number, low: number, prevClose: number | null): number {
  const span = Math.max(0, high - low);
  if (!(prevClose != null && prevClose > 0)) return span;
  return Math.max(span, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

/**
 * Wilder ATR step. The caller seeds `prevAtr` with the mean true range of the first `period` bars.
 * Before that seed exists, pass null and this returns the bar's true range.
 */
export function atrNext(prevAtr: number | null, bar: Candle, prevClose: number | null, period: number): number {
  const tr = trueRange(bar.high, bar.low, prevClose);
  if (!(period > 0) || prevAtr == null) return tr;
  return (prevAtr * (period - 1) + tr) / period;
}

/** Ratchet. A smaller ATR cannot pull the stop down. */
export function trailNext(trail: number | null, highestClose: number, atr: number, mult: number): number {
  const next = highestClose - mult * Math.max(0, atr);
  if (trail == null || !Number.isFinite(trail)) return next;
  return Math.max(trail, next);
}

function feeRate(bps: number): number {
  return Math.max(0, bps) / 10_000;
}

interface OpenPos {
  entry: number;
  fill: number;
  units: number;
  cost: number;
  openedTs: number;
  expiresAt: number;
  initialStop: number;
  trail: number;
  highestClose: number;
}

function emptySummary(): BreakoutSummary {
  return {
    returnUsd: 0,
    returnPct: 0,
    trades: 0,
    wins: 0,
    feesUsd: 0,
    buys: [],
    sells: [],
    equity: [],
    missedEntries: 0,
    vetoedEntries: 0,
    avgWinUsd: null,
    avgLossUsd: null,
    maxDrawdown: null,
    maxHoldHours: 0,
    lowFeeNetUsd: 0,
  };
}

function vetoed(vector: DecisionVector): boolean {
  return vector.toxic_flow_risk === "high" || vector.liquidity_stress === "stressed" || vector.market_regime === "contraction";
}

export function runBreakout(candles5m: Candle[], opts: BreakoutOpts): BreakoutSummary {
  const ordered = candles5m.filter((c) => c.close > 0 && c.high > 0 && c.low > 0).slice().sort((a, b) => a.ts - b.ts);
  if (ordered.length < 2) return emptySummary();

  const bucketMs = (opts.bucketSec ?? 14_400) * 1000;
  const classify = opts.classify ?? classifyDeterministic;
  const maker = feeRate(opts.makerFeeBps);
  const lowMaker = feeRate(10);
  const lowTaker = feeRate(10);

  let building: Candle | null = null;
  let buildingId: number | null = null;
  const completedHighs: number[] = [];
  let ema: number | null = null;
  let emaSamples = 0;
  let atr: number | null = null;
  let atrWarm = false;
  const atrSeed: number[] = [];
  let prev4hClose: number | null = null;

  const closes: number[] = [];
  const vol = new Welford();
  let prev5: number | null = null;
  let last5: Candle | null = null;

  let cash = opts.bankrollUsd;
  let pos: OpenPos | null = null;
  let pending: { price: number } | null = null;
  let fees = 0;
  let wins = 0;
  let trades = 0;
  let missedEntries = 0;
  let vetoedEntries = 0;
  let lowFeeNetUsd = 0;
  let maxHoldHours = 0;
  const winNets: number[] = [];
  const lossNets: number[] = [];
  const buys: Mark[] = [];
  const sells: Mark[] = [];
  const equity: EquityPoint[] = [];

  const stateAt = (bar: Candle, position: "long" | "flat"): MarketState => {
    const i = closes.length - 1;
    const ret = (barsBack: number) => {
      if (barsBack <= 0 || i < barsBack) return 0;
      const prev = closes[i - barsBack];
      const cur = closes[i];
      if (prev == null || cur == null || !(prev > 0)) return 0;
      return ((cur - prev) / prev) * 10_000;
    };
    const volBps = vol.n > 1 ? vol.stdev() * Math.sqrt(14_400) : 0;
    return {
      pair: opts.pair,
      ts: bar.ts,
      horizonSec: 14_400,
      mid: bar.close,
      spreadBps: 2,
      spreadEmaBps: 2,
      imbalance5: 0,
      imbalance20: 0,
      volBps,
      parkinsonBps: 0,
      emaGapBps: 0,
      emaCross: "flat",
      rsi: null,
      volumeDelta: 0,
      volumeGross: bar.volume,
      returnsBps: { m5: ret(1), m30: ret(6), h1: ret(12), h4: ret(48), h24: ret(288) },
      feeBps: { maker: opts.makerFeeBps, taker: opts.takerFeeBps },
      position,
    };
  };

  const settle = (px: number, ts: number, openedTs: number, liquidity: "taker") => {
    if (!pos) return;
    void liquidity;
    const exitFee = pos.units * px * feeRate(opts.takerFeeBps);
    const entryFee = pos.cost - pos.units * pos.fill;
    const gross = pos.units * (px - pos.fill);
    const net = gross - entryFee - exitFee;
    const lowExit = pos.units * px * lowTaker;
    const lowEntry = pos.units * pos.fill * lowMaker;
    lowFeeNetUsd += gross - lowEntry - lowExit;
    fees += exitFee;
    cash += pos.units * px - exitFee;
    if (pos.units * px - exitFee > pos.cost) {
      wins += 1;
      winNets.push(net);
    } else lossNets.push(net);
    trades += 1;
    maxHoldHours = Math.max(maxHoldHours, (ts - openedTs) / 3_600_000);
    sells.push({ ts, price: px });
    pos = null;
  };

  const onComplete = (bar4h: Candle, last5: Candle, tradable: boolean) => {
    const priorHighs = completedHighs.slice(-opts.breakoutBars);
    const priorHigh = priorHighs.length >= opts.breakoutBars ? Math.max(...priorHighs) : null;

    ema = emaNext(ema, bar4h.close, opts.trendEmaBars);
    emaSamples += 1;

    const tr = trueRange(bar4h.high, bar4h.low, prev4hClose);
    if (!atrWarm) {
      atrSeed.push(tr);
      if (atrSeed.length >= opts.atrBars) {
        atr = atrSeed.reduce((s, x) => s + x, 0) / opts.atrBars;
        atrWarm = true;
      }
    } else if (atr != null) {
      atr = atrNext(atr, bar4h, prev4hClose, opts.atrBars);
    }

    if (pos && atr != null) {
      pos.highestClose = Math.max(pos.highestClose, bar4h.close);
      pos.trail = trailNext(pos.trail, pos.highestClose, atr, opts.trailAtr);
    }

    const ready = priorHigh != null && emaSamples >= opts.trendEmaBars && atrWarm && atr != null && ema != null;
    if (tradable && !pos && !pending && ready && bar4h.close > priorHigh && bar4h.close > ema) {
      const vector = classify(stateAt(last5, "flat")).vector;
      if (vetoed(vector)) vetoedEntries += 1;
      else pending = { price: bar4h.close };
    }

    completedHighs.push(bar4h.high);
    prev4hClose = bar4h.close;
  };

  for (const bar of ordered) {
    const id = Math.floor(bar.ts / bucketMs) * bucketMs;
    if (building && buildingId != null && id !== buildingId && last5) {
      onComplete(building, last5, bar.ts >= opts.windowStartTs);
      building = null;
      buildingId = null;
    }
    if (!building) {
      building = { ts: id, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
      buildingId = id;
    } else {
      building.high = Math.max(building.high, bar.high);
      building.low = Math.min(building.low, bar.low);
      building.close = bar.close;
      building.volume += bar.volume;
    }

    closes.push(bar.close);
    if (prev5 != null && prev5 > 0) {
      const ret = ((bar.close - prev5) / prev5) * 10_000;
      vol.push(ret / Math.sqrt(Math.max(1, opts.barSec)));
    }
    prev5 = bar.close;
    last5 = bar;

    if (bar.ts < opts.windowStartTs) continue;

    if (pos) {
      const stop = Math.max(pos.initialStop, pos.trail);
      if (bar.low <= stop) settle(Math.min(stop, bar.open), bar.ts, pos.openedTs, "taker");
      else if (bar.ts >= pos.expiresAt) settle(bar.close, bar.ts, pos.openedTs, "taker");
    }

    if (pending && !pos) {
      if (bar.low <= pending.price) {
        const budget = cash / (1 + maker);
        const sizeUsd = Math.min(opts.notionalUsd, budget);
        if (sizeUsd >= opts.minSizeUsd && pending.price > 0) {
          const units = sizeUsd / pending.price;
          const cost = sizeUsd * (1 + maker);
          const entryFee = sizeUsd * maker;
          cash -= cost;
          fees += entryFee;
          const entry = cost / units;
          const seedTrail = atr != null ? pending.price - opts.trailAtr * atr : entry * (1 - opts.stopLossBps / 10_000);
          pos = {
            entry,
            fill: pending.price,
            units,
            cost,
            openedTs: bar.ts,
            expiresAt: bar.ts + opts.maxHoldSec * 1000,
            initialStop: entry * (1 - opts.stopLossBps / 10_000),
            trail: seedTrail,
            highestClose: pending.price,
          };
          buys.push({ ts: bar.ts, price: pending.price });
        }
      } else missedEntries += 1;
      pending = null;
    }

    equity.push({ ts: bar.ts, equity: cash + (pos ? pos.units * bar.close : 0) });
  }

  const last = equity.length ? equity[equity.length - 1]!.equity : opts.bankrollUsd;
  const returnUsd = last - opts.bankrollUsd;
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  return {
    returnUsd,
    returnPct: opts.bankrollUsd > 0 ? returnUsd / opts.bankrollUsd : 0,
    trades,
    wins,
    feesUsd: fees,
    buys,
    sells,
    equity,
    missedEntries,
    vetoedEntries,
    avgWinUsd: avg(winNets),
    avgLossUsd: avg(lossNets),
    maxDrawdown: maxDrawdown(equity.map((p) => p.equity)).maxDrawdown,
    maxHoldHours,
    lowFeeNetUsd,
  };
}

export const BREAKOUT_BUCKET_MS = FOUR_HOURS_MS;
