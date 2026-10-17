/**
 * Hourly paper P/L for /p6. The page only reads these keys.
 * A book reset must delete p6:eq:* . That delete is deferred and is not built here.
 * Nothing in this file is written into p6:hot.
 *
 * Closed trades are a per-hour aggregate on p6:eq:tr:{hour}, not a list of trade ids.
 * Totals still come from the cumulative equity and realized points, not from that aggregate.
 */

import { DEPLOYABLE_USD } from "../../vendor/87b35d0/config.ts";

export const PNL_START_USD = DEPLOYABLE_USD;
export const EQ_HOUR_MS = 3_600_000;
export const EQ_TTL_MS = 31 * 24 * 60 * 60 * 1000;
export const FIFTEEN_MS = 15 * 60 * 1000;
export const STALE_MS = 20 * 60 * 1000;
export const EQ_FIRST_KEY = "p6:eq:first";
/** An hour with more closes than this is unknown. The aggregate is not a truncated list. */
export const EQ_TRADE_CAP = 500;
export const N_MIN = 30;
export const N_NOTE = "n<30: not statistically meaningful";
/** An anchor older than this, measured from the window start, greys that tile. Exactly this age does not. */
export const ANCHOR_GREY_MS = EQ_HOUR_MS;

const WINDOWS = [
  { id: "8h", ms: 8 * EQ_HOUR_MS, span: "8h" },
  { id: "24h", ms: 24 * EQ_HOUR_MS, span: "24h" },
  { id: "7d", ms: 7 * 24 * EQ_HOUR_MS, span: "7d" },
  { id: "30d", ms: 30 * 24 * EQ_HOUR_MS, span: "30d" },
] as const;

export type PnlWindowId = (typeof WINDOWS)[number]["id"];

export function eqKey(hourStartSec: number): string {
  return `p6:eq:${hourStartSec}`;
}

/** Per-hour close aggregate. Separate from the NX equity snapshot so later closes can be recorded. */
export function eqTradeKey(hourStartSec: number): string {
  return `p6:eq:tr:${hourStartSec}`;
}

export function hourStartSec(ms: number): number {
  return Math.floor(ms / EQ_HOUR_MS) * 3600;
}

/** Last completed 15m close at or before now. A timestamp exactly on a boundary is that close. */
export function lastCompletedCloseMs(nowMs: number): number {
  return Math.floor(nowMs / FIFTEEN_MS) * FIFTEEN_MS;
}

export interface EqPoint {
  hourStartSec: number;
  ts: number;
  equity: number;
  realized: number;
  unrealized: number;
  fees: number;
  spreadSlip: number;
}

/** Counts for one hour. No trade ids. largestNet is the greatest net, not the greatest absolute net. */
export interface HourAgg {
  n: number;
  wins: number;
  losses: number;
  flat: number;
  largestNet: number;
  realizedSum: number;
}

export function encodePoint(point: Omit<EqPoint, "hourStartSec">): string {
  return JSON.stringify([point.ts, point.equity, point.realized, point.unrealized, point.fees, point.spreadSlip]);
}

export function parsePoint(raw: string | null, hour: number): EqPoint | null {
  if (!raw) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(body) || body.length < 6) return null;
  const nums = body.slice(0, 6).map((value) => (typeof value === "number" ? value : Number.NaN));
  if (nums.some((value) => !Number.isFinite(value))) return null;
  return {
    hourStartSec: hour,
    ts: nums[0]!,
    equity: nums[1]!,
    realized: nums[2]!,
    unrealized: nums[3]!,
    fees: nums[4]!,
    spreadSlip: nums[5]!,
  };
}

/**
 * Closed-trade source: one numeric aggregate per hour, on p6:eq:tr:{hour}, not p6:fills or p6:ledger.
 * The equity snapshot stays NX. This aggregate is rewritten from the holder's in-memory closes for that hour.
 * A missing hour is unknown. More than EQ_TRADE_CAP closes is unknown too, so a short count is never shown as complete.
 * A close at the hour start is included. A close at the next hour start belongs to the next hour.
 */
