/**
 * One $12,000 ledger over many pairs. Same 4-hour breakout fill rules as runBreakout.
 * A flatten returns cash on this bar; a rotation entry waits for the next 5-minute bar.
 */

import type { Candle, ClosedTrade, EquityPoint } from "./backtest";
import { atrNext, trailNext, trueRange } from "./breakout";
import { emaNext, Welford } from "./features";
import { maxDrawdown } from "./metrics";
import { classifyDeterministic } from "./model";
import { compareRank, planRotation, rankOf, type RotationName } from "./pool";
import type { MarketState } from "./state";

const FOUR_HOURS_MS = 14_400_000;

export interface PoolPairOpts {
  pair: string;
  candles: Candle[];
  notionalUsd: number;
  stopLossBps: number;
}

export interface PoolBacktestOpts {
  windowStartTs: number;
  windowEndTs: number;
  bankrollUsd: number;
  makerFeeBps: number;
  takerFeeBps: number;
  minSizeUsd: number;
  maxGrossUsd: number;
  maxConcurrent: number;
  breakoutBars: number;
  trendEmaBars: number;
  atrBars: number;
  trailAtr: number;
  maxHoldSec: number;
  poolDd: number;
  pairs: PoolPairOpts[];
  classify?: (state: MarketState) => { vector: { liquidity_stress: string; market_regime: string } };
}

export interface PoolBacktestResult {
  returnUsd: number;
  trades: number;
  wins: number;
  feesUsd: number;
  missedEntries: number;
  vetoedEntries: number;
  rotations: number;
  maxDrawdown: number | null;
  tradeLog: ClosedTrade[];
  equity: EquityPoint[];
  halted: boolean;
}

