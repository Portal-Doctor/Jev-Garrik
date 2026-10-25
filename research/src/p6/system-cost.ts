/**
 * Display-only system-cost hurdle for /p6 and /p6/health.json.
 * Nothing here is an input to promotion, kill, sizing, or the engine.
 * A bad config becomes an unavailable hurdle. It does not throw.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PNL_START_USD } from "./pnl-block";

/**
 * When the forward test began: the registered first forward bar.
 * system-cost.test.ts locks this string to FORWARD_BAR_1 in select.ts.
 */
export const SYSTEM_COST_START_ISO = "2026-10-10T00:00:00.000Z";
export const SYSTEM_COST_START_MS = Date.parse(SYSTEM_COST_START_ISO);

/**
 * Hosting cutover to a local Docker server at no charge.
 * Brian set this to the forward start. Vercel and Redis accrue until this instant, and $0 applies after it.
 * The hurdle light uses this same instant: cost before it is sunk history.
 */
export const SYSTEM_COST_CUTOVER_ISO = "2026-10-26T00:00:00.000Z";
export const SYSTEM_COST_CUTOVER_MS = Date.parse(SYSTEM_COST_CUTOVER_ISO);

/**
 * Display conversion. $20 is 1R, the unpromoted paper risk.
 * system-cost.test.ts locks this to PAPER_MINIMUM_USD.
 * It does not size a trade.
 */
export const SYSTEM_COST_R_USD = 20;

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;
const MONTHS_PER_YEAR = 12;

export interface SystemCostItem {
  name: string;
  monthlyUsd: number;
  note?: string;
  /** True when this line's monthly amount is an estimate. Display only. */
  estimate?: boolean;
  /** ISO date the line starts, inclusive, when the file is effective-dated. */
  from?: string;
  /** ISO date the line ends, exclusive, when the file is effective-dated. */
  until?: string;
}

export interface SystemCostSpan {
  /** ISO date, inclusive. 00:00Z. */
  from: string;
  /** ISO date, exclusive. 00:00Z. Absent on the open-ended span. */
  until?: string;
  items: SystemCostItem[];
}

export interface SystemCostConfig {
  lastUpdated: string;
  /** Legacy single rate, or the open-ended span when the file is effective-dated. */
  items: SystemCostItem[];
  /** Effective-dated rates. Accrual integrates these. Absent on a legacy file. */
  spans?: SystemCostSpan[];
  /** ISO date of the hosting cutover. Display only. Brian set it to the forward start. */
  cutover?: string;
}

export type SystemCostStatus = "ok" | "unavailable";
export type SystemCostLight = "green" | "amber" | "red" | "unavailable";

export interface SystemCostHurdle {
  status: SystemCostStatus;
  light: SystemCostLight;
  lastUpdated?: string;
  monthlyUsd?: number;
  monthlyR?: number;
  accruedUsd?: number;
  accruedR?: number;
  /**
   * Cost accrued before the forward start (SYSTEM_COST_CUTOVER_ISO).
   * Shown on the dashboard. Excluded from net and from the light.
   */
  sunkUsd?: number;
  sunkR?: number;
  /**
   * Header P/L: engine equity minus the paper start capital.
   * Includes the engine's open marks. Not the class A book. Null when equity is missing.
   */
  pnlUsd?: number | null;
  pnlR?: number | null;
  /**
   * Class A book P/L used by the light: realized plus open marks since the forward start.
   * Null when that input was not supplied. Zero is a real book with nothing accrued.
   */
  classAPnlUsd?: number | null;
  classAPnlR?: number | null;
  netUsd?: number | null;
  netR?: number | null;
  since?: string;
  elapsedDays?: number;
  items?: SystemCostItem[];
}

export const SYSTEM_COST_UNAVAILABLE: SystemCostHurdle = { status: "unavailable", light: "unavailable" };

/** ISO calendar date, YYYY-MM-DD. A datetime and an impossible day are rejected. */
export function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function nonNegativeFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function parseItems(raw: unknown): SystemCostItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items: SystemCostItem[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const item = row as Record<string, unknown>;
    if (typeof item.name !== "string" || item.name.trim() === "") return null;
    if (!nonNegativeFinite(item.monthlyUsd)) return null;
    if (item.note != null && typeof item.note !== "string") return null;
    if (item.estimate != null && typeof item.estimate !== "boolean") return null;
    const parsed: SystemCostItem = { name: item.name.trim(), monthlyUsd: item.monthlyUsd };
    if (typeof item.note === "string" && item.note.trim() !== "") parsed.note = item.note;
    if (item.estimate === true) parsed.estimate = true;
    items.push(parsed);
  }
  return items;
}

