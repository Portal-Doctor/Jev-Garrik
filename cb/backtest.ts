/**
 * Historical replay of the paper strategy against a fee-aware oracle.
 * Candles supply the numbers we can calculate. The order book is not in that tape,
 * so imbalance and taker flow stay neutral and size is the configured notional.
 */

import { findBook } from "./books";
import { config } from "./config";
import { emaNext, rsiNext, Welford } from "./features";
import { evaluateGate } from "./gate";
import {
  adverseAvoidance,
  breakevenRoundTripBps,
  directionalHitRate,
  evaluationChecklist,
  feeTierClears,
  hurdleProximity,
  maxDrawdown,
  netToGross,
  predictiveEdge,
  sortinoRatio,
  systemQuality,
  type CheckRow,
  type YieldSample,
} from "./metrics";
import { runBreakout, type BreakoutSummary } from "./breakout";
import { classifyDeterministic } from "./model";
import type { GateResult } from "./gate";
import type { MarketState } from "./state";
import { trendFromFourHour, type TrendAnswer } from "./trend";

export interface Candle {
  /** Bucket start, epoch ms. */
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Mark {
  ts: number;
  price: number;
}

export interface EquityPoint {
  ts: number;
  equity: number;
}

export interface SideSummary {
  returnUsd: number;
  returnPct: number;
  trades: number;
  wins: number;
  feesUsd: number;
  buys: Mark[];
  sells: Mark[];
  equity: EquityPoint[];
}

export interface BacktestResult {
  pair: string;
  months: 1 | 3 | 6;
  barSec: number;
  fromTs: number;
  toTs: number;
  bars: number;
  bankrollUsd: number;
  notionalUsd: number;
  stopLossBps: number;
  takeProfitBps: number;
  assumedSpreadBps: number;
  assumptions: string[];
  strategy: SideSummary;
  oracle: SideSummary;
  /** One configured clip, bought on the first close and sold on the last. */
  holdUsd: number;
  price: Array<{ ts: number; close: number }>;
  score: BacktestScore;
  diagnostics: Diagnostics;
  /** Closed-trade average winner, in USD. */
  fixedAvgWinUsd: number | null;
  /** Closed-trade average loser, in USD. */
  fixedAvgLossUsd: number | null;
  /** Longest closed hold, in hours. */
  fixedMaxHoldHours: number;
  /** Donchian breakout with a trailing stop, on the same candles. */
  breakout?: BreakoutSummary;
}

export interface BacktestScore {
  predictions: number;
  /** Hourly tape. 100 ms, 1 s, and 5 s are absent, so those hit rates are null. */
  hitRate1s: number | null;
  hitRate1h: number | null;
  hitRate4h: number | null;
  edgeRatio: number | null;
  edgeWinRate: number | null;
  avoidance: number | null;
  breakoutSignals: number;
  fakeBreakEntries: number;
  grossUsd: number;
  netUsd: number;
  makerFeesUsd: number;
  takerFeesUsd: number;
  netToGross: number | null;
  makerFillRate: number | null;
  slippageBps: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
  recoveryBars: number | null;
  sqn: number | null;
  trades: number;
  checks: CheckRow[];
}

export interface FeeTierRow {
  name: string;
  makerBps: number;
  takerBps: number;
  buffer: number;
  cleared: number;
}

export interface Diagnostics {
  candidates: number;
  cleared: number;
  candidatesPerDay: number;
  clearedPerDay: number;
  closestExpectedBps: number | null;
  closestHurdleBps: number | null;
  closestGapBps: number | null;
  medianGapBps: number | null;
  yieldRefusals: number;
  shadowTrades: number;
  shadowNetUsd: number;
  shadowGrossUsd: number;
  adverseSelection: number | null;
  feeTiers: FeeTierRow[];
  breakevenRoundTripBps: number | null;
  hitRate10s: number | null;
  hitRate1m: number | null;
  hitRate5m: number | null;
  edge10s: number | null;
  edge1m: number | null;
  edge5m: number | null;
  edge1h: number | null;
  spreadNote: string;
  queueNote: string;
  /** Same entries and exits, replayed at 10 bps maker and 10 bps taker. */
  lowFeeNetUsd: number;
}

export interface BacktestOpts {
  pair: string;
  months: 1 | 3 | 6;
  /** First candle that counts toward trades and the chart. Earlier candles warm indicators. */
  windowStartTs: number;
  barSec: number;
  horizonSec: number;
  notionalUsd: number;
  bankrollUsd: number;
  makerFeeBps: number;
  takerFeeBps: number;
  feeBuffer: number;
  buyThreshold: number;
  sellThreshold: number;
  stopLossBps: number;
  takeProfitBps: number;
  depthParticipation: number;
  minSizeUsd: number;
  assumedSpreadBps: number;
  /** Skip the hindsight oracle. Used for the short 1 minute horizon pass. */
  skipOracle?: boolean;
}

type Desired = (state: MarketState) => "long" | "flat";

const DAY_MS = 86_400_000;
const WINDOW_DAYS: Record<1 | 3 | 6, number> = { 1: 30, 3: 90, 6: 180 };
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; result: BacktestResult }>();

