/**
 * Paper book. Events are injected. This module does not open a socket,
 * fetch, or sign. Risk is the forward Kelly schedule. The 10R pause is the
 * confirmed re-arm rule. Open MTM feeds book halts only.
 */

import { newEntryOrder, fillRestingBuy, type RestingOrder } from "../../vendor/87b35d0/fill.ts";
import { MAKER_FEE_BPS, TAKER_FEE_BPS } from "../../vendor/87b35d0/config.ts";
import { classCHoldExpired, classEHoldExpired, PAPER_MINIMUM_USD, x1FillPrice, stopFillPrice } from "../p3/design-rules";
import { intrabarFill } from "../p3/fills";
import type { ClassId } from "../p3/portfolio";
import { assignBetas, averageLinkage, betaWeight } from "../p5/risk";
import { weekKey } from "../p5/stats";
import { shadowPackets, type ShadowPacket } from "./jev-shadow";
import { forwardClassRisk, UNPROMOTED_RISK_USD, type KellyHold } from "./kelly";
import type { LegLog } from "./legs";
import { BOOTSTRAP_SEEDS } from "./metrics";
import { applyMidSample, freshMidBook, heartbeatMustReconnect, takerSideFromMaker, type MidBook } from "./mid-feed";
import {
  classBlockers,
  entryGates,
  equityState,
  freshClassCurve,
  markBrianOk,
  paperDecision,
  stepClass,
  type ClassCurve,
} from "./session";
import { onFeedGap, onPublicTrade, openShadow, type ShadowOrder } from "./shadow";

const CLASSES: ClassId[] = ["A", "B", "C", "D", "E"];

export interface BookConfig {
  bankrollUsd: number;
  default13Usd: number;
  members: string[];
}

export interface Position {
  id: string;
  classId: ClassId;
  productId: string;
  entryTs: number;
  fillPrice: number;
  units: number;
  riskUsd: number;
  stop: number;
  notionalUsd: number;
  sLiveBps: number;
  atr1h: number;
  entryFeeUsd: number;
  entrySpreadUsd: number;
  arrivalMid: number;
}

export interface ClosedTrade {
  id: string;
  classId: ClassId;
  productId: string;
  netR: number;
  netUsd: number;
  grossUsd: number;
  costUsd: number;
  riskUsd: number;
  notionalUsd: number;
  entryDate: string;
  exitTs: number;
  exitKind: string;
}

interface Working {
  order: RestingOrder;
  classId: ClassId;
  stop: number;
  riskUsd: number;
  sLiveBps: number;
  arrivalMid: number;
  bid: number;
  ask: number;
  bookTsMs: number;
  decisionMid: number;
  status: "working" | "indeterminate";
}

export interface Book {
  config: BookConfig;
  nowMs: number;
  day: string | null;
  week: string | null;
  dayStartEquity: number;
  weekStartEquity: number;
  peakEquity: number;
  realizedUsd: number;
  killSwitch: boolean;
  classes: Record<ClassId, ClassCurve>;
  kelly: Record<ClassId, KellyHold | null>;
  positions: Position[];
  closed: ClosedTrade[];
  working: Working[];
  shadows: ShadowOrder[];
  legs: LegLog[];
  packets: ShadowPacket[];
  marks: Record<string, number>;
  betas: Record<string, number | null>;
  rho: Record<string, number>;
  mids: MidBook;
  lastHeartbeatMs: number | null;
  heartbeatGaps: number;
  rejected: { id: string; reason: string }[];
  indeterminateByClass: Record<ClassId, number>;
  submittedByClass: Record<ClassId, number>;
}