export function encodeHourAgg(closed: { exitTs: number; netUsd: number }[], hourSec: number): string {
  const from = hourSec * 1000;
  const to = from + EQ_HOUR_MS;
  let n = 0;
  let wins = 0;
  let losses = 0;
  let flat = 0;
  let largest = 0;
  let seen = false;
  let sum = 0;
  for (const trade of closed) {
    if (!(trade.exitTs >= from && trade.exitTs < to)) continue;
    if (!Number.isFinite(trade.netUsd)) continue;
    n += 1;
    if (n > EQ_TRADE_CAP) return JSON.stringify({ cut: true });
    if (trade.netUsd > 0) wins += 1;
    else if (trade.netUsd < 0) losses += 1;
    else flat += 1;
    if (!seen || trade.netUsd > largest) {
      largest = trade.netUsd;
      seen = true;
    }
    sum += trade.netUsd;
  }
  return JSON.stringify([n, wins, losses, flat, seen ? largest : 0, sum]);
}

/** Null means the hour is unknown (missing, cut, or not an aggregate). A zero aggregate means the hour had no closes. */
export function parseHourAgg(raw: string | null): HourAgg | null {
  if (raw == null) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(body) || body.length < 6) return null;
  const nums = body.slice(0, 6).map((value) => (typeof value === "number" ? value : Number.NaN));
  if (nums.some((value) => !Number.isFinite(value))) return null;
  const n = nums[0]!;
  const wins = nums[1]!;
  const losses = nums[2]!;
  const flat = nums[3]!;
  if (n < 0 || wins < 0 || losses < 0 || flat < 0) return null;
  return { n, wins, losses, flat, largestNet: nums[4]!, realizedSum: nums[5]! };
}

export interface EquityExtra {
  key: string;
  value: string;
  px?: number;
  nx?: boolean;
}

/**
 * Entries for the existing flush EVAL. Zero extra Redis commands.
 * The hour snapshot and p6:eq:first are NX. The hour's aggregate is not, so closes during the hour are kept.
 */
export function equityExtras(input: {
  nowMs: number;
  eqHourDone: number;
  pnl: { equityUsd: number; realizedUsd: number; unrealizedUsd: number; feesUsd: number; spreadSlipUsd: number };
  closed: { exitTs: number; netUsd: number }[];
}): EquityExtra[] {
  const hour = hourStartSec(input.nowMs);
  const trades = encodeHourAgg(input.closed, hour);
  const entries: EquityExtra[] = [{ key: eqTradeKey(hour), value: trades, px: EQ_TTL_MS }];
  if (input.eqHourDone === hour) return entries;
  const point = encodePoint({
    ts: input.nowMs,
    equity: input.pnl.equityUsd,
    realized: input.pnl.realizedUsd,
    unrealized: input.pnl.unrealizedUsd,
    fees: input.pnl.feesUsd,
    spreadSlip: input.pnl.spreadSlipUsd,
  });
  entries.push({ key: eqKey(hour), value: point, px: EQ_TTL_MS, nx: true });
  entries.push({ key: EQ_FIRST_KEY, value: point, nx: true });
  return entries;
}

/**
 * One MGET. The lookback is the 31-day TTL, so every unexpired hourly point is in this read.
 * That is the anchor set. There is no second read and no ±1h key.
 * A point older than the TTL is gone. p6:eq:first is the only fallback, and only when nothing in this read is at or before the window start.
 */
export function pnlMgetKeys(nowMs: number): string[] {
  const end = lastCompletedCloseMs(nowMs);
  const latest = hourStartSec(end);
  const earliest = hourStartSec(end - EQ_TTL_MS);
  const keys = new Set<string>([EQ_FIRST_KEY]);
  for (let hour = earliest; hour <= latest; hour += 3600) {
    keys.add(eqKey(hour));
    keys.add(eqTradeKey(hour));
  }
  return [...keys].sort();
}