const ASSUMPTIONS = [
  "Five minute Coinbase candles. One minute candles score the short holding periods.",
  "Direction is the deterministic classifier on returns and volatility.",
  "Imbalance and taker flow are neutral because candles have no book.",
  "Spread is assumed, and each entry uses the configured notional.",
  "The oracle is the best long or flat path on these prices with the same fees.",
  "Entries are post-only and pay the maker fee. A stop still crosses and pays the taker fee. A contraction veto, a trend down, and the 24 hour clock rest post-only, then cross if they do not fill.",
  "Take-profit rests as a post-only ask and fills only when the high trades through it. Trend is the 4 hour close above its 50 bar EMA with a positive 24 hour return.",
  "The backtest cannot replay Jev, so entry vetoes stay the deterministic labels. Live vetoes use Jev's probability once the ring is warm.",
  "A new long requires that 4 hour trend. Toxic flow, stressed liquidity, contraction, a chase, and a payoff under 2 to 1 refuse the entry. A long flattens on trend down, not on toxic flow.",
  "100 ms, 1 s, and 5 s hit rates are not in this tape. Hit rate is scored at 1 hour and 4 hours.",
  "There is no L2 book in these candles, so imbalance, queue fill rate, and sub-second slippage stay unscored.",
  "A stop fills at the stop price even when the bar opens through it. A take-profit does not fill on a bar that only touches the level.",
  "Breakout uses completed 4 hour bars, a post-only entry that can miss, a 3 ATR trailing stop, and a 14 day cap. Stops fill at the stop or the bar open, whichever is worse.",
];

function feeRate(bps: number): number {
  return Math.max(0, bps) / 10_000;
}

/** Cash change of buying `notional` at `entry` and selling at `exit`. */
export function roundTripPnl(entry: number, exit: number, notional: number, makerFeeBps: number, takerFeeBps: number): number {
  if (!(entry > 0) || !(exit > 0) || !(notional > 0)) return 0;
  const units = notional / entry;
  const cost = notional * (1 + feeRate(makerFeeBps));
  const proceeds = units * exit * (1 - feeRate(takerFeeBps));
  return proceeds - cost;
}

interface OracleTrade {
  buy: number;
  sell: number;
}

/** Perfect-foresight long or flat. One clip at a time. Trades that lose money after fees are skipped. */
export function oracleTrades(
  prices: number[],
  notional: number,
  makerFeeBps: number,
  takerFeeBps: number,
): OracleTrade[] {
  const n = prices.length;
  const best = new Array<number>(n + 1).fill(Number.NEGATIVE_INFINITY);
  const prev = new Array<number>(n + 1).fill(-1);
  const buyAt = new Array<number>(n + 1).fill(-1);
  const sellAt = new Array<number>(n + 1).fill(-1);
  best[0] = 0;
  for (let j = 0; j < n; j++) {
    if (best[j]! > best[j + 1]!) {
      best[j + 1] = best[j]!;
      prev[j + 1] = j;
      buyAt[j + 1] = -1;
    }
    if (j === 0 || !(prices[j]! > 0)) continue;
    for (let i = 0; i < j; i++) {
      if (!(prices[i]! > 0)) continue;
      const gain = roundTripPnl(prices[i]!, prices[j]!, notional, makerFeeBps, takerFeeBps);
      if (!(gain > 0)) continue;
      const cand = best[i]! + gain;
      if (cand > best[j + 1]!) {
        best[j + 1] = cand;
        prev[j + 1] = i;
        buyAt[j + 1] = i;
        sellAt[j + 1] = j;
      }
    }
  }
  const trades: OracleTrade[] = [];
  let k = n;
  while (k > 0) {
    if (buyAt[k]! >= 0) trades.push({ buy: buyAt[k]!, sell: sellAt[k]! });
    const p = prev[k]!;
    if (p < 0 || p >= k) break;
    k = p;
  }
  trades.reverse();
  return trades;
}

interface OpenPos {
  /** Fee-inclusive entry, used by the stop and take-profit. */
  entry: number;
  /** Signal close the buy was booked at. */
  fill: number;
  units: number;
  cost: number;
  openedTs: number;
  expiresAt: number;
}

function retBps(closes: number[], i: number, barsBack: number): number {
  if (barsBack <= 0 || i < barsBack) return 0;
  const prev = closes[i - barsBack];
  const cur = closes[i];
  if (prev == null || cur == null || !(prev > 0)) return 0;
  return ((cur - prev) / prev) * 10_000;
}

