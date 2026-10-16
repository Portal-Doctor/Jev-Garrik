/**
 * Hourly paper P/L for /p6. The page only reads these keys.
 * A book reset must delete p6:eq:* . That delete is deferred and is not built here.
 * Nothing in this file is written into p6:hot.
 */

import { DEPLOYABLE_USD } from "../../vendor/87b35d0/config.ts";

export const PNL_START_USD = DEPLOYABLE_USD;
export const EQ_HOUR_MS = 3_600_000;
export const EQ_TTL_MS = 31 * 24 * 60 * 60 * 1000;
export const FIFTEEN_MS = 15 * 60 * 1000;
export const STALE_MS = 20 * 60 * 1000;
export const EQ_FIRST_KEY = "p6:eq:first";
/** Per-hour trade lists above this are not stored. The hour is unknown, not a short list. */
export const EQ_TRADE_CAP = 500;
export const N_NOTE = "n<30: not statistically meaningful";

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

/** Trades closed in that hour. Separate from the NX equity snapshot so later closes can be recorded. */
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

export interface EqTrade {
  id: string;
  exitTs: number;
  net: number;
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
 * Closed-trade source: one compact list per hour, on p6:eq:tr:{hour}, not p6:fills or p6:ledger.
 * The equity snapshot stays NX. This list is rewritten from the holder's in-memory closes for that hour.
 * A missing hour is unknown. A list over the cap is unknown too, so a short list is never shown as complete.
 */
export function encodeHourTrades(closed: { id: string; exitTs: number; netUsd: number }[], hourSec: number): string {
  const from = hourSec * 1000;
  const to = from + EQ_HOUR_MS;
  const rows: [string, number, number][] = [];
  for (const trade of closed) {
    if (!(trade.exitTs >= from && trade.exitTs < to)) continue;
    if (typeof trade.id !== "string" || !Number.isFinite(trade.netUsd)) continue;
    rows.push([trade.id, trade.exitTs, trade.netUsd]);
  }
  if (rows.length > EQ_TRADE_CAP) return JSON.stringify({ cut: true });
  return JSON.stringify(rows);
}

/** Null means the hour is unknown. An empty array means the hour had no closes. */
export function parseHourTrades(raw: string | null): EqTrade[] | null {
  if (raw == null) return null;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(body)) return null;
  const trades: EqTrade[] = [];
  for (const row of body) {
    if (!Array.isArray(row) || row.length < 3) return null;
    if (typeof row[0] !== "string" || typeof row[1] !== "number" || typeof row[2] !== "number") return null;
    if (!Number.isFinite(row[1]) || !Number.isFinite(row[2])) return null;
    trades.push({ id: row[0], exitTs: row[1], net: row[2] });
  }
  return trades;
}

export interface EquityExtra {
  key: string;
  value: string;
  px?: number;
  nx?: boolean;
}

/**
 * Entries for the existing flush EVAL. Zero extra Redis commands.
 * The hour snapshot and p6:eq:first are NX. The hour's trade list is not, so closes during the hour are kept.
 */