interface OpenPos {
  pair: string;
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

interface PairMem {
  pair: string;
  notionalUsd: number;
  stopLossBps: number;
  byTs: Map<number, Candle>;
  building: Candle | null;
  buildingId: number | null;
  completedHighs: number[];
  ema: number | null;
  emaPrev: number | null;
  emaSamples: number;
  atr: number | null;
  atrWarm: boolean;
  atrSeed: number[];
  prev4hClose: number | null;
  last4h: Candle | null;
  lastPriorHigh: number | null;
  closes: number[];
  vol: Welford;
  prev5: number | null;
  last5: Candle | null;
  pending: { price: number } | null;
  queued: { price: number } | null;
  lastCandidate: boolean;
  lastRank: number;
}

function feeRate(bps: number): number {
  return Math.max(0, bps) / 10_000;
}

let classifyHook: PoolBacktestOpts["classify"];

function vetoed(pair: PairMem): boolean {
  if (!pair.last5) return true;
  const vector = (classifyHook ?? classifyDeterministic)(stateAt(pair, pair.last5)).vector;
  return vector.liquidity_stress === "stressed" || vector.market_regime === "contraction";
}

function stateAt(pair: PairMem, bar: Candle): MarketState {
  const i = pair.closes.length - 1;
  const ret = (barsBack: number) => {
    if (barsBack <= 0 || i < barsBack) return 0;
    const prev = pair.closes[i - barsBack];
    const cur = pair.closes[i];
    if (prev == null || cur == null || !(prev > 0)) return 0;
    return ((cur - prev) / prev) * 10_000;
  };
  const volBps = pair.vol.n > 1 ? pair.vol.stdev() * Math.sqrt(14_400) : 0;
  return {
    pair: pair.pair,
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
    feeBps: { maker: 40, taker: 80 },
    position: "flat",
  };
}

function ready(pair: PairMem, bars: number, emaBars: number): boolean {
  return (
    pair.lastPriorHigh != null &&
    pair.ema != null &&
    pair.emaPrev != null &&
    pair.emaSamples >= emaBars &&
    pair.atrWarm &&
    pair.atr != null &&
    pair.last4h != null &&
    pair.completedHighs.length >= bars
  );
}

function isCandidate(pair: PairMem, bars: number, emaBars: number): boolean {
  if (!ready(pair, bars, emaBars) || !pair.last4h || pair.ema == null || pair.lastPriorHigh == null) return false;
  if (!(pair.last4h.close > pair.lastPriorHigh && pair.last4h.close > pair.ema)) return false;
  if (vetoed(pair)) return false;
  return true;
}

function pairRank(pair: PairMem, pos: OpenPos | null, bar: Candle | null): number {
  if (!pair.last4h || pair.atr == null || pair.ema == null || pair.emaPrev == null || pair.lastPriorHigh == null) {
    return Number.NEGATIVE_INFINITY;
  }
  const stop = pos ? Math.max(pos.initialStop, pos.trail) : null;
  const broken = pos != null && bar != null && bar.low <= stop!;
  return rankOf({
    atr: pair.atr,
    close: pair.last4h.close,
    prior20High: pair.lastPriorHigh,
    ema: pair.ema,
    emaPrev: pair.emaPrev,
    fill: pos?.fill,
    highestCloseSinceEntry: pos?.highestClose,
    brokenTrail: broken,
  }).rank;
}

export function runPooledBreakout(opts: PoolBacktestOpts): PoolBacktestResult {
  classifyHook = opts.classify;
  const maker = feeRate(opts.makerFeeBps);
  const taker = feeRate(opts.takerFeeBps);
  const mems = new Map<string, PairMem>();
  const allTs = new Set<number>();
  for (const p of opts.pairs) {
    const ordered = p.candles.filter((c) => c.close > 0 && c.high > 0 && c.low > 0).slice().sort((a, b) => a.ts - b.ts);
    const byTs = new Map<number, Candle>();
    for (const c of ordered) {
      byTs.set(c.ts, c);
      allTs.add(c.ts);
    }
    mems.set(p.pair, {
      pair: p.pair,
      notionalUsd: p.notionalUsd,
      stopLossBps: p.stopLossBps,
      byTs,
      building: null,
      buildingId: null,
      completedHighs: [],
      ema: null,
      emaPrev: null,
      emaSamples: 0,
      atr: null,
      atrWarm: false,
      atrSeed: [],
      prev4hClose: null,
      last4h: null,
      lastPriorHigh: null,
      closes: [],
      vol: new Welford(),
      prev5: null,
      last5: null,
      pending: null,
      queued: null,
      lastCandidate: false,
      lastRank: Number.NEGATIVE_INFINITY,
    });
  }

  const stamps = [...allTs].sort((a, b) => a - b);
  let cash = opts.bankrollUsd;
  const pos = new Map<string, OpenPos>();
  let fees = 0;
  let wins = 0;
  let trades = 0;
  let missed = 0;
  let vetoedEntries = 0;
  let rotations = 0;
  let halted = false;
  const tradeLog: ClosedTrade[] = [];
  const equity: EquityPoint[] = [];

  const mark = (pair: string, px: number): number => {
    const p = pos.get(pair);
    return p ? p.units * px : 0;
  };

  const equityAt = (pxOf: (pair: string) => number): number => {
    let m = cash;
    for (const pair of mems.keys()) m += mark(pair, pxOf(pair));
    return m;
  };

  const grossAt = (pxOf: (pair: string) => number): number => {
    let g = 0;
    for (const pair of mems.keys()) g += mark(pair, pxOf(pair));
    return g;
  };

  const settle = (pair: string, px: number, ts: number) => {
    const p = pos.get(pair);
    if (!p) return;
    const exitFee = p.units * px * taker;
    const entryFee = p.cost - p.units * p.fill;
    const gross = p.units * (px - p.fill);
    const net = gross - entryFee - exitFee;
    cash += p.units * px - exitFee;
    fees += exitFee;
    if (p.units * px - exitFee > p.cost) wins += 1;
    trades += 1;
    tradeLog.push({
      openedTs: p.openedTs,
      closedTs: ts,
      netUsd: net,
      entryNotionalUsd: p.units * p.fill,
      exitNotionalUsd: p.units * px,
    });
    pos.delete(pair);
  };

  const enter = (pair: string, limit: number, ts: number, bar: Candle) => {
    if (pos.has(pair) || halted) return;
    if (!(bar.low <= limit)) {
      missed += 1;
      return;
    }
    const mem = mems.get(pair)!;
    const roomGross = opts.maxGrossUsd - grossAt((q) => (q === pair ? 0 : mems.get(q)?.last5?.close ?? 0));
    const budget = cash / (1 + maker);
    const sizeUsd = Math.min(mem.notionalUsd, budget, Math.max(0, roomGross));
    if (!(sizeUsd >= opts.minSizeUsd) || !(limit > 0)) {
      missed += 1;
      return;
    }
    const units = sizeUsd / limit;
    const cost = sizeUsd * (1 + maker);
    cash -= cost;
    fees += sizeUsd * maker;
    const entry = cost / units;
    const atr = mem.atr;
    const seedTrail = atr != null ? limit - opts.trailAtr * atr : entry * (1 - mem.stopLossBps / 10_000);
    pos.set(pair, {
      pair,
      entry,
      fill: limit,
      units,
      cost,
      openedTs: ts,
      expiresAt: ts + opts.maxHoldSec * 1000,
      initialStop: entry * (1 - mem.stopLossBps / 10_000),
      trail: seedTrail,
      highestClose: limit,
    });
  };

  const complete4h = (mem: PairMem, bar4h: Candle) => {
    const priorHighs = mem.completedHighs.slice(-opts.breakoutBars);
    mem.lastPriorHigh = priorHighs.length >= opts.breakoutBars ? Math.max(...priorHighs) : null;
    mem.emaPrev = mem.ema;
    mem.ema = emaNext(mem.ema, bar4h.close, opts.trendEmaBars);
    mem.emaSamples += 1;
    const tr = trueRange(bar4h.high, bar4h.low, mem.prev4hClose);
    if (!mem.atrWarm) {
      mem.atrSeed.push(tr);
      if (mem.atrSeed.length >= opts.atrBars) {
        mem.atr = mem.atrSeed.reduce((s, x) => s + x, 0) / opts.atrBars;
        mem.atrWarm = true;
      }
    } else if (mem.atr != null) {
      mem.atr = atrNext(mem.atr, bar4h, mem.prev4hClose, opts.atrBars);
    }
    const held = pos.get(mem.pair);
    if (held && mem.atr != null) {
      held.highestClose = Math.max(held.highestClose, bar4h.close);
      held.trail = trailNext(held.trail, held.highestClose, mem.atr, opts.trailAtr);
    }
    mem.last4h = bar4h;
    const signal = isCandidate(mem, opts.breakoutBars, opts.trendEmaBars);
    if (signal && vetoed(mem)) vetoedEntries += 1;
    mem.lastCandidate = signal;
    mem.lastRank = pairRank(mem, held ?? null, mem.last5);
    mem.completedHighs.push(bar4h.high);
    mem.prev4hClose = bar4h.close;
  };

  for (const ts of stamps) {
    for (const mem of mems.values()) {
      const bar = mem.byTs.get(ts);
      if (!bar) continue;
      const id = Math.floor(bar.ts / FOUR_HOURS_MS) * FOUR_HOURS_MS;
      if (mem.building && mem.buildingId != null && id !== mem.buildingId && mem.last5) {
        complete4h(mem, mem.building);
        mem.building = null;
        mem.buildingId = null;
      }
      if (!mem.building) {
        mem.building = { ts: id, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume };
        mem.buildingId = id;
      } else {
        mem.building.high = Math.max(mem.building.high, bar.high);
        mem.building.low = Math.min(mem.building.low, bar.low);
        mem.building.close = bar.close;
        mem.building.volume += bar.volume;
      }
      mem.closes.push(bar.close);
      if (mem.prev5 != null && mem.prev5 > 0) {
        mem.vol.push(((bar.close - mem.prev5) / mem.prev5) * 10_000 / Math.sqrt(300));
      }
      mem.prev5 = bar.close;
      mem.last5 = bar;
    }

    if (ts < opts.windowStartTs || ts >= opts.windowEndTs) continue;

    for (const mem of mems.values()) {
      const bar = mem.byTs.get(ts);
      if (!bar) continue;
      const held = pos.get(mem.pair);
      if (held) {
        const stop = Math.max(held.initialStop, held.trail);
        if (bar.low <= stop) settle(mem.pair, Math.min(stop, bar.open), ts);
        else if (bar.ts >= held.expiresAt) settle(mem.pair, bar.close, ts);
      }
      if (mem.queued && !pos.has(mem.pair)) {
        mem.pending = mem.queued;
        mem.queued = null;
      }
    }

    const pxOf = (pair: string) => mems.get(pair)?.last5?.close ?? 0;
    const eq = equityAt(pxOf);
    if (!halted && eq <= opts.bankrollUsd * (1 - opts.poolDd)) {
      halted = true;
      for (const pair of [...pos.keys()]) {
        const px = pxOf(pair);
        if (px > 0) settle(pair, px, ts);
      }
    }

    const names: RotationName[] = [];
    for (const mem of mems.values()) {
      const held = pos.get(mem.pair);
      const bar = mem.byTs.get(ts) ?? mem.last5;
      const rank = pairRank(mem, held ?? null, bar);
      mem.lastRank = rank;
      names.push({
        pair: mem.pair,
        rank,
        clipUsd: mem.notionalUsd,
        open: held != null,
        candidate: !held && mem.lastCandidate,
      });
    }

    const plan = planRotation({
      equityUsd: equityAt(pxOf),
      cashUsd: cash,
      grossUsd: grossAt(pxOf),
      maxGrossUsd: opts.maxGrossUsd,
      maxConcurrent: opts.maxConcurrent,
      makerFeeBps: opts.makerFeeBps,
      minSizeUsd: opts.minSizeUsd,
      names,
      halted,
      poolUsd: opts.bankrollUsd,
      poolDd: opts.poolDd,
    });
    if (plan.halt) halted = true;

    const finiteOpens = new Set(names.filter((n) => n.open && Number.isFinite(n.rank)).map((n) => n.pair));
    let rotated = false;
    for (const pair of plan.flatten) {
      if (!pos.has(pair)) continue;
      if (finiteOpens.has(pair)) rotated = true;
      const px = pxOf(pair);
      if (px > 0) settle(pair, px, ts);
    }
    if (rotated) rotations += 1;

    for (const pair of plan.enter) {
      const mem = mems.get(pair);
      if (!mem || !mem.last4h || pos.has(pair)) continue;
      const limit = mem.last4h.close;
      if (rotated) mem.queued = { price: limit };
      else mem.pending = { price: limit };
    }
    for (const mem of mems.values()) mem.lastCandidate = false;

    for (const mem of mems.values()) {
      const bar = mem.byTs.get(ts);
      if (!bar || !mem.pending || pos.has(mem.pair)) continue;
      enter(mem.pair, mem.pending.price, ts, bar);
      mem.pending = null;
    }

    equity.push({ ts, equity: equityAt(pxOf) });
  }

  const last = equity.length ? equity[equity.length - 1]!.equity : opts.bankrollUsd;
  return {
    returnUsd: last - opts.bankrollUsd,
    trades,
    wins,
    feesUsd: fees,
    missedEntries: missed,
    vetoedEntries,
    rotations,
    maxDrawdown: maxDrawdown(equity.map((p) => p.equity)).maxDrawdown,
    tradeLog,
    equity,
    halted,
  };
}