export interface PnlTile {
  id: PnlWindowId;
  span: string;
  status: "ok" | "no-data";
  /** Grey short-history line. Null when a point exists at or before the window start. */
  since: string | null;
  /** Set when the chosen anchor is more than an hour before the window start. Null on a since-start fallback. */
  anchorLabel: string | null;
  /** True when any hour in the window has no aggregate, or was over the close cap. W-L is then not a number. */
  tradesUnknown: boolean;
  windowStartMs: number;
  windowEndMs: number;
  anchorTs: number | null;
  totalUsd: number | null;
  totalPct: number | null;
  realizedUsd: number | null;
  realizedPct: number | null;
  unrealizedDelta: number | null;
  feesUsd: number | null;
  spreadSlipUsd: number | null;
  wins: number;
  losses: number;
  closedN: number;
  /** Peak-to-trough on the hourly points inside the window. */
  drawdownUsd: number | null;
  /** Null when trades are unknown, realized <= 0, n < 3, or the largest net is not positive. */
  concentrationPct: number | null;
  /** Set when the window does not start and end on an hour. W-L then uses complete hours only. */
  hourNote: string | null;
}

export interface PnlBlock {
  stale: boolean;
  /** p6:lastRun end. The header clock. Null when that timestamp is missing. */
  lastUpdatedMs: number | null;
  paperStartMs: number | null;
  pointCount: number;
  openPositions: number;
  openUnrealized: number | null;
  tiles: PnlTile[];
}

function roundedCents(value: number): number {
  return Math.round(value * 100) / 100;
}

function groupedAbs(cents: number): string {
  return Math.abs(cents).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** Signed dollars. The sign sits before the dollar sign, and thousands are grouped. */
export function signedUsd(value: number): string {
  const cents = roundedCents(value);
  if (cents === 0) return "$0.00";
  const body = groupedAbs(cents);
  return cents < 0 ? `-$${body}` : `+$${body}`;
}

/** Hourly drawdown. Unsigned when the drop is non-negative. A minus is allowed. A plus is not. */
export function drawdownText(value: number): string {
  const cents = roundedCents(value);
  if (cents === 0) return "$0.00";
  const body = groupedAbs(cents);
  if (cents < 0) return `-$${body}`;
  return `$${body}`;
}

export function signedPct(value: number): string {
  const rounded = roundedCents(value);
  if (rounded === 0) return "0.00%";
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded.toFixed(2)}%`;
}

export function wlText(wins: number, losses: number): string {
  return `${wins}W-${losses}L`;
}

export function closedNote(n: number): string {
  return n < N_MIN ? N_NOTE : "";
}

export function concentrationText(pct: number | null): string {
  if (pct == null) return "n/a";
  return `largest trade = ${pct.toFixed(1)}% of window realized`;
}

export function sinceText(ageMs: number, span: string): string {
  const hours = Math.max(0, Math.floor(ageMs / EQ_HOUR_MS));
  const days = Math.floor(hours / 24);
  const rem = hours % 24;
  return `since start: ${days}d ${rem}h of ${span}`;
}

export function anchorAgeLabel(ageMs: number): string {
  const hours = Math.floor(ageMs / EQ_HOUR_MS);
  const minutes = Math.floor((ageMs % EQ_HOUR_MS) / 60_000);
  return `anchor ${hours}h ${String(minutes).padStart(2, "0")}m old`;
}

/** Missing, null, or non-numeric lastRun end is stale. Exactly STALE_MS old is not. */
export function endIsStale(nowMs: number, lastEndMs: number | null | undefined): boolean {
  if (typeof lastEndMs !== "number") return true;
  return nowMs - lastEndMs > STALE_MS;
}

/** Time-only CT clock. hourCycle h23, so a midnight hour is 00 and not 24, and not hour12. */
export const CT_CLOCK: Intl.DateTimeFormatOptions = {
  timeZone: "America/Chicago",
  hourCycle: "h23",
  hour: "2-digit",
  minute: "2-digit",
};

/** Shown when a window edge is not on an hour. Those hours are left out of W-L. */
export const HOUR_EDGE_NOTE = "counts complete hours only";

export function tileMarkedGrey(tile: { since: string | null; anchorLabel: string | null }): boolean {
  return tile.since != null || tile.anchorLabel != null;
}

export function formatCt(ms: number, withDate: boolean): string {
  const date = new Date(ms);
  if (!withDate) {
    const time = new Intl.DateTimeFormat("en-US", CT_CLOCK).format(date);
    return `${time} CT`;
  }
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${day}, ${time} CT`;
}

