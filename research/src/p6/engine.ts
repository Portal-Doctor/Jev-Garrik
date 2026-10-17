/**
 * Paper book. Events are injected. This module does not open a socket,
 * fetch, or sign. Risk is the forward Kelly schedule on the fixed $8,000
 * bankroll. The 20R kill and the $1,200 backstop use the running high-water
 * mark from amendment 2a. Open MTM includes the entry fee and the cost of a taker exit.
 */

import { newEntryOrder, type RestingOrder } from "../../vendor/87b35d0/fill.ts";
import { DEPLOYABLE_USD, MAKER_FEE_BPS, TAKER_FEE_BPS } from "../../vendor/87b35d0/config.ts";
import {
  BACKSTOP_PAIR_USD,
  BOOK_HALT_USD,
  classATenDayExit,
  classBDisasterStop,
  classBHeld,
  classEMoveToBreakEven,
  CLASS_C_MAX_HOLD_MS,
  CLASS_E_MAX_HOLD_MS,
  PAPER_MINIMUM_USD,
  stopFillPrice,
  tradeThroughFill,
  x1FillPrice,
  type ClassBRow,
} from "../p3/design-rules";
import { intrabarFill, trailAfterCompletedBar } from "../p3/fills";
import type { ClassId } from "../p3/portfolio";
import { dateOfTs, isDayCloseBar, TRAIL_ATR } from "../p5/book";
import { netBps } from "../p5/walk";
import { momentumBlocked, momentumCrashOn } from "../p5/guards";
import { isMondayCloseBar, x1EntryTs } from "../p5/run";
import { assignBetas, averageLinkage, betaWeight, CLASS_DOLLAR_BACKSTOP_USD, openRiskAfterMove } from "../p5/risk";
import type { SourceDay } from "../p3/bar-access";
import { forwardClusterBeta, latestClusterDate, type MemberCloses } from "./clusters";
import { readForwardPick, type APick, type APickLog } from "./select";
import { daysBetween, weekKey } from "../p5/stats";
import { shadowPackets, type ShadowPacket } from "./jev-shadow";
import { bookPanel, parity7d, weeklyHaltsInLast6, type BookPanel } from "./review";
import { forwardClassRisk, UNPROMOTED_RISK_USD, type KellyHold } from "./kelly";
import { delayBps, MISSED_SEND_STALE_QUOTE, STALE_QUOTE_MS, type LegLog } from "./legs";
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
  /** P5 historical book: fixed risk and s_bt, Jev guards off. */
  parity?: { riskUsd: number; sBtBps: number } | null;
  /** P5 monthly cluster id. When set, rho events are not used. */
  clusterOf?: (productId: string, tsMs: number) => string;
  /** Step-1 A config. Stays frozen unless monthlyASelect is on. */
  aPick?: APick | null;
  /** Off until Quant, Trader, and Brian approve monthly re-selection. */
  monthlyASelect?: boolean;
  /** Scores the expanded IS. Called at 00:00 UTC on the 1st when the flag is on. */
  aReselect?: (asOf: string) => APick | null;
  /** Daily closes for the forward cluster and beta schedule. Parity passes clusterOf instead. */
  memberCloses?: readonly MemberCloses[];
  btcCloses?: readonly { date: string; close: number }[];
  clusterMemberOn?: (productId: string, date: string) => boolean;
  /**
   * Live paper only. An exit reads the book at send and is not a trade when that book is stale.
   * Parity and injected tests leave this off, so a stored quote still prices the exit.
   */
  liveQuotes?: boolean;
}

export interface PairBackstopLog {
  kind: "trip" | "reenable";
  tsMs: number;
  realizedUsd: number;
  markedUsd: number;
  cumulativeUsd: number;
  who?: string;
  why?: string;
}

