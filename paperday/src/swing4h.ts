/**
 * swing_4h. Daily bias, 4h signal, maker entry on the 1h close that coincides
 * with the 4h close, 120s cancel, no cross. Stop is the wider of the 4h swing
 * low and k × 4h ATR14. Target is the registered R, or the next daily swing
 * high when that high is nearer. Holds are 48h or 96h.
 */

import {
  DAILY_LOSS_HALT_USD,
  PAIR_LOSS_HALT_USD,
  RESERVE_USD,
  STARTING_BUDGET_USD,
  SWING_MAX_HOLD_MS,
  TAKER_FEE_BPS,
  swingEntryAllowed,
  type StrategyId,
} from "./config";
import { aggregate, type Candle } from "./bars";
import { biasEmaNext } from "./bias";
import { ctDayKey, quarterKey, utcDayKey } from "./clock";
import { belowFeeFloor, type ClosedSample } from "./expectancy";
import { stopBpsOf } from "./fees";
import { fillRestingBuy, newEntryOrder } from "./fill";
import { confirmedSwingLow, emaSeries, indicatorSeries, nearestSwingHighAbove, type IndicatorPoint } from "./indicators";
import { buildPacket, type PacketInput } from "./jev";
import { freshBook, PaperSession } from "./pipeline";
import { openPosition, rMultiple, stepPosition, type Position } from "./position";
import { findSetups, type Candidate, type DecisionSnapshot } from "./rules";
import { blankAllocator, release } from "./allocator";
import { MemoryStore } from "./store";
import type { EngineResult } from "./engine";
import type { HigherOpts, QualifiedIdea } from "./higher";
import { lossToStopUsd, overnightRiskUsd, searchSwingTarget, swingFloor, swingStop } from "./swing";
import { proxyAt } from "./proxy";

const H1 = 3_600_000;
const H4 = 14_400_000;
const D1 = 86_400_000;

interface Pair4h {
  pair: string;
  m1: Candle[];
  h1: Candle[];
  h4: Candle[];
  d1: Candle[];
  ind4: IndicatorPoint[];
  h4Swing: Array<number | null>;
  dailyUp: boolean[];
  h1Index: Map<number, number>;
  h4Index: Map<number, number>;
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

const preparedCache = new Map<string, Pair4h>();

function prepare(pair: string, candles: Candle[], toMs: number): Pair4h {
  const key = `${pair}|${toMs}|${candles.length}|${candles[0]?.ts ?? 0}`;
  const hit = preparedCache.get(key);
  if (hit) return hit;
  const m1 = candles.filter((c) => c.close > 0 && c.ts < toMs).sort((a, b) => a.ts - b.ts);
  const h1 = aggregate(m1, H1, toMs);
  const h4 = aggregate(m1, H4, toMs);
  const d1 = aggregate(m1, D1, toMs);
  const ind4 = indicatorSeries(h4);
  const ema50 = emaSeries(d1.map((b) => b.close), 50);
  const ema200 = emaSeries(d1.map((b) => b.close), 200);
  const dailyUp: boolean[] = [];
  for (let i = 0; i < d1.length; i++) {
    const prev = i > 0 ? d1[i - 1] : undefined;
    dailyUp.push(i >= 199 && ema200[i] != null && ema50[i] != null && prev != null && d1[i]!.close > ema50[i]! && d1[i]!.close > prev.close);
  }
  const h4Swing: Array<number | null> = new Array(h4.length).fill(null);
  let lastLow: number | null = null;
  for (let i = 0; i < h4.length; i++) {
    if (i >= 1) {
      const low = confirmedSwingLow(h4, i - 1);
      if (low != null) lastLow = low;
    }
    h4Swing[i] = lastLow;
  }
  const h1Index = new Map<number, number>();
  h1.forEach((b, i) => h1Index.set(b.ts, i));
  const h4Index = new Map<number, number>();
  h4.forEach((b, i) => h4Index.set(b.ts, i));
  const built = { pair, m1, h1, h4, d1, ind4, h4Swing, dailyUp, h1Index, h4Index };
  preparedCache.set(key, built);
  return built;
}

function snapshot4(p: Pair4h, h4i: number, d1i: number): DecisionSnapshot | null {
  const bar = p.h4[h4i];
  const ind = p.ind4[h4i];
  if (!bar || !ind) return null;
  const prev = h4i > 0 ? p.h4[h4i - 1] : undefined;
  const prevInd = h4i > 0 ? p.ind4[h4i - 1] : undefined;
  let recentLow3 = bar.low;
  for (let k = 1; k <= 2 && h4i - k >= 0; k++) recentLow3 = Math.min(recentLow3, p.h4[h4i - k]!.low);
  const donchian = ind.donchian20PriorHigh;
  const daily = d1i >= 0 && p.dailyUp[d1i] === true;
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
    donchian5mPriorHigh: donchian,
    close4h: bar.close,
    donchian4hPriorHigh: donchian,
    biasKnown: daily,
    biasUp: daily,
  };
}

