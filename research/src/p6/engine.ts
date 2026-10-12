/**
 * Paper book. Events are injected. This module does not open a socket,
 * fetch, or sign. Risk is the forward Kelly schedule on the fixed $8,000
 * bankroll. The 20R kill and the $1,200 backstop use the running high-water
 * mark from amendment 2a. Open MTM includes the cost of a taker exit.
 */

import { newEntryOrder, type RestingOrder } from "../../vendor/87b35d0/fill.ts";
import { MAKER_FEE_BPS, TAKER_FEE_BPS } from "../../vendor/87b35d0/config.ts";
import {
  classAExit,
  classATenDayExit,
  classBDisasterStop,
  classBHeld,
  classCHoldExpired,
  classEHoldExpired,
  classEMoveToBreakEven,
  PAPER_MINIMUM_USD,
  stopFillPrice,
  tradeThroughFill,
  x1FillPrice,
  type ClassBRow,
} from "../p3/design-rules";
import { intrabarFill, trailAfterCompletedBar } from "../p3/fills";
import type { ClassId } from "../p3/portfolio";
import { momentumBlocked, momentumCrashOn } from "../p5/guards";
import { assignBetas, averageLinkage, betaWeight } from "../p5/risk";
import { weekKey } from "../p5/stats";
import { shadowPackets, type ShadowPacket } from "./jev-shadow";
import { bookPanel, parity7d, weeklyHaltsInLast6, type BookPanel } from "./review";
import { forwardClassRisk, UNPROMOTED_RISK_USD, type KellyHold } from "./kelly";
import type { LegLog } from "./legs";
import { BOOTSTRAP_SEEDS } from "./metrics";
import { applyMidSample, freshMidBook, halfSpreadBps, heartbeatMustReconnect, takerSideFromMaker, type MidBook } from "./mid-feed";
import { barBeginsAtOrAfterEntry, strategyBarClosed } from "./signals";
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
  target: number | null;
  dailyAtr: number;
  priorDailyCloses: number[];
  pendingExit: string | null;
  clusterId: string;
  tick: number;
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
  tick: number;
  target: number | null;
  notionalUsd: number;
  stopBps: number;
  filledUnits: number;
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
  quotes: Record<string, { bid: number; ask: number; tsMs: number }>;
  momentumDates: string[];
  haltWeeks: string[];
  clusterMonth: string | null;
  incidents: string[];
}

export type ForwardEvent =
  | { kind: "clock"; tsMs: number }
  | { kind: "heartbeat"; tsMs: number }
  | { kind: "mid"; tsMs: number; productId: string; bid: number; ask: number; tradeVolume?: number }
  | { kind: "beta"; productId: string; beta: number | null }
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
      target?: number;
      dailyAtr?: number;
      priorDailyCloses?: number[];
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
      tick?: number;
      target?: number;
    }
  | { kind: "minute"; productId: string; tsMs: number; open: number; high: number; low: number; close: number; volume: number }
  | {
      kind: "bar15";
      productId: string;
      startSec: number;
      nowSec: number;
      open: number;
      high: number;
      low: number;
      close: number;
      atr1h?: number;
      dailyClose?: boolean;
      bScores?: ClassBRow[];
    }
  | { kind: "btc"; tsMs: number; return60: number; return10: number }
  | { kind: "rho"; a: string; b: string; rho: number; month?: string }
  | { kind: "gap"; productId: string }
  | { kind: "trade"; productId: string; price: number; size: number; makerSide: string; tsMs?: number }
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
    config: { members: config.members ?? [] },
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
    quotes: {},
    momentumDates: [],
    haltWeeks: [],
    clusterMonth: null,
    incidents: [],
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

export function forwardBookPanel(book: Book, replayNetUsd: number | null): BookPanel {
  const equity = book.realizedUsd + openMtm(book);
  return bookPanel({
    weeklyHaltsLast6: weeklyHaltsInLast6(book.haltWeeks, book.week),
    bookDrawdownUsd: Math.max(0, book.peakEquity - equity),
    parity7d: parity7d(book.realizedUsd, replayNetUsd),
  });
}

export function bookRoundTrip(book: Book): Book {
  return JSON.parse(JSON.stringify(book)) as Book;
}