export interface PairBackstop {
  latched: boolean;
  /** Next trip is this cumulative P&L minus $500. Forward bar 1 starts at 0. */
  baselineUsd: number;
  log: PairBackstopLog[];
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
  /** Monday 01:00 (or another open) the held-set exit fills at. Unix seconds. */
  pendingExitTs: number | null;
  /** Bar open before the entry spread. Stop deduction and the 30-day R use this. */
  rawEntry: number;
  /** Stop at entry, before the trail. The 30-day unrealized R uses rawEntry minus this. */
  initialStop: number;
  /** Highest completed daily close since entry. The A trail reads it only on the day-close bar. */
  highestClose: number | null;
  clusterId: string;
  tick: number;
  /** A config at entry. A later pick does not change it. */
  aConfig: string | null;
  /** Assigned beta at entry. Later cluster dates do not reprice an open leg. */
  beta: number | null;
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
  quoteSource?: "l2" | "rest" | "rest_fallback";
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
  quotes: Record<string, { bid: number; ask: number; tsMs: number; quoteSrc?: "l2" | "rest_fallback" }>;
  momentumDates: string[];
  haltWeeks: string[];
  clusterMonth: string | null;
  /** Latest month start or fold start whose 60-day clusters are on the book. */
  clusterAsOf: string | null;
  forwardClusters: Record<string, string>;
  aPick: APick | null;
  aPicks: APickLog[];
  incidents: string[];
  pairs: Record<string, PairBackstop>;
  /** V6. Packets offered to Jev, and packets skipped because a 1m bar was missing. */
  jevPackets: number;
  jevSkipped: number;
  /** V6. Stops filled from the first price after a gap. */
  gapFills: number;
  /** Start of the 15m window whose Jev packets were already counted. */
  jevBarSec?: number;
  /**
   * UTC day the promotion clock may start. Null until p6:acct is loaded or written.
   * Not part of p6:hot. A missing value leaves the day count unrestricted.
   */
  acctFromDay: string | null;
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
      /** Registered A config that produced this entry. */
      aConfig?: string;
      /** V6. The bid and ask are a REST product-book snapshot, flagged on the leg. */
      quoteFallback?: boolean;
      /** When the signal was known. Logged. Not a staleness input. */
      decisionTs?: number;
      /** When the signal bar closed. Logged. Not a staleness input. */
      barCloseTs?: number;
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
      /** Wall-clock time the order is sent. Staleness is measured from this, not from the signal time. */
      sendTsMs?: number;
      decisionMid: number;
      tick?: number;
      target?: number;
      /** V6. The bid and ask are a REST product-book snapshot. */
      quoteFallback?: boolean;
      decisionTs?: number;
      barCloseTs?: number;
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
      dailyAtr?: number;
      bScores?: ClassBRow[];
      /** gap runs before entries. rest runs after. all is both, for injected tests. */
      phase?: "gap" | "rest" | "all";
      /** V6. A 1m bar is missing in this window, so Jev is not called. */
      missing1m?: boolean;
      /** False for catch-up and history bars. Those bars do not move the skip count. */
      countJev?: boolean;
      /** V6. This bar is the first price after a feed gap. */
      feedGap?: boolean;
    }
  | { kind: "btc"; tsMs: number; return60: number; return10: number }
  | { kind: "rho"; a: string; b: string; rho: number; month?: string }
  | { kind: "gap"; productId: string; startMs?: number; endMs?: number }
  | { kind: "trade"; productId: string; price: number; size: number; makerSide: string; tsMs?: number; handoverMicro?: boolean }
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
    }
  | { kind: "pair-enable"; productId: string; tsMs: number; who: string; why: string };

function emptyCounts(): Record<ClassId, number> {
  return { A: 0, B: 0, C: 0, D: 0, E: 0 };
}

function emptyClasses(): Record<ClassId, ClassCurve> {
  return { A: freshClassCurve(), B: freshClassCurve(), C: freshClassCurve(), D: freshClassCurve(), E: freshClassCurve() };
}

