/**
 * Historical replay of the paper path: rules, Jev stage policy, hard overrides,
 * allocator, maker fill, and the position manager. jev_off never calls a model.
 * jev_veto and jev_select throw unless a review service is injected.
 */

import {
  RESERVE_USD,
  STARTING_BUDGET_USD,
  TAKER_FEE_BPS,
  type AllocatorMode,
  type JevStage,
  type ShareFormula,
  type StrategyId,
  type VariantId,
} from "./config";
import { aggregate, gapExceeds, type Candle } from "./bars";
import { biasFromFourHour, type BiasAnswer } from "./bias";
import { ctDayKey, quarterKey, utcDayKey } from "./clock";
import { indicatorSeries, latestSwingLow, type IndicatorPoint } from "./indicators";
import { blankAllocator, release } from "./allocator";
import { fillRestingBuy, newEntryOrder, type RestingOrder } from "./fill";
import { buildPacket, type JevReviewService, type PacketInput } from "./jev";
import { findSetups, type Candidate, type DecisionSnapshot, type Sentiment } from "./rules";
import { freshBook, PaperSession } from "./pipeline";
import { openPosition, stepPosition, type Position } from "./position";
import { MemoryStore } from "./store";

export interface EngineOpts {
  candles: Record<string, Candle[]>;
  fromMs: number;
  toMs: number;
  mode: AllocatorMode;
  formula: ShareFormula;
  strategy: StrategyId;
  sentiment: Sentiment;
  enabledPairs: readonly string[];
  variant: VariantId;
  jev?: JevReviewService | null;
  stage?: JevStage;
}

export interface EngineResult {
  variant: VariantId;
  mode: AllocatorMode;
  formula: ShareFormula;
  strategy: StrategyId;
  fromMs: number;
  toMs: number;
  netUsd: number;
  maxDrawdownUsd: number;
  fromStartDrawdownUsd: number;
  endingEquityUsd: number;
  trades: number;
  feesUsd: number;
  ideas: number;
  fills: number;
  quarters: Array<{ quarter: string; netUsd: number }>;
  rejects: Record<string, number>;
  exits: Record<string, number>;
}

interface Prepared {
  pair: string;
  m1: Candle[];
  m5: Candle[];
  h4: Candle[];
  ind: IndicatorPoint[];
  m5Index: Map<number, number>;
  /** Bias of the last 4h bar whose close is <= this 5m bar's close time. */
  bias: BiasAnswer[];
  close4h: Array<number | null>;
  donchian4h: Array<number | null>;
}

interface LiveOrder {
  order: RestingOrder;
  reserved: number;
  stop: number;
  filledUnits: number;
  filledFee: number;
  candidate: Candidate;
}

const FOUR_H = 14_400_000;
const FIVE = 300_000;
const ONE = 60_000;

function prepare(pair: string, candles: Candle[], toMs: number): Prepared {
  const m1 = candles.filter((c) => c.close > 0 && c.ts < toMs).sort((a, b) => a.ts - b.ts);
  const m5 = aggregate(m1, FIVE, toMs);
  const h4 = aggregate(m1, FOUR_H, toMs);
  const ind = indicatorSeries(m5);
  const m5Index = new Map<number, number>();
  m5.forEach((b, i) => m5Index.set(b.ts, i));
  const biasByH4: BiasAnswer[] = [];
  const donchianByH4: Array<number | null> = [];
  const closes: Array<{ close: number }> = [];
  for (let i = 0; i < h4.length; i++) {
    closes.push({ close: h4[i]!.close });
    biasByH4.push(biasFromFourHour(closes));
    if (i < 20) donchianByH4.push(null);
    else {
      let m = -Infinity;
      for (let k = i - 20; k < i; k++) m = Math.max(m, h4[k]!.high);
      donchianByH4.push(m);
    }
  }
  const bias: BiasAnswer[] = [];
  const close4h: Array<number | null> = [];
  const donchian4h: Array<number | null> = [];
  let h = 0;
  for (const bar of m5) {
    const decision = bar.ts + FIVE;
    while (h < h4.length && h4[h]!.ts + FOUR_H <= decision) h += 1;
    if (h === 0) {
      bias.push({ known: false, up: false, lastClose: null, ema: null });
      close4h.push(null);
      donchian4h.push(null);
    } else {
      bias.push(biasByH4[h - 1]!);
      close4h.push(h4[h - 1]!.close);
      donchian4h.push(donchianByH4[h - 1] ?? null);
    }
  }
  return { pair, m1, m5, h4, ind, m5Index, bias, close4h, donchian4h };
}

