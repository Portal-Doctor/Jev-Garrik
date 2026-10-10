/**
 * Repo 4h breakout through the paper book.
 * Stop S and take-profit T come from cb/books.ts. The fee floor sees that pair.
 * A take-profit exit is maker. A trail, stop, or 14-day exit is taker.
 * The Jul-Sep sanity replay calls cb/breakout.ts with the book clips and is not the search row.
 */

import { bookFor } from "../../cb/books";
import { runBreakout } from "../../cb/breakout";
import {
  BREAKOUT_ATR_BARS,
  BREAKOUT_BARS,
  BREAKOUT_EMA_BARS,
  BREAKOUT_MAX_HOLD_MS,
  BREAKOUT_TRAIL_ATR,
  DAILY_LOSS_HALT_USD,
  PAIR_LOSS_HALT_USD,
  RESERVE_USD,
  STARTING_BUDGET_USD,
  TAKER_FEE_BPS,
} from "./config";
import { aggregate, type Candle } from "./bars";
import { biasEmaNext } from "./bias";
import { quarterKey, utcDayKey, ctDayKey } from "./clock";
import { perTradeFloor } from "./fees";
import { fillRestingBuy, newEntryOrder } from "./fill";
import { trueRange } from "./indicators";
import { buildPacket, type PacketInput } from "./jev";
import { freshBook, PaperSession } from "./pipeline";
import { rMultiple, type Position } from "./position";
import type { Candidate } from "./rules";
import { blankAllocator, release } from "./allocator";
import { MemoryStore } from "./store";
import type { EngineResult } from "./engine";
import type { HigherOpts } from "./higher";
import { lossToStopUsd, overnightRiskUsd } from "./swing";
import { proxyAt } from "./proxy";
import type { ClosedSample } from "./expectancy";

const M5 = 300_000;
const H4 = 14_400_000;

interface OpenBreakout {
  pos: Position;
  trail: number;
  tp: number;
  reserved: number;
  highest: number;
  lastH4: number;
}

function bump(map: Record<string, number>, key: string): void {
  map[key] = (map[key] ?? 0) + 1;
}

