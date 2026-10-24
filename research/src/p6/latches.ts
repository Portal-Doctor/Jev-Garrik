/**
 * Persisted entry latches. A green close does not clear one.
 * Daily and weekly reset only when their window rolls. The book halt and the
 * class dollar backstop stay until Brian's bound clear. Parity books never
 * call this: they keep the recomputed backtest rules.
 * Exits do not read these flags.
 */

import { BOOK_HALT_USD, DAILY_HALT_USD, WEEKLY_HALT_USD } from "../p3/design-rules";
import type { ClassId } from "../p3/portfolio";
import { CLASS_DOLLAR_BACKSTOP_USD } from "../p5/risk";

const CLASS_IDS: readonly ClassId[] = ["A", "B", "C", "D", "E"];
const CLEAR_SCOPES = new Set(["book", "class-A", "class-B", "class-C", "class-D", "class-E"]);
const DAY_WINDOW = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_WINDOW = /^\d{4}-W\d{2}$/;
const INT_TOKEN = /^\d+$/;
/** Last ids kept so a consumed clear token cannot fire again. */
const CLEARED_CAP = 20;
const FOUR_H_MS = 14_400_000;

export interface DailyLatch {
  tripAt: number;
  window: string;
  lossUsd: number;
}

export interface WeeklyLatch {
  tripAt: number;
  window: string;
  lossUsd: number;
}

export interface BookLatch {
  id: string;
  tripAt: number;
  drawdownUsd: number;
  peakEquityUsd: number;
}

export interface ClassLatch {
  id: string;
  tripAt: number;
  peakUsd: number;
  cumUsd: number;
  tradeId: string;
}

export interface RiskLatches {
  daily?: DailyLatch;
  weekly?: WeeklyLatch;
  book?: BookLatch;
  class?: Partial<Record<ClassId, ClassLatch>>;
}

/** After a manual clear, the trigger must go back under the line before it can trip again. */
export interface LatchRearm {
  book?: true;
  class?: Partial<Record<ClassId, true>>;
}

export interface LatchEquity {
  dailyLoss: number;
  weeklyLoss: number;
  drawdown: number;
  peakEquity: number;
}

export interface LatchBook {
  day: string | null;
  config: { parity?: unknown };
  classes: Record<ClassId, { peakUsd: number; cumUsd: number }>;
  closed: readonly { id: string; classId: ClassId }[];
  incidents: string[];
  latches?: RiskLatches;
  clearedLatchIds?: string[];
  latchRearm?: LatchRearm;
  /** D entries placed before this are not put back. The next 4h bar is a new signal. */
  dEntryNotBeforeMs?: number;
}

interface ClearRequest {
  scope: string;
  latchId: string;
  /** Canonical decimal. A leading zero is a different token and does not match. */
  tripText: string;
}

const clearSeen = new WeakMap<LatchBook, string>();

/** ISO week of a UTC day, `YYYY-Www`. The week rolls on Monday, with the registered book week. */
export function isoWeekWindow(day: string): string {
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  const date = new Date(parsed);
  const thursday = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = thursday.getUTCDay() || 7;
  thursday.setUTCDate(thursday.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 1));
  const week = Math.ceil((thursday.getTime() - yearStart.getTime()) / 86_400_000 / 7 + 1 / 7);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function classIdOf(scope: string): ClassId | null {
  if (!scope.startsWith("class-")) return null;
  const id = scope.slice("class-".length);
  return CLASS_IDS.includes(id as ClassId) ? (id as ClassId) : null;
}

function parseClear(token: string): ClearRequest | null {
  const parts = token.split(":");
  if (parts.length !== 3) return null;
  const scope = parts[0] ?? "";
  const latchId = parts[1] ?? "";
  const tripText = parts[2] ?? "";
  if (!CLEAR_SCOPES.has(scope) || !INT_TOKEN.test(tripText)) return null;
  // The trip text is the id's suffix. Number("0123") is 123, so a leading zero must not match.
  if (latchId !== `${scope}-${tripText}` || String(Number(tripText)) !== tripText) return null;
  const tripAt = Number(tripText);
  if (!Number.isSafeInteger(tripAt)) return null;
  return { scope, latchId, tripText };
}