function dateMs(isoDate: string): number {
  return Date.parse(`${isoDate}T00:00:00.000Z`);
}

/** A span that shares any positive-length interval with another. Touching endpoints are contiguous, not an overlap. */
export class SystemCostSpanOverlapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SystemCostSpanOverlapError";
  }
}

function spanLabel(span: SystemCostSpan): string {
  return `${span.from}..${span.until ?? "open"}`;
}

/** Returns the first overlapping pair. Contiguous spans, where one `until` equals the next `from`, are not a pair. */
export function overlappingSystemCostSpans(spans: readonly SystemCostSpan[]): [SystemCostSpan, SystemCostSpan] | null {
  const ordered = spans
    .map((span, index) => ({
      span,
      index,
      fromMs: dateMs(span.from),
      untilMs: span.until == null ? Number.POSITIVE_INFINITY : dateMs(span.until),
    }))
    .sort((a, b) => a.fromMs - b.fromMs || a.untilMs - b.untilMs || a.index - b.index);
  for (let i = 1; i < ordered.length; i += 1) {
    const prev = ordered[i - 1]!;
    const next = ordered[i]!;
    if (prev.untilMs > next.fromMs) return [prev.span, next.span];
  }
  return null;
}

/**
 * A config is accepted only when lastUpdated is a real ISO date and every
 * line item has a name and a non-negative finite monthlyUsd. One bad item
 * rejects the file. There is no partial sum.
 * A legacy file is `{ lastUpdated, items }` and accrues that one rate.
 * An effective-dated file is `{ lastUpdated, spans }` and integrates each span.
 * Overlapping spans throw SystemCostSpanOverlapError. A span that ends where the next starts stays valid.
 */
export function parseSystemCostConfig(raw: unknown): SystemCostConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.lastUpdated !== "string" || !isIsoDate(body.lastUpdated)) return null;
  if (body.cutover != null && (typeof body.cutover !== "string" || !isIsoDate(body.cutover))) return null;
  if (body.spans != null) {
    if (!Array.isArray(body.spans) || body.spans.length === 0) return null;
    const spans: SystemCostSpan[] = [];
    for (const row of body.spans) {
      if (!row || typeof row !== "object" || Array.isArray(row)) return null;
      const span = row as Record<string, unknown>;
      if (typeof span.from !== "string" || !isIsoDate(span.from)) return null;
      if (span.until != null && (typeof span.until !== "string" || !isIsoDate(span.until))) return null;
      if (span.until != null && dateMs(span.until) <= dateMs(span.from)) return null;
      const items = parseItems(span.items);
      if (!items) return null;
      spans.push({ from: span.from, ...(typeof span.until === "string" ? { until: span.until } : {}), items });
    }
    const overlap = overlappingSystemCostSpans(spans);
    if (overlap) throw new SystemCostSpanOverlapError(`overlapping system cost spans: ${spanLabel(overlap[0])} and ${spanLabel(overlap[1])}`);
    const open = spans.filter((span) => span.until == null);
    const items = (open.length === 1 ? open[0] : spans[spans.length - 1])!.items.map((item) => ({ ...item }));
    return { lastUpdated: body.lastUpdated, items, spans, ...(typeof body.cutover === "string" ? { cutover: body.cutover } : {}) };
  }
  const items = parseItems(body.items);
  if (!items) return null;
  return { lastUpdated: body.lastUpdated, items };
}

/**
 * The committed JSON. A static `new URL("./system-cost.json")` is rewritten into a
 * page asset that readFileSync cannot open, so the dashboard would show unavailable
 * while the route still loaded. These are plain paths. The file is also listed in
 * web/next.config.ts so the deploy trace keeps it.
 */
function committedConfigText(): string {
  const paths: string[] = [];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    paths.push(join(/*turbopackIgnore: true*/ here, "system-cost.json"));
  } catch {
    // A bundled url is not a file path. The cwd candidates below still apply.
  }
  const cwd = process.cwd();
  paths.push(join(/*turbopackIgnore: true*/ cwd, "research", "src", "p6", "system-cost.json"));
  paths.push(join(/*turbopackIgnore: true*/ cwd, "..", "research", "src", "p6", "system-cost.json"));
  let last: unknown;
  for (const path of paths) {
    try {
      return readFileSync(/*turbopackIgnore: true*/ path, "utf8");
    } catch (error) {
      last = error;
    }
  }
  throw last instanceof Error ? last : new Error("system cost config missing");
}

/**
 * Reads the committed JSON. A malformed file is null.
 * Overlapping spans throw SystemCostSpanOverlapError instead of being billed twice.
 */