function utcDay(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function exitCostUsd(position: Position, mark: number): number {
  return (mark * position.units * (TAKER_FEE_BPS + position.sLiveBps)) / 10_000;
}

function openMtm(book: Book): number {
  let total = 0;
  for (const position of book.positions) {
    const mark = book.marks[position.productId] ?? position.fillPrice;
    total += (mark - position.fillPrice) * position.units - exitCostUsd(position, mark);
  }
  return total;
}

function pairPnl(book: Book, productId: string): number {
  let closed = 0;
  for (const trade of book.closed) if (trade.productId === productId) closed += trade.netUsd;
  let open = 0;
  for (const position of book.positions) {
    if (position.productId !== productId) continue;
    const mark = book.marks[productId] ?? position.fillPrice;
    open += (mark - position.fillPrice) * position.units - exitCostUsd(position, mark);
  }
  return closed + open;
}

function pairLossOf(book: Book, productId: string): number {
  const pnl = pairPnl(book, productId);
  return pnl < 0 ? -pnl : 0;
}

function worstPairLoss(book: Book): number {
  const ids = new Set<string>([...book.positions.map((position) => position.productId), ...book.closed.map((trade) => trade.productId)]);
  let worst = 0;
  for (const id of ids) worst = Math.max(worst, pairLossOf(book, id));
  return worst;
}

function equityOf(book: Book) {
  const equity = book.realizedUsd + openMtm(book);
  return equityState({
    peakEquity: Math.max(book.peakEquity, equity),
    realizedUsd: book.realizedUsd,
    openMtmUsd: openMtm(book),
    dayStartEquity: book.dayStartEquity,
    weekStartEquity: book.weekStartEquity,
    pairLossUsd: worstPairLoss(book),
  });
}

function rollClock(book: Book, tsMs: number): void {
  const day = utcDay(tsMs);
  const week = weekKey(day);
  const equity = book.realizedUsd + openMtm(book);
  if (book.day === null || day > book.day) {
    book.day = day;
    book.dayStartEquity = equity;
  }
  if (book.week === null || week > book.week) {
    book.week = week;
    book.weekStartEquity = equity;
  }
  if (equity > book.peakEquity) book.peakEquity = equity;
  if (tsMs >= book.nowMs) book.nowMs = tsMs;
  const state = equityOf(book);
  if (state.halt && book.week != null && !book.haltWeeks.includes(book.week)) book.haltWeeks.push(book.week);
}

function touchTime(book: Book, tsMs: number): void {
  if (book.nowMs !== 0 && tsMs < book.nowMs) return;
  rollClock(book, tsMs);
  reviewKelly(book, tsMs);
}

function reviewDue(book: Book, tsMs: number): boolean {
  const day = utcDay(tsMs);
  const monday = weekKey(day);
  if (day !== monday) return false;
  return CLASSES.some((id) => (book.kelly[id]?.reviewMonday ?? "") < monday);
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
      nowMs: tsMs,
      held: book.kelly[classId],
      bootstrapSeed: seed,
    });
    book.kelly[classId] = { reviewMonday: size.reviewMonday, riskUsd: size.riskUsd, promoted: size.promoted };
  }
}

function scheduledRisk(book: Book, classId: ClassId): number {
  return book.kelly[classId]?.riskUsd ?? UNPROMOTED_RISK_USD;
}

function noteQuote(book: Book, productId: string, bid: number, ask: number, tsMs: number): void {
  book.quotes[productId] = { bid, ask, tsMs };
}

function clusterIds(book: Book, productId: string): string[] {
  if (book.config.members.length === 0) return [...new Set([...book.positions.map((position) => position.productId), productId])];
  return book.config.members.includes(productId) ? book.config.members : [productId];
}

function clusterOf(book: Book, productId: string): string {
  const ids = clusterIds(book, productId);
  const groups = averageLinkage(ids, (left, right) => {
    if (left === right) return 1;
    const key = [left, right].sort().join("|");
    return book.rho[key] ?? null;
  });
  return groups.get(productId) ?? productId;
}

function clusterOpen(book: Book, productId: string): number {
  const cluster = clusterOf(book, productId);
  return book.positions.filter((position) => position.clusterId === cluster).length;
}

function betaAdd(book: Book, productId: string, notional: number): number {
  const ids = clusterIds(book, productId);
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
  target?: number | null;
  dailyAtr?: number;
  priorDailyCloses?: number[];
  tick?: number;
}): boolean {
  const equity = equityOf(book);
  const blockers = classBlockers(opts.classId, book.classes[opts.classId], {
    halt: equity.halt,
    backstop: equity.backstop || pairLossOf(book, opts.productId) >= 500,
    momentumBlocked: momentumBlocked(book.momentumDates, utcDay(opts.tsMs)),
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
    target: opts.target ?? null,
    dailyAtr: opts.dailyAtr ?? 0,
    priorDailyCloses: opts.priorDailyCloses ?? [],
    pendingExit: null,
    clusterId: clusterOf(book, opts.productId),
    tick: opts.tick ?? 0.01,
  });
  book.submittedByClass[opts.classId] += 1;
  return true;
}