function currentLatch(book: LatchBook, scope: string): { id: string; tripAt: number } | null {
  if (scope === "book") {
    const row = book.latches?.book;
    return row ? { id: row.id, tripAt: row.tripAt } : null;
  }
  const classId = classIdOf(scope);
  if (!classId) return null;
  const row = book.latches?.class?.[classId];
  return row ? { id: row.id, tripAt: row.tripAt } : null;
}

function rememberCleared(book: LatchBook, id: string): void {
  const next = [...(book.clearedLatchIds ?? [])];
  if (!next.includes(id)) next.push(id);
  book.clearedLatchIds = next.slice(-CLEARED_CAP);
}

function dropBookLatch(book: LatchBook): void {
  if (!book.latches?.book) return;
  delete book.latches.book;
  book.latchRearm = { ...book.latchRearm, book: true };
}

function dropClassLatch(book: LatchBook, classId: ClassId): void {
  const row = book.latches?.class;
  if (!row?.[classId]) return;
  delete row[classId];
  book.latchRearm = {
    ...book.latchRearm,
    class: { ...book.latchRearm?.class, [classId]: true },
  };
}

/**
 * Bound manual clear. The token is scope:latchId:tripAtMs.
 * A match removes that book or class latch. A mismatch, a stale token, or a token whose id was already cleared is one incident and changes nothing. The same line is not written again.
 * The raw token is not written onto the book.
 */
function applyClear(book: LatchBook, token: string | undefined): void {
  if (!token) return;
  const parsed = parseClear(token);
  const scope = parsed?.scope ?? "";
  const current = scope ? currentLatch(book, scope) : null;
  const seenKey = `${token}\0${current?.id ?? ""}`;
  if (clearSeen.get(book) === seenKey) return;
  clearSeen.set(book, seenKey);
  const tripText = String(current?.tripAt ?? "");
  if (!parsed || !current || current.id !== parsed.latchId || tripText !== parsed.tripText) {
    const line = parsed ? `latch_clear_mismatch scope=${parsed.scope} id=${parsed.latchId}` : "latch_clear_mismatch";
    if (!book.incidents.includes(line)) book.incidents.push(line);
    return;
  }
  if (parsed.scope === "book") dropBookLatch(book);
  else {
    const classId = classIdOf(parsed.scope);
    if (!classId) return;
    dropClassLatch(book, classId);
  }
  rememberCleared(book, parsed.latchId);
  book.incidents.push(`latch_cleared who=brian scope=${parsed.scope} id=${parsed.latchId}`);
}

function expireWindows(book: LatchBook): void {
  const day = book.day;
  if (!day || !book.latches) return;
  if (book.latches.daily && book.latches.daily.window !== day) delete book.latches.daily;
  const week = isoWeekWindow(day);
  if (book.latches.weekly && book.latches.weekly.window !== week) delete book.latches.weekly;
}

function relaxRearm(book: LatchBook, equity: LatchEquity): void {
  const rearm = book.latchRearm;
  if (!rearm) return;
  if (rearm.book && equity.drawdown < -BOOK_HALT_USD) delete rearm.book;
  if (rearm.class) {
    for (const classId of CLASS_IDS) {
      if (!rearm.class[classId]) continue;
      const curve = book.classes[classId];
      if (curve.peakUsd - curve.cumUsd < CLASS_DOLLAR_BACKSTOP_USD) delete rearm.class[classId];
    }
  }
}

function lastTradeId(book: LatchBook, classId: ClassId): string {
  for (let i = book.closed.length - 1; i >= 0; i -= 1) {
    const trade = book.closed[i];
    if (trade?.classId === classId) return trade.id;
  }
  return "none";
}