export type ForwardEvent =
  | { kind: "clock"; tsMs: number }
  | { kind: "heartbeat"; tsMs: number }
  | { kind: "mid"; tsMs: number; productId: string; bid: number; ask: number; tradeVolume?: number }
  | { kind: "beta"; productId: string; beta: number | null }
  | { kind: "rho"; a: string; b: string; rho: number }
  | { kind: "kill-switch"; on: boolean }
  | { kind: "brian-ok"; classId: ClassId }
  | { kind: "mark"; productId: string; price: number }
  | {
      kind: "x1";
      id: string;
      classId: ClassId;
      productId: string;
      tsMs: number;
      nextOpen: number;
      stop: number;
      atr1h: number;
      bid: number;
      ask: number;
      bookTsMs: number;
      sendTsMs: number;
      decisionMid: number;
    }
  | {
      kind: "d-order";
      id: string;
      productId: string;
      limit: number;
      units: number;
      placedTs: number;
      stop: number;
      bid: number;
      ask: number;
      bookTsMs: number;
      decisionMid: number;
    }
  | { kind: "minute"; productId: string; tsMs: number; open: number; high: number; low: number; close: number; volume: number }
  | { kind: "bar15"; productId: string; startSec: number; nowSec: number; open: number; high: number; low: number; close: number; atr1h?: number }
  | { kind: "gap"; productId: string }
  | { kind: "trade"; productId: string; price: number; size: number; makerSide: string }
  | { kind: "shadow"; id: string; mode: "X2" | "X3"; classId: ClassId; productId: string; limit: number; tick: number }
  | {
      kind: "realize";
      id: string;
      classId: ClassId;
      productId: string;
      netR: number;
      netUsd: number;
      riskUsd: number;
      entryDate: string;
      exitTs: number;
    };

function emptyCounts(): Record<ClassId, number> {
  return { A: 0, B: 0, C: 0, D: 0, E: 0 };
}

function emptyClasses(): Record<ClassId, ClassCurve> {
  return { A: freshClassCurve(), B: freshClassCurve(), C: freshClassCurve(), D: freshClassCurve(), E: freshClassCurve() };
}

export function freshBook(config: Partial<BookConfig> = {}): Book {
  return {
    config: { bankrollUsd: config.bankrollUsd ?? 10_000, default13Usd: config.default13Usd ?? 13, members: config.members ?? [] },
    nowMs: 0,
    day: null,
    week: null,
    dayStartEquity: 0,
    weekStartEquity: 0,
    peakEquity: 0,
    realizedUsd: 0,
    killSwitch: false,
    classes: emptyClasses(),
    kelly: { A: null, B: null, C: null, D: null, E: null },
    positions: [],
    closed: [],
    working: [],
    shadows: [],
    legs: [],
    packets: [],
    marks: {},
    betas: {},
    rho: {},
    mids: freshMidBook(),
    lastHeartbeatMs: null,
    heartbeatGaps: 0,
    rejected: [],
    indeterminateByClass: emptyCounts(),
    submittedByClass: emptyCounts(),
  };
}

export function assertNoLiveEndpoint(text: string): void {
  if (/wss?:\/\/|api\.exchange\.coinbase|advanced-trade-ws/i.test(text)) throw new Error("replay input must be injected events");
}

export function replayInjected(events: readonly ForwardEvent[], config?: Partial<BookConfig>): Book {
  let book = freshBook(config);
  for (const event of events) book = applyForward(book, event);
  return book;
}

export function bookRoundTrip(book: Book): Book {
  return JSON.parse(JSON.stringify(book)) as Book;
}