export function equityExtras(input: {
  nowMs: number;
  eqHourDone: number;
  pnl: { equityUsd: number; realizedUsd: number; unrealizedUsd: number; feesUsd: number; spreadSlipUsd: number };
  closed: { id: string; exitTs: number; netUsd: number }[];
}): EquityExtra[] {
  const hour = hourStartSec(input.nowMs);
  const trades = encodeHourTrades(input.closed, hour);
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

/** One MGET: every hour in the 30d horizon (drawdown and trades), the 30d anchor's previous hour, and first. */
export function pnlMgetKeys(nowMs: number): string[] {
  const end = lastCompletedCloseMs(nowMs);
  const latest = hourStartSec(end);
  const earliest = hourStartSec(end - 30 * 24 * EQ_HOUR_MS);
  const keys = new Set<string>([EQ_FIRST_KEY, eqKey(earliest - 3600)]);
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
  /** Grey short-history line. Null when the window starts after the first point. */
  since: string | null;
  /** True when an hour's trades are unknown, or the anchor is outside the one-hour tolerance. */
  partial: boolean;
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
  /** Null when realized <= 0 or n < 3. */
  concentrationPct: number | null;
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

export function signedUsd(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}$${value.toFixed(2)}`;
}

export function signedPct(value: number): string {
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toFixed(2)}%`;
}

export function wlText(wins: number, losses: number): string {
  return `${wins}W-${losses}L`;
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

export function formatCt(ms: number, withDate: boolean): string {
  const date = new Date(ms);
  if (!withDate) {
    const time = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Chicago",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(date);
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
    partial: false,
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
  };
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
  trades: Map<number, EqTrade[] | null>;
}): PnlBlock {
  const end = lastCompletedCloseMs(input.nowMs);
  const hours = new Set<number>();
  for (const point of input.points) hours.add(point.hourStartSec);
  if (input.first) hours.add(input.first.hourStartSec);
  const pointCount = hours.size;
  const stale = input.lastEndMs == null || input.nowMs - input.lastEndMs > STALE_MS;
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
    const short = start < origin.ts;
    const since = short ? sinceText(end - origin.ts, window.span) : null;
    const startHour = hourStartSec(start);
    const tolerance = input.points.filter((point) => Math.abs(point.hourStartSec - startHour) <= 3600 && point.ts <= start);
    tolerance.sort((a, b) => b.ts - a.ts);
    const anchor = tolerance[0] ?? (origin.ts <= end ? origin : null);
    if (!anchor) return emptyTile(window.id, window.span, start, end, since ?? "no data yet");
    const inTolerance = tolerance.length > 0;
    let partial = !inTolerance;
    const fromHour = Math.max(startHour, origin.hourStartSec);
    const toHour = hourStartSec(end);
    const trades: EqTrade[] = [];
    for (let hour = fromHour; hour <= toHour; hour += 3600) {
      const list = input.trades.get(hour);
      if (list == null) {
        partial = true;
        continue;
      }
      for (const trade of list) {
        if (trade.exitTs <= start || trade.exitTs > end) continue;
        if (trade.exitTs < origin.ts) continue;
        trades.push(trade);
      }
    }
    const total = input.equityNow! - anchor.equity;
    const realized = input.realizedNow! - anchor.realized;
    const unrealizedDelta = input.unrealizedNow! - anchor.unrealized;
    let wins = 0;
    let losses = 0;
    let largest = 0;
    let seen = false;
    for (const trade of trades) {
      if (trade.net > 0) wins += 1;
      else if (trade.net < 0) losses += 1;
      if (!seen || trade.net > largest) {
        largest = trade.net;
        seen = true;
      }
    }
    const path = input.points.filter((point) => point.ts >= anchor.ts && point.ts <= end);
    const concentration = realized > 0 && trades.length >= 3 ? (largest / realized) * 100 : null;
    return {
      id: window.id,
      span: window.span,
      status: "ok" as const,
      since,
      partial,
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
      closedN: trades.length,
      drawdownUsd: hourlyDrawdown(path),
      concentrationPct: concentration,
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

/** Bytes of 30d of hour snapshots plus one trade row per hour, values only. Keys are extra and small. */
export function equitySeriesValueBytes(tradesPerHour: number): number {
  const point = Buffer.byteLength(encodePoint({ ts: 0, equity: 8000, realized: 0, unrealized: 0, fees: 0, spreadSlip: 0 }));
  const sample = Array.from({ length: tradesPerHour }, (_, index) => ({
    id: `trade-${index}`,
    exitTs: index,
    netUsd: 1,
  }));
  const trades = Buffer.byteLength(encodeHourTrades(sample, 0));
  return 30 * 24 * (point + trades);
}