function hourlyDrawdown(points: EqPoint[]): number | null {
  if (points.length === 0) return null;
  const sorted = [...points].sort((a, b) => a.ts - b.ts);
  let peak = sorted[0]!.equity;
  let drop = 0;
  for (const point of sorted) {
    if (point.equity > peak) peak = point.equity;
    const gap = peak - point.equity;
    if (gap > drop) drop = gap;
  }
  return drop;
}

function emptyTile(id: PnlWindowId, span: string, start: number, end: number, since: string | null): PnlTile {
  return {
    id,
    span,
    status: "no-data",
    since,
    anchorLabel: null,
    tradesUnknown: false,
    windowStartMs: start,
    windowEndMs: end,
    anchorTs: null,
    totalUsd: null,
    totalPct: null,
    realizedUsd: null,
    realizedPct: null,
    unrealizedDelta: null,
    feesUsd: null,
    spreadSlipUsd: null,
    wins: 0,
    losses: 0,
    closedN: 0,
    drawdownUsd: null,
    concentrationPct: null,
    hourNote: null,
  };
}

/** Complete clock hours inside [startMs, endMs]. An hour that hangs over either edge is omitted. */
export function completeHourSpan(startMs: number, endMs: number): { fromSec: number; toSec: number } | null {
  const first = Math.ceil(startMs / EQ_HOUR_MS) * EQ_HOUR_MS;
  const last = Math.floor((endMs - EQ_HOUR_MS) / EQ_HOUR_MS) * EQ_HOUR_MS;
  if (!(last >= first)) return null;
  return { fromSec: first / 1000, toSec: last / 1000 };
}

export function buildPnlBlock(input: {
  nowMs: number;
  lastEndMs: number | null;
  equityNow: number | null;
  realizedNow: number | null;
  unrealizedNow: number | null;
  feesNow: number | null;
  spreadNow: number | null;
  openPositions: number;
  first: EqPoint | null;
  points: EqPoint[];
  trades: Map<number, HourAgg | null>;
}): PnlBlock {
  const end = lastCompletedCloseMs(input.nowMs);
  const hours = new Set<number>();
  for (const point of input.points) hours.add(point.hourStartSec);
  if (input.first) hours.add(input.first.hourStartSec);
  const pointCount = hours.size;
  const stale = endIsStale(input.nowMs, input.lastEndMs);
  const earliest = input.points.reduce<EqPoint | null>((min, point) => (min == null || point.ts < min.ts ? point : min), null);
  const origin = input.first ?? earliest;
  const ready =
    pointCount >= 2 &&
    origin != null &&
    input.equityNow != null &&
    input.realizedNow != null &&
    input.unrealizedNow != null &&
    input.feesNow != null &&
    input.spreadNow != null;
  const tiles = WINDOWS.map((window) => {
    const start = end - window.ms;
    if (!ready || !origin) return emptyTile(window.id, window.span, start, end, "no data yet");
    const atOrBefore = input.points.filter((point) => point.ts <= start);
    if (origin.ts <= start) atOrBefore.push(origin);
    atOrBefore.sort((a, b) => b.ts - a.ts);
    const found = atOrBefore[0] ?? null;
    const anchor = found ?? (origin.ts <= end ? origin : null);
    const short = found == null && origin.ts > start;
    const since = short ? sinceText(end - origin.ts, window.span) : null;
    if (!anchor) return emptyTile(window.id, window.span, start, end, since ?? "no data yet");
    const anchorLabel = found != null && start - found.ts > ANCHOR_GREY_MS ? anchorAgeLabel(start - found.ts) : null;
    const span = completeHourSpan(start, end);
    const hourNote = start % EQ_HOUR_MS !== 0 || end % EQ_HOUR_MS !== 0 ? HOUR_EDGE_NOTE : null;
    let tradesUnknown = false;
    let wins = 0;
    let losses = 0;
    let closedN = 0;
    let largest = 0;
    let seen = false;
    // Hours before the paper-start hour are outside the series. The since-start label covers them.
    // A missing hour after that start, inside the complete-hour span, is unknown.
    const fromSec = span ? Math.max(span.fromSec, origin.hourStartSec) : null;
    if (span && fromSec != null && fromSec <= span.toSec) {
      for (let hour = fromSec; hour <= span.toSec; hour += 3600) {
        const agg = input.trades.get(hour);
        if (agg == null) {
          tradesUnknown = true;
          continue;
        }
        closedN += agg.n;
        wins += agg.wins;
        losses += agg.losses;
        if (agg.n > 0 && (!seen || agg.largestNet > largest)) {
          largest = agg.largestNet;
          seen = true;
        }
      }
    }
    if (tradesUnknown) {
      wins = 0;
      losses = 0;
      closedN = 0;
      seen = false;
    }
    const total = input.equityNow! - anchor.equity;
    const realized = input.realizedNow! - anchor.realized;
    const unrealizedDelta = input.unrealizedNow! - anchor.unrealized;
    const path = input.points.filter((point) => point.ts >= anchor.ts && point.ts <= end);
    // A partial edge (hourNote) mixes complete-hour winners with whole-window realized.
    // Withhold the ratio. An aligned window has no partial hour, so the window realized is that same span.
    const concentration =
      hourNote == null && !tradesUnknown && realized > 0 && closedN >= 3 && seen && largest > 0 ? (largest / realized) * 100 : null;
    return {
      id: window.id,
      span: window.span,
      status: "ok" as const,
      since,
      anchorLabel,
      tradesUnknown,
      windowStartMs: start,
      windowEndMs: end,
      anchorTs: anchor.ts,
      totalUsd: total,
      totalPct: (total / PNL_START_USD) * 100,
      realizedUsd: realized,
      realizedPct: (realized / PNL_START_USD) * 100,
      unrealizedDelta,
      feesUsd: input.feesNow! - anchor.fees,
      spreadSlipUsd: input.spreadNow! - anchor.spreadSlip,
      wins,
      losses,
      closedN,
      drawdownUsd: hourlyDrawdown(path),
      concentrationPct: concentration,
      hourNote,
    };
  });
  return {
    stale,
    lastUpdatedMs: input.lastEndMs,
    paperStartMs: origin?.ts ?? null,
    pointCount,
    openPositions: input.openPositions,
    openUnrealized: input.unrealizedNow,
    tiles,
  };
}