function utcDay(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function openMtm(book: Book): number {
  let total = 0;
  for (const position of book.positions) {
    const mark = book.marks[position.productId] ?? position.fillPrice;
    total += (mark - position.fillPrice) * position.units;
  }
  return total;
}

function equityOf(book: Book) {
  const equity = book.realizedUsd + openMtm(book);
  return equityState({
    peakEquity: Math.max(book.peakEquity, equity),
    realizedUsd: book.realizedUsd,
    openMtmUsd: openMtm(book),
    dayStartEquity: book.dayStartEquity,
    weekStartEquity: book.weekStartEquity,
    pairLossUsd: 0,
  });
}

function rollClock(book: Book, tsMs: number): void {
  const day = utcDay(tsMs);
  const week = weekKey(day);
  const equity = book.realizedUsd + openMtm(book);
  if (book.day === null) {
    book.day = day;
    book.dayStartEquity = equity;
  } else if (book.day !== day) {
    book.day = day;
    book.dayStartEquity = equity;
  }
  if (book.week === null) {
    book.week = week;
    book.weekStartEquity = equity;
  } else if (book.week !== week) {
    book.week = week;
    book.weekStartEquity = equity;
  }
  if (equity > book.peakEquity) book.peakEquity = equity;
  book.nowMs = tsMs;
}

function reviewDue(book: Book, tsMs: number): boolean {
  const day = utcDay(tsMs);
  const monday = weekKey(day);
  const held = book.kelly.A;
  if (!held) return day === monday;
  return held.reviewMonday < monday;
}

function reviewKelly(book: Book, tsMs: number): void {
  if (!reviewDue(book, tsMs)) return;
  const streams = CLASSES.map((id) => ({ id, netR: book.closed.filter((trade) => trade.classId === id).map((trade) => trade.netR) }));
  for (const classId of CLASSES) {
    const forward = book.closed
      .filter((trade) => trade.classId === classId)
      .map((trade) => ({ netR: trade.netR, entryDate: trade.entryDate }));
    const seed = BOOTSTRAP_SEEDS[`${classId}:bootstrap`];
    const size = forwardClassRisk({
      classId,
      forward,
      streams,
      bankrollUsd: book.config.bankrollUsd,
      nowMs: tsMs,
      held: book.kelly[classId],
      bootstrapSeed: seed,
      default13Usd: book.config.default13Usd,
    });
    book.kelly[classId] = { reviewMonday: size.reviewMonday, riskUsd: size.riskUsd, promoted: size.promoted };
  }
}

function scheduledRisk(book: Book, classId: ClassId): number {
  return book.kelly[classId]?.riskUsd ?? UNPROMOTED_RISK_USD;
}

function spreadBps(bid: number, ask: number): number | null {
  if (!(bid > 0) || !(ask > bid)) return null;
  const mid = (bid + ask) / 2;
  return ((ask - bid) / mid) * 10_000;
}

function clusterOpen(book: Book, productId: string): number {
  const ids = [...new Set([...Object.keys(book.betas), ...book.positions.map((position) => position.productId), productId])];
  const groups = averageLinkage(ids, (left, right) => {
    if (left === right) return 1;
    const key = [left, right].sort().join("|");
    return book.rho[key] ?? null;
  });
  const cluster = groups.get(productId) ?? productId;
  return book.positions.filter((position) => (groups.get(position.productId) ?? position.productId) === cluster).length;
}

function betaAdd(book: Book, productId: string, notional: number): number {
  const ids = [...new Set([...Object.keys(book.betas), ...book.positions.map((position) => position.productId), productId])];
  const assigned = assignBetas(ids.map((id) => ({ id, beta: book.betas[id] ?? null })));
  let total = 0;
  for (const position of book.positions) total += position.notionalUsd * betaWeight(assigned.get(position.productId) ?? 1);
  total += notional * betaWeight(assigned.get(productId) ?? 1);
  return total;
}

function lastExitTs(book: Book, productId: string): number | null {
  let last: number | null = null;
  for (const trade of book.closed) if (trade.productId === productId) last = trade.exitTs;
  return last;
}

function pushClosed(book: Book, trade: ClosedTrade): void {
  book.closed.push(trade);
  book.realizedUsd += trade.netUsd;
  const minSize = trade.riskUsd <= PAPER_MINIMUM_USD;
  book.classes[trade.classId] = stepClass(book.classes[trade.classId], trade.netR, trade.netUsd, minSize);
  if (book.realizedUsd + openMtm(book) > book.peakEquity) book.peakEquity = book.realizedUsd + openMtm(book);
}

function tryEnter(book: Book, opts: {
  id: string;
  classId: ClassId;
  productId: string;
  tsMs: number;
  stopBps: number;
  sLive: number;
  bid: number;
  ask: number;
  bookTsMs: number;
  sendTsMs: number;
  decisionMid: number;
  arrivalMid: number;
  fillPrice: number;
  stop: number;
  atr1h: number;
  maker: boolean;
}): boolean {
  const equity = equityOf(book);
  const blockers = classBlockers(opts.classId, book.classes[opts.classId], {
    halt: equity.halt,
    backstop: equity.backstop,
    momentumBlocked: false,
    killSwitch: book.killSwitch,
  });
  const decision = paperDecision({
    classId: opts.classId,
    blockers,
    stopBps: opts.stopBps,
    sBtBps: opts.sLive,
    breadthPaused: false,
    scheduledRiskUsd: scheduledRisk(book, opts.classId),
  });
  if (!decision.entries) {
    book.rejected.push({ id: opts.id, reason: blockers.join(",") || "blocked" });
    return false;
  }
  const openRisk = book.positions.reduce((sum, position) => sum + position.riskUsd, 0);
  const gross = book.positions.reduce((sum, position) => sum + position.notionalUsd, 0);
  const failed = entryGates({
    openPairs: book.positions.map((position) => position.productId),
    pair: opts.productId,
    classId: opts.classId,
    classOpen: book.positions.filter((position) => position.classId === opts.classId).length,
    bookOpen: book.positions.length,
    openInCluster: clusterOpen(book, opts.productId),
    openRiskUsd: openRisk,
    addRiskUsd: decision.openRiskUsd,
    grossUsd: gross,
    addNotionalUsd: decision.notionalUsd,
    betaWeightedUsd: betaAdd(book, opts.productId, decision.notionalUsd),
    lastExitTsMs: lastExitTs(book, opts.productId),
    nowTsMs: opts.tsMs,
  });
  if (failed.length > 0) {
    book.rejected.push({ id: opts.id, reason: failed.join(",") });
    return false;
  }
  const units = decision.notionalUsd / opts.fillPrice;
  const feeBps = opts.maker ? MAKER_FEE_BPS : TAKER_FEE_BPS;
  const entryFeeUsd = (decision.notionalUsd * feeBps) / 10_000;
  const entrySpreadUsd = opts.maker ? 0 : Math.abs(opts.fillPrice - opts.arrivalMid) * units;
  book.legs.push({
    id: opts.id,
    productId: opts.productId,
    classId: opts.classId,
    side: "entry",
    arrivalMid: opts.arrivalMid,
    arrivalBid: opts.bid,
    arrivalAsk: opts.ask,
    arrivalSnapshotTs: opts.bookTsMs,
    orderSendTs: opts.sendTsMs,
    decisionMid: opts.decisionMid,
    activeStop: opts.stop,
    triggerBarTs: null,
    fillPrice: opts.fillPrice,
    units,
    feesUsd: entryFeeUsd,
  });
  book.positions.push({
    id: opts.id,
    classId: opts.classId,
    productId: opts.productId,
    entryTs: opts.tsMs,
    fillPrice: opts.fillPrice,
    units,
    riskUsd: decision.riskUsd,
    stop: opts.stop,
    notionalUsd: decision.notionalUsd,
    sLiveBps: opts.sLive,
    atr1h: opts.atr1h,
    entryFeeUsd,
    entrySpreadUsd,
    arrivalMid: opts.arrivalMid,
  });
  book.submittedByClass[opts.classId] += 1;
  return true;
}

function closePosition(book: Book, position: Position, opts: { tsMs: number; fill: number; kind: string; triggerBarTs: number | null }): void {
  const exitNotional = position.units * opts.fill;
  const exitFee = (exitNotional * TAKER_FEE_BPS) / 10_000;
  const slip = opts.kind === "stop" ? Math.max(0, position.stop - opts.fill) * position.units : Math.abs(opts.fill - position.arrivalMid) * position.units;
  const costUsd = position.entryFeeUsd + position.entrySpreadUsd + exitFee + (opts.kind === "stop" ? slip : 0);
  const netUsd = (opts.fill - position.fillPrice) * position.units - position.entryFeeUsd - exitFee;
  const grossUsd = netUsd + costUsd;
  const netR = position.riskUsd > 0 ? netUsd / position.riskUsd : 0;
  book.legs.push({
    id: `${position.id}:exit`,
    productId: position.productId,
    classId: position.classId,
    side: "exit",
    arrivalMid: opts.kind === "stop" ? position.stop : opts.fill,
    arrivalBid: position.fillPrice,
    arrivalAsk: position.fillPrice,
    arrivalSnapshotTs: opts.tsMs,
    orderSendTs: opts.tsMs,
    decisionMid: position.arrivalMid,
    activeStop: position.stop,
    triggerBarTs: opts.triggerBarTs,
    fillPrice: opts.fill,
    units: position.units,
    feesUsd: exitFee,
  });
  book.positions = book.positions.filter((item) => item.id !== position.id);
  pushClosed(book, {
    id: position.id,
    classId: position.classId,
    productId: position.productId,
    netR,
    netUsd,
    grossUsd,
    costUsd,
    riskUsd: position.riskUsd,
    notionalUsd: position.notionalUsd,
    entryDate: utcDay(position.entryTs),
    exitTs: opts.tsMs,
    exitKind: opts.kind,
  });
}

export function applyForward(book: Book, event: ForwardEvent): Book {
  if (event.kind === "clock") {
    rollClock(book, event.tsMs);
    reviewKelly(book, event.tsMs);
    return book;
  }
  if (event.kind === "heartbeat") {
    if (book.lastHeartbeatMs != null && heartbeatMustReconnect(book.lastHeartbeatMs, event.tsMs)) book.heartbeatGaps += 1;
    book.lastHeartbeatMs = event.tsMs;
    return book;
  }
  if (event.kind === "mid") {
    applyMidSample(book.mids, { productId: event.productId, nowMs: event.tsMs, bid: event.bid, ask: event.ask, tradeVolume: event.tradeVolume });
    book.nowMs = event.tsMs;
    return book;
  }
  if (event.kind === "beta") {
    book.betas[event.productId] = event.beta;
    return book;
  }
  if (event.kind === "rho") {
    book.rho[[event.a, event.b].sort().join("|")] = event.rho;
    return book;
  }
  if (event.kind === "kill-switch") {
    book.killSwitch = event.on;
    return book;
  }
  if (event.kind === "brian-ok") {
    book.classes[event.classId] = markBrianOk(book.classes[event.classId]);
    return book;
  }
  if (event.kind === "mark") {
    book.marks[event.productId] = event.price;
    const equity = book.realizedUsd + openMtm(book);
    if (equity > book.peakEquity) book.peakEquity = equity;
    return book;
  }
  if (event.kind === "realize") {
    pushClosed(book, {
      id: event.id,
      classId: event.classId,
      productId: event.productId,
      netR: event.netR,
      netUsd: event.netUsd,
      grossUsd: event.netUsd,
      costUsd: 0,
      riskUsd: event.riskUsd,
      notionalUsd: 0,
      entryDate: event.entryDate,
      exitTs: event.exitTs,
      exitKind: "realize",
    });
    return book;
  }
  if (event.kind === "shadow") {
    book.shadows.push(openShadow(event));
    book.submittedByClass[event.classId] += 1;
    return book;
  }
  if (event.kind === "trade") {
    const taker = takerSideFromMaker(event.makerSide);
    void taker;
    book.shadows = book.shadows.map((order) => (order.productId === event.productId ? onPublicTrade(order, event.price, event.size) : order));
    return book;
  }
  if (event.kind === "gap") {
    book.shadows = book.shadows.map((order) => (order.productId === event.productId ? onFeedGap(order) : order));
    book.working = book.working.filter((order) => {
      if (order.order.pair !== event.productId || order.status !== "working") return true;
      order.status = "indeterminate";
      book.indeterminateByClass[order.classId] += 1;
      return false;
    });
    return book;
  }
  if (event.kind === "x1") {
    const sLive = spreadBps(event.bid, event.ask);
    if (sLive == null) {
      book.rejected.push({ id: event.id, reason: "no-book" });
      return book;
    }
    const stopBps = ((event.nextOpen - event.stop) / event.nextOpen) * 10_000;
    if (!(stopBps > 0)) {
      book.rejected.push({ id: event.id, reason: "stop" });
      return book;
    }
    const arrivalMid = (event.bid + event.ask) / 2;
    tryEnter(book, {
      id: event.id,
      classId: event.classId,
      productId: event.productId,
      tsMs: event.tsMs,
      stopBps,
      sLive,
      bid: event.bid,
      ask: event.ask,
      bookTsMs: event.bookTsMs,
      sendTsMs: event.sendTsMs,
      decisionMid: event.decisionMid,
      arrivalMid,
      fillPrice: x1FillPrice(event.nextOpen, "buy", sLive),
      stop: event.stop,
      atr1h: event.atr1h,
      maker: false,
    });
    return book;
  }
  if (event.kind === "d-order") {
    const sLive = spreadBps(event.bid, event.ask);
    if (sLive == null) {
      book.rejected.push({ id: event.id, reason: "no-book" });
      return book;
    }
    const arrivalMid = (event.bid + event.ask) / 2;
    const stopBps = ((event.limit - event.stop) / event.limit) * 10_000;
    const equity = equityOf(book);
    const blockers = classBlockers("D", book.classes.D, { halt: equity.halt, backstop: equity.backstop, momentumBlocked: false, killSwitch: book.killSwitch });
    const decision = paperDecision({ classId: "D", blockers, stopBps, sBtBps: sLive, breadthPaused: false, scheduledRiskUsd: scheduledRisk(book, "D") });
    if (!decision.entries) {
      book.rejected.push({ id: event.id, reason: blockers.join(",") || "blocked" });
      return book;
    }
    book.submittedByClass.D += 1;
    book.working.push({
      order: newEntryOrder(event.id, event.productId, event.limit, event.units, event.placedTs),
      classId: "D",
      stop: event.stop,
      riskUsd: decision.riskUsd,
      sLiveBps: sLive,
      arrivalMid,
      bid: event.bid,
      ask: event.ask,
      bookTsMs: event.bookTsMs,
      decisionMid: event.decisionMid,
      status: "working",
    });
    return book;
  }
  if (event.kind === "minute") {
    const next: Working[] = [];
    for (const working of book.working) {
      if (working.order.pair !== event.productId || working.status !== "working") {
        next.push(working);
        continue;
      }
      const filled = fillRestingBuy(working.order, { ts: event.tsMs, open: event.open, high: event.high, low: event.low, close: event.close, volume: event.volume });
      working.order = filled.order;
      if (filled.event.status === "filled" || filled.event.status === "partial") {
        const units = filled.event.units;
        const fillPrice = filled.event.price;
        book.legs.push({
          id: working.order.id,
          productId: event.productId,
          classId: "D",
          side: "entry",
          arrivalMid: working.arrivalMid,
          arrivalBid: working.bid,
          arrivalAsk: working.ask,
          arrivalSnapshotTs: working.bookTsMs,
          orderSendTs: working.order.placedTs,
          decisionMid: working.decisionMid,
          activeStop: working.stop,
          triggerBarTs: event.tsMs,
          fillPrice,
          units,
          feesUsd: filled.event.feeUsd,
        });
        book.positions.push({
          id: working.order.id,
          classId: "D",
          productId: event.productId,
          entryTs: event.tsMs,
          fillPrice,
          units,
          riskUsd: working.riskUsd,
          stop: working.stop,
          notionalUsd: units * fillPrice,
          sLiveBps: working.sLiveBps,
          atr1h: 0,
          entryFeeUsd: filled.event.feeUsd,
          entrySpreadUsd: 0,
          arrivalMid: working.arrivalMid,
        });
      }
      if (filled.event.status === "none" || filled.event.status === "partial") next.push(working);
    }
    book.working = next;
    return book;
  }
  if (event.kind === "bar15") {
    if (event.nowSec >= event.startSec + 900 && event.startSec % 900 === 0) {
      book.packets.push(...shadowPackets({ members: book.config.members, barStartSec: event.startSec, nowSec: event.nowSec, warming: false }));
    }
    const barTs = event.startSec * 1000;
    const bar = { open: event.open, high: event.high, low: event.low, close: event.close };
    for (const position of [...book.positions]) {
      if (position.productId !== event.productId) continue;
      const hit = intrabarFill(bar, position.stop, Number.POSITIVE_INFINITY);
      if (hit.kind === "stop" && hit.price != null) {
        const gap = event.open <= position.stop;
        const fill = gap ? event.open : stopFillPrice(position.stop, position.fillPrice, position.sLiveBps, event.atr1h ?? position.atr1h);
        closePosition(book, position, { tsMs: barTs, fill, kind: "stop", triggerBarTs: barTs });
        continue;
      }
      if (position.classId === "C" && classCHoldExpired(position.entryTs, barTs)) {
        closePosition(book, position, { tsMs: barTs, fill: event.open, kind: "time", triggerBarTs: barTs });
        continue;
      }
      if (position.classId === "E" && classEHoldExpired(position.entryTs, barTs)) {
        closePosition(book, position, { tsMs: barTs, fill: event.open, kind: "time", triggerBarTs: barTs });
      }
    }
    return book;
  }
  return book;
}
