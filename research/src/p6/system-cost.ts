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
}

export interface SystemCostConfig {
  lastUpdated: string;
  items: SystemCostItem[];
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
  /** Existing displayed P/L: equity minus the paper start capital. Null when equity is missing. */
  pnlUsd?: number | null;
  pnlR?: number | null;
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

/**
 * A config is accepted only when lastUpdated is a real ISO date and every
 * line item has a name and a non-negative finite monthlyUsd. One bad item
 * rejects the file. There is no partial sum.
 */
export function parseSystemCostConfig(raw: unknown): SystemCostConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const body = raw as Record<string, unknown>;
  if (typeof body.lastUpdated !== "string" || !isIsoDate(body.lastUpdated)) return null;
  if (!Array.isArray(body.items)) return null;
  const items: SystemCostItem[] = [];
  for (const row of body.items) {
    if (!row || typeof row !== "object" || Array.isArray(row)) return null;
    const item = row as Record<string, unknown>;
    if (typeof item.name !== "string" || item.name.trim() === "") return null;
    if (!nonNegativeFinite(item.monthlyUsd)) return null;
    if (item.note != null && typeof item.note !== "string") return null;
    const parsed: SystemCostItem = { name: item.name.trim(), monthlyUsd: item.monthlyUsd };
    if (typeof item.note === "string" && item.note.trim() !== "") parsed.note = item.note;
    items.push(parsed);
  }
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

/** Reads the committed JSON. Any parse or validation failure is null, not a throw. */
export function loadSystemCostConfig(text?: string): SystemCostConfig | null {
  try {
    const raw = text ?? committedConfigText();
    return parseSystemCostConfig(JSON.parse(raw));
  } catch {
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

/** Existing P/L minus accrued system cost. */
export function netAfterSystemCost(pnlUsd: number, accruedUsd: number): number {
  return pnlUsd - accruedUsd;
}

/**
 * Hurdle light. Display only. It does not promote or kill.
 *
 * green: net P/L after system costs is strictly positive (`netUsd > 0`).
 * red: net is at or below minus one month of system cost (`netUsd <= -monthlyUsd`).
 * amber: net is known, and it is neither green nor red.
 * Exactly zero is not strictly positive. With a positive monthly cost it is amber.
 * With a zero monthly cost, zero is red because `0 <= -0`.
 */
export function systemCostLight(netUsd: number, monthlyUsd: number): Exclude<SystemCostLight, "unavailable"> {
  if (netUsd > 0) return "green";
  if (netUsd <= -monthlyUsd) return "red";
  return "amber";
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
 * Monthly total, accrued cost since the forward test began, that cost in R,
 * and net P/L after system costs. `startMs` defaults to the forward-test start.
 */
export function systemCostHurdle(input: {
  config: SystemCostConfig | null;
  pnlUsd: number | null;
  nowMs: number;
  startMs?: number;
}): SystemCostHurdle {
  try {
    const config = input.config;
    if (!config || !Number.isFinite(input.nowMs)) return SYSTEM_COST_UNAVAILABLE;
    const startMs = input.startMs ?? SYSTEM_COST_START_MS;
    if (!Number.isFinite(startMs)) return SYSTEM_COST_UNAVAILABLE;
    const monthlyUsd = config.items.reduce((sum, item) => sum + item.monthlyUsd, 0);
    if (!nonNegativeFinite(monthlyUsd)) return SYSTEM_COST_UNAVAILABLE;
    const accruedUsd = accruedSystemCostUsd(monthlyUsd, startMs, input.nowMs);
    const elapsedDays = Math.max(0, input.nowMs - startMs) / MS_PER_DAY;
    if (!Number.isFinite(accruedUsd) || !Number.isFinite(elapsedDays)) return SYSTEM_COST_UNAVAILABLE;
    const pnlUsd = input.pnlUsd != null && Number.isFinite(input.pnlUsd) ? input.pnlUsd : null;
    const netUsd = pnlUsd == null ? null : netAfterSystemCost(pnlUsd, accruedUsd);
    const light = netUsd == null ? "unavailable" : systemCostLight(netUsd, monthlyUsd);
    return {
      status: "ok",
      light,
      lastUpdated: config.lastUpdated,
      monthlyUsd,
      monthlyR: usdToR(monthlyUsd),
      accruedUsd,
      accruedR: usdToR(accruedUsd),
      pnlUsd,
      pnlR: pnlUsd == null ? null : usdToR(pnlUsd),
      netUsd,
      netR: netUsd == null ? null : usdToR(netUsd),
      since: new Date(startMs).toISOString(),
      elapsedDays,
      items: config.items.map((item) => ({ ...item })),
    };
  } catch {
    return SYSTEM_COST_UNAVAILABLE;
  }
}

/** Loads the committed file and builds the hurdle. Never throws. */
export function readSystemCostHurdle(equityUsd: number | null, nowMs: number): SystemCostHurdle {
  try {
    return systemCostHurdle({
      config: loadSystemCostConfig(),
      pnlUsd: displayedPnlUsd(equityUsd),
      nowMs,
    });
  } catch {
    return SYSTEM_COST_UNAVAILABLE;
  }
}