function stateAt(
  opts: BacktestOpts,
  candle: Candle,
  i: number,
  closes: number[],
  position: "long" | "flat",
  vol: Welford,
  parkSum: number,
  parkN: number,
  emaFast: number | null,
  emaSlow: number | null,
  rsi: number | null,
): MarketState {
  const mid = candle.close;
  const barsPerHour = Math.max(1, Math.round(3600 / opts.barSec));
  const fast = emaFast;
  const slow = emaSlow;
  let emaCross: MarketState["emaCross"] = "flat";
  let emaGapBps = 0;
  if (fast != null && slow != null && slow > 0) {
    emaGapBps = ((fast - slow) / slow) * 10_000;
    emaCross = fast > slow ? "above" : fast < slow ? "below" : "flat";
  }
  const volBps = vol.n > 1 ? vol.stdev() * Math.sqrt(Math.max(0, opts.horizonSec)) : 0;
  const perBar = parkN > 0 ? Math.sqrt(parkSum / (4 * parkN * Math.LN2)) : 0;
  const parkinsonBps = perBar * Math.sqrt(opts.horizonSec / opts.barSec) * 10_000;
  return {
    pair: opts.pair,
    ts: candle.ts,
    horizonSec: opts.horizonSec,
    mid,
    spreadBps: opts.assumedSpreadBps,
    spreadEmaBps: opts.assumedSpreadBps,
    imbalance5: 0,
    imbalance20: 0,
    volBps,
    parkinsonBps,
    emaGapBps,
    emaCross,
    rsi,
    volumeDelta: 0,
    volumeGross: candle.volume,
    returnsBps: {
      m5: opts.barSec <= 300 ? retBps(closes, i, Math.max(1, Math.round(300 / opts.barSec))) : 0,
      m30: opts.barSec <= 1800 ? retBps(closes, i, Math.max(1, Math.round(1800 / opts.barSec))) : 0,
      h1: retBps(closes, i, barsPerHour),
      h4: retBps(closes, i, barsPerHour * 4),
      h24: retBps(closes, i, barsPerHour * 24),
    },
    feeBps: { maker: opts.makerFeeBps, taker: opts.takerFeeBps },
    position,
  };
}

function gateFor(state: MarketState, opts: BacktestOpts, feeBuffer: number, trend: TrendAnswer): GateResult {
  const vector = classifyDeterministic(state).vector;
  const depthUsd = opts.depthParticipation > 0 ? opts.notionalUsd / opts.depthParticipation : 0;
  return evaluateGate({
    position: state.position,
    vector,
    horizonVolBps: state.volBps,
    spreadBps: state.spreadBps,
    makerFeeBps: opts.makerFeeBps,
    takerFeeBps: opts.takerFeeBps,
    feeBuffer,
    buyThreshold: opts.buyThreshold,
    sellThreshold: opts.sellThreshold,
    depthUsd,
    notionalUsd: opts.notionalUsd,
    participation: opts.depthParticipation,
    minSizeUsd: opts.minSizeUsd,
    remainingGrossUsd: Number.POSITIVE_INFINITY,
    halted: false,
    feedBlocked: false,
    emaCross: state.emaCross,
    htfTrendUp: trend.up,
    htfTrendKnown: trend.known,
    h4ReturnBps: state.returnsBps.h4,
    stopLossBps: opts.stopLossBps,
    takeProfitBps: opts.takeProfitBps,
  });
}

function closePos(
  pos: OpenPos,
  px: number,
  takerFeeBps: number,
  cash: number,
): { cash: number; fee: number; win: boolean } {
  const proceeds = pos.units * px;
  const fee = proceeds * feeRate(takerFeeBps);
  return { cash: cash + proceeds - fee, fee, win: proceeds - fee > pos.cost };
}

function summarize(bankroll: number, fees: number, wins: number, trades: number, buys: Mark[], sells: Mark[], equity: EquityPoint[]): SideSummary {
  const last = equity.length ? equity[equity.length - 1]!.equity : bankroll;
  const returnUsd = last - bankroll;
  return {
    returnUsd,
    returnPct: bankroll > 0 ? returnUsd / bankroll : 0,
    trades,
    wins,
    feesUsd: fees,
    buys,
    sells,
    equity,
  };
}