const D_MAX_HOLD_MS = 48 * 3_600_000;

function sellThrough(limit: number, price: number, tick: number, volume: number): { filled: boolean; volume: number } | null {
  if (!(tick > 0) || !(volume > 0)) return null;
  if (!(price >= limit + tick)) return { filled: false, volume: 0 };
  return { filled: true, volume: volume * 0.5 };
}

function closePosition(
  book: Book,
  position: Position,
  opts: { tsMs: number; fill: number; kind: string; triggerBarTs: number | null; makerExit?: boolean; decisionMid?: number },
): void {
  const quote = book.quotes[position.productId];
  const bid = quote?.bid ?? position.fillPrice;
  const ask = quote?.ask ?? position.fillPrice;
  const arrivalMid = opts.kind === "stop" ? position.stop : (bid + ask) / 2;
  const exitNotional = position.units * opts.fill;
  const exitFee = (exitNotional * (opts.makerExit ? MAKER_FEE_BPS : TAKER_FEE_BPS)) / 10_000;
  const slip = opts.makerExit ? 0 : Math.max(0, arrivalMid - opts.fill) * position.units;
  const costUsd = position.entryFeeUsd + position.entrySpreadUsd + exitFee + slip;
  const netUsd = (opts.fill - position.fillPrice) * position.units - position.entryFeeUsd - exitFee;
  const grossUsd = netUsd + costUsd;
  const netR = position.riskUsd > 0 ? netUsd / position.riskUsd : 0;
  book.legs.push({
    id: `${position.id}:exit`,
    productId: position.productId,
    classId: position.classId,
    side: "exit",
    arrivalMid,
    arrivalBid: bid,
    arrivalAsk: ask,
    arrivalSnapshotTs: quote?.tsMs ?? opts.tsMs,
    orderSendTs: opts.tsMs,
    decisionMid: opts.decisionMid ?? arrivalMid,
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

function takerSell(open: number, sLive: number): number {
  return x1FillPrice(open, "sell", sLive);
}

function addDFill(book: Book, working: Working, units: number, tsMs: number): void {
  const fillPrice = working.order.limit;
  const fee = (units * fillPrice * MAKER_FEE_BPS) / 10_000;
  const existing = book.positions.find((position) => position.id === working.order.id);
  if (existing) {
    const total = existing.units + units;
    existing.fillPrice = (existing.fillPrice * existing.units + fillPrice * units) / total;
    existing.units = total;
    existing.notionalUsd += units * fillPrice;
    existing.entryFeeUsd += fee;
    return;
  }
  book.legs.push({
    id: working.order.id,
    productId: working.order.pair,
    classId: "D",
    side: "entry",
    arrivalMid: working.arrivalMid,
    arrivalBid: working.bid,
    arrivalAsk: working.ask,
    arrivalSnapshotTs: working.bookTsMs,
    orderSendTs: working.order.placedTs,
    decisionMid: working.decisionMid,
    activeStop: working.stop,
    triggerBarTs: tsMs,
    fillPrice,
    units,
    feesUsd: fee,
  });
  book.positions.push({
    id: working.order.id,
    classId: "D",
    productId: working.order.pair,
    entryTs: tsMs,
    fillPrice,
    units,
    riskUsd: working.riskUsd,
    stop: working.stop,
    notionalUsd: units * fillPrice,
    sLiveBps: working.sLiveBps,
    atr1h: 0,
    entryFeeUsd: fee,
    entrySpreadUsd: 0,
    arrivalMid: working.arrivalMid,
    target: working.target,
    dailyAtr: 0,
    priorDailyCloses: [],
    pendingExit: null,
    clusterId: clusterOf(book, working.order.pair),
    tick: working.tick,
  });
}

export function applyForward(book: Book, event: ForwardEvent): Book {
  if (event.kind === "clock") {
    touchTime(book, event.tsMs);
    return book;
  }
  if (event.kind === "heartbeat") {
    if (book.lastHeartbeatMs != null && heartbeatMustReconnect(book.lastHeartbeatMs, event.tsMs)) book.heartbeatGaps += 1;
    book.lastHeartbeatMs = event.tsMs;
    return book;
  }
  if (event.kind === "mid") {
    applyMidSample(book.mids, { productId: event.productId, nowMs: event.tsMs, bid: event.bid, ask: event.ask, tradeVolume: event.tradeVolume });
    noteQuote(book, event.productId, event.bid, event.ask, event.tsMs);
    touchTime(book, event.tsMs);
    return book;
  }
  if (event.kind === "beta") {
    book.betas[event.productId] = event.beta;
    return book;
  }
  if (event.kind === "btc") {
    touchTime(book, event.tsMs);
    if (momentumCrashOn(event.return60, event.return10)) {
      const day = utcDay(event.tsMs);
      if (!book.momentumDates.includes(day)) book.momentumDates.push(day);
    }
    return book;
  }
  if (event.kind === "rho") {
    if (event.month && book.clusterMonth && event.month !== book.clusterMonth) book.rho = {};
    if (event.month) book.clusterMonth = event.month;
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
    touchTime(book, event.exitTs);
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
    const tsMs = event.tsMs ?? book.nowMs;
    touchTime(book, tsMs);
    book.shadows = book.shadows.map((order) => (order.productId === event.productId ? onPublicTrade(order, event.price, event.size) : order));
    const keep: Working[] = [];
    for (const working of book.working) {
      if (working.order.pair !== event.productId || working.status !== "working") {
        keep.push(working);
        continue;
      }
      if (tsMs >= working.order.expireTs) continue;
      const result = tradeThroughFill(working.order.limit, event.price, working.tick, event.size);
      if (!result?.filled) {
        keep.push(working);
        continue;
      }
      const units = Math.min(working.order.unitsRemaining - working.filledUnits, result.volume);
      if (!(units > 0)) {
        keep.push(working);
        continue;
      }
      working.filledUnits += units;
      addDFill(book, working, units, tsMs);
      if (working.filledUnits + 1e-9 < working.order.unitsRemaining) keep.push(working);
    }
    book.working = keep;
    for (const position of [...book.positions]) {
      if (position.classId !== "D" || position.productId !== event.productId || position.target == null) continue;
      const hit = sellThrough(position.target, event.price, position.tick, event.size);
      if (hit?.filled) closePosition(book, position, { tsMs, fill: position.target, kind: "target", triggerBarTs: tsMs, makerExit: true, decisionMid: position.target });
    }
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
    touchTime(book, event.tsMs);
    const sLive = halfSpreadBps(event.bid, event.ask);
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
    noteQuote(book, event.productId, event.bid, event.ask, event.bookTsMs);
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
      target: event.target ?? null,
      dailyAtr: event.dailyAtr ?? 0,
      priorDailyCloses: event.priorDailyCloses ?? [],
    });
    return book;
  }
  if (event.kind === "d-order") {
    touchTime(book, event.placedTs);
    const sLive = halfSpreadBps(event.bid, event.ask);
    if (sLive == null) {
      book.rejected.push({ id: event.id, reason: "no-book" });
      return book;
    }
    const arrivalMid = (event.bid + event.ask) / 2;
    const stopBps = ((event.limit - event.stop) / event.limit) * 10_000;
    if (!(stopBps > 0)) {
      book.rejected.push({ id: event.id, reason: "stop" });
      return book;
    }
    noteQuote(book, event.productId, event.bid, event.ask, event.bookTsMs);
    const equity = equityOf(book);
    const blockers = classBlockers("D", book.classes.D, {
      halt: equity.halt,
      backstop: equity.backstop || pairLossOf(book, event.productId) >= 500,
      momentumBlocked: false,
      killSwitch: book.killSwitch,
    });
    const decision = paperDecision({ classId: "D", blockers, stopBps, sBtBps: sLive, breadthPaused: false, scheduledRiskUsd: scheduledRisk(book, "D") });
    if (!decision.entries) {
      book.rejected.push({ id: event.id, reason: blockers.join(",") || "blocked" });
      return book;
    }
    const failed = entryGates({
      openPairs: book.positions.map((position) => position.productId),
      pair: event.productId,
      classId: "D",
      classOpen: book.positions.filter((position) => position.classId === "D").length,
      bookOpen: book.positions.length,
      openInCluster: clusterOpen(book, event.productId),
      openRiskUsd: book.positions.reduce((sum, position) => sum + position.riskUsd, 0),
      addRiskUsd: decision.openRiskUsd,
      grossUsd: book.positions.reduce((sum, position) => sum + position.notionalUsd, 0),
      addNotionalUsd: decision.notionalUsd,
      betaWeightedUsd: betaAdd(book, event.productId, decision.notionalUsd),
      lastExitTsMs: lastExitTs(book, event.productId),
      nowTsMs: event.placedTs,
    });
    if (failed.length > 0) {
      book.rejected.push({ id: event.id, reason: failed.join(",") });
      return book;
    }
    const units = decision.notionalUsd / event.limit;
    book.submittedByClass.D += 1;
    book.working.push({
      order: newEntryOrder(event.id, event.productId, event.limit, units, event.placedTs),
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
      tick: event.tick ?? 0.01,
      target: event.target ?? null,
      notionalUsd: decision.notionalUsd,
      stopBps,
      filledUnits: 0,
    });
    return book;
  }
  if (event.kind === "minute") {
    touchTime(book, event.tsMs);
    book.working = book.working.filter((working) => working.order.pair !== event.productId || event.tsMs < working.order.expireTs);
    return book;
  }
  if (event.kind === "bar15") {
    const closed = strategyBarClosed(event.startSec, event.nowSec);
    if (closed) {
      book.marks[event.productId] = event.close;
      book.packets.push(...shadowPackets({ members: book.config.members, barStartSec: event.startSec, nowSec: event.nowSec, warming: false }));
      touchTime(book, (event.startSec + 900) * 1000);
    }
    const barTs = event.startSec * 1000;
    const bar = { open: event.open, high: event.high, low: event.low, close: event.close };
    for (const position of [...book.positions]) {
      if (position.productId !== event.productId) continue;
      if (!strategyBarClosed(event.startSec, event.nowSec) || !barBeginsAtOrAfterEntry(event.startSec, position.entryTs)) continue;
      if (position.pendingExit) {
        closePosition(book, position, {
          tsMs: barTs,
          fill: takerSell(event.open, position.sLiveBps),
          kind: position.pendingExit,
          triggerBarTs: barTs,
          decisionMid: event.close,
        });
        continue;
      }
      let stop = position.stop;
      if (position.classId === "B" && position.dailyAtr > 0) stop = Math.max(stop, classBDisasterStop(position.fillPrice, position.dailyAtr));
      const hit = intrabarFill(bar, stop, Number.POSITIVE_INFINITY);
      if (hit.kind === "stop" && hit.price != null) {
        const gap = event.open <= stop;
        const fill = gap ? event.open : stopFillPrice(stop, position.fillPrice, position.sLiveBps, event.atr1h ?? position.atr1h);
        closePosition(book, position, { tsMs: barTs, fill, kind: "stop", triggerBarTs: barTs, decisionMid: event.close });
        continue;
      }
      if (position.classId === "E" && position.target != null && event.high >= position.target) {
        closePosition(book, position, { tsMs: barTs, fill: position.target, kind: "target", triggerBarTs: barTs, decisionMid: event.close });
        continue;
      }
      const endMs = (event.startSec + 900) * 1000;
      if (position.classId === "C" && classCHoldExpired(position.entryTs, endMs)) {
        closePosition(book, position, { tsMs: endMs, fill: takerSell(event.open, position.sLiveBps), kind: "time", triggerBarTs: barTs, decisionMid: event.close });
        continue;
      }
      if (position.classId === "E" && classEHoldExpired(position.entryTs, endMs)) {
        closePosition(book, position, { tsMs: endMs, fill: takerSell(event.open, position.sLiveBps), kind: "time", triggerBarTs: barTs, decisionMid: event.close });
        continue;
      }
      if (position.classId === "D" && endMs - position.entryTs >= D_MAX_HOLD_MS) {
        closePosition(book, position, { tsMs: endMs, fill: takerSell(event.open, position.sLiveBps), kind: "time", triggerBarTs: barTs, decisionMid: event.close });
        continue;
      }
      if (position.classId === "B" && event.bScores && !classBHeld(event.bScores, position.productId)) {
        position.pendingExit = "rebalance";
      }
      if (position.classId === "A" && position.dailyAtr > 0) position.stop = trailAfterCompletedBar(position.stop, event.close, position.dailyAtr);
      if (position.classId === "D" && position.dailyAtr > 0) position.stop = trailAfterCompletedBar(position.stop, event.close, position.dailyAtr);
      if (position.classId === "E") position.stop = classEMoveToBreakEven(position.stop, position.fillPrice, event.close);
      if (position.classId === "A" && event.dailyClose) {
        const heldDays = (endMs - position.entryTs) / 86_400_000;
        const unrealizedR = position.riskUsd > 0 ? ((event.close - position.fillPrice) * position.units) / position.riskUsd : 0;
        const prior = position.priorDailyCloses.slice(-10);
        if (classATenDayExit(event.close, prior) || (classAExit(event.close, prior.length === 10 ? Math.min(...prior) : event.close, heldDays, unrealizedR) && heldDays >= 30 && unrealizedR < 1)) {
          position.pendingExit = "rule";
        }
        position.priorDailyCloses = [...position.priorDailyCloses, event.close].slice(-10);
      }
    }
    return book;
  }
  return book;
}