export function freshBook(config: Partial<BookConfig> = {}): Book {
  if ("aPick" in config && config.aPick === null) throw new Error("refusing a book with no A pick");
  const aPick = config.aPick !== undefined ? config.aPick : config.parity ? null : readForwardPick();
  return {
    config: {
      members: config.members ?? [],
      parity: config.parity ?? null,
      clusterOf: config.clusterOf,
      aPick,
      monthlyASelect: config.monthlyASelect === true,
      aReselect: config.aReselect,
      memberCloses: config.memberCloses,
      btcCloses: config.btcCloses,
      clusterMemberOn: config.clusterMemberOn,
    },
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
    clusterAsOf: null,
    forwardClusters: {},
    aPick,
    aPicks: aPick ? [{ ...aPick, reason: "forward-bar-1" }] : [],
    incidents: [],
    pairs: {},
    jevPackets: 0,
    jevSkipped: 0,
    gapFills: 0,
    acctFromDay: null,
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

/** Forward report block. Every A pick is logged with the six IS statistics. */
export function forwardSessionReport(book: Book, replayNetUsd: number | null): BookPanel & { aPicks: APickLog[] } {
  return { ...forwardBookPanel(book, replayNetUsd), aPicks: book.aPicks };
}

export function bookRoundTrip(book: Book): Book {
  return JSON.parse(JSON.stringify(book)) as Book;
}

function utcDay(tsMs: number): string {
  return new Date(tsMs).toISOString().slice(0, 10);
}

function parityRoundTripUsd(position: Position, mark: number, sBtBps: number): number {
  const exitFill = x1FillPrice(mark, "sell", sBtBps);
  const net = netBps(position.fillPrice, exitFill, TAKER_FEE_BPS, TAKER_FEE_BPS);
  return (net / 10_000) * position.units * position.fillPrice;
}

/**
 * The exit-cost term inside markedPnl. One definition.
 * A live book uses notional × (taker bps + the position's live slippage) / 10_000.
 * A parity book has no separate slippage term: this returns the residual
 * notional − cost basis − round-trip mark, so markedPnl stays the round-trip net.
 */
export function openExitCostUsd(book: Book, position: Position, mark: number): number {
  const notional = mark * position.units;
  const costBasis = position.units * position.fillPrice + position.entryFeeUsd;
  if (book.config.parity) return notional - costBasis - parityRoundTripUsd(position, mark, book.config.parity.sBtBps);
  return (notional * (TAKER_FEE_BPS + position.sLiveBps)) / 10_000;
}

export function markedPnl(book: Book, position: Position, mark: number): number {
  const notional = mark * position.units;
  const costBasis = position.units * position.fillPrice + position.entryFeeUsd;
  // The close already subtracts entryFeeUsd once. Charging it here keeps equity continuous. Parity already charges the round trip.
  return notional - openExitCostUsd(book, position, mark) - costBasis;
}

function openMtm(book: Book): number {
  let total = 0;
  for (const position of book.positions) {
    const mark = book.marks[position.productId] ?? position.fillPrice;
    total += markedPnl(book, position, mark);
  }
  return total;
}

export interface ClassPnl {
  cumR: number;
  peakR: number;
  drawdownR: number;
  cumUsd: number;
  peakUsd: number;
  drawdownUsd: number;
  paused: boolean;
  killed: boolean;
  /** Paused-state size. Null when the class is not paused. */
  sizingUsd: number | null;
}

export interface PairPnl {
  productId: string;
  classId: string;
  side: "long" | "flat";
  entry: number | null;
  stop: number | null;
  unrealizedUsd: number;
  realizedUsd: number;
  feesUsd: number;
  latched: boolean;
  /** Dollars of room before the $500 pair backstop. Zero when latched. */
  roomUsd: number;
}

export interface PaperPnl {
  startingUsd: number;
  realizedUsd: number;
  unrealizedUsd: number;
  equityUsd: number;
  feesUsd: number;
  spreadSlipUsd: number;
  /** Mean decision-to-arrival bps of the last 20 legs. Not part of cost. */
  arrivalDelayBps: number | null;
  feeBps: { maker: number; taker: number };
  book: { hwmUsd: number; drawdownUsd: number; haltUsd: number; roomUsd: number };
  classes: { A: ClassPnl; B: ClassPnl; C: ClassPnl; D: ClassPnl; E: ClassPnl };
  classBackstopUsd: number;
  pairBackstopUsd: number;
  pairs: PairPnl[];
}

function classPnl(curve: ClassCurve): ClassPnl {
  const cumR = curve.netR.reduce((sum, value) => sum + value, 0);
  const paused = curve.pause.paused || curve.bleed.paused;
  return {
    cumR,
    peakR: curve.pause.peak,
    drawdownR: Math.max(0, curve.pause.peak - cumR),
    cumUsd: curve.cumUsd,
    peakUsd: curve.peakUsd,
    drawdownUsd: Math.max(0, curve.peakUsd - curve.cumUsd),
    paused: curve.pause.paused,
    killed: curve.pause.killed,
    sizingUsd: paused ? PAPER_MINIMUM_USD : null,
  };
}

/** R3 equity and the Quant bars. The page displays this and does not recompute it. */
export function paperPnl(book: Book): PaperPnl {
  const unrealizedUsd = openMtm(book);
  const mtm = book.realizedUsd + unrealizedUsd;
  const equityUsd = DEPLOYABLE_USD + mtm;
  const hwmUsd = DEPLOYABLE_USD + Math.max(book.peakEquity, mtm);
  const drawdownUsd = Math.max(0, hwmUsd - equityUsd);
  const haltUsd = Math.abs(BOOK_HALT_USD);
  const feesUsd = book.legs.reduce((sum, leg) => sum + leg.feesUsd, 0);
  const closedFees = new Map<string, number>();
  for (const leg of book.legs) {
    const id = leg.side === "exit" ? leg.id.replace(/:exit$/, "") : leg.id;
    closedFees.set(id, (closedFees.get(id) ?? 0) + leg.feesUsd);
  }
  let spreadSlipUsd = book.positions.reduce((sum, position) => sum + position.entrySpreadUsd, 0);
  for (const trade of book.closed) spreadSlipUsd += Math.max(0, trade.costUsd - (closedFees.get(trade.id) ?? 0));
  const recent = book.legs.slice(-20);
  const delays = recent.flatMap((leg) => {
    const delay = delayBps(leg.decisionMid, leg.arrivalMid);
    return delay == null ? [] : [delay];
  });
  const arrivalDelayBps = delays.length > 0 ? delays.reduce((sum, value) => sum + value, 0) / delays.length : null;
  const ids = [...new Set([...book.positions.map((row) => row.productId), ...book.closed.map((row) => row.productId)])];
  const pairs: PairPnl[] = ids.map((productId) => {
    const open = book.positions.filter((row) => row.productId === productId);
    const parts = pairParts(book, productId);
    const state = book.pairs[productId];
    const latched = state?.latched === true;
    const baseline = state?.baselineUsd ?? 0;
    const roomUsd = latched ? 0 : Math.max(0, BACKSTOP_PAIR_USD - (baseline - parts.cumulativeUsd));
    const fees = book.legs.filter((leg) => leg.productId === productId).reduce((sum, leg) => sum + leg.feesUsd, 0);
    const position = open[0];
    return {
      productId,
      classId: position?.classId ?? book.closed.filter((row) => row.productId === productId).at(-1)?.classId ?? "",
      side: open.length > 0 ? "long" : "flat",
      entry: position?.fillPrice ?? null,
      stop: position?.stop ?? null,
      unrealizedUsd: parts.markedUsd,
      realizedUsd: parts.realizedUsd,
      feesUsd: fees,
      latched,
      roomUsd,
    };
  });
  return {
    startingUsd: DEPLOYABLE_USD,
    realizedUsd: book.realizedUsd,
    unrealizedUsd,
    equityUsd,
    feesUsd,
    spreadSlipUsd,
    arrivalDelayBps,
    feeBps: { maker: MAKER_FEE_BPS, taker: TAKER_FEE_BPS },
    book: { hwmUsd, drawdownUsd, haltUsd, roomUsd: Math.max(0, haltUsd - drawdownUsd) },
    classes: {
      A: classPnl(book.classes.A),
      B: classPnl(book.classes.B),
      C: classPnl(book.classes.C),
      D: classPnl(book.classes.D),
      E: classPnl(book.classes.E),
    },
    classBackstopUsd: CLASS_DOLLAR_BACKSTOP_USD,
    pairBackstopUsd: BACKSTOP_PAIR_USD,
    pairs,
  };
}

function pairParts(book: Book, productId: string): { realizedUsd: number; markedUsd: number; cumulativeUsd: number } {
  let realizedUsd = 0;
  for (const trade of book.closed) if (trade.productId === productId) realizedUsd += trade.netUsd;
  let markedUsd = 0;
  for (const position of book.positions) {
    if (position.productId !== productId) continue;
    const mark = book.marks[productId] ?? position.fillPrice;
    markedUsd += markedPnl(book, position, mark);
  }
  return { realizedUsd, markedUsd, cumulativeUsd: realizedUsd + markedUsd };
}

function pairState(book: Book, productId: string): PairBackstop {
  const existing = book.pairs[productId];
  if (existing) return existing;
  const created: PairBackstop = { latched: false, baselineUsd: 0, log: [] };
  book.pairs[productId] = created;
  return created;
}

/** Latches one pair at -$500 from its baseline. A recovery does not clear it. */
function reviewPair(book: Book, productId: string, tsMs: number): void {
  if (book.config.parity) return;
  const state = pairState(book, productId);
  if (state.latched) return;
  const parts = pairParts(book, productId);
  if (parts.cumulativeUsd <= state.baselineUsd - BACKSTOP_PAIR_USD) {
    state.latched = true;
    state.log.push({ kind: "trip", tsMs, realizedUsd: parts.realizedUsd, markedUsd: parts.markedUsd, cumulativeUsd: parts.cumulativeUsd });
  }
}

function reviewKnownPairs(book: Book, tsMs: number): void {
  const ids = new Set<string>([
    ...book.positions.map((position) => position.productId),
    ...book.closed.map((trade) => trade.productId),
    ...Object.keys(book.marks),
  ]);
  for (const id of ids) reviewPair(book, id, tsMs);
}

function pairLatched(book: Book, productId: string): boolean {
  return book.pairs[productId]?.latched === true;
}

/** P5 blocks the entry while that pair's loss is at least $500, and allows it again if the mark recovers. */
function pairEntryBlocked(book: Book, productId: string): boolean {
  if (book.config.parity) return Math.max(0, -pairParts(book, productId).cumulativeUsd) >= BACKSTOP_PAIR_USD;
  return pairLatched(book, productId);
}

function decisionBlockers(book: Book, classId: ClassId, tsMs: number) {
  const equity = equityOf(book);
  const blockers = classBlockers(classId, book.classes[classId], {
    halt: equity.halt,
    backstop: equity.backstop,
    momentumBlocked: book.config.parity ? false : momentumBlocked(book.momentumDates, utcDay(tsMs)),
    killSwitch: book.killSwitch,
  });
  if (!book.config.parity) return blockers;
  return blockers.filter((item) => item !== "pause-1b" && item !== "pause-1c" && item !== "pause-2b");
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
  if (book.day === null || day > book.day) {
    const previous = book.day;
    book.day = day;
    book.dayStartEquity = equity;
    refreshForwardClusters(book, day);
    if (book.config.monthlyASelect && previous != null && day.endsWith("-01") && book.config.aReselect) {
      const next = book.config.aReselect(day);
      if (next) {
        book.aPick = next;
        book.config.aPick = next;
        book.aPicks.push({ ...next, at: day, reason: "month" });
      }
    }
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
      fromDay: book.acctFromDay,
    });
    book.kelly[classId] = { reviewMonday: size.reviewMonday, riskUsd: size.riskUsd, promoted: size.promoted };
  }
}