export function runBacktest(candles: Candle[], opts: BacktestOpts, desired?: Desired): BacktestResult {
  const ordered = candles.filter((c) => c.close > 0 && c.high > 0 && c.low > 0).slice().sort((a, b) => a.ts - b.ts);
  const window = ordered.filter((c) => c.ts >= opts.windowStartTs);
  if (window.length < 2) throw new Error("not enough candles in the window");

  const maker = feeRate(opts.makerFeeBps);
  const closes: number[] = [];
  const vol = new Welford();
  let parkSum = 0;
  let parkN = 0;
  let emaFast: number | null = null;
  let emaSlow: number | null = null;
  let prevClose: number | null = null;
  let avgGain = 0;
  let avgLoss = 0;
  let rsiSamples = 0;
  let rsi: number | null = null;

  let cash = opts.bankrollUsd;
  let pos: OpenPos | null = null;
  let fees = 0;
  let wins = 0;
  let trades = 0;
  let grossUsd = 0;
  let netUsd = 0;
  let makerFeesUsd = 0;
  let takerFeesUsd = 0;
  const tradeNets: number[] = [];
  const holdHours: number[] = [];
  const buys: Mark[] = [];
  const sells: Mark[] = [];
  const equity: EquityPoint[] = [];
  const longCalls: boolean[] = [];
  const windowCloses: number[] = [];
  let breakoutSignals = 0;
  let fakeBreakEntries = 0;

  const yieldSamples: YieldSample[] = [];
  let shadow: OpenPos | null = null;
  let shadowCash = opts.bankrollUsd;
  let shadowGross = 0;
  let shadowNet = 0;
  let shadowTrades = 0;
  let shadowEntries = 0;
  let shadowAdverse = 0;
  const lowMakerBps = 10;
  const lowTakerBps = 10;
  let lowFeePos: OpenPos | null = null;
  let lowFeeNetUsd = 0;

  const settleLow = (px: number, liquidity: "maker" | "taker") => {
    if (!lowFeePos) return;
    const exitBps = liquidity === "maker" ? lowMakerBps : lowTakerBps;
    const gross = lowFeePos.units * (px - lowFeePos.fill);
    const exitFee = lowFeePos.units * px * feeRate(exitBps);
    const entryFee = lowFeePos.cost - lowFeePos.units * lowFeePos.fill;
    lowFeeNetUsd += gross - entryFee - exitFee;
    lowFeePos = null;
  };

  const openLow = (bar: Candle, sizeUsd: number) => {
    const rate = feeRate(lowMakerBps);
    const units = sizeUsd / bar.close;
    const cost = sizeUsd * (1 + rate);
    lowFeePos = {
      entry: cost / units,
      fill: bar.close,
      units,
      cost,
      openedTs: bar.ts,
      expiresAt: 0,
    };
  };

  const shadowSettle = (current: OpenPos, px: number, liquidity: "maker" | "taker") => {
    const exitBps = liquidity === "maker" ? opts.makerFeeBps : opts.takerFeeBps;
    const gross = current.units * (px - current.fill);
    const exitFee = current.units * px * feeRate(exitBps);
    const entryFee = current.cost - current.units * current.fill;
    shadowGross += gross;
    shadowNet += gross - entryFee - exitFee;
    shadowTrades += 1;
    const closed = closePos(current, px, exitBps, shadowCash);
    shadowCash = closed.cash;
    shadow = null;
  };

  const openShadow = (bar: Candle) => {
    const budget = shadowCash / (1 + maker);
    const sizeUsd = Math.min(opts.notionalUsd, budget);
    if (sizeUsd < opts.minSizeUsd) return;
    const units = sizeUsd / bar.close;
    const cost = sizeUsd * (1 + maker);
    shadowCash -= cost;
    shadow = {
      entry: cost / units,
      fill: bar.close,
      units,
      cost,
      openedTs: bar.ts,
      expiresAt: bar.ts + opts.horizonSec * 1000,
    };
    shadowEntries += 1;
  };

  const fourHourMs = 14_400_000;
  const fourHourByKey = new Map<number, Candle>();
  for (const c of ordered) {
    const key = Math.floor(c.ts / fourHourMs) * fourHourMs;
    const cur = fourHourByKey.get(key);
    if (!cur) {
      fourHourByKey.set(key, { ts: key, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
      continue;
    }
    cur.high = Math.max(cur.high, c.high);
    cur.low = Math.min(cur.low, c.low);
    cur.close = c.close;
    cur.volume += c.volume;
  }
  const fourHourKeys = [...fourHourByKey.keys()].sort((a, b) => a - b);
  const trendAt = (ts: number): TrendAnswer => {
    const cutoff = Math.floor(ts / fourHourMs) * fourHourMs;
    const buckets = fourHourKeys.filter((k) => k < cutoff).map((k) => fourHourByKey.get(k)!);
    return trendFromFourHour(buckets, config.trendEmaBars);
  };

  const want = desired ?? ((state: MarketState) => gateFor(state, opts, opts.feeBuffer, trendAt(state.ts)).target);

  const settle = (current: OpenPos, px: number, ts: number, liquidity: "maker" | "taker") => {
    settleLow(px, liquidity);
    const exitBps = liquidity === "maker" ? opts.makerFeeBps : opts.takerFeeBps;
    const exitRate = feeRate(exitBps);
    const gross = current.units * (px - current.fill);
    const exitFee = current.units * px * exitRate;
    const entryFee = current.cost - current.units * current.fill;
    const net = gross - entryFee - exitFee;
    grossUsd += gross;
    netUsd += net;
    if (liquidity === "maker") makerFeesUsd += exitFee;
    else takerFeesUsd += exitFee;
    tradeNets.push(net);
    holdHours.push(Math.max(0, (ts - current.openedTs) / 3_600_000));
    const closed = closePos(current, px, exitBps, cash);
    cash = closed.cash;
    fees += closed.fee;
    if (closed.win) wins += 1;
    trades += 1;
    sells.push({ ts, price: px });
    pos = null;
  };

  for (let i = 0; i < ordered.length; i++) {
    const bar = ordered[i]!;
    const inWindow = bar.ts >= opts.windowStartTs;
    if (inWindow && pos) {
      const stopPx = pos.entry * (1 - opts.stopLossBps / 10_000);
      const takePx = pos.entry * (1 + opts.takeProfitBps / 10_000);
      const hitStop = bar.low <= stopPx;
      const hitTake = bar.high > takePx;
      if (hitStop) settle(pos, stopPx, bar.ts, "taker");
      else if (hitTake) settle(pos, takePx, bar.ts, "maker");
      else if (bar.ts >= pos.expiresAt) settle(pos, bar.close, bar.ts, "maker");
    }
    if (inWindow && shadow) {
      const stopPx = shadow.entry * (1 - opts.stopLossBps / 10_000);
      const takePx = shadow.entry * (1 + opts.takeProfitBps / 10_000);
      if (bar.low <= stopPx) shadowSettle(shadow, stopPx, "taker");
      else if (bar.high > takePx) shadowSettle(shadow, takePx, "maker");
      else if (bar.ts >= shadow.expiresAt) shadowSettle(shadow, bar.close, "maker");
    }

    closes.push(bar.close);
    if (i > 0) {
      const prev = closes[i - 1]!;
      const ret = prev > 0 ? ((bar.close - prev) / prev) * 10_000 : 0;
      vol.push(ret / Math.sqrt(opts.barSec));
    }
    if (bar.high >= bar.low && bar.low > 0) {
      const x = Math.log(bar.high / bar.low);
      if (Number.isFinite(x)) {
        parkSum += x * x;
        parkN += 1;
      }
    }
    emaFast = emaNext(emaFast, bar.close, 8);
    emaSlow = emaNext(emaSlow, bar.close, 21);
    if (prevClose != null) {
      const next = rsiNext(prevClose, bar.close, avgGain, avgLoss, rsiSamples, 14);
      rsi = next.rsi;
      avgGain = next.avgGain;
      avgLoss = next.avgLoss;
      rsiSamples = next.samples;
    }
    prevClose = bar.close;

    if (!inWindow) continue;

    const state = stateAt(opts, bar, i, closes, pos ? "long" : "flat", vol, parkSum, parkN, emaFast, emaSlow, rsi);
    const call = classifyDeterministic(state);
    const isLong = call.vector.direction_bias === "long";
    longCalls.push(isLong);
    windowCloses.push(bar.close);

    let priorHigh = Number.NEGATIVE_INFINITY;
    const from = Math.max(0, i - 20);
    for (let k = from; k < i; k++) priorHigh = Math.max(priorHigh, ordered[k]!.high);
    const next = ordered[i + 1];
    const breakout = i >= 20 && isLong && bar.close > priorHigh && next != null;
    const fake = breakout && next!.close < priorHigh;

    const trend = trendAt(bar.ts);
    const strict = gateFor(state, opts, opts.feeBuffer, trend);
    const costState = shadow ? { ...state, position: "long" as const } : state;
    const cost = gateFor(costState, opts, 1, trend);
    if (state.position === "flat" && (strict.approved || strict.reason === "yield")) {
      yieldSamples.push({ expectedBps: strict.expectedYieldBps, hurdleBps: strict.hurdleBps });
    }
    const marginal = !desired && cost.approved && !strict.approved;
    if (!desired && shadow && cost.target === "flat") shadowSettle(shadow, bar.close, "maker");
    else if (marginal && !shadow) {
      const before = shadowEntries;
      openShadow(bar);
      if (shadowEntries > before && next && next.close < bar.close) shadowAdverse += 1;
    }

    const target = want(state);
    let entered = false;
    if (pos && target === "flat") settle(pos, bar.close, bar.ts, "maker");
    else if (!pos && target === "long") {
      const budget = cash / (1 + maker);
      const sizeUsd = Math.min(opts.notionalUsd, budget);
      if (sizeUsd >= opts.minSizeUsd) {
        const units = sizeUsd / bar.close;
        const cost = sizeUsd * (1 + maker);
        const entryFee = sizeUsd * maker;
        cash -= cost;
        fees += entryFee;
        makerFeesUsd += entryFee;
        pos = {
          entry: cost / units,
          fill: bar.close,
          units,
          cost,
          openedTs: bar.ts,
          expiresAt: bar.ts + opts.horizonSec * 1000,
        };
        openLow(bar, sizeUsd);
        buys.push({ ts: bar.ts, price: bar.close });
        entered = true;
      }
    }
    if (breakout) {
      breakoutSignals += 1;
      if (fake && entered) fakeBreakEntries += 1;
    }
    equity.push({ ts: bar.ts, equity: cash + (pos ? pos.units * bar.close : 0) });
  }

  const prices = window.map((c) => c.close);
  const oracle = opts.skipOracle
    ? summarize(opts.bankrollUsd, 0, 0, 0, [], [], [])
    : simulateOracle(window, oracleTrades(prices, opts.notionalUsd, opts.makerFeeBps, opts.takerFeeBps), opts);

  const first = window[0]!.close;
  const last = window[window.length - 1]!.close;
  const holdUsd = roundTripPnl(first, last, opts.notionalUsd, opts.makerFeeBps, opts.takerFeeBps);
  const winNets = tradeNets.filter((n) => n > 0);
  const lossNets = tradeNets.filter((n) => n <= 0);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);

  return {
    pair: opts.pair,
    months: opts.months,
    barSec: opts.barSec,
    fromTs: window[0]!.ts,
    toTs: window[window.length - 1]!.ts,
    bars: window.length,
    bankrollUsd: opts.bankrollUsd,
    notionalUsd: opts.notionalUsd,
    stopLossBps: opts.stopLossBps,
    takeProfitBps: opts.takeProfitBps,
    assumedSpreadBps: opts.assumedSpreadBps,
    assumptions: ASSUMPTIONS,
    strategy: summarize(opts.bankrollUsd, fees, wins, trades, buys, sells, equity),
    oracle: oracle,
    holdUsd,
    price: window.map((c) => ({ ts: c.ts, close: c.close })),
    fixedAvgWinUsd: mean(winNets),
    fixedAvgLossUsd: mean(lossNets),
    fixedMaxHoldHours: holdHours.length ? Math.max(...holdHours) : 0,
    diagnostics: buildDiagnostics({
      samples: yieldSamples,
      windowMs: Math.max(1, window[window.length - 1]!.ts - window[0]!.ts),
      shadowTrades,
      shadowNet,
      shadowGross,
      shadowEntries,
      shadowAdverse,
      longCalls,
      closes: windowCloses,
      barSec: opts.barSec,
      feeBuffer: opts.feeBuffer,
      spreadBps: opts.assumedSpreadBps,
      makerBps: opts.makerFeeBps,
      takerBps: opts.takerFeeBps,
      lowFeeNetUsd,
    }),
    score: scoreBacktest({
      barSec: opts.barSec,
      horizonSec: opts.horizonSec,
      longCalls,
      closes: windowCloses,
      breakoutSignals,
      fakeBreakEntries,
      tradeNets,
      grossUsd,
      netUsd,
      makerFeesUsd,
      takerFeesUsd,
      equity: equity.map((p) => p.equity),
    }),
  };
}

function buildDiagnostics(input: {
  samples: YieldSample[];
  windowMs: number;
  shadowTrades: number;
  shadowNet: number;
  shadowGross: number;
  shadowEntries: number;
  shadowAdverse: number;
  longCalls: boolean[];
  closes: number[];
  barSec: number;
  feeBuffer: number;
  spreadBps: number;
  makerBps: number;
  takerBps: number;
  lowFeeNetUsd: number;
}): Diagnostics {
  const near = hurdleProximity(input.samples);
  const expected = input.samples.map((s) => s.expectedBps);
  const days = Math.max(input.windowMs / DAY_MS, 1 / 24);
  const minute = input.barSec <= 60;
  const edge1h = predictiveEdge(input.longCalls, input.closes, Math.max(1, Math.round(3600 / input.barSec))).ratio;
  return {
    candidates: input.samples.length,
    cleared: near.cleared,
    candidatesPerDay: input.samples.length / days,
    clearedPerDay: near.cleared / days,
    closestExpectedBps: near.closest?.expectedBps ?? null,
    closestHurdleBps: near.closest?.hurdleBps ?? null,
    closestGapBps: near.closestGapBps,
    medianGapBps: near.medianGapBps,
    yieldRefusals: near.refusals,
    shadowTrades: input.shadowTrades,
    shadowNetUsd: input.shadowNet,
    shadowGrossUsd: input.shadowGross,
    adverseSelection: input.shadowEntries > 0 ? input.shadowAdverse / input.shadowEntries : null,
    feeTiers: feeTierClears(expected, [
      { name: "Post-only book, safety buffer", makerBps: input.makerBps, takerBps: input.takerBps, buffer: input.feeBuffer, spreadBps: input.spreadBps },
      { name: "Post-only book, cost only", makerBps: input.makerBps, takerBps: input.takerBps, buffer: 1, spreadBps: input.spreadBps },
      { name: "Maker 20 bps round trip", makerBps: 20, takerBps: 20, buffer: input.feeBuffer, spreadBps: input.spreadBps },
      { name: "Zero maker fee", makerBps: 0, takerBps: 0, buffer: 1, spreadBps: input.spreadBps },
    ]),
    breakevenRoundTripBps: breakevenRoundTripBps(expected, input.feeBuffer, input.spreadBps / 2),
    hitRate10s: null,
    hitRate1m: minute ? directionalHitRate(input.longCalls, input.closes, 1).rate : null,
    hitRate5m: minute ? directionalHitRate(input.longCalls, input.closes, 5).rate : null,
    edge10s: null,
    edge1m: minute ? predictiveEdge(input.longCalls, input.closes, 1).ratio : null,
    edge5m: minute ? predictiveEdge(input.longCalls, input.closes, 5).ratio : null,
    edge1h,
    spreadNote: "Spread is a fixed assumption. Historical bid-ask expansion is not in the candle tape.",
    queueNote: "Post-only queue time is shorter than these candles, so fill probability and missed-trade cost are not scored.",
    lowFeeNetUsd: input.lowFeeNetUsd,
  };
}

function scoreBacktest(input: {
  barSec: number;
  horizonSec: number;
  longCalls: boolean[];
  closes: number[];
  breakoutSignals: number;
  fakeBreakEntries: number;
  tradeNets: number[];
  grossUsd: number;
  netUsd: number;
  makerFeesUsd: number;
  takerFeesUsd: number;
  equity: number[];
}): BacktestScore {
  const ahead1h = Math.max(1, Math.round(3600 / input.barSec));
  const ahead4h = Math.max(1, Math.round(14_400 / input.barSec));
  const hit1h = directionalHitRate(input.longCalls, input.closes, ahead1h);
  const hit4h = directionalHitRate(input.longCalls, input.closes, ahead4h);
  const edge = predictiveEdge(input.longCalls, input.closes, ahead4h);
  const kept = netToGross(input.netUsd, input.grossUsd);
  const sortino = sortinoRatio(input.equity, input.barSec);
  const dd = maxDrawdown(input.equity);
  const sqn = systemQuality(input.tradeNets);
  return {
    predictions: hit1h.n,
    hitRate1s: null,
    hitRate1h: hit1h.rate,
    hitRate4h: hit4h.rate,
    edgeRatio: edge.ratio,
    edgeWinRate: edge.winRate,
    avoidance: adverseAvoidance(input.breakoutSignals, input.fakeBreakEntries),
    breakoutSignals: input.breakoutSignals,
    fakeBreakEntries: input.fakeBreakEntries,
    grossUsd: input.grossUsd,
    netUsd: input.netUsd,
    makerFeesUsd: input.makerFeesUsd,
    takerFeesUsd: input.takerFeesUsd,
    netToGross: kept,
    makerFillRate: null,
    slippageBps: null,
    sortino,
    maxDrawdown: dd.maxDrawdown,
    recoveryBars: dd.recoveryBars,
    sqn,
    trades: input.tradeNets.length,
    checks: evaluationChecklist({
      hitRate1s: null,
      edge: edge.ratio,
      netToGross: kept,
      makerFillRate: null,
      sortino,
      sqn,
      trades: input.tradeNets.length,
    }),
  };
}

function simulateOracle(window: Candle[], planned: OracleTrade[], opts: BacktestOpts): SideSummary {
  const maker = feeRate(opts.makerFeeBps);
  let cash = opts.bankrollUsd;
  let fees = 0;
  let wins = 0;
  let pos: OpenPos | null = null;
  const buys: Mark[] = [];
  const sells: Mark[] = [];
  const equity: EquityPoint[] = [];
  const byBuy = new Map<number, number>();
  for (const t of planned) byBuy.set(t.buy, t.sell);

  const openSells = new Map<number, number[]>();
  for (const t of planned) {
    const list = openSells.get(t.sell) ?? [];
    list.push(t.buy);
    openSells.set(t.sell, list);
  }

  for (let i = 0; i < window.length; i++) {
    const bar = window[i]!;
    if (pos && openSells.get(i)?.length) {
      const closed = closePos(pos, bar.close, opts.takerFeeBps, cash);
      cash = closed.cash;
      fees += closed.fee;
      if (closed.win) wins += 1;
      sells.push({ ts: bar.ts, price: bar.close });
      pos = null;
    }
    if (!pos && byBuy.has(i)) {
      const budget = cash / (1 + maker);
      const sizeUsd = Math.min(opts.notionalUsd, budget);
      if (sizeUsd >= opts.minSizeUsd) {
        const units = sizeUsd / bar.close;
        const cost = sizeUsd * (1 + maker);
        cash -= cost;
        fees += sizeUsd * maker;
        pos = {
          entry: cost / units,
          fill: bar.close,
          units,
          cost,
          openedTs: bar.ts,
          expiresAt: 0,
        };
        buys.push({ ts: bar.ts, price: bar.close });
      }
    }
    equity.push({ ts: bar.ts, equity: cash + (pos ? pos.units * bar.close : 0) });
  }
  return summarize(opts.bankrollUsd, fees, wins, planned.length, buys, sells, equity);
}

async function fetchCandles(pair: string, fromMs: number, toMs: number, barSec: number): Promise<Candle[]> {
  const out = new Map<number, Candle>();
  const chunk = 299 * barSec * 1000;
  for (let cursor = fromMs; cursor < toMs; cursor += chunk) {
    const end = Math.min(toMs, cursor + chunk);
    const url = `https://api.exchange.coinbase.com/products/${encodeURIComponent(pair)}/candles?granularity=${barSec}&start=${Math.floor(cursor / 1000)}&end=${Math.floor(end / 1000)}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Coinbase candles ${res.status}`);
    const rows = (await res.json()) as unknown;
    if (!Array.isArray(rows)) throw new Error("Coinbase candles returned an unexpected payload");
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

export interface BacktestTotals {
  netUsd: number;
  grossUsd: number;
  trades: number;
  feesUsd: number;
  breakoutNetUsd: number;
  breakoutTrades: number;
}

export interface BacktestAll {
  months: 1 | 3 | 6;
  pairs: BacktestResult[];
  totals: BacktestTotals;
}

/** Per-pair stop and clip. A name outside the table keeps the global fallback. */
export function backtestRisk(pair: string): { notionalUsd: number; stopLossBps: number; takeProfitBps: number; bankrollUsd: number } {
  const book = findBook(pair);
  const n = Math.max(1, config.pairs.length);
  return {
    notionalUsd: book?.notionalUsd ?? config.notionalUsd,
    stopLossBps: book?.stopLossBps ?? config.stopLossBps,
    takeProfitBps: book?.takeProfitBps ?? config.takeProfitBps,
    bankrollUsd: book ? config.bankrollUsd / n : config.bankrollUsd,
  };
}

export async function loadAllBacktests(months: 1 | 3 | 6): Promise<BacktestAll> {
  const names = config.pairs.filter((pair) => findBook(pair)?.enabled);
  const pairs: BacktestResult[] = [];
  for (const pair of names) pairs.push(await loadHistoricalBacktest(pair, months));
  const totals = pairs.reduce(
    (s, r) => ({
      netUsd: s.netUsd + r.score.netUsd,
      grossUsd: s.grossUsd + r.score.grossUsd,
      trades: s.trades + r.score.trades,
      feesUsd: s.feesUsd + r.score.makerFeesUsd + r.score.takerFeesUsd,
      breakoutNetUsd: s.breakoutNetUsd + (r.breakout?.returnUsd ?? 0),
      breakoutTrades: s.breakoutTrades + (r.breakout?.trades ?? 0),
    }),
    { netUsd: 0, grossUsd: 0, trades: 0, feesUsd: 0, breakoutNetUsd: 0, breakoutTrades: 0 },
  );
  return { months, pairs, totals };
}

export async function loadHistoricalBacktest(pair: string, months: 1 | 3 | 6): Promise<BacktestResult> {
  const key = `${pair}:${months}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.result;

  const barSec = 300;
  const now = Date.now();
  const windowStartTs = now - WINDOW_DAYS[months] * DAY_MS;
  const fetchFrom = windowStartTs - 10 * DAY_MS;
  const candles = await fetchCandles(pair, fetchFrom, now, barSec);
  const risk = backtestRisk(pair);
  const result = runBacktest(candles, {
    pair,
    months,
    windowStartTs,
    barSec,
    horizonSec: config.horizonSec,
    notionalUsd: risk.notionalUsd,
    bankrollUsd: risk.bankrollUsd,
    makerFeeBps: config.makerFeeBps,
    takerFeeBps: config.takerFeeBps,
    feeBuffer: config.feeBuffer,
    buyThreshold: config.buyThreshold,
    sellThreshold: config.sellThreshold,
    stopLossBps: risk.stopLossBps,
    takeProfitBps: risk.takeProfitBps,
    depthParticipation: config.depthParticipation,
    minSizeUsd: config.minSizeUsd,
    assumedSpreadBps: 2,
  });
  try {
    const microFrom = now - 7 * DAY_MS;
    const minutes = await fetchCandles(pair, microFrom - DAY_MS, now, 60);
    const micro = runBacktest(minutes, {
      ...resultOpts(pair, months, microFrom),
      barSec: 60,
      horizonSec: 3600,
      skipOracle: true,
    });
    result.diagnostics.hitRate1m = micro.diagnostics.hitRate1m;
    result.diagnostics.hitRate5m = micro.diagnostics.hitRate5m;
    result.diagnostics.edge1m = micro.diagnostics.edge1m;
    result.diagnostics.edge5m = micro.diagnostics.edge5m;
  } catch {
    // The 1 minute tape is optional. The hourly score still stands.
  }
  result.breakout = runBreakout(candles, {
    pair,
    windowStartTs,
    barSec,
    notionalUsd: risk.notionalUsd,
    bankrollUsd: risk.bankrollUsd,
    makerFeeBps: config.makerFeeBps,
    takerFeeBps: config.takerFeeBps,
    stopLossBps: risk.stopLossBps,
    minSizeUsd: config.minSizeUsd,
    breakoutBars: config.breakoutBars,
    trendEmaBars: config.trendEmaBars,
    atrBars: config.atrBars,
    trailAtr: config.trailAtr,
    maxHoldSec: config.breakoutMaxHoldSec,
  });
  cache.set(key, { at: Date.now(), result });
  return result;
}

function resultOpts(pair: string, months: 1 | 3 | 6, windowStartTs: number): BacktestOpts {
  const risk = backtestRisk(pair);
  return {
    pair,
    months,
    windowStartTs,
    barSec: 300,
    horizonSec: config.horizonSec,
    notionalUsd: risk.notionalUsd,
    bankrollUsd: risk.bankrollUsd,
    makerFeeBps: config.makerFeeBps,
    takerFeeBps: config.takerFeeBps,
    feeBuffer: config.feeBuffer,
    buyThreshold: config.buyThreshold,
    sellThreshold: config.sellThreshold,
    stopLossBps: risk.stopLossBps,
    takeProfitBps: risk.takeProfitBps,
    depthParticipation: config.depthParticipation,
    minSizeUsd: config.minSizeUsd,
    assumedSpreadBps: 2,
  };
}