function trip(book: LatchBook, tsMs: number, equity: LatchEquity): void {
  const latches: RiskLatches = book.latches ?? {};
  if (book.day && !latches.daily && equity.dailyLoss >= DAILY_HALT_USD) {
    latches.daily = { tripAt: tsMs, window: book.day, lossUsd: equity.dailyLoss };
  }
  if (book.day && !latches.weekly && equity.weeklyLoss >= WEEKLY_HALT_USD) {
    latches.weekly = { tripAt: tsMs, window: isoWeekWindow(book.day), lossUsd: equity.weeklyLoss };
  }
  if (!latches.book && !book.latchRearm?.book && equity.drawdown >= -BOOK_HALT_USD) {
    latches.book = {
      id: `book-${tsMs}`,
      tripAt: tsMs,
      drawdownUsd: equity.drawdown,
      peakEquityUsd: equity.peakEquity,
    };
  }
  for (const classId of CLASS_IDS) {
    const curve = book.classes[classId];
    const gap = curve.peakUsd - curve.cumUsd;
    if (latches.class?.[classId] || book.latchRearm?.class?.[classId]) continue;
    if (gap < CLASS_DOLLAR_BACKSTOP_USD) continue;
    latches.class = latches.class ?? {};
    latches.class[classId] = {
      id: `class-${classId}-${tsMs}`,
      tripAt: tsMs,
      peakUsd: curve.peakUsd,
      cumUsd: curve.cumUsd,
      tradeId: lastTradeId(book, classId),
    };
  }
  book.latches = latches;
}

function prune(book: LatchBook): void {
  const latches = book.latches;
  if (latches?.class && CLASS_IDS.every((id) => latches.class?.[id] == null)) delete latches.class;
  if (latches && latches.daily == null && latches.weekly == null && latches.book == null && latches.class == null) delete book.latches;
  const rearm = book.latchRearm;
  if (rearm?.class && CLASS_IDS.every((id) => rearm.class?.[id] == null)) delete rearm.class;
  if (rearm && rearm.book == null && rearm.class == null) delete book.latchRearm;
  if (book.clearedLatchIds && book.clearedLatchIds.length === 0) delete book.clearedLatchIds;
}

/** Trip, expire, and apply one bound clear. No-op on a parity book. */
export function syncRiskLatches(book: LatchBook, tsMs: number, clearToken: string | undefined, equity: LatchEquity): void {
  if (book.config.parity) return;
  expireWindows(book);
  applyClear(book, clearToken);
  relaxRearm(book, equity);
  trip(book, tsMs, equity);
  prune(book);
}

export function haltLatchOn(book: LatchBook): boolean {
  const latches = book.latches;
  return latches?.daily != null || latches?.weekly != null || latches?.book != null;
}

export function classLatchOn(book: LatchBook, classId: ClassId): boolean {
  return book.latches?.class?.[classId] != null;
}

/** The following 4h close. A cancelled D entry is not restored before that evaluation. */
export function armDFreshFloor(book: LatchBook, tsMs: number): void {
  if (book.config.parity) return;
  const next = Math.floor(tsMs / FOUR_H_MS) * FOUR_H_MS + FOUR_H_MS;
  if (book.dEntryNotBeforeMs == null || next > book.dEntryNotBeforeMs) book.dEntryNotBeforeMs = next;
}

export function dEntryBeforeFresh(book: LatchBook, placedTs: number): boolean {
  return !book.config.parity && book.dEntryNotBeforeMs != null && placedTs < book.dEntryNotBeforeMs;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readDaily(value: unknown): DailyLatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (!finite(row.tripAt) || typeof row.window !== "string" || !DAY_WINDOW.test(row.window) || !finite(row.lossUsd)) return undefined;
  return { tripAt: row.tripAt, window: row.window, lossUsd: row.lossUsd };
}

function readWeekly(value: unknown): WeeklyLatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (!finite(row.tripAt) || typeof row.window !== "string" || !WEEK_WINDOW.test(row.window) || !finite(row.lossUsd)) return undefined;
  return { tripAt: row.tripAt, window: row.window, lossUsd: row.lossUsd };
}

function readBook(value: unknown): BookLatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (!finite(row.tripAt) || !finite(row.drawdownUsd) || !finite(row.peakEquityUsd)) return undefined;
  const id = `book-${row.tripAt}`;
  if (row.id !== id) return undefined;
  return { id, tripAt: row.tripAt, drawdownUsd: row.drawdownUsd, peakEquityUsd: row.peakEquityUsd };
}

function readClass(value: unknown, classId: ClassId): ClassLatch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const row = value as Record<string, unknown>;
  if (!finite(row.tripAt) || !finite(row.peakUsd) || !finite(row.cumUsd) || typeof row.tradeId !== "string" || row.tradeId.length === 0) return undefined;
  const id = `class-${classId}-${row.tripAt}`;
  if (row.id !== id) return undefined;
  return { id, tripAt: row.tripAt, peakUsd: row.peakUsd, cumUsd: row.cumUsd, tradeId: row.tradeId };
}

