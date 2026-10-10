/**
 * Swing book and the repo 4h breakout, replayed through the paper allocator and the fee floor.
 * Swing may run in a backtest only when the caller passes swingApproved. Forward paper
 * keeps SWING_APPROVED false. The breakout is re-implemented here and does not consult labels.
 * Its exits are a 3 ATR trail or a 14-day market flat, both taker, so it has no resting
 * maker target and every signal is below_fee_floor. That is not retuned.
 */

import {
  BREAKOUT_ATR_BARS,
  BREAKOUT_BARS,
  BREAKOUT_EMA_BARS,
  BREAKOUT_MAX_HOLD_MS,
  BREAKOUT_TRAIL_ATR,
  DAILY_LOSS_HALT_USD,
  PAIR_LOSS_HALT_USD,
  REPO_BREAKOUT_STOP_BPS,
  RESERVE_USD,
  STARTING_BUDGET_USD,
  SWING_MAX_HOLD_MS,
  TAKER_FEE_BPS,
  swingEntryAllowed,
  type AllocatorMode,
  type RunStrategy,
  type SentimentMode,
  type ShareFormula,
  type StrategyId,
  type VariantId,
} from "./config";
import { aggregate, type Candle } from "./bars";
import { biasEmaNext, biasFromFourHour, type BiasAnswer } from "./bias";
import { ctDayKey, quarterKey, utcDayKey } from "./clock";
import { belowFeeFloor, type ClosedSample } from "./expectancy";
import { stopBpsOf } from "./fees";
import { fillRestingBuy, newEntryOrder } from "./fill";
import { confirmedSwingLow, indicatorSeries, nearestSwingHighAbove, trueRange, type IndicatorPoint } from "./indicators";
import { buildPacket, type PacketInput } from "./jev";
import { freshBook, PaperSession } from "./pipeline";
import { openPosition, rMultiple, stepPosition, type Position } from "./position";
import { findSetups, type Candidate, type DecisionSnapshot } from "./rules";
import { blankAllocator, release } from "./allocator";
import { MemoryStore } from "./store";
import type { EngineResult } from "./engine";
import { lossToStopUsd, overnightRiskUsd, searchSwingTarget, SWING_ATR_MULT, swingFloor, swingStop, swingTarget } from "./swing";
import { proxyAt, type ProxyBook } from "./proxy";

const M15 = 900_000;
const H1 = 3_600_000;
const H4 = 14_400_000;
const D1 = 86_400_000;

export interface SwingPair {
  pair: string;
  m1: Candle[];
  m15: Candle[];
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
  ind: IndicatorPoint[];
  bias4: BiasAnswer[];
  dailyUp: boolean[];
  h1Swing: Array<number | null>;
  m15Swing: Array<number | null>;
  h1Index: Map<number, number>;
  m15Index: Map<number, number>;
}