export function loadSystemCostConfig(text?: string): SystemCostConfig | null {
  try {
    const raw = text ?? committedConfigText();
    return parseSystemCostConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SystemCostSpanOverlapError) throw error;
    return null;
  }
}

/**
 * Accrued system cost since `startMs`.
 *
 * Proration: a day is 86,400,000 ms. The daily rate is
 * `monthlyUsd * 12 / 365.25`, so 365.25 days cost twelve months.
 * `accruedUsd = monthlyUsd * 12 / 365.25 * elapsedDays`,
 * where `elapsedDays = max(0, nowMs - startMs) / 86_400_000`.
 * Time before the forward-test start accrues nothing.
 */
export function accruedSystemCostUsd(monthlyUsd: number, startMs: number, nowMs: number): number {
  const elapsedDays = Math.max(0, nowMs - startMs) / MS_PER_DAY;
  return monthlyUsd * (MONTHS_PER_YEAR / DAYS_PER_YEAR) * elapsedDays;
}

/** Dollars to R at $20 = 1R. */
export function usdToR(usd: number): number {
  return usd / SYSTEM_COST_R_USD;
}

/**
 * Existing P/L minus a cost figure.
 * The hurdle passes only cost accrued since the forward start.
 */
export function netAfterSystemCost(pnlUsd: number, accruedUsd: number): number {
  return pnlUsd - accruedUsd;
}

/**
 * Hurdle light. Display only. It does not promote or kill.
 *
 * Net is class A book P/L minus cost accrued from the forward start
 * (SYSTEM_COST_CUTOVER_ISO, 2026-10-26T00:00:00.000Z) onward.
 * That P/L is realized plus open marks accrued from the same instant.
 * The closed-trade count is class A closes since that instant, not the engine's closed list.
 * Cost before that instant is sunk history and is not in the light.
 * The header P/L stays equity minus the paper start capital. It is not this net.
 *
 * amber: there is no class A closed trade yet, or net == 0.
 * red: at least one class A close since the forward start and net < 0.
 * green: at least one class A close since the forward start and net > 0.
 * Amber stays reachable when the monthly rate is $0, because net == 0 is amber.
 * A missing closed count is no data and stays amber.
 */
export function systemCostLight(netUsd: number, closedTrades: number): Exclude<SystemCostLight, "unavailable"> {
  if (!(closedTrades > 0)) return "amber";
  if (netUsd < 0) return "red";
  if (netUsd > 0) return "green";
  if (!(closedTrades > 0) || netUsd === 0) return "amber";
  return Number.isFinite(netUsd) ? "green" : "amber";
}

/** The P/L the header already shows: equity minus the paper start capital. Missing equity stays null. */
export function displayedPnlUsd(equityUsd: number | null): number | null {
  if (equityUsd == null || !Number.isFinite(equityUsd)) return null;
  return equityUsd - PNL_START_USD;
}

export function formatCostR(value: number): string {
  const rounded = Math.round(Math.abs(value) * 100) / 100;
  return `${rounded.toFixed(2)}R`;
}

export function formatSignedR(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return "0.00R";
  const body = Math.abs(rounded).toFixed(2);
  return rounded > 0 ? `+${body}R` : `-${body}R`;
}

/**
 * Monthly total, accrued cost since the cost file's start, sunk history before
 * the forward start, and net P/L after cost accrued from that start onward.
 * `startMs` defaults to the cost accrual start. `closedTrades` defaults to 0,
 * which keeps the light amber.
 */