export function sanitizeLatches(value: unknown): RiskLatches | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const latches: RiskLatches = {};
  const daily = readDaily(row.daily);
  const weekly = readWeekly(row.weekly);
  const book = readBook(row.book);
  if (daily) latches.daily = daily;
  if (weekly) latches.weekly = weekly;
  if (book) latches.book = book;
  if (row.class && typeof row.class === "object" && !Array.isArray(row.class)) {
    const classes: Partial<Record<ClassId, ClassLatch>> = {};
    const raw = row.class as Record<string, unknown>;
    for (const classId of CLASS_IDS) {
      const item = readClass(raw[classId], classId);
      if (item) classes[classId] = item;
    }
    if (CLASS_IDS.some((id) => classes[id] != null)) latches.class = classes;
  }
  if (!latches.daily && !latches.weekly && !latches.book && !latches.class) return undefined;
  return latches;
}

function sanitizeRearm(value: unknown): LatchRearm | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const row = value as Record<string, unknown>;
  const rearm: LatchRearm = {};
  if (row.book === true) rearm.book = true;
  if (row.class && typeof row.class === "object" && !Array.isArray(row.class)) {
    const raw = row.class as Record<string, unknown>;
    const classes: Partial<Record<ClassId, true>> = {};
    for (const classId of CLASS_IDS) if (raw[classId] === true) classes[classId] = true;
    if (CLASS_IDS.some((id) => classes[id] === true)) rearm.class = classes;
  }
  if (!rearm.book && !rearm.class) return undefined;
  return rearm;
}

function sanitizeCleared(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((item): item is string => typeof item === "string" && /^(?:book|class-[A-E])-\d+$/.test(item));
  if (ids.length === 0) return undefined;
  return ids.slice(-CLEARED_CAP);
}

/** Fields that ride the existing hot flush. Absent when nothing is latched. */
export function latchHotFields(book: LatchBook): {
  latches?: RiskLatches;
  clearedLatchIds?: string[];
  latchRearm?: LatchRearm;
  dEntryNotBeforeMs?: number;
} {
  const latches = sanitizeLatches(book.latches);
  const clearedLatchIds = sanitizeCleared(book.clearedLatchIds);
  const latchRearm = sanitizeRearm(book.latchRearm);
  const out: {
    latches?: RiskLatches;
    clearedLatchIds?: string[];
    latchRearm?: LatchRearm;
    dEntryNotBeforeMs?: number;
  } = {};
  if (latches) out.latches = latches;
  if (clearedLatchIds) out.clearedLatchIds = clearedLatchIds;
  if (latchRearm) out.latchRearm = latchRearm;
  if (finite(book.dEntryNotBeforeMs)) out.dEntryNotBeforeMs = book.dEntryNotBeforeMs;
  return out;
}

/**
 * A full book snapshot is the source of truth: missing latch fields mean none.
 * A partial install that does not carry the book leaves the in-memory latches alone.
 */
export function adoptLatchState(
  book: LatchBook,
  body: {
    positions?: unknown;
    latches?: unknown;
    clearedLatchIds?: unknown;
    latchRearm?: unknown;
    dEntryNotBeforeMs?: unknown;
  },
): void {
  const full = body.positions !== undefined;
  const touched = full || "latches" in body || "clearedLatchIds" in body || "latchRearm" in body || "dEntryNotBeforeMs" in body;
  if (!touched) return;
  if (full || "latches" in body) {
    const latches = sanitizeLatches(body.latches);
    if (latches) book.latches = latches;
    else delete book.latches;
  }
  if (full || "clearedLatchIds" in body) {
    const ids = sanitizeCleared(body.clearedLatchIds);
    if (ids) book.clearedLatchIds = ids;
    else delete book.clearedLatchIds;
  }
  if (full || "latchRearm" in body) {
    const rearm = sanitizeRearm(body.latchRearm);
    if (rearm) book.latchRearm = rearm;
    else delete book.latchRearm;
  }
  if (full || "dEntryNotBeforeMs" in body) {
    if (finite(body.dEntryNotBeforeMs)) book.dEntryNotBeforeMs = body.dEntryNotBeforeMs;
    else delete book.dEntryNotBeforeMs;
  }
}