export interface HigherOpts {
  candles: Record<string, Candle[]>;
  fromMs: number;
  toMs: number;
  mode: AllocatorMode;
  formula: ShareFormula;
  strategy: RunStrategy;
  sentimentMode: SentimentMode;
  proxy: ProxyBook | null;
  swingApproved: boolean;
  enabledPairs: readonly string[];
  variant: VariantId;
  /** Reused across windows that share `toMs`. Built with prepareSwingPairs. */
  prepared?: SwingPair[];
  /** Search knobs. Absent keeps the turn-1 swing: 2× ATR, the 2.5–4R band, 48h. */
  stopAtrMult?: number;
  targetR?: number;
  maxHoldMs?: number;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

function lastClosed(bars: Candle[], tf: number, atMs: number): number {
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

function ruleStrategy(strategy: RunStrategy): StrategyId {
  if (strategy === "swing_A") return "A";
  if (strategy === "swing_B") return "B";
  if (strategy === "swing_C") return "C";
  return "combined";
}

function preparePair(pair: string, candles: Candle[], toMs: number): SwingPair {
  const m1 = candles.filter((c) => c.close > 0 && c.ts < toMs).sort((a, b) => a.ts - b.ts);
  const m15 = aggregate(m1, M15, toMs);
  const h1 = aggregate(m1, H1, toMs);
  const h4 = aggregate(m1, H4, toMs);
  const d1 = aggregate(m1, D1, toMs);
  const ind = indicatorSeries(h1);
  const bias4: BiasAnswer[] = [];
  const closes4: Array<{ close: number }> = [];
  for (const bar of h4) {
    closes4.push({ close: bar.close });
    bias4.push(biasFromFourHour(closes4));
  }
  const dailyUp: boolean[] = [];
  let ema: number | null = null;
  for (let i = 0; i < d1.length; i++) {
    ema = biasEmaNext(ema, d1[i]!.close, 50);
    const prev = i > 0 ? d1[i - 1]! : null;
    dailyUp.push(i >= 6 && ema != null && prev != null && d1[i]!.close > ema && d1[i]!.close > prev.close);
  }
  const h1Swing: Array<number | null> = new Array(h1.length).fill(null);
  let lastLow: number | null = null;
  for (let i = 0; i < h1.length; i++) {
    if (i >= 1) {
      const low = confirmedSwingLow(h1, i - 1);
      if (low != null) lastLow = low;
    }
    h1Swing[i] = lastLow;
  }
  const m15Swing: Array<number | null> = new Array(m15.length).fill(null);
  let last15: number | null = null;
  for (let i = 0; i < m15.length; i++) {
    if (i >= 1) {
      const low = confirmedSwingLow(m15, i - 1);
      if (low != null) last15 = low;
    }
    m15Swing[i] = last15;
  }
  const h1Index = new Map<number, number>();
  h1.forEach((b, i) => h1Index.set(b.ts, i));
  const m15Index = new Map<number, number>();
  m15.forEach((b, i) => m15Index.set(b.ts, i));
  return { pair, m1, m15, h1, h4, d1, ind, bias4, dailyUp, h1Swing, m15Swing, h1Index, m15Index };
}

export function prepareSwingPairs(candles: Record<string, Candle[]>, enabledPairs: readonly string[], toMs: number): SwingPair[] {
  return enabledPairs.map((pair) => preparePair(pair, candles[pair] ?? [], toMs));
}

function blank(opts: HigherOpts, noteReject?: string): EngineResult {
  const rejects: Record<string, number> = {};
  if (noteReject) rejects[noteReject] = 1;
  return {
    variant: opts.variant,
    mode: opts.mode,
    formula: opts.formula,
    strategy: "combined",
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    netUsd: 0,
    maxDrawdownUsd: 0,
    fromStartDrawdownUsd: 0,
    endingEquityUsd: STARTING_BUDGET_USD,
    trades: 0,
    feesUsd: 0,
    ideas: 0,
    fills: 0,
    quarters: [],
    rejects,
    exits: {},
    samples: [],
    stopsByPair: {},
    pairHaltBreached: false,
    dailyHaltBreached: false,
    wins: 0,
    avgR: null,
  };
}

function snapshotOf(p: SwingPair, h1i: number, h4i: number, d1i: number): DecisionSnapshot | null {
  const bar = p.h1[h1i];
  const ind = p.ind[h1i];
  if (!bar || !ind) return null;
  const prev = h1i > 0 ? p.h1[h1i - 1] : undefined;
  const prevInd = h1i > 0 ? p.ind[h1i - 1] : undefined;
  let recentLow3 = bar.low;
  for (let k = 1; k <= 2 && h1i - k >= 0; k++) recentLow3 = Math.min(recentLow3, p.h1[h1i - k]!.low);
  const bias4 = h4i >= 0 ? p.bias4[h4i] : undefined;
  const daily = d1i >= 0 ? p.dailyUp[d1i] === true : false;
  const up = bias4?.up === true && daily;
  let donchian4: number | null = null;
  if (h4i >= 20) {
    let m = -Infinity;
    for (let k = h4i - 20; k < h4i; k++) m = Math.max(m, p.h4[k]!.high);
    donchian4 = m;
  }
  return {
    pair: p.pair,
    barTs: bar.ts,
    close: bar.close,
    low: bar.low,
    high: bar.high,
    prevClose: prev?.close ?? null,
    prevVwap: prevInd?.vwap ?? null,
    vwap: ind.vwap,
    ema9: ind.ema9,
    ema20: ind.ema20,
    ema50: ind.ema50,
    ema200: ind.ema200,
    rsi: ind.rsi14,
    macd: ind.macd,
    macdSignal: ind.macdSignal,
    atr: ind.atr14,
    volume: bar.volume,
    volSma20: ind.volSma20,
    recentLow3,
    donchian5mPriorHigh: ind.donchian20PriorHigh,
    close4h: h4i >= 0 ? p.h4[h4i]!.close : null,
    donchian4hPriorHigh: donchian4,
    biasKnown: bias4?.known === true && d1i >= 6,
    biasUp: up,
  };
}

export async function runSwing(opts: HigherOpts): Promise<EngineResult> {
  if (opts.variant !== "jev_off") throw new Error("not run: needs paid Jev reviews");
  if (!swingEntryAllowed(opts.swingApproved)) return blank(opts, "swing_not_approved");
  const pairs = opts.prepared ?? prepareSwingPairs(opts.candles, opts.enabledPairs, opts.toMs);
  const session = new PaperSession({
    stage: 0,
    jev: null,
    store: new MemoryStore(null),
    state: blankAllocator(opts.mode, opts.formula),
    book: freshBook(opts.enabledPairs, "clear"),
    enabledPairs: opts.enabledPairs,
    atrByPair: {},
    jevOff: true,
  });
  session.opts.store.retain = false;
  const book = () => session.opts.book;

  let cash = STARTING_BUDGET_USD;
  let fees = 0;
  let peak = STARTING_BUDGET_USD;
  let maxDd = 0;
  let fromStartDd = 0;
  let ideas = 0;
  let fills = 0;
  let trades = 0;
  let wins = 0;
  let rSum = 0;
  let pairHalt = false;
  let dailyHalt = false;
  const quarters = new Map<string, number>();
  const rejects: Record<string, number> = {};
  const exits: Record<string, number> = {};
  const samples: ClosedSample[] = [];
  const stopsByPair: Record<string, number[]> = {};
  const positions = new Map<string, Position>();
  const reservedLeft = new Map<string, number>();
  const pendingNet = new Map<string, number>();
  const lastPx = new Map<string, number>();
  const m1Ptr = pairs.map(() => 0);
  const cautionIdeas = new Map<string, number>();
  let utcDay = "";
  let ctDay = "";

  const mark = (): number => {
    let eq = cash;
    for (const pos of positions.values()) eq += pos.units * (lastPx.get(pos.pair) ?? pos.entry);
    return eq;
  };
  const noteEquity = () => {
    const eq = mark();
    if (eq > peak) peak = eq;
    maxDd = Math.max(maxDd, peak - eq);
    fromStartDd = Math.max(fromStartDd, STARTING_BUDGET_USD - eq);
    book().equityUsd = eq;
    book().allocatableUsd = Math.max(0, cash - RESERVE_USD);
  };
  const addNet = (ts: number, net: number) => {
    const q = quarterKey(ts);
    quarters.set(q, (quarters.get(q) ?? 0) + net);
  };
  const dropReserve = (pair: string, amount: number) => {
    if (!(amount > 0)) return;
    session.opts.state = release(session.opts.state, pair, amount);
    book().openNotionalUsd = Math.max(0, book().openNotionalUsd - amount);
    const left = (reservedLeft.get(pair) ?? 0) - amount;
    if (left <= 1e-6) reservedLeft.delete(pair);
    else reservedLeft.set(pair, left);
  };
  const refreshBusy = () => {
    book().openPairs = [...positions.keys()];
    book().openCount = positions.size;
    book().restingCount = 0;
  };
  const noteHalts = (pair: string) => {
    if (book().realizedUsdTodayUtc <= -DAILY_LOSS_HALT_USD) dailyHalt = true;
    if ((book().pairLossUsd[pair] ?? 0) >= PAIR_LOSS_HALT_USD) pairHalt = true;
  };
  const onExit = (pos: Position, ts: number, net: number, r: number) => {
    const stopBps = pos.plannedStopBps ?? stopBpsOf(pos.entry, pos.initialStop);
    const targetBps = pos.plannedTargetBps ?? stopBps * 3;
    samples.push({ closeTs: ts, stopBps, targetBps, win: net > 0, rMultiple: r });
    rSum += r;
    if (net > 0) wins += 1;
    trades += 1;
  };

  const events: Array<{ i: number; m15i: number }> = [];
  for (let i = 0; i < pairs.length; i++) {
    const series = pairs[i]!;
    for (let m15i = 0; m15i < series.m15.length; m15i++) {
      const bar = series.m15[m15i]!;
      if (bar.ts + M15 <= opts.fromMs || bar.ts + M15 > opts.toMs) continue;
      events.push({ i, m15i });
    }
  }
  events.sort((a, b) => pairs[a.i]!.m15[a.m15i]!.ts - pairs[b.i]!.m15[b.m15i]!.ts || a.i - b.i);

  const rule = ruleStrategy(opts.strategy);
  for (const ev of events) {
    const series = pairs[ev.i]!;
    const m15i = ev.m15i;
    const bar = series.m15[m15i]!;
    lastPx.set(series.pair, bar.close);
    const day = utcDayKey(bar.ts);
    if (day !== utcDay) {
      utcDay = day;
      book().lossesTodayUtc = 0;
      book().rTodayUtc = 0;
      book().realizedUsdTodayUtc = 0;
    }
    const local = ctDayKey(bar.ts);
    if (local !== ctDay) {
      ctDay = local;
      book().ideasTodayCt = 0;
      cautionIdeas.clear();
    }
    const prev = m15i > 0 ? series.m15[m15i - 1] : undefined;
    const missingSec = prev ? (bar.ts - prev.ts - M15) / 1000 : 0;
    const pos = positions.get(series.pair);
    if (pos) {
      const stepped = stepPosition(pos, bar, {
        gapSec: missingSec > 0 ? missingSec : 0,
        fiveMinComplete: false,
        fiveMinClose: null,
        vwap: null,
        confirmedSwingLow: series.m15Swing[m15i] ?? null,
        barMs: M15,
      });
      for (const event of stepped.events) {
        cash += event.units * event.price - event.feeUsd;
        fees += event.feeUsd;
        addNet(bar.ts, event.netUsd);
        book().realizedUsdTodayUtc += event.netUsd;
        book().rTodayUtc += event.rMultiple;
        if (event.kind === "t1") pendingNet.set(pos.id, (pendingNet.get(pos.id) ?? 0) + event.netUsd);
        if (event.kind === "exit") {
          const total = (pendingNet.get(pos.id) ?? 0) + event.netUsd;
          pendingNet.delete(pos.id);
          bump(exits, event.reason);
          if (total < 0) {
            book().lossesTodayUtc += 1;
            book().pairLossUsd[series.pair] = (book().pairLossUsd[series.pair] ?? 0) + -total;
          }
          const riskUsd = (pos.entry - pos.initialStop) * pos.initialUnits;
          onExit(pos, bar.ts, total, riskUsd > 0 ? total / riskUsd : 0);
          noteHalts(series.pair);
          dropReserve(series.pair, reservedLeft.get(series.pair) ?? 0);
        }
      }
      if (stepped.position) positions.set(series.pair, stepped.position);
      else positions.delete(series.pair);
    }

    noteEquity();
    refreshBusy();
    if ((bar.ts + M15) % H1 !== 0) continue;
    if (positions.has(series.pair)) continue;
    const decisionTs = bar.ts + M15;
    const h1i = series.h1Index.get(decisionTs - H1);
    if (h1i == null) continue;
    const h4i = lastClosed(series.h4, H4, decisionTs);
    const d1i = lastClosed(series.d1, D1, decisionTs);
    const snap = snapshotOf(series, h1i, h4i, d1i);
    if (!snap || snap.atr == null || !(snap.atr > 0)) continue;
    if (!snap.biasUp) continue;
    const proxy = opts.sentimentMode === "market_proxy" && opts.proxy ? proxyAt(opts.proxy, series.pair, decisionTs) : null;
    if (proxy?.veto) {
      bump(rejects, "sentiment");
      continue;
    }
    session.opts.atrByPair[series.pair] = snap.atr;
    let setups = findSetups(snap, "clear", rule);
    if (proxy?.caution) {
      setups = setups.filter((s) => s.setup === "A");
      if ((cautionIdeas.get(series.pair) ?? 0) >= 1) {
        bump(rejects, "sentiment");
        continue;
      }
    }
    for (const setup of setups) {
      const geom = swingStop(setup.entry, series.h1Swing[h1i] ?? null, snap.atr, opts.stopAtrMult ?? SWING_ATR_MULT);
      if (!geom) {
        bump(rejects, "no_structure");
        continue;
      }
      const nextHigh = h4i >= 0 ? nearestSwingHighAbove(series.h4, h4i, setup.entry) : null;
      const targetPx =
        opts.targetR == null
          ? swingTarget(setup.entry, geom.stop, nextHigh)
          : searchSwingTarget(setup.entry, geom.stop, opts.targetR, nextHigh);
      const floor = swingFloor(setup.entry, geom.stop, targetPx);
      (stopsByPair[series.pair] ??= []).push(floor.stopBps);
      if (!floor.pass || belowFeeFloor(floor.stopBps, floor.targetBps)) {
        bump(rejects, "below_fee_floor");
        continue;
      }
      const notional = session.proposedNotional(series.pair);
      const unitsPlanned = setup.entry > 0 ? notional / setup.entry : 0;
      const candidate: Candidate = {
        ...setup,
        stop: geom.stop,
        plannedTargetBps: floor.targetBps,
        entryProfile: "swing",
        lossToStopUsd: lossToStopUsd(setup.entry, geom.stop, unitsPlanned),
        targetPrice: targetPx,
      };
      book().overnightOpenRiskUsd = overnightRiskUsd(
        [...positions.values()].map((p) => ({
          openedTs: p.openedTs,
          entry: p.entry,
          stop: p.stop,
          units: p.units,
          maxHoldMs: p.maxHoldMs,
        })),
        decisionTs,
      );
      const packet: PacketInput = {
        asOf: decisionTs,
        pair: candidate.pair,
        setup: candidate.setup,
        barTs: candidate.barTs,
        candidateId: candidate.id,
        biasUp: true,
        close: candidate.entry,
        stop: candidate.stop,
        atr: snap.atr,
        rsi: snap.rsi,
        vwap: snap.vwap,
        sentiment: "clear",
        barTsList: [candidate.barTs],
      };
      buildPacket(packet);
      const admission = await session.consider(candidate, packet, decisionTs);
      if (!admission.admitted) {
        for (const reason of admission.failed) bump(rejects, reason);
        continue;
      }
      ideas += 1;
      if (proxy?.caution) cautionIdeas.set(series.pair, (cautionIdeas.get(series.pair) ?? 0) + 1);
      const order = newEntryOrder(candidate.id, series.pair, candidate.entry, unitsPlanned, decisionTs);
      let filledUnits = 0;
      let filledFee = 0;
      let live = order;
      const ptr = m1Ptr[ev.i] ?? 0;
      let p = ptr;
      while (p < series.m1.length && series.m1[p]!.ts < decisionTs) p += 1;
      while (p < series.m1.length && series.m1[p]!.ts < decisionTs + 120_000 && series.m1[p]!.ts < opts.toMs) {
        const minute = series.m1[p]!;
        const filled = fillRestingBuy(live, minute);
        live = filled.order;
        if (filled.event.status === "partial" || filled.event.status === "filled") {
          filledUnits += filled.event.units;
          filledFee += filled.event.feeUsd;
          fees += filled.event.feeUsd;
          cash -= filled.event.units * filled.event.price + filled.event.feeUsd;
          fills += 1;
        }
        p += 1;
        if (filled.event.status === "cancel" || filled.event.status === "filled" || live.unitsRemaining <= 1e-12) break;
      }
      m1Ptr[ev.i] = p;
      const used = filledUnits * candidate.entry;
      const unused = notional - used;
      if (unused > 1e-6) dropReserve(series.pair, unused);
      if (!(filledUnits > 0)) {
        refreshBusy();
        break;
      }
      reservedLeft.set(series.pair, used);
      const opened = openPosition({
        id: candidate.id,
        pair: series.pair,
        entry: candidate.entry,
        units: filledUnits,
        stop: geom.stop,
        openedTs: decisionTs,
        entryFeeUsd: filledFee,
        target2Price: targetPx,
        maxHoldMs: opts.maxHoldMs ?? SWING_MAX_HOLD_MS,
        flatAtMidnight: false,
        vwapExit: false,
        plannedStopBps: floor.stopBps,
        plannedTargetBps: floor.targetBps,
      });
      positions.set(series.pair, opened);
      refreshBusy();
      break;
    }
  }

  for (const pos of [...positions.values()]) {
    const px = lastPx.get(pos.pair) ?? pos.entry;
    const fee = (pos.units * px * TAKER_FEE_BPS) / 10_000;
    const entryAlloc = pos.initialUnits > 0 ? pos.entryFeeUsd * (pos.units / pos.initialUnits) : 0;
    const net = pos.units * px - fee - pos.units * pos.entry - entryAlloc;
    cash += pos.units * px - fee;
    fees += fee;
    addNet(opts.toMs - 1, net);
    bump(exits, "window_end");
    if (net < 0) book().pairLossUsd[pos.pair] = (book().pairLossUsd[pos.pair] ?? 0) + -net;
    onExit(pos, opts.toMs - 1, net, rMultiple(net, pos.entry, pos.initialStop, pos.initialUnits));
    noteHalts(pos.pair);
    positions.delete(pos.pair);
  }
  noteEquity();
  const ending = mark();
  return {
    variant: "jev_off",
    mode: opts.mode,
    formula: opts.formula,
    strategy: "combined",
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    netUsd: ending - STARTING_BUDGET_USD,
    maxDrawdownUsd: maxDd,
    fromStartDrawdownUsd: fromStartDd,
    endingEquityUsd: ending,
    trades,
    feesUsd: fees,
    ideas,
    fills,
    quarters: [...quarters.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([quarter, netUsd]) => ({ quarter, netUsd })),
    rejects,
    exits,
    samples,
    stopsByPair,
    pairHaltBreached: pairHalt,
    dailyHaltBreached: dailyHalt,
    wins,
    avgR: trades > 0 ? rSum / trades : null,
  };
}

export async function runBreakoutPaper(opts: HigherOpts): Promise<EngineResult> {
  if (opts.variant !== "jev_off") throw new Error("not run: needs paid Jev reviews");
  const rejects: Record<string, number> = {};
  const stopsByPair: Record<string, number[]> = {};
  for (const pair of opts.enabledPairs) {
    const m1 = (opts.candles[pair] ?? []).filter((c) => c.close > 0 && c.ts < opts.toMs);
    const h4 = aggregate(m1, H4, opts.toMs);
    let ema: number | null = null;
    let emaSamples = 0;
    let atr: number | null = null;
    let atrWarm = false;
    const atrSeed: number[] = [];
    let prevClose: number | null = null;
    const highs: number[] = [];
    for (let i = 0; i < h4.length; i++) {
      const bar = h4[i]!;
      const prior = highs.length >= BREAKOUT_BARS ? Math.max(...highs.slice(-BREAKOUT_BARS)) : null;
      ema = biasEmaNext(ema, bar.close, BREAKOUT_EMA_BARS);
      emaSamples += 1;
      const tr = trueRange(bar.high, bar.low, prevClose);
      if (!atrWarm) {
        atrSeed.push(tr);
        if (atrSeed.length >= BREAKOUT_ATR_BARS) {
          atr = atrSeed.reduce((s, x) => s + x, 0) / BREAKOUT_ATR_BARS;
          atrWarm = true;
        }
      } else if (atr != null) {
        atr = (atr * (BREAKOUT_ATR_BARS - 1) + tr) / BREAKOUT_ATR_BARS;
      }
      const closeTs = bar.ts + H4;
      const ready = prior != null && emaSamples >= BREAKOUT_EMA_BARS && atrWarm && atr != null && ema != null;
      if (ready && closeTs >= opts.fromMs && closeTs < opts.toMs && bar.close > prior && bar.close > ema) {
        const bookBps = REPO_BREAKOUT_STOP_BPS[pair] ?? 0;
        const atrBps = bar.close > 0 ? ((BREAKOUT_TRAIL_ATR * atr!) / bar.close) * 10_000 : 0;
        const live = bookBps > 0 && atrBps > 0 ? Math.min(bookBps, atrBps) : bookBps || atrBps;
        if (live > 0) (stopsByPair[pair] ??= []).push(live);
        bump(rejects, "below_fee_floor");
      }
      highs.push(bar.high);
      prevClose = bar.close;
    }
    void BREAKOUT_MAX_HOLD_MS;
  }
  const result = blank(opts);
  result.rejects = rejects;
  result.stopsByPair = stopsByPair;
  result.strategy = "combined";
  return result;
}