function zero(opts: HigherOpts, rejects: Record<string, number>, stopsByPair: Record<string, number[]>, qualified: number): EngineResult {
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
    stopsByPair,
    pairHaltBreached: false,
    dailyHaltBreached: false,
    wins: 0,
    avgR: null,
    qualified,
    entryAttempts: 0,
    entryFills: 0,
    entryTimeouts: 0,
  };
}

export async function runSwing4h(opts: HigherOpts): Promise<EngineResult> {
  if (opts.variant !== "jev_off" && !opts.jevAdmit) throw new Error("not run: needs paid Jev reviews");
  if (!swingEntryAllowed(opts.swingApproved)) return zero(opts, { swing_not_approved: 1 }, {}, 0);
  const pairs = opts.enabledPairs.map((pair) => {
    const prepared = opts.prepared?.find((p) => p.pair === pair);
    if (prepared) return prepare(pair, prepared.m1, opts.toMs);
    return prepare(pair, opts.candles[pair] ?? [], opts.toMs);
  });
  const session = new PaperSession({
    stage: 0,
    jev: null,
    store: new MemoryStore(null),
    state: blankAllocator(opts.mode, opts.formula),
    book: { ...freshBook(opts.enabledPairs, "clear"), enforceActivityWindow: opts.activityWindow !== false },
    enabledPairs: opts.enabledPairs,
    atrByPair: {},
    jevOff: true,
  });
  session.opts.store.retain = false;
  const book = () => session.opts.book;
  const rule: StrategyId = "combined";
  const k = opts.stopAtrMult ?? 1.5;
  const targetR = opts.targetR ?? 3;

  let cash = STARTING_BUDGET_USD;
  let fees = 0;
  let peak = STARTING_BUDGET_USD;
  let maxDd = 0;
  let ideas = 0;
  let fills = 0;
  let trades = 0;
  let wins = 0;
  let rSum = 0;
  let pairHalt = false;
  let dailyHalt = false;
  let qualified = 0;
  let entryAttempts = 0;
  let entryFills = 0;
  let entryTimeouts = 0;
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

  const recordStops = (series: Pair4h, h4i: number, decisionTs: number) => {
    const d1i = lastClosed(series.d1, D1, decisionTs);
    const snap = snapshot4(series, h4i, d1i);
    if (!snap || snap.atr == null || !(snap.atr > 0) || !snap.biasUp) return [];
    const out: Array<{ setup: Candidate; stop: number; stopBps: number; targetBps: number; targetPx: number; snap: DecisionSnapshot }> = [];
    for (const setup of findSetups(snap, "clear", rule)) {
      const geom = swingStop(setup.entry, series.h4Swing[h4i] ?? null, snap.atr, k);
      if (!geom) {
        bump(rejects, "no_structure");
        continue;
      }
      const nextHigh = d1i >= 0 ? nearestSwingHighAbove(series.d1, d1i, setup.entry) : null;
      const targetPx = searchSwingTarget(setup.entry, geom.stop, targetR, nextHigh);
      const floor = swingFloor(setup.entry, geom.stop, targetPx);
      (stopsByPair[series.pair] ??= []).push(floor.stopBps);
      if (!floor.pass || belowFeeFloor(floor.stopBps, floor.targetBps)) {
        bump(rejects, "below_fee_floor");
        continue;
      }
      qualified += 1;
      out.push({ setup, stop: geom.stop, stopBps: floor.stopBps, targetBps: floor.targetBps, targetPx, snap });
    }
    return out;
  };

  if (opts.geometryOnly) {
    for (const series of pairs) {
      for (let h4i = 0; h4i < series.h4.length; h4i++) {
        const decisionTs = series.h4[h4i]!.ts + H4;
        if (decisionTs <= opts.fromMs || decisionTs > opts.toMs) continue;
        recordStops(series, h4i, decisionTs);
      }
    }
    return zero(opts, rejects, stopsByPair, qualified);
  }

  const events: Array<{ i: number; h1i: number }> = [];
  for (let i = 0; i < pairs.length; i++) {
    const series = pairs[i]!;
    for (let h1i = 0; h1i < series.h1.length; h1i++) {
      const bar = series.h1[h1i]!;
      if (bar.ts + H1 <= opts.fromMs || bar.ts + H1 > opts.toMs) continue;
      events.push({ i, h1i });
    }
  }
  events.sort((a, b) => pairs[a.i]!.h1[a.h1i]!.ts - pairs[b.i]!.h1[b.h1i]!.ts || a.i - b.i);

  const noteEquity = () => {
    let eq = cash;
    for (const pos of positions.values()) eq += pos.units * (lastPx.get(pos.pair) ?? pos.entry);
    if (eq > peak) peak = eq;
    maxDd = Math.max(maxDd, peak - eq);
    book().equityUsd = eq;
    book().allocatableUsd = Math.max(0, cash - RESERVE_USD);
    return eq;
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

  for (const ev of events) {
    const series = pairs[ev.i]!;
    const bar = series.h1[ev.h1i]!;
    const decisionTs = bar.ts + H1;
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
    const prev = ev.h1i > 0 ? series.h1[ev.h1i - 1] : undefined;
    const missingSec = prev ? (bar.ts - prev.ts - H1) / 1000 : 0;
    const pos = positions.get(series.pair);
    if (pos) {
      const h1Swing = ev.h1i >= 2 ? confirmedSwingLow(series.h1, ev.h1i - 1) : null;
      const stepped = stepPosition(pos, bar, {
        gapSec: missingSec > 0 ? missingSec : 0,
        fiveMinComplete: false,
        fiveMinClose: null,
        vwap: null,
        confirmedSwingLow: h1Swing,
        barMs: H1,
      });
      for (const event of stepped.events) {
        cash += event.units * event.price - event.feeUsd;
        fees += event.feeUsd;
        const q = quarterKey(bar.ts);
        quarters.set(q, (quarters.get(q) ?? 0) + event.netUsd);
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
          samples.push({
            closeTs: bar.ts,
            stopBps: pos.plannedStopBps ?? stopBpsOf(pos.entry, pos.initialStop),
            targetBps: pos.plannedTargetBps ?? 0,
            win: total > 0,
            rMultiple: rMultiple(total, pos.entry, pos.initialStop, pos.initialUnits),
          });
          rSum += samples[samples.length - 1]!.rMultiple;
          if (total > 0) wins += 1;
          trades += 1;
          if (book().realizedUsdTodayUtc <= -DAILY_LOSS_HALT_USD) dailyHalt = true;
          if ((book().pairLossUsd[series.pair] ?? 0) >= PAIR_LOSS_HALT_USD) pairHalt = true;
          dropReserve(series.pair, reservedLeft.get(series.pair) ?? 0);
        }
      }
      if (stepped.position) positions.set(series.pair, stepped.position);
      else positions.delete(series.pair);
    }
    noteEquity();
    refreshBusy();
    if (decisionTs % H4 !== 0) continue;
    if (positions.has(series.pair)) continue;
    const h4i = series.h4Index.get(decisionTs - H4);
    if (h4i == null) continue;
    const proxy = opts.sentimentMode === "market_proxy" && opts.proxy ? proxyAt(opts.proxy, series.pair, decisionTs) : null;
    const ideasHere = recordStops(series, h4i, decisionTs);
    interface Ready {
      id: string;
      setup: Candidate;
      stop: number;
      stopBps: number;
      targetBps: number;
      targetPx: number;
      atr: number;
      rsi: number | null;
      vwap: number | null;
    }
    const ready: Ready[] = [];
    for (const idea of ideasHere) {
      if (proxy?.veto || (proxy?.caution && (idea.setup.setup !== "A" || (cautionIdeas.get(series.pair) ?? 0) >= 1))) {
        bump(rejects, "sentiment");
        continue;
      }
      ready.push({
        id: idea.setup.id,
        setup: idea.setup,
        stop: idea.stop,
        stopBps: idea.stopBps,
        targetBps: idea.targetBps,
        targetPx: idea.targetPx,
        atr: idea.snap.atr!,
        rsi: idea.snap.rsi,
        vwap: idea.snap.vwap,
      });
    }
    if (ready.length >= 2) opts.jevAdmit?.onChoice(ready.length);
    const ordered = opts.jevAdmit ? opts.jevAdmit.order(ready) : ready;
    for (const item of ordered) {
      if (opts.jevAdmit && !opts.jevAdmit.allow(item.id)) {
        bump(rejects, "jev");
        continue;
      }
      const qualifiedIdea: QualifiedIdea = {
        id: item.id,
        pair: series.pair,
        setup: item.setup.setup,
        barTs: item.setup.barTs,
        asOf: decisionTs,
        entry: item.setup.entry,
        stop: item.stop,
        atr: item.atr,
        rsi: item.rsi,
        vwap: item.vwap,
        biasUp: true,
      };
      opts.onQualified?.(qualifiedIdea);
      session.opts.atrByPair[series.pair] = item.atr;
      const notional = session.proposedNotional(series.pair);
      const unitsPlanned = item.setup.entry > 0 ? notional / item.setup.entry : 0;
      const candidate: Candidate = {
        ...item.setup,
        stop: item.stop,
        plannedTargetBps: item.targetBps,
        entryProfile: "swing",
        lossToStopUsd: lossToStopUsd(item.setup.entry, item.stop, unitsPlanned),
        targetPrice: item.targetPx,
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
        atr: item.atr,
        rsi: item.rsi,
        vwap: item.vwap,
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
      entryAttempts += 1;
      const order = newEntryOrder(candidate.id, series.pair, candidate.entry, unitsPlanned, decisionTs);
      let filledUnits = 0;
      let filledFee = 0;
      let live = order;
      let p = m1Ptr[ev.i] ?? 0;
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
      if (notional - used > 1e-6) dropReserve(series.pair, notional - used);
      if (!(filledUnits > 0)) {
        entryTimeouts += 1;
        refreshBusy();
        break;
      }
      entryFills += 1;
      reservedLeft.set(series.pair, used);
      positions.set(
        series.pair,
        openPosition({
          id: candidate.id,
          pair: series.pair,
          entry: candidate.entry,
          units: filledUnits,
          stop: item.stop,
          openedTs: decisionTs,
          entryFeeUsd: filledFee,
          target2Price: item.targetPx,
          maxHoldMs: opts.maxHoldMs ?? SWING_MAX_HOLD_MS,
          flatAtMidnight: false,
          vwapExit: false,
          plannedStopBps: item.stopBps,
          plannedTargetBps: item.targetBps,
        }),
      );
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
    bump(exits, "window_end");
    samples.push({
      closeTs: opts.toMs - 1,
      stopBps: pos.plannedStopBps ?? 0,
      targetBps: pos.plannedTargetBps ?? 0,
      win: net > 0,
      rMultiple: rMultiple(net, pos.entry, pos.initialStop, pos.initialUnits),
    });
    rSum += samples[samples.length - 1]!.rMultiple;
    if (net > 0) wins += 1;
    trades += 1;
    if (net < 0) book().pairLossUsd[pos.pair] = (book().pairLossUsd[pos.pair] ?? 0) + -net;
    if ((book().pairLossUsd[pos.pair] ?? 0) >= PAIR_LOSS_HALT_USD) pairHalt = true;
    positions.delete(pos.pair);
  }
  const ending = noteEquity();
  return {
    variant: opts.variant,
    mode: opts.mode,
    formula: opts.formula,
    strategy: "combined",
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    netUsd: ending - STARTING_BUDGET_USD,
    maxDrawdownUsd: maxDd,
    fromStartDrawdownUsd: Math.max(0, STARTING_BUDGET_USD - ending),
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
    qualified,
    entryAttempts,
    entryFills,
    entryTimeouts,
  };
}