/** Values only, over the 31-day read: one equity point and one aggregate per hour. */
export function equitySeriesValueBytes(tradesPerHour: number): number {
  const point = Buffer.byteLength(encodePoint({ ts: 1_760_637_600_000, equity: 8123.45, realized: 123.45, unrealized: 12.34, fees: 4.56, spreadSlip: 1.23 }));
  const trades = Buffer.byteLength(realisticHourAggregate(tradesPerHour, 1_760_637_600));
  const hours = 31 * 24 + 1;
  return hours * (point + trades);
}

/** RESP bulk array for one equity MGET, realistic numbers, every hour present. This is the page-read reply, not the key list. */
export function pnlPageReplyBytes(nowMs: number, tradesPerHour = 20): number {
  const keys = pnlMgetKeys(nowMs);
  const point = encodePoint({ ts: nowMs, equity: 8123.45, realized: 123.45, unrealized: 12.34, fees: 4.56, spreadSlip: 1.23 });
  const agg = realisticHourAggregate(tradesPerHour, hourStartSec(nowMs));
  const values = keys.map((key) => {
    if (key.startsWith("p6:eq:tr:")) return agg;
    if (key === EQ_FIRST_KEY || key.startsWith("p6:eq:")) return point;
    return null;
  });
  let bytes = Buffer.byteLength(`*${values.length}\r\n`);
  for (const value of values) {
    if (value == null) {
      bytes += Buffer.byteLength("$-1\r\n");
      continue;
    }
    const len = Buffer.byteLength(value);
    bytes += Buffer.byteLength(`$${len}\r\n`) + len + Buffer.byteLength("\r\n");
  }
  return bytes;
}

function realisticHourAggregate(tradesPerHour: number, hourSec: number): string {
  const closed = Array.from({ length: tradesPerHour }, (_, index) => ({
    exitTs: hourSec * 1000 + index * 1000,
    netUsd: index % 5 === 0 ? 0 : index % 3 === 0 ? -1.25 : 2.5,
  }));
  return encodeHourAgg(closed, hourSec);
}