function scheduledRisk(book: Book, classId: ClassId): number {
  if (book.config.parity) return book.config.parity.riskUsd;
  return book.kelly[classId]?.riskUsd ?? UNPROMOTED_RISK_USD;
}

function spreadBps(book: Book, bid: number, ask: number): number | null {
  if (book.config.parity) return book.config.parity.sBtBps;
  return halfSpreadBps(bid, ask);
}

function noteQuote(book: Book, productId: string, bid: number, ask: number, tsMs: number): void {
  book.quotes[productId] = { bid, ask, tsMs };
}

function clusterIds(book: Book, productId: string): string[] {
  if (book.config.members.length === 0) return [...new Set([...book.positions.map((position) => position.productId), productId])];
  return book.config.members.includes(productId) ? book.config.members : [productId];
}

/** Fold one completed daily close into the live cluster inputs. The month schedule still decides when betas change. */
export function noteMemberDay(book: Book, productId: string, day: SourceDay): void {
  const members = book.config.memberCloses;
  if (members) {
    const row = members.find((member) => member.productId === productId);
    if (row) {
      const days = row.days as SourceDay[];
      const at = days.findIndex((item) => item.date === day.date);
      if (at >= 0) days[at] = day;
      else days.push(day);
      days.sort((a, b) => (a.date < b.date ? -1 : 1));
    }
  }
  if (productId === "BTC-USD" && !day.empty && day.close > 0 && book.config.btcCloses) {
    const closes = book.config.btcCloses as { date: string; close: number }[];
    const at = closes.findIndex((item) => item.date === day.date);
    const point = { date: day.date, close: day.close };
    if (at >= 0) closes[at] = point;
    else closes.push(point);
    closes.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
}

function refreshForwardClusters(book: Book, day: string): void {
  const closes = book.config.memberCloses;
  if (!closes || closes.length === 0 || book.config.clusterOf) return;
  const asOf = latestClusterDate(day);
  if (!asOf || asOf === book.clusterAsOf) return;
  const computed = forwardClusterBeta(closes, book.config.btcCloses ?? [], asOf, book.config.clusterMemberOn);
  const clusters: Record<string, string> = {};
  for (const [id, cluster] of computed.clusters) clusters[id] = cluster;
  book.forwardClusters = clusters;
  book.clusterAsOf = asOf;
  const betas: Record<string, number | null> = {};
  for (const [id, beta] of computed.betas) betas[id] = beta;
  book.betas = betas;
}

function clusterOf(book: Book, productId: string, tsMs = book.nowMs): string {
  if (book.config.clusterOf) return book.config.clusterOf(productId, tsMs);
  if (book.config.memberCloses && book.config.memberCloses.length > 0) {
    const day = tsMs > 0 ? new Date(tsMs).toISOString().slice(0, 10) : book.day;
    if (day) refreshForwardClusters(book, day);
    return book.forwardClusters[productId] ?? productId;
  }
  const ids = clusterIds(book, productId);
  const groups = averageLinkage(ids, (left, right) => {
    if (left === right) return 1;
    const key = [left, right].sort().join("|");
    return book.rho[key] ?? null;
  });
  return groups.get(productId) ?? productId;
}

function clusterOpen(book: Book, productId: string, tsMs = book.nowMs): number {
  const cluster = clusterOf(book, productId, tsMs);
  return book.positions.filter((position) => position.clusterId === cluster).length;
}

/** P5 keeps entry risk until the stop moves, then prices the distance from the fill. */
function liveOpenRisk(book: Book, position: Position): number {
  if (!book.config.parity || !(position.stop > position.initialStop)) return position.riskUsd;
  return openRiskAfterMove(position.units, position.fillPrice, position.stop, position.sLiveBps);
}

function betaAdd(book: Book, productId: string, notional: number): number {
  if (book.config.memberCloses && book.config.memberCloses.length > 0 && !book.config.clusterOf) {
    let total = 0;
    for (const position of book.positions) total += position.notionalUsd * betaWeight(position.beta ?? 1);
    total += notional * betaWeight(book.betas[productId] ?? 1);
    return total;
  }
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
  rawEntry?: number;
  aConfig?: string | null;
  quoteFallback?: boolean;
  decisionTs?: number;
  barCloseTs?: number;
}): boolean {
  reviewKnownPairs(book, opts.tsMs);
  if (pairEntryBlocked(book, opts.productId)) {
    book.rejected.push({ id: opts.id, reason: "pair-backstop" });
    return false;
  }
  const blockers = decisionBlockers(book, opts.classId, opts.tsMs);
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
  const openRisk = book.positions.reduce((sum, position) => sum + liveOpenRisk(book, position), 0);
  const gross = book.positions.reduce((sum, position) => sum + position.notionalUsd, 0);
  const failed = entryGates({
    openPairs: book.positions.map((position) => position.productId),
    pair: opts.productId,
    classId: opts.classId,
    classOpen: book.positions.filter((position) => position.classId === opts.classId).length,
    bookOpen: book.positions.length,
    openInCluster: clusterOpen(book, opts.productId, opts.tsMs),
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
    stale: opts.quoteFallback === true,
    source: opts.quoteFallback ? "rest" : "l2",
    quoteSrc: opts.quoteFallback ? "rest_fallback" : "l2",
    decisionTs: opts.decisionTs,
    barCloseTs: opts.barCloseTs,
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
    pendingExitTs: null,
    rawEntry: opts.rawEntry ?? opts.fillPrice,
    initialStop: opts.stop,
    highestClose: null,
    clusterId: clusterOf(book, opts.productId, opts.tsMs),
    tick: opts.tick ?? 0.01,
    aConfig: opts.aConfig ?? null,
    beta: book.betas[opts.productId] ?? null,
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
  const age = quote ? opts.tsMs - quote.tsMs : Number.POSITIVE_INFINITY;
  if (book.config.liveQuotes && !(quote && age <= STALE_QUOTE_MS)) {
    book.rejected.push({ id: `${position.id}:exit`, reason: MISSED_SEND_STALE_QUOTE });
    book.incidents.push(`${MISSED_SEND_STALE_QUOTE} ${position.id}`);
    return;
  }
  const stale = quote == null || age > STALE_QUOTE_MS || quote.quoteSrc === "rest_fallback";
  const bid = quote?.bid ?? 0;
  const ask = quote?.ask ?? 0;
  const arrivalMid = opts.kind === "stop" ? position.stop : (bid + ask) / 2;
  const exitNotional = position.units * opts.fill;
  const exitFee = (exitNotional * (opts.makerExit ? MAKER_FEE_BPS : TAKER_FEE_BPS)) / 10_000;
  const slip = opts.makerExit ? 0 : Math.max(0, arrivalMid - opts.fill) * position.units;
  const costUsd = position.entryFeeUsd + position.entrySpreadUsd + exitFee + slip;
  const takerParity = book.config.parity != null && opts.makerExit !== true && position.fillPrice > 0;
  const netBps = ((opts.fill - position.fillPrice) / position.fillPrice) * 10_000 - TAKER_FEE_BPS - TAKER_FEE_BPS;
  const netUsd = takerParity
    ? (netBps / 10_000) * position.units * position.fillPrice
    : (opts.fill - position.fillPrice) * position.units - position.entryFeeUsd - exitFee;
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
    stale,
    source: quote?.quoteSrc === "rest_fallback" ? "rest" : "l2",
    quoteSrc: quote?.quoteSrc ?? (quote ? "l2" : undefined),
    decisionTs: opts.tsMs,
    barCloseTs: opts.triggerBarTs ?? undefined,
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
  reviewPair(book, position.productId, opts.tsMs);
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
    pendingExitTs: null,
    rawEntry: fillPrice,
    initialStop: working.stop,
    highestClose: null,
    clusterId: clusterOf(book, working.order.pair),
    tick: working.tick,
    aConfig: null,
    beta: book.betas[working.order.pair] ?? null,
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
    reviewPair(book, event.productId, book.nowMs);
    return book;
  }
  if (event.kind === "pair-enable") {
    touchTime(book, event.tsMs);
    const who = event.who.trim();
    const why = event.why.trim();
    if (who.length === 0 || why.length === 0) {
      book.rejected.push({ id: `pair-enable-${event.productId}`, reason: "reenable-note" });
      return book;
    }
    const state = book.pairs[event.productId];
    if (!state?.latched) {
      book.rejected.push({ id: `pair-enable-${event.productId}`, reason: "not-latched" });
      return book;
    }
    const parts = pairParts(book, event.productId);
    state.latched = false;
    state.baselineUsd = parts.cumulativeUsd;
    state.log.push({
      kind: "reenable",
      tsMs: event.tsMs,
      realizedUsd: parts.realizedUsd,
      markedUsd: parts.markedUsd,
      cumulativeUsd: parts.cumulativeUsd,
      who,
      why,
    });
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
    reviewPair(book, event.productId, event.exitTs);
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
    if (event.handoverMicro) {
      for (const position of [...book.positions]) {
        if (position.productId !== event.productId) continue;
        if (!(event.price <= position.stop)) continue;
        book.quotes[position.productId] = { bid: event.price, ask: event.price, tsMs };
        book.incidents.push(`handover_micro ${position.id}`);
        closePosition(book, position, { tsMs, fill: event.price, kind: "stop", triggerBarTs: tsMs, decisionMid: event.price });
      }
    }
    return book;
  }
  if (event.kind === "gap") {
    book.shadows = book.shadows.map((order) => (order.productId === event.productId ? onFeedGap(order) : order));
    book.working = book.working.filter((order) => {
      if (order.order.pair !== event.productId || order.status !== "working") return true;
      if (event.startMs != null && event.endMs != null) {
        const touches = order.order.placedTs <= event.endMs && order.order.expireTs >= event.startMs;
        if (!touches) return true;
      }
      order.status = "indeterminate";
      book.indeterminateByClass[order.classId] += 1;
      return false;
    });
    return book;
  }
  if (event.kind === "x1") {
    touchTime(book, event.tsMs);
    if (event.classId === "A" && !event.aConfig) {
      book.rejected.push({ id: event.id, reason: "a-config" });
      return book;
    }
    if (event.classId === "A" && book.aPick && event.aConfig !== book.aPick.config) {
      book.rejected.push({ id: event.id, reason: "a-config" });
      return book;
    }
    if (event.sendTsMs - event.bookTsMs > STALE_QUOTE_MS) {
      book.rejected.push({ id: event.id, reason: MISSED_SEND_STALE_QUOTE });
      book.incidents.push(`${MISSED_SEND_STALE_QUOTE} ${event.id}`);
      return book;
    }
    const sLive = spreadBps(book, event.bid, event.ask);
    if (sLive == null) {
      book.rejected.push({ id: event.id, reason: "no-book" });
      return book;
    }
    let stop = event.stop;
    if (event.classId === "B" && (event.dailyAtr ?? 0) > 0) stop = Math.max(stop, classBDisasterStop(event.nextOpen, event.dailyAtr ?? 0));
    const stopBps = ((event.nextOpen - stop) / event.nextOpen) * 10_000;
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
      stop,
      atr1h: event.atr1h,
      maker: false,
      target: event.target ?? null,
      dailyAtr: event.dailyAtr ?? 0,
      priorDailyCloses: event.priorDailyCloses ?? [],
      rawEntry: event.nextOpen,
      aConfig: event.classId === "A" ? (event.aConfig ?? null) : null,
      quoteFallback: event.quoteFallback === true,
      decisionTs: event.decisionTs,
      barCloseTs: event.barCloseTs,
    });
    return book;
  }
  if (event.kind === "d-order") {
    touchTime(book, event.placedTs);
    if ((event.sendTsMs ?? event.placedTs) - event.bookTsMs > STALE_QUOTE_MS) {
      book.rejected.push({ id: event.id, reason: MISSED_SEND_STALE_QUOTE });
      book.incidents.push(`${MISSED_SEND_STALE_QUOTE} ${event.id}`);
      return book;
    }
    const sLive = spreadBps(book, event.bid, event.ask);
    if (sLive == null) {
      book.rejected.push({ id: event.id, reason: "no-book" });
      return book;
    }
    reviewKnownPairs(book, event.placedTs);
    if (pairEntryBlocked(book, event.productId)) {
      book.rejected.push({ id: event.id, reason: "pair-backstop" });
      return book;
    }
    const arrivalMid = (event.bid + event.ask) / 2;
    const stopBps = ((event.limit - event.stop) / event.limit) * 10_000;
    if (!(stopBps > 0)) {
      book.rejected.push({ id: event.id, reason: "stop" });
      return book;
    }
    noteQuote(book, event.productId, event.bid, event.ask, event.bookTsMs);
    const blockers = decisionBlockers(book, "D", event.placedTs);
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
      openInCluster: clusterOpen(book, event.productId, event.placedTs),
      openRiskUsd: book.positions.reduce((sum, position) => sum + liveOpenRisk(book, position), 0),
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
      quoteSource: event.quoteFallback ? "rest_fallback" : "l2",
    });
    return book;
  }
  if (event.kind === "minute") {
    touchTime(book, event.tsMs);
    book.working = book.working.filter((working) => working.order.pair !== event.productId || event.tsMs < working.order.expireTs);
    return book;
  }
  if (event.kind === "bar15") {
    const phase = event.phase ?? "all";
    const closed = strategyBarClosed(event.startSec, event.nowSec);
    if (closed && phase === "gap") {
      touchTime(book, event.startSec * 1000);
    } else if (closed) {
      book.marks[event.productId] = event.close;
      if (event.countJev !== false && book.jevBarSec !== event.startSec) {
        book.jevBarSec = event.startSec;
        const packets = shadowPackets({ members: book.config.members, barStartSec: event.startSec, nowSec: event.nowSec, warming: false });
        book.jevPackets += packets.length;
        if (event.missing1m) {
          book.jevSkipped += packets.length;
          book.incidents.push(`jev skip ${event.productId} ${event.startSec}`);
        } else {
          book.packets.push(...packets);
        }
      }
      touchTime(book, (event.startSec + 900) * 1000);
      reviewPair(book, event.productId, (event.startSec + 900) * 1000);
    }
    const barTs = event.startSec * 1000;
    const bar = { open: event.open, high: event.high, low: event.low, close: event.close };
      const dayClose = event.dailyClose ?? isDayCloseBar(event.startSec);
    for (const position of [...book.positions]) {
      if (position.productId !== event.productId) continue;
      if (!closed || !barBeginsAtOrAfterEntry(event.startSec, position.entryTs)) continue;
      const stop = position.stop;
      const hit = intrabarFill(bar, stop, Number.POSITIVE_INFINITY);
      if (hit.kind === "stop" && hit.price != null) {
        const gap = event.open <= stop;
        if (phase === "gap" && !gap) continue;
        const fill = gap ? event.open : stopFillPrice(stop, position.rawEntry, position.sLiveBps, event.atr1h ?? position.atr1h);
        if (event.feedGap) {
          book.gapFills += 1;
          book.incidents.push(`gap fill ${position.id}`);
        }
        closePosition(book, position, { tsMs: barTs, fill, kind: "stop", triggerBarTs: barTs, decisionMid: event.close });
        continue;
      }
      if (phase === "gap") continue;
      const openFill = () => takerSell(event.open, position.sLiveBps);
      if (position.pendingExitTs != null && event.startSec >= position.pendingExitTs) {
        closePosition(book, position, { tsMs: barTs, fill: openFill(), kind: "rule", triggerBarTs: barTs, decisionMid: event.close });
        continue;
      }
      if (position.pendingExit) {
        closePosition(book, position, { tsMs: barTs, fill: openFill(), kind: position.pendingExit, triggerBarTs: barTs, decisionMid: event.close });
        continue;
      }
      if (position.classId === "E" && position.target != null && event.high >= position.target) {
        closePosition(book, position, { tsMs: barTs, fill: position.target, kind: "target", triggerBarTs: barTs, decisionMid: event.close });
        continue;
      }
      const hold = position.classId === "C" ? CLASS_C_MAX_HOLD_MS : position.classId === "E" ? CLASS_E_MAX_HOLD_MS : position.classId === "D" ? D_MAX_HOLD_MS : null;
      if (hold != null && barTs >= position.entryTs + hold) {
        closePosition(book, position, { tsMs: barTs, fill: openFill(), kind: "time", triggerBarTs: barTs, decisionMid: event.close });
        continue;
      }
      if (position.classId === "B" && event.bScores && dayClose && isMondayCloseBar(dateOfTs(event.startSec)) && !classBHeld(event.bScores, position.productId)) {
        position.pendingExitTs = x1EntryTs(dateOfTs(event.startSec));
      }
      if (position.classId === "A" && dayClose) {
        const atr = event.dailyAtr != null && event.dailyAtr > 0 ? event.dailyAtr : position.dailyAtr;
        if (atr > 0 && event.close > 0) {
          position.highestClose = Math.max(position.highestClose ?? Number.NEGATIVE_INFINITY, event.close);
          position.dailyAtr = atr;
          position.stop = Math.max(position.stop, position.highestClose - TRAIL_ATR * atr);
        }
        const barDate = dateOfTs(event.startSec);
        const entryDate = utcDay(position.entryTs);
        if (barDate > entryDate) {
          const heldDays = daysBetween(entryDate, barDate);
          const distance = position.rawEntry - position.initialStop;
          const unrealizedR = distance > 0 ? (event.close - position.rawEntry) / distance : 0;
          const prior = position.priorDailyCloses.slice(-10);
          if (classATenDayExit(event.close, prior) || (heldDays >= 30 && unrealizedR < 1)) position.pendingExit = "rule";
        }
        if (barDate >= entryDate) position.priorDailyCloses = [...position.priorDailyCloses, event.close].slice(-10);
      }
      if (position.classId === "D" && position.dailyAtr > 0) position.stop = trailAfterCompletedBar(position.stop, event.close, position.dailyAtr);
      if (position.classId === "E") position.stop = classEMoveToBreakEven(position.stop, position.fillPrice, event.close);
    }
    return book;
  }
  return book;
}