function snapshotAt(p: Prepared, i: number): DecisionSnapshot | null {
  const bar = p.m5[i];
  const ind = p.ind[i];
  if (!bar || !ind) return null;
  const prev = i > 0 ? p.m5[i - 1] : undefined;
  const prevInd = i > 0 ? p.ind[i - 1] : undefined;
  let recentLow3 = bar.low;
  for (let k = 1; k <= 2 && i - k >= 0; k++) recentLow3 = Math.min(recentLow3, p.m5[i - k]!.low);
  const bias = p.bias[i] ?? { known: false, up: false, lastClose: null, ema: null };
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
    close4h: p.close4h[i] ?? null,
    donchian4hPriorHigh: p.donchian4h[i] ?? null,
    biasKnown: bias.known,
    biasUp: bias.up,
  };
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export async function runEngine(opts: EngineOpts): Promise<EngineResult> {
  if (opts.variant !== "jev_off" && !opts.jev) {
    throw new Error("not run: needs paid Jev reviews");
  }
  const stage: JevStage = opts.variant === "jev_select" ? 2 : opts.variant === "jev_veto" ? 1 : 0;
  const pairs = opts.enabledPairs.map((pair) => prepare(pair, opts.candles[pair] ?? [], opts.toMs));
  const session = new PaperSession({
    stage: opts.stage ?? stage,
    jev: opts.jev ?? null,
    store: new MemoryStore(null),
    state: blankAllocator(opts.mode, opts.formula),
    book: freshBook(opts.enabledPairs, opts.sentiment),
    enabledPairs: opts.enabledPairs,
    atrByPair: {},
    jevOff: opts.variant === "jev_off",
  });
  session.opts.store.retain = false;

  let cash = STARTING_BUDGET_USD;
  let fees = 0;
  let peak = STARTING_BUDGET_USD;
  let maxDd = 0;
  let fromStartDd = 0;
  let ideas = 0;
  let fills = 0;
  let trades = 0;
  const quarters = new Map<string, number>();
  const rejects: Record<string, number> = {};
  const exits: Record<string, number> = {};
  const positions = new Map<string, Position>();
  const resting = new Map<string, LiveOrder>();
  const reservedLeft = new Map<string, number>();
  const pendingNet = new Map<string, number>();
  const lastPx = new Map<string, number>();
  const ptr = pairs.map(() => 0);
  for (let i = 0; i < pairs.length; i++) {
    const series = pairs[i]!;
    while (ptr[i]! < series.m1.length && series.m1[ptr[i]!]!.ts < opts.fromMs) ptr[i]! += 1;
  }
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
    session.opts.book.equityUsd = eq;
    session.opts.book.allocatableUsd = Math.max(0, cash - RESERVE_USD);
    return eq;
  };
  const addNet = (ts: number, net: number) => {
    const q = quarterKey(ts);
    quarters.set(q, (quarters.get(q) ?? 0) + net);
  };
  const dropReserve = (pair: string, amount: number) => {
    if (!(amount > 0)) return;
    session.opts.state = release(session.opts.state, pair, amount);
    session.opts.book.openNotionalUsd = Math.max(0, session.opts.book.openNotionalUsd - amount);
    const left = (reservedLeft.get(pair) ?? 0) - amount;
    if (left <= 1e-6) reservedLeft.delete(pair);
    else reservedLeft.set(pair, left);
  };
  const refreshBusy = () => {
    const busy = new Set<string>([...positions.keys(), ...resting.keys()]);
    session.opts.book.openPairs = [...busy];
    session.opts.book.openCount = positions.size;
    session.opts.book.restingCount = resting.size;
  };
  const book = session.opts.book;

  let guard = 0;
  const guardMax = pairs.reduce((s, p) => s + p.m1.length, 0) + 10;
  while (guard++ < guardMax) {
    let ts = Infinity;
    for (let i = 0; i < pairs.length; i++) {
      const series = pairs[i]!;
      const at = ptr[i]!;
      if (at < series.m1.length && series.m1[at]!.ts < ts) ts = series.m1[at]!.ts;
    }
    if (!Number.isFinite(ts) || ts >= opts.toMs) break;
    const batch: number[] = [];
    for (let i = 0; i < pairs.length; i++) {
      const series = pairs[i]!;
      if (ptr[i]! < series.m1.length && series.m1[ptr[i]!]!.ts === ts) batch.push(i);
    }
    const day = utcDayKey(ts);
    if (day !== utcDay) {
      utcDay = day;
      book.lossesTodayUtc = 0;
      book.rTodayUtc = 0;
      book.realizedUsdTodayUtc = 0;
    }
    const local = ctDayKey(ts);
    if (local !== ctDay) {
      ctDay = local;
      book.ideasTodayCt = 0;
    }

    for (const i of batch) {
      const series = pairs[i]!;
      const bar = series.m1[ptr[i]!]!;
      const prevTs = ptr[i]! > 0 ? series.m1[ptr[i]! - 1]!.ts : null;
      const gap = gapExceeds(prevTs, bar.ts, 120);
      lastPx.set(series.pair, bar.close);
      const fiveOpen = Math.floor(bar.ts / FIVE) * FIVE;
      const fiveComplete = bar.ts === fiveOpen + 4 * ONE;
      const fiveIdx = fiveComplete ? (series.m5Index.get(fiveOpen) ?? -1) : -1;
      const five = fiveIdx >= 0 ? series.m5[fiveIdx] : undefined;
      const ind = fiveIdx >= 0 ? series.ind[fiveIdx] : undefined;
      const swing = fiveIdx >= 1 ? latestSwingLow(series.m5, fiveIdx) : null;

      const pos = positions.get(series.pair);
      if (pos) {
        const stepped = stepPosition(pos, bar, {
          gapSec: gap ? (bar.ts - (prevTs ?? bar.ts)) / 1000 : 0,
          fiveMinComplete: fiveComplete && five != null,
          fiveMinClose: five?.close ?? null,
          vwap: ind?.vwap ?? null,
          confirmedSwingLow: swing,
        });
        for (const ev of stepped.events) {
          cash += ev.units * ev.price - ev.feeUsd;
          fees += ev.feeUsd;
          addNet(bar.ts, ev.netUsd);
          book.realizedUsdTodayUtc += ev.netUsd;
          book.rTodayUtc += ev.rMultiple;
          if (ev.kind === "t1") pendingNet.set(pos.id, (pendingNet.get(pos.id) ?? 0) + ev.netUsd);
          if (ev.kind === "exit") {
            const total = (pendingNet.get(pos.id) ?? 0) + ev.netUsd;
            pendingNet.delete(pos.id);
            trades += 1;
            bump(exits, ev.reason);
            if (total < 0) {
              book.lossesTodayUtc += 1;
              book.pairLossUsd[series.pair] = (book.pairLossUsd[series.pair] ?? 0) + -total;
            }
            dropReserve(series.pair, reservedLeft.get(series.pair) ?? 0);
          }
        }
        if (stepped.position) positions.set(series.pair, stepped.position);
        else positions.delete(series.pair);
      }

      const live = resting.get(series.pair);
      if (live && !positions.has(series.pair)) {
        const filled = fillRestingBuy(live.order, bar);
        live.order = filled.order;
        if (filled.event.status === "partial" || filled.event.status === "filled") {
          live.filledUnits += filled.event.units;
          live.filledFee += filled.event.feeUsd;
          fees += filled.event.feeUsd;
          cash -= filled.event.units * filled.event.price + filled.event.feeUsd;
          fills += 1;
        }
        const done =
          filled.event.status === "cancel" || filled.event.status === "filled" || live.order.unitsRemaining <= 1e-12;
        if (done) {
          resting.delete(series.pair);
          const used = live.filledUnits * live.order.limit;
          const unused = live.reserved - used;
          if (unused > 1e-6) dropReserve(series.pair, unused);
          if (live.filledUnits > 0) {
            reservedLeft.set(series.pair, used);
            const posNew = openPosition({
              id: live.candidate.id,
              pair: series.pair,
              entry: live.order.limit,
              units: live.filledUnits,
              stop: live.stop,
              openedTs: bar.ts,
              entryFeeUsd: live.filledFee,
            });
            const managed = stepPosition(posNew, bar, {
              gapSec: 0,
              fiveMinComplete: false,
              fiveMinClose: null,
              vwap: null,
              confirmedSwingLow: null,
            });
            for (const ev of managed.events) {
              cash += ev.units * ev.price - ev.feeUsd;
              fees += ev.feeUsd;
              addNet(bar.ts, ev.netUsd);
              book.realizedUsdTodayUtc += ev.netUsd;
              book.rTodayUtc += ev.rMultiple;
              if (ev.kind === "exit") {
                trades += 1;
                bump(exits, ev.reason);
                if (ev.netUsd < 0) {
                  book.lossesTodayUtc += 1;
                  book.pairLossUsd[series.pair] = (book.pairLossUsd[series.pair] ?? 0) + -ev.netUsd;
                }
                dropReserve(series.pair, reservedLeft.get(series.pair) ?? 0);
              }
            }
            if (managed.position) positions.set(series.pair, managed.position);
            else reservedLeft.delete(series.pair);
          }
        }
      }
    }

    noteEquity();
    refreshBusy();

    for (const i of batch) {
      const series = pairs[i]!;
      const bar = series.m1[ptr[i]!]!;
      const fiveOpen = Math.floor(bar.ts / FIVE) * FIVE;
      if (bar.ts !== fiveOpen + 4 * ONE) continue;
      if (positions.has(series.pair) || resting.has(series.pair)) continue;
      const fiveIdx = series.m5Index.get(fiveOpen);
      if (fiveIdx == null) continue;
      const decisionTs = fiveOpen + FIVE;
      const decisionUtc = utcDayKey(decisionTs);
      if (decisionUtc !== utcDay) {
        utcDay = decisionUtc;
        book.lossesTodayUtc = 0;
        book.rTodayUtc = 0;
        book.realizedUsdTodayUtc = 0;
      }
      const decisionCt = ctDayKey(decisionTs);
      if (decisionCt !== ctDay) {
        ctDay = decisionCt;
        book.ideasTodayCt = 0;
      }
      const snap = snapshotAt(series, fiveIdx);
      if (!snap || snap.atr == null || !(snap.atr > 0)) continue;
      session.opts.atrByPair[series.pair] = snap.atr;
      const setups = findSetups(snap, opts.sentiment, opts.strategy);
      for (const candidate of setups) {
        const packet: PacketInput = {
          asOf: decisionTs,
          pair: candidate.pair,
          setup: candidate.setup,
          barTs: candidate.barTs,
          candidateId: candidate.id,
          biasUp: snap.biasUp,
          close: snap.close,
          stop: candidate.stop,
          atr: snap.atr,
          rsi: snap.rsi,
          vwap: snap.vwap,
          sentiment: opts.sentiment,
          barTsList: [candidate.barTs],
        };
        buildPacket(packet);
        const admission = await session.consider(candidate, packet, decisionTs);
        if (!admission.admitted) {
          for (const reason of admission.failed) bump(rejects, reason);
          continue;
        }
        ideas += 1;
        const notional = session.proposedNotional(series.pair);
        const units = notional / candidate.entry;
        resting.set(series.pair, {
          order: newEntryOrder(candidate.id, series.pair, candidate.entry, units, decisionTs),
          reserved: notional,
          stop: candidate.stop,
          filledUnits: 0,
          filledFee: 0,
          candidate,
        });
        reservedLeft.set(series.pair, notional);
        refreshBusy();
        break;
      }
    }

    for (const i of batch) ptr[i]! += 1;
  }

  for (const pos of [...positions.values()]) {
    const px = lastPx.get(pos.pair) ?? pos.entry;
    const fee = (pos.units * px * TAKER_FEE_BPS) / 10_000;
    const entryAlloc = pos.initialUnits > 0 ? pos.entryFeeUsd * (pos.units / pos.initialUnits) : 0;
    const net = pos.units * px - fee - pos.units * pos.entry - entryAlloc;
    cash += pos.units * px - fee;
    fees += fee;
    trades += 1;
    addNet(opts.toMs - 1, net);
    bump(exits, "window_end");
    if (net < 0) {
      book.pairLossUsd[pos.pair] = (book.pairLossUsd[pos.pair] ?? 0) + -net;
    }
    positions.delete(pos.pair);
  }
  const ending = noteEquity();
  const quarterRows = [...quarters.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([quarter, netUsd]) => ({ quarter, netUsd }));
  return {
    variant: opts.variant,
    mode: opts.mode,
    formula: opts.formula,
    strategy: opts.strategy,
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
    quarters: quarterRows,
    rejects,
    exits,
  };
}