export async function runBreakoutPaper(opts: HigherOpts): Promise<EngineResult> {
  if (opts.variant !== "jev_off" && !opts.jevAdmit) throw new Error("not run: needs paid Jev reviews");
  const session = new PaperSession({
    stage: 0,
    jev: null,
    store: new MemoryStore(null),
    state: blankAllocator(opts.mode, opts.formula),
    book: { ...freshBook(opts.enabledPairs, "clear"), enforceActivityWindow: false },
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
  let trades = 0;
  let wins = 0;
  let rSum = 0;
  let ideas = 0;
  let fills = 0;
  let qualified = 0;
  let entryAttempts = 0;
  let entryFills = 0;
  let entryTimeouts = 0;
  let pairHalt = false;
  let dailyHalt = false;
  const quarters = new Map<string, number>();
  const rejects: Record<string, number> = {};
  const exits: Record<string, number> = {};
  const samples: ClosedSample[] = [];
  const stopsByPair: Record<string, number[]> = {};
  const positions = new Map<string, OpenBreakout>();
  const lastPx = new Map<string, number>();

  interface Series {
    pair: string;
    m1: Candle[];
    m5: Candle[];
    h4: Candle[];
    atrAt: Array<number | null>;
    m1From: number;
  }
  const series: Series[] = opts.enabledPairs.map((pair) => {
    const m1 = (opts.candles[pair] ?? []).filter((c) => c.close > 0 && c.ts < opts.toMs).sort((a, b) => a.ts - b.ts);
    return { pair, m1, m5: aggregate(m1, M5, opts.toMs), h4: aggregate(m1, H4, opts.toMs), atrAt: [], m1From: 0 };
  });

  interface Signal {
    i: number;
    h4i: number;
    closeTs: number;
    close: number;
    atr: number;
  }
  const signals: Signal[] = [];
  for (let i = 0; i < series.length; i++) {
    const s = series[i]!;
    let ema: number | null = null;
    let emaSamples = 0;
    let atr: number | null = null;
    let atrWarm = false;
    const atrSeed: number[] = [];
    let prevClose: number | null = null;
    const highs: number[] = [];
    for (let h = 0; h < s.h4.length; h++) {
      const bar = s.h4[h]!;
      const prior = highs.length >= BREAKOUT_BARS ? Math.max(...highs.slice(-BREAKOUT_BARS)) : null;
      ema = biasEmaNext(ema, bar.close, BREAKOUT_EMA_BARS);
      emaSamples += 1;
      const tr = trueRange(bar.high, bar.low, prevClose);
      if (!atrWarm) {
        atrSeed.push(tr);
        if (atrSeed.length >= BREAKOUT_ATR_BARS) {
          atr = atrSeed.reduce((sum, x) => sum + x, 0) / BREAKOUT_ATR_BARS;
          atrWarm = true;
        }
      } else if (atr != null) atr = (atr * (BREAKOUT_ATR_BARS - 1) + tr) / BREAKOUT_ATR_BARS;
      const closeTs = bar.ts + H4;
      const ready = prior != null && emaSamples >= BREAKOUT_EMA_BARS && atrWarm && atr != null && ema != null;
      s.atrAt[h] = atr;
      if (ready && closeTs >= opts.fromMs && closeTs < opts.toMs && bar.close > prior && bar.close > ema) {
        signals.push({ i, h4i: h, closeTs, close: bar.close, atr: atr! });
      }
      highs.push(bar.high);
      prevClose = bar.close;
    }
  }
  if (opts.geometryOnly) {
    for (const signal of signals) {
      const pair = series[signal.i]!.pair;
      const planned = bookFor(pair);
      (stopsByPair[pair] ??= []).push(planned.stopLossBps);
      const floor = perTradeFloor(planned.stopLossBps, planned.takeProfitBps);
      if (!floor.pass) bump(rejects, "below_fee_floor");
      else qualified += 1;
    }
    return {
      variant: "jev_off",
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
  signals.sort((a, b) => a.closeTs - b.closeTs || a.i - b.i);

  const events: Array<{ i: number; m5i: number }> = [];
  for (let i = 0; i < series.length; i++) {
    const s = series[i]!;
    for (let m5i = 0; m5i < s.m5.length; m5i++) {
      const bar = s.m5[m5i]!;
      if (bar.ts + M5 <= opts.fromMs || bar.ts + M5 > opts.toMs) continue;
      events.push({ i, m5i });
    }
  }
  events.sort((a, b) => series[a.i]!.m5[a.m5i]!.ts - series[b.i]!.m5[b.m5i]!.ts || a.i - b.i);

  let sig = 0;
  let choiceTs = -1;
  let choiceN = 0;
  const flushChoice = () => {
    if (choiceN >= 2) opts.jevAdmit?.onChoice(choiceN);
    choiceN = 0;
    choiceTs = -1;
  };
  let utcDay = "";
  let ctDay = "";
  const noteEquity = () => {
    let eq = cash;
    for (const open of positions.values()) eq += open.pos.units * (lastPx.get(open.pos.pair) ?? open.pos.entry);
    if (eq > peak) peak = eq;
    maxDd = Math.max(maxDd, peak - eq);
    book().equityUsd = eq;
    book().allocatableUsd = Math.max(0, cash - RESERVE_USD);
    return eq;
  };
  const refreshBusy = () => {
    book().openPairs = [...positions.keys()];
    book().openCount = positions.size;
    book().restingCount = 0;
  };
  const dropReserve = (pair: string, amount: number) => {
    if (!(amount > 0)) return;
    session.opts.state = release(session.opts.state, pair, amount);
    book().openNotionalUsd = Math.max(0, book().openNotionalUsd - amount);
  };
  const onExit = (open: OpenBreakout, ts: number, net: number, reason: string) => {
    samples.push({
      closeTs: ts,
      stopBps: open.pos.plannedStopBps ?? 0,
      targetBps: open.pos.plannedTargetBps ?? 0,
      win: net > 0,
      rMultiple: rMultiple(net, open.pos.entry, open.pos.initialStop, open.pos.initialUnits),
    });
    rSum += samples[samples.length - 1]!.rMultiple;
    if (net > 0) wins += 1;
    trades += 1;
    bump(exits, reason);
    const q = quarterKey(ts);
    quarters.set(q, (quarters.get(q) ?? 0) + net);
    book().realizedUsdTodayUtc += net;
    if (net < 0) {
      book().lossesTodayUtc += 1;
      book().pairLossUsd[open.pos.pair] = (book().pairLossUsd[open.pos.pair] ?? 0) + -net;
      if (book().realizedUsdTodayUtc <= -DAILY_LOSS_HALT_USD) dailyHalt = true;
      if ((book().pairLossUsd[open.pos.pair] ?? 0) >= PAIR_LOSS_HALT_USD) pairHalt = true;
    }
    dropReserve(open.pos.pair, open.reserved);
    positions.delete(open.pos.pair);
  };

  const stepOpen = (s: Series, bar: Candle) => {
    const open = positions.get(s.pair);
    if (!open) return;
    lastPx.set(s.pair, bar.close);
    const stopPx = Math.max(open.pos.initialStop, open.trail);
    let exitPx: number | null = null;
    let reason = "stop";
    let feeBps = TAKER_FEE_BPS;
    if (bar.low <= stopPx) {
      exitPx = bar.open < stopPx ? bar.open : stopPx;
      reason = open.trail > open.pos.initialStop ? "trail" : "stop";
    } else if (bar.high >= open.tp) {
      exitPx = open.tp;
      reason = "t2";
      feeBps = 50;
    } else if (bar.ts + M5 >= open.pos.openedTs + BREAKOUT_MAX_HOLD_MS) {
      exitPx = bar.close;
      reason = "max_hold";
    }
    if (exitPx == null) return;
    const fee = (open.pos.units * exitPx * feeBps) / 10_000;
    const entryAlloc = open.pos.entryFeeUsd;
    const net = open.pos.units * exitPx - fee - open.pos.units * open.pos.entry - entryAlloc;
    cash += open.pos.units * exitPx - fee;
    fees += fee;
    onExit(open, bar.ts, net, reason);
  };

  const refreshTrail = (s: Series, open: OpenBreakout, closeTs: number) => {
    while (open.lastH4 + 1 < s.h4.length && s.h4[open.lastH4 + 1]!.ts + H4 <= closeTs) {
      open.lastH4 += 1;
      const bar = s.h4[open.lastH4]!;
      open.highest = Math.max(open.highest, bar.close);
      const atr = s.atrAt[open.lastH4];
      if (atr != null) open.trail = Math.max(open.trail, open.highest - BREAKOUT_TRAIL_ATR * atr);
    }
  };

  const isLastAtTs = events.map((_, k) => {
    if (k + 1 >= events.length) return true;
    const ts = series[events[k]!.i]!.m5[events[k]!.m5i]!.ts;
    const next = series[events[k + 1]!.i]!.m5[events[k + 1]!.m5i]!.ts;
    return ts !== next;
  });
  for (let idx = 0; idx < events.length; idx++) {
    const ev = events[idx]!;
    const s = series[ev.i]!;
    const bar = s.m5[ev.m5i]!;
    const closeTs = bar.ts + M5;
    lastPx.set(s.pair, bar.close);
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
    }
    const open = positions.get(s.pair);
    if (open) refreshTrail(s, open, closeTs);
    stepOpen(s, bar);
    noteEquity();
    refreshBusy();

    while (isLastAtTs[idx] && sig < signals.length && signals[sig]!.closeTs <= closeTs) {
      const signal = signals[sig]!;
      sig += 1;
      const s = series[signal.i]!;
      if (positions.has(s.pair)) continue;
      const planned = bookFor(s.pair);
      (stopsByPair[s.pair] ??= []).push(planned.stopLossBps);
      const floor = perTradeFloor(planned.stopLossBps, planned.takeProfitBps);
      if (!floor.pass) {
        bump(rejects, "below_fee_floor");
        continue;
      }
      qualified += 1;
      if (signal.closeTs !== choiceTs) {
        flushChoice();
        choiceTs = signal.closeTs;
      }
      const proxy = opts.sentimentMode === "market_proxy" && opts.proxy ? proxyAt(opts.proxy, s.pair, signal.closeTs) : null;
      if (proxy?.veto) {
        bump(rejects, "sentiment");
        continue;
      }
      choiceN += 1;
      const stopPx = signal.close * (1 - planned.stopLossBps / 10_000);
      const tpPx = signal.close * (1 + planned.takeProfitBps / 10_000);
      session.opts.atrByPair[s.pair] = signal.atr;
      const notional = session.proposedNotional(s.pair);
      const unitsPlanned = signal.close > 0 ? notional / signal.close : 0;
      const candidate: Candidate = {
        id: `${s.pair}|breakout|${signal.closeTs}`,
        pair: s.pair,
        setup: "A",
        barTs: signal.h4i >= 0 ? s.h4[signal.h4i]!.ts : signal.closeTs,
        entry: signal.close,
        stop: stopPx,
        signalClose: signal.close,
        atr: signal.atr,
        rsi: null,
        originatedFromSentiment: false,
        side: "long",
        plannedTargetBps: planned.takeProfitBps,
        entryProfile: "breakout",
        lossToStopUsd: lossToStopUsd(signal.close, stopPx, unitsPlanned),
      };
      book().overnightOpenRiskUsd = overnightRiskUsd(
        [...positions.values()].map((p) => ({
          openedTs: p.pos.openedTs,
          entry: p.pos.entry,
          stop: p.pos.stop,
          units: p.pos.units,
          maxHoldMs: BREAKOUT_MAX_HOLD_MS,
        })),
        signal.closeTs,
      );
      const packet: PacketInput = {
        asOf: signal.closeTs,
        pair: s.pair,
        setup: "A",
        barTs: candidate.barTs,
        candidateId: candidate.id,
        biasUp: true,
        close: signal.close,
        stop: stopPx,
        atr: signal.atr,
        rsi: null,
        vwap: null,
        sentiment: "clear",
        barTsList: [candidate.barTs],
      };
      buildPacket(packet);
      opts.onQualified?.({
        id: candidate.id,
        pair: s.pair,
        setup: "A",
        barTs: candidate.barTs,
        asOf: signal.closeTs,
        entry: candidate.entry,
        stop: candidate.stop,
        atr: signal.atr,
        rsi: null,
        vwap: null,
        biasUp: true,
      });
      if (opts.jevAdmit && !opts.jevAdmit.allow(candidate.id)) {
        bump(rejects, "jev");
        continue;
      }
      const admission = await session.consider(candidate, packet, signal.closeTs);
      if (!admission.admitted) {
        for (const reason of admission.failed) bump(rejects, reason);
        continue;
      }
      ideas += 1;
      entryAttempts += 1;
      const order = newEntryOrder(candidate.id, s.pair, signal.close, unitsPlanned, signal.closeTs);
      let filledUnits = 0;
      let filledFee = 0;
      let live = order;
      let p = s.m1From;
      while (p < s.m1.length && s.m1[p]!.ts < signal.closeTs) p += 1;
      while (p < s.m1.length && s.m1[p]!.ts < signal.closeTs + 120_000 && s.m1[p]!.ts < opts.toMs) {
        const minute = s.m1[p]!;
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
      s.m1From = p;
      const used = filledUnits * signal.close;
      if (notional - used > 1e-6) dropReserve(s.pair, notional - used);
      if (!(filledUnits > 0)) {
        entryTimeouts += 1;
        refreshBusy();
        continue;
      }
      entryFills += 1;
      const pos: Position = {
        id: candidate.id,
        pair: s.pair,
        entry: signal.close,
        units: filledUnits,
        initialUnits: filledUnits,
        initialStop: stopPx,
        stop: stopPx,
        openedTs: signal.closeTs,
        entryFeeUsd: filledFee,
        t1Done: false,
        lastTs: signal.closeTs,
        target2Price: tpPx,
        maxHoldMs: BREAKOUT_MAX_HOLD_MS,
        flatAtMidnight: false,
        vwapExit: false,
        plannedStopBps: planned.stopLossBps,
        plannedTargetBps: planned.takeProfitBps,
      };
      positions.set(s.pair, { pos, trail: stopPx, tp: tpPx, reserved: used, highest: signal.close, lastH4: signal.h4i });
      refreshBusy();
    }
  }
  flushChoice();

  for (const open of [...positions.values()]) {
    const px = lastPx.get(open.pos.pair) ?? open.pos.entry;
    const fee = (open.pos.units * px * TAKER_FEE_BPS) / 10_000;
    const net = open.pos.units * px - fee - open.pos.units * open.pos.entry - open.pos.entryFeeUsd;
    cash += open.pos.units * px - fee;
    fees += fee;
    onExit(open, opts.toMs - 1, net, "window_end");
  }
  const ending = noteEquity();
  return {
    variant: "jev_off",
    mode: opts.mode,
    formula: opts.formula,
    strategy: "combined",
    fromMs: opts.fromMs,
    toMs: opts.toMs,
    netUsd: opts.geometryOnly ? 0 : ending - STARTING_BUDGET_USD,
    maxDrawdownUsd: opts.geometryOnly ? 0 : maxDd,
    fromStartDrawdownUsd: 0,
    endingEquityUsd: opts.geometryOnly ? STARTING_BUDGET_USD : ending,
    trades: opts.geometryOnly ? 0 : trades,
    feesUsd: opts.geometryOnly ? 0 : fees,
    ideas: opts.geometryOnly ? 0 : ideas,
    fills: opts.geometryOnly ? 0 : fills,
    quarters: opts.geometryOnly ? [] : [...quarters.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([quarter, netUsd]) => ({ quarter, netUsd })),
    rejects,
    exits: opts.geometryOnly ? {} : exits,
    samples: opts.geometryOnly ? [] : samples,
    stopsByPair,
    pairHaltBreached: opts.geometryOnly ? false : pairHalt,
    dailyHaltBreached: opts.geometryOnly ? false : dailyHalt,
    wins: opts.geometryOnly ? 0 : wins,
    avgR: !opts.geometryOnly && trades > 0 ? rSum / trades : null,
    qualified,
    entryAttempts: opts.geometryOnly ? 0 : entryAttempts,
    entryFills: opts.geometryOnly ? 0 : entryFills,
    entryTimeouts: opts.geometryOnly ? 0 : entryTimeouts,
  };
}

export interface RepoReplay {
  netUsd: number;
  trades: number;
  missed: number;
  feesUsd: number;
  perPair: Array<{ pair: string; netUsd: number; trades: number; clipUsd: number }>;
}

/** cb/breakout.ts on 5-minute bars, book clips, $1,200 bankroll per pair. Compared with $1,171.80. */
export function replayRepoBreakout(candles: Record<string, Candle[]>, fromMs: number, toMs: number): RepoReplay {
  const warmup = fromMs - 10 * 86_400_000;
  const perPair: RepoReplay["perPair"] = [];
  let netUsd = 0;
  let trades = 0;
  let missed = 0;
  let feesUsd = 0;
  for (const pair of Object.keys(candles)) {
    const book = bookFor(pair);
    const m1 = candles[pair]!.filter((c) => c.ts >= warmup && c.ts < toMs);
    const m5 = aggregate(m1, M5, toMs);
    const result = runBreakout(m5, {
      pair,
      windowStartTs: fromMs,
      barSec: 300,
      notionalUsd: book.notionalUsd,
      bankrollUsd: 1_200,
      makerFeeBps: 50,
      takerFeeBps: 90,
      stopLossBps: book.stopLossBps,
      minSizeUsd: 25,
      breakoutBars: BREAKOUT_BARS,
      trendEmaBars: BREAKOUT_EMA_BARS,
      atrBars: BREAKOUT_ATR_BARS,
      trailAtr: BREAKOUT_TRAIL_ATR,
      maxHoldSec: BREAKOUT_MAX_HOLD_MS / 1000,
    });
    const net = result.tradeLog.reduce((sum, trade) => sum + trade.netUsd, 0);
    perPair.push({ pair, netUsd: net, trades: result.trades, clipUsd: book.notionalUsd });
    netUsd += net;
    trades += result.trades;
    missed += result.missedEntries;
    feesUsd += result.feesUsd;
  }
  return { netUsd, trades, missed, feesUsd, perPair };
}