export function systemCostHurdle(input: {
  config: SystemCostConfig | null;
  /** Header P/L. Stored on the hurdle. Not the light, unless lightPnlUsd is omitted. */
  pnlUsd: number | null;
  /**
   * Class A book P/L for the light. Omit only when the caller is the cost-math test
   * and the header figure is the number under test. The page always passes this.
   */
  lightPnlUsd?: number | null;
  nowMs: number;
  startMs?: number;
  /** Class A closes since the forward start. Zero, missing, or non-finite means there is no closed trade yet. */
  closedTrades?: number;
}): SystemCostHurdle {
  try {
    const config = input.config;
    if (!config || !Number.isFinite(input.nowMs)) return SYSTEM_COST_UNAVAILABLE;
    const startMs = input.startMs ?? SYSTEM_COST_START_MS;
    if (!Number.isFinite(startMs) || !Number.isFinite(SYSTEM_COST_CUTOVER_MS)) return SYSTEM_COST_UNAVAILABLE;
    const forwardMs = SYSTEM_COST_CUTOVER_MS;
    const spans = config.spans ?? [];
    let monthlyUsd = config.items.reduce((sum, item) => sum + item.monthlyUsd, 0);
    let accruedUsd = 0;
    let sunkUsd = 0;
    let forwardUsd = 0;
    let items = config.items.map((item) => ({ ...item }));
    const addAccrual = (monthly: number, fromMs: number, untilMs: number) => {
      const overlapStart = Math.max(startMs, fromMs);
      const overlapEnd = Math.min(input.nowMs, untilMs);
      if (!(overlapEnd > overlapStart)) return;
      accruedUsd += accruedSystemCostUsd(monthly, overlapStart, overlapEnd);
      const sunkEnd = Math.min(overlapEnd, forwardMs);
      if (sunkEnd > overlapStart) sunkUsd += accruedSystemCostUsd(monthly, overlapStart, sunkEnd);
      const forwardStart = Math.max(overlapStart, forwardMs);
      if (overlapEnd > forwardStart) forwardUsd += accruedSystemCostUsd(monthly, forwardStart, overlapEnd);
    };
    if (spans.length > 0) {
      if (overlappingSystemCostSpans(spans)) return SYSTEM_COST_UNAVAILABLE;
      monthlyUsd = 0;
      items = [];
      for (const span of spans) {
        const fromMs = dateMs(span.from);
        const untilMs = span.until == null ? Number.POSITIVE_INFINITY : dateMs(span.until);
        const spanMonthly = span.items.reduce((sum, item) => sum + item.monthlyUsd, 0);
        if (input.nowMs >= fromMs && input.nowMs < untilMs) monthlyUsd += spanMonthly;
        addAccrual(spanMonthly, fromMs, untilMs);
        for (const item of span.items) {
          items.push({ ...item, from: span.from, ...(span.until ? { until: span.until } : {}) });
        }
      }
    } else {
      addAccrual(monthlyUsd, Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
    }
    if (!nonNegativeFinite(monthlyUsd) || !nonNegativeFinite(accruedUsd) || !nonNegativeFinite(sunkUsd) || !nonNegativeFinite(forwardUsd)) {
      return SYSTEM_COST_UNAVAILABLE;
    }
    const elapsedDays = Math.max(0, input.nowMs - startMs) / MS_PER_DAY;
    if (!Number.isFinite(accruedUsd) || !Number.isFinite(elapsedDays)) return SYSTEM_COST_UNAVAILABLE;
    const pnlUsd = input.pnlUsd != null && Number.isFinite(input.pnlUsd) ? input.pnlUsd : null;
    const usesClassA = input.lightPnlUsd !== undefined;
    const lightPnl = !usesClassA ? pnlUsd : input.lightPnlUsd != null && Number.isFinite(input.lightPnlUsd) ? input.lightPnlUsd : null;
    const netUsd = lightPnl == null ? null : netAfterSystemCost(lightPnl, forwardUsd);
    const closedTrades = typeof input.closedTrades === "number" && Number.isFinite(input.closedTrades) ? input.closedTrades : 0;
    const light = netUsd == null ? "unavailable" : systemCostLight(netUsd, closedTrades);
    return {
      status: "ok",
      light,
      lastUpdated: config.lastUpdated,
      monthlyUsd,
      monthlyR: usdToR(monthlyUsd),
      accruedUsd,
      accruedR: usdToR(accruedUsd),
      sunkUsd,
      sunkR: usdToR(sunkUsd),
      pnlUsd,
      pnlR: pnlUsd == null ? null : usdToR(pnlUsd),
      ...(usesClassA ? { classAPnlUsd: lightPnl, classAPnlR: lightPnl == null ? null : usdToR(lightPnl) } : {}),
      netUsd,
      netR: netUsd == null ? null : usdToR(netUsd),
      since: new Date(startMs).toISOString(),
      elapsedDays,
      items,
    };
  } catch {
    return SYSTEM_COST_UNAVAILABLE;
  }
}

/**
 * Loads the committed file and builds the hurdle. Never throws.
 * closedTrades defaults to 0 when the caller has no class A book.
 * lightPnlUsd defaults to the header figure only when omitted. The page passes the class A basis.
 */
export function readSystemCostHurdle(
  equityUsd: number | null,
  nowMs: number,
  closedTrades = 0,
  lightPnlUsd?: number | null,
): SystemCostHurdle {
  try {
    return systemCostHurdle({
      config: loadSystemCostConfig(),
      pnlUsd: displayedPnlUsd(equityUsd),
      ...(lightPnlUsd !== undefined ? { lightPnlUsd } : {}),
      nowMs,
      closedTrades,
    });
  } catch {
    return SYSTEM_COST_UNAVAILABLE;
  }
}
