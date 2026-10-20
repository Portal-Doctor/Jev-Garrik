/**
 * Read-only /p6 view. get and mget only. Write methods throw.
 * This file does not import the host, the hot store, or the relay client.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { connect as connectNet, isIP } from "node:net";
import { connect as connectTls } from "node:tls";
import type { Kv } from "./relay";
import { commandBudget, healthStale, monthCommands, nextCronMs, projectionTone } from "./dashboard-format";
import {
  buildPnlBlock,
  endIsStale,
  EQ_FIRST_KEY,
  formatCt,
  parseHourAgg,
  parsePoint,
  pnlMgetKeys,
  type EqPoint,
  type HourAgg,
  type PnlBlock,
} from "./pnl-block";
import { closedNow, fetchRestBids, type MarkNow, type MarkPosition, type MarkQuote } from "./mark-now";
import { classStress, execCostWord, modelledShare, quoteMissStats, type ClassStress, type ExecWord, type StressGrade, type StressTrade } from "./x1-fill";

export { type PnlBlock };

export { commandBudget, healthStale, monthCommands, nextCronMs, projectionTone };

export const LAST_RUN_KEY = "p6:lastRun";
const HOT_KEY = "p6:hot";
const LEASE_KEY = "p6:lease";

/**
 * How to open the dashboard.
 *
 * GET and HEAD of `/p6` and every path under `/p6/` are open when `token` is absent.
 * They do not read DASHBOARD_TOKEN or the `p6_dash` cookie. The variable stays defined
 * for writes and for stripping `?token=`. A plain GET renders the page.
 *
 * A present `token` query on GET, HEAD, or a write is never rendered. A value equal to
 * DASHBOARD_TOKEN answers 302 to the same path with that parameter removed (other query
 * parameters stay) and sets the cookie below. Any other present value is 401, body
 * "unauthorized", with no page payload.
 *
 * POST, PUT, DELETE, and every other method still require the dashboard token.
 * Query: put the dashboard token in the `token` parameter:
 * https://<your-vercel-domain>/p6?token=<DASHBOARD_TOKEN>
 * Do not send the token in the path.
 *
 * Cookie name: p6_dash
 * Attributes: HttpOnly; Secure; SameSite=Strict; Path=/p6; Max-Age=2592000 (30 days). No Domain.
 * Value: hex HMAC-SHA256, keyed by DASHBOARD_TOKEN, over the fixed label "p6-dashboard-v1".
 * The cookie is not the raw token. Rotating DASHBOARD_TOKEN invalidates existing cookies.
 * There is no new environment variable.
 *
 * Precedence for a write when Authorization, the cookie, and `?token=` are all present:
 * - `?token=` present and equal to DASHBOARD_TOKEN: redirect and set the cookie.
 *   A disagreeing Bearer or cookie is ignored on that response.
 * - `?token=` present and wrong, empty, or malformed: 401. Bearer and cookie are not consulted.
 * - `?token=` absent: allow when the Bearer token matches or the cookie matches.
 *   A wrong Bearer does not reject a valid cookie. A wrong cookie does not reject a valid Bearer.
 *   Both wrong, or both missing, is the same 401 as a missing token. The body is "unauthorized".
 *
 * Comparisons are SHA-256 digests checked with timingSafeEqual. The token and the cookie are not logged.
 * These responses send Referrer-Policy: no-referrer and Cache-Control: no-store.
 * This check is /p6 only. It does not authorize the engine or the cron route.
 */
export const P6_COOKIE_NAME = "p6_dash";
export const P6_COOKIE_MAX_AGE = 2_592_000;
export const P6_COOKIE_LABEL = "p6-dashboard-v1";

function sameSecret(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
}

/** Hex HMAC-SHA256 of the fixed label, keyed by the dashboard token. Not the raw token. */
export function dashboardCookieValue(token: string): string {
  return createHmac("sha256", token).update(P6_COOKIE_LABEL).digest("hex");
}

export function dashboardSetCookie(token: string): string {
  return `${P6_COOKIE_NAME}=${dashboardCookieValue(token)}; HttpOnly; Secure; SameSite=Strict; Path=/p6; Max-Age=${P6_COOKIE_MAX_AGE}`;
}

export function readDashCookie(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== P6_COOKIE_NAME) continue;
    const raw = part.slice(eq + 1).trim();
    if (!raw) return "";
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

export function dashboardAuthorized(header: string | null, token: string | undefined): boolean {
  if (!token || header == null) return false;
  const prefix = "Bearer ";
  if (!header.startsWith(prefix)) return false;
  return sameSecret(header.slice(prefix.length), token);
}

export type DashboardAccess =
  | { action: "allow" }
  | { action: "deny" }
  | { action: "redirect"; location: string; setCookie: string };

/**
 * `/p6` or a path under `/p6/`. Anything else is rejected: look-alikes (`/p6evil`),
 * protocol-relative (`//evil.com`), backslash tricks, and dot-segment traversal.
 * The returned path is the pathname only, with no query and no host.
 */
export function dashboardPathname(pathname: string): string | null {
  if (typeof pathname !== "string" || pathname.length === 0) return null;
  if (!pathname.startsWith("/") || pathname.startsWith("//")) return null;
  if (pathname.includes("\\") || pathname.includes("//")) return null;
  if (/[\u0000\r\n]/.test(pathname)) return null;
  if (pathname.split("/").some((segment) => segment === "." || segment === "..")) return null;
  if (/%2e|%2f|%5c/i.test(pathname)) return null;
  if (pathname !== "/p6" && !pathname.startsWith("/p6/")) return null;
  return pathname;
}

export function dashboardAccess(input: {
  authorization: string | null;
  cookieHeader: string | null;
  /** Null when `token` is absent. A present empty value is `""`. */
  tokenParam: string | null;
  searchParams?: URLSearchParams;
  dashboardToken: string | undefined;
  /** Request pathname. Omitted on the `/p6` page guard, which stays on `/p6`. */
  pathname?: string;
}): DashboardAccess {
  const token = input.dashboardToken;
  if (!token) return { action: "deny" };
  if (input.tokenParam !== null) {
    if (!sameSecret(input.tokenParam, token)) return { action: "deny" };
    const path = dashboardPathname(input.pathname ?? "/p6");
    if (!path) return { action: "deny" };
    const params = new URLSearchParams(input.searchParams ?? undefined);
    stripTokenQuery(params);
    const query = params.toString();
    const location = query ? `${path}?${query}` : path;
    if (location.includes("\n") || location.includes("\r")) return { action: "deny" };
    return { action: "redirect", location, setCookie: dashboardSetCookie(token) };
  }
  const bearer = dashboardAuthorized(input.authorization, token);
  const cookie = readDashCookie(input.cookieHeader);
  const cookieOk = cookie != null && cookie !== "" && sameSecret(cookie, dashboardCookieValue(token));
  if (bearer || cookieOk) return { action: "allow" };
  return { action: "deny" };
}

/**
 * Next's middleware adapter parses Location with NextURL and throws on a relative URL.
 * The path stays `/p6` or a path under `/p6/`. The origin comes from the request, never from the location string.
 */
export function absoluteDashboardLocation(requestUrl: string, location: string): string | null {
  if (!location.startsWith("/") || location.startsWith("//")) return null;
  if (location.includes("\\") || location.includes("\n") || location.includes("\r")) return null;
  const rawPath = location.split("?")[0] ?? "";
  if (dashboardPathname(rawPath) == null) return null;
  let request: URL;
  let absolute: URL;
  try {
    request = new URL(requestUrl);
    absolute = new URL(location, request);
  } catch {
    return null;
  }
  if (absolute.origin !== request.origin || absolute.username !== "" || absolute.password !== "") return null;
  if (dashboardPathname(absolute.pathname) == null || absolute.pathname !== rawPath) return null;
  return absolute.toString();
}

/** Proxy result for /p6. GET and HEAD are open. A `token` query is stripped before the page renders. Other methods still require the dashboard token. */
export function applyDashboardProxy(request: Request, dashboardToken: string | undefined): { status: number; body: string | null; headers: Record<string, string> } {
  const url = new URL(request.url);
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  const path = dashboardPathname(url.pathname);
  if (!path) return { status: 401, body: "unauthorized", headers };
  const tokenParam = tokenQueryValue(url.searchParams);
  const isRead = request.method === "GET" || request.method === "HEAD";
  if (isRead && tokenParam === null) {
    return { status: 200, body: null, headers: { ...headers, "X-Robots-Tag": "noindex" } };
  }
  const access = dashboardAccess({
    authorization: request.headers.get("authorization"),
    cookieHeader: request.headers.get("cookie"),
    tokenParam,
    searchParams: url.searchParams,
    dashboardToken,
    pathname: path,
  });
  if (access.action === "deny") return { status: 401, body: "unauthorized", headers };
  if (access.action === "redirect") {
    return { status: 302, body: null, headers: { ...headers, Location: access.location, "Set-Cookie": access.setCookie } };
  }
  return { status: 200, body: null, headers };
}

function stripUrls(line: string): string {
  return line.replace(/https?:\/\/\S+/g, "[url]");
}

/** One Coinbase product id, such as BTC-USD or 1INCH-USDC. Anchored so a suffix cannot bless a host. */
const PRODUCT = "[A-Z0-9]{2,10}-[A-Z]{2,5}";
const DECISION = `[A-E]-${PRODUCT}-\\d{9,16}(?::[a-z0-9]+)*`;
const PRODUCT_RE = new RegExp(`^${PRODUCT}$`);
const DECISION_RE = new RegExp(`^${DECISION}$`);

function tokenQueryValue(params: URLSearchParams): string | null {
  for (const [key, value] of params.entries()) {
    if (key.toLowerCase() === "token") return value;
  }
  return null;
}

function stripTokenQuery(params: URLSearchParams): void {
  for (const key of [...params.keys()]) {
    if (key.toLowerCase() === "token") params.delete(key);
  }
}

const OUTCOMES = new Set([
  "handover",
  "running",
  "crash",
  "uncovered",
  "missed-cron",
  "missed-cron-covered",
  "overlap-warm",
  "duplicate",
  "kill",
  "save failed",
]);

const GAP_CAUSES = new Set([
  "uncovered",
  "crash",
  "kill",
  "duplicate",
  "missed-cron",
  "missed-cron-covered",
  "overlap-warm",
  "handover",
  "handover_micro",
  "seed",
  "engine_gap",
  "takeover",
  "save failed",
]);

const EXACT_INCIDENTS = new Set([
  "redacted",
  "call_error",
  "save failed",
  "lease lost",
  "kv set lease lost",
  "kv set p6:hot failed",
  "kv set p6:warmup failed",
  "kv set p6:lease-meta failed",
  "redis timeout",
  "redis closed",
  "registration flags unavailable",
  "daily warmup unavailable",
  "seq invalid",
  "seq map overflow",
  "kv value exceeds 1 MB",
  "kv value exceeds 1 MB p6:fills",
  "kv value exceeds 1 MB p6:ledger",
  "tape window indeterminate",
]);

const INCIDENT_PATTERNS: RegExp[] = [
  /^hot \d{1,9} bytes at 75% of 256 KB$/,
  /^heartbeat write \d{1,9} exceeds 256 KB$/,
  new RegExp(`^daily warmup missing ${PRODUCT}$`),
  /^socket \d{1,3} closed$/,
  /^socket \d{1,3} error$/,
  new RegExp(`^l2 sequence shard \\d{1,3} \\d{1,16} -> \\d{1,16}$`),
  new RegExp(`^l2 resync ${PRODUCT}$`),
  new RegExp(`^rest book ${PRODUCT} (?:budget-stop|429|failed|\\d{3})$`),
  new RegExp(`^l2 rest snapshot ${PRODUCT}(?: (?:budget-stop|429|failed|\\d{3}))?$`),
  new RegExp(`^tick missing ${PRODUCT}$`),
  new RegExp(`^missed_send_stale_quote ${DECISION}$`),
  new RegExp(`^rest 15m missed ${PRODUCT} \\d{1,16} after 120s; (?:trades-built bar|no trades)$`),
  new RegExp(`^buffer overflow \\d{4}-\\d{2}-\\d{2} \\d{1,6}$`),
  new RegExp(`^rest 15m ${PRODUCT} budget-stop$`),
  new RegExp(`^history daily ${PRODUCT} (?:failed|\\d{3})$`),
  new RegExp(`^history rest ${PRODUCT} \\d{1,16} \\d{3}$`),
  new RegExp(`^history missing ${PRODUCT} \\d{1,16} bars \\d{1,6}$`),
  new RegExp(`^hour delta ${PRODUCT} (?:budget|\\d{3})$`),
  new RegExp(`^4h fold mismatch ${PRODUCT} \\d{1,16}$`),
  new RegExp(`^tape (?:backfill|candle) ${PRODUCT} (?:failed|\\d{3})$`),
  new RegExp(`^tape gap ${PRODUCT} \\d{1,6}$`),
  new RegExp(`^4h seed rest ${PRODUCT} (?:failed|\\d{3})$`),
  new RegExp(`^4h seed rest ${PRODUCT} \\d{1,6} seed_src=rest_1h$`),
  new RegExp(`^4h seed short ${PRODUCT} \\d{1,6}$`),
  new RegExp(`^kv value exceeds 1 MB (?:p6:[a-z0-9:_-]{1,48}|warmup ${PRODUCT})$`),
  new RegExp(`^jev (?:no_1m_input|not_called|timeout|call_error|invalid_response) ${PRODUCT} \\d{1,16}(?: (?:no_trades_feed|no_book_feed))?$`),
  new RegExp(`^jev skip ${PRODUCT} \\d{1,16}$`),
  new RegExp(`^handover_micro ${DECISION}$`),
  new RegExp(`^gap fill ${DECISION}$`),
  new RegExp(`^generator ${PRODUCT} failed$`),
  new RegExp(`^rest ${PRODUCT} \\d{1,16} failed$`),
  new RegExp(`^saved A pick ${PRODUCT} ignored$`),
];

/** Jev caller failures, including the `jev-call failed` variant. Known `jev <reason>` lines are matched earlier. */
function isJevCallerError(line: string): boolean {
  if (/jev[\s_-]*caller|experimental_evaluate|typesafe[\s_-]*ai/i.test(line)) return true;
  if (/jev[\s_-]*call[\s_-]*failed/i.test(line)) return true;
  return false;
}

function knownIncident(line: string): string | null {
  const text = line.trim();
  if (EXACT_INCIDENTS.has(text)) return text;
  for (const pattern of INCIDENT_PATTERNS) {
    if (pattern.test(text)) return text;
  }
  const reconnect = text.match(/^socket reconnect (\d{1,6}) (closed|heartbeat|late-heartbeat): ([A-Z0-9,-]+)$/);
  if (!reconnect) return null;
  const products = reconnect[3]?.split(",") ?? [];
  if (products.length === 0 || products.some((id) => !PRODUCT_RE.test(id))) return null;
  return `socket reconnect ${reconnect[1]} ${reconnect[2]}: ${products.join(",")}`;
}

function publicIncident(line: string): string {
  const known = knownIncident(line);
  if (known) return known;
  if (isJevCallerError(line)) return "call_error";
  return "redacted";
}

function publicOutcome(value: string): string {
  if (value === "redacted") return "redacted";
  return OUTCOMES.has(value) ? value : "redacted";
}

function publicCause(value: string): string {
  if (value === "redacted") return "redacted";
  if (GAP_CAUSES.has(value)) return value;
  const uncovered = value.match(new RegExp(`^uncovered (${PRODUCT})$`));
  if (uncovered?.[1]) return `uncovered ${uncovered[1]}`;
  return "redacted";
}

function publicEmitted(value: string): string {
  if (value === "redacted") return "redacted";
  return DECISION_RE.test(value) ? value : "redacted";
}

function publicSkipLabel(value: string): string {
  if (value === "FLAG" || value === "PASS" || value === "INSUFFICIENT_DATA") return value;
  if (/^insufficient data \(days \d{1,4}\/7, scheduled \d{1,8}\)$/.test(value)) return value;
  return "redacted";
}

function publicScalar(value: string, key?: string): string {
  if (isJevCallerError(value)) return "call_error";
  if (key === "outcome") return publicOutcome(value);
  if (key === "cause") return publicCause(value);
  if (key === "skipLabel") return publicSkipLabel(value);
  if (key === "skipStatus") return value === "FLAG" || value === "PASS" || value === "INSUFFICIENT_DATA" ? value : "redacted";
  if (key === "side") return value === "long" || value === "short" ? value : "redacted";
  if (key === "src") return value === "entry" ? value : "redacted";
  if (key === "classId" || key === "c") return /^[A-E]$/.test(value) ? value : "redacted";
  if (key === "productId" || key === "p" || key === "k") return PRODUCT_RE.test(value) ? value : "redacted";
  if (key === "id") return DECISION_RE.test(value) || PRODUCT_RE.test(value) ? value : "redacted";
  if (key === "reason") return /^[a-z0-9-]{1,40}$/.test(value) ? value : "redacted";
  if (key === "applied") return new RegExp(`^${PRODUCT}:\\d{1,16}$`).test(value) ? value : "redacted";
  const incident = knownIncident(value);
  if (incident) return incident;
  if (OUTCOMES.has(value) || PRODUCT_RE.test(value) || DECISION_RE.test(value)) return value;
  return "redacted";
}

function scrubPublic(value: unknown, key?: string): unknown {
  if (typeof value === "string") return publicScalar(value, key);
  if (Array.isArray(value)) return value.map((item) => scrubPublic(item, key));
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [child, item] of Object.entries(value as Record<string, unknown>)) {
    if (child === "holder") continue;
    out[child] = scrubPublic(item, child);
  }
  return out;
}

const PUBLIC_LAST_RUN_KEYS = [
  "start",
  "end",
  "outcome",
  "applied",
  "decisions",
  "fills",
  "rest",
  "redis",
  "cold",
  "warm",
  "pending",
  "completed",
  "pnl",
  "positions",
  "positionsOmitted",
  "positionsSkipped",
  "jev",
] as const;

function publicRedis(value: unknown): { cmds?: unknown; bytes?: unknown; maxValueBytes?: unknown } | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  return { cmds: row.cmds, bytes: row.bytes, maxValueBytes: row.maxValueBytes };
}

function publicLastRun(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!raw) return null;
  const out: Record<string, unknown> = {};
  for (const key of PUBLIC_LAST_RUN_KEYS) {
    if (!(key in raw)) continue;
    out[key] = key === "redis" ? publicRedis(raw.redis) : scrubPublic(raw[key]);
  }
  return out;
}

/**
 * Public /p6 view. Drops lease.holder and any lastRun field outside the page allowlist.
 * Incident text, outcome codes, gap causes, decision ids, product ids, and class ids are allowlisted.
 * Closed trades and positions keep only those fields plus finite numbers.
 * Anything else becomes `redacted`, and a Jev-caller error becomes `call_error`.
 */
export function redactP6View(view: DashboardView): DashboardView {
  const shown: DashboardView = {
    ...view,
    lease: view.lease ? { holder: "", untilMs: view.lease.untilMs } : null,
    lastRun: publicLastRun(view.lastRun),
    incidents: view.incidents.map(publicIncident),
    gaps: view.gaps.map((gap) => ({
      ...gap,
      ...(typeof gap.cause === "string" ? { cause: publicCause(gap.cause) } : {}),
    })),
    emitted: view.emitted.map(publicEmitted),
    closed: view.closed.map(publicClosed),
    positions: view.positions.map(publicPosition),
    mark: publicMark(view.mark),
    fills: publicFills(view.fills ?? []),
    runLabel: publicEnum(view.runLabel, RUN_LABEL) === "non-X1" ? "non-X1" : publicEnum(view.runLabel, RUN_LABEL) === "X1" ? "X1" : undefined,
  };
  delete shown.markInputs;
  return shown;
}

const BASIS = new Set(["bid1m", "mid-half-spread", "bar15-high", "bar15-low"]);
const FILL_SRC = new Set(["l2", "modelled", "stale_quote_modelled", "pre-fix fill model"]);
const MARK_STATE = new Set(["live", "stale", "rest", "na"]);
const EXEC_WORD = new Set(["ok", "yellow", "red"]);
const STRESS_GRADE = new Set(["insufficient", "indicative", "decision-grade"]);
const RUN_LABEL = new Set(["X1", "non-X1"]);
const PUBLIC_MARK_LABEL = "marked to bid, taker 0.90% exit";
const PUBLIC_REST_LABEL = "REST mark";

function publicNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function publicEnum(value: unknown, allowed: ReadonlySet<string>): string | undefined {
  return typeof value === "string" && allowed.has(value) ? value : undefined;
}

function publicClosed(row: DashboardView["closed"][number]): DashboardView["closed"][number] {
  const productId = typeof row.productId === "string" ? publicScalar(row.productId, "productId") : undefined;
  const classId = typeof row.classId === "string" ? publicScalar(row.classId, "classId") : undefined;
  const netUsd = publicNumber(row.netUsd);
  const mfeR = publicNumber(row.mfeR);
  const maeR = publicNumber(row.maeR);
  const fillSrc = publicEnum(row.fillSrc, FILL_SRC);
  const execCostBps = publicNumber(row.execCostBps);
  const driftBps = publicNumber(row.driftBps);
  const delayBps = publicNumber(row.delayBps);
  const shadowNetUsd = publicNumber(row.shadowNetUsd);
  const shadowNetR = publicNumber(row.shadowNetR);
  const mfeBasis = publicEnum(row.mfeBasis, BASIS);
  const maeBasis = publicEnum(row.maeBasis, BASIS);
  return {
    ...(productId && productId !== "redacted" ? { productId } : productId === "redacted" ? { productId } : {}),
    ...(classId ? { classId } : {}),
    ...(netUsd !== undefined ? { netUsd } : {}),
    ...(mfeR !== undefined ? { mfeR } : {}),
    ...(maeR !== undefined ? { maeR } : {}),
    ...(fillSrc ? { fillSrc } : {}),
    ...(execCostBps !== undefined ? { execCostBps } : {}),
    ...(driftBps !== undefined ? { driftBps } : {}),
    ...(delayBps !== undefined ? { delayBps } : {}),
    ...(shadowNetUsd !== undefined ? { shadowNetUsd } : {}),
    ...(shadowNetR !== undefined ? { shadowNetR } : {}),
    ...(mfeBasis ? { mfeBasis } : {}),
    ...(maeBasis ? { maeBasis } : {}),
  };
}

function publicPosition(row: DashboardView["positions"][number]): DashboardView["positions"][number] {
  const productId = typeof row.productId === "string" ? publicScalar(row.productId, "productId") : undefined;
  const id = typeof row.id === "string" ? publicScalar(row.id, "id") : undefined;
  const mfeBid1m = publicNumber(row.mfeBid1m);
  const maeBid1m = publicNumber(row.maeBid1m);
  const mfeTs = publicNumber(row.mfeTs);
  const maeTs = publicNumber(row.maeTs);
  const mfe15 = publicNumber(row.mfe15);
  const mae15 = publicNumber(row.mae15);
  const grossR = publicNumber(row.grossR);
  const netR = publicNumber(row.netR);
  const mfeBasis = publicEnum(row.mfeBasis, BASIS);
  const maeBasis = publicEnum(row.maeBasis, BASIS);
  const mfe15Basis = publicEnum(row.mfe15Basis, BASIS);
  const mae15Basis = publicEnum(row.mae15Basis, BASIS);
  return {
    ...(productId ? { productId } : {}),
    ...(id ? { id } : {}),
    ...(mfeBid1m !== undefined ? { mfeBid1m } : {}),
    ...(maeBid1m !== undefined ? { maeBid1m } : {}),
    ...(mfeTs !== undefined ? { mfeTs } : {}),
    ...(maeTs !== undefined ? { maeTs } : {}),
    ...(mfe15 !== undefined ? { mfe15 } : {}),
    ...(mae15 !== undefined ? { mae15 } : {}),
    ...(grossR !== undefined ? { grossR } : {}),
    ...(netR !== undefined ? { netR } : {}),
    ...(mfeBasis ? { mfeBasis } : {}),
    ...(maeBasis ? { maeBasis } : {}),
    ...(mfe15Basis ? { mfe15Basis } : {}),
    ...(mae15Basis ? { mae15Basis } : {}),
  };
}

function publicMark(mark: MarkNow | null | undefined): MarkNow | null {
  if (!mark) return null;
  const state = publicEnum(mark.state, MARK_STATE);
  const label = mark.label === PUBLIC_MARK_LABEL ? PUBLIC_MARK_LABEL : undefined;
  const restLabel = mark.restLabel === PUBLIC_REST_LABEL ? PUBLIC_REST_LABEL : undefined;
  const staleText = typeof mark.staleText === "string" && /^stale since \d{2}:\d{2} CT$/.test(mark.staleText) ? mark.staleText : undefined;
  const rows: MarkNow["rows"] = mark.rows.map((row) => {
    const productId = typeof row.productId === "string" ? publicScalar(row.productId, "productId") : "redacted";
    return {
      productId,
      pnl: publicNumber(row.pnl) ?? null,
      grossUsd: publicNumber(row.grossUsd) ?? null,
      grossR: publicNumber(row.grossR) ?? null,
      netR: publicNumber(row.netR) ?? null,
    };
  });
  return {
    pnlNow: publicNumber(mark.pnlNow) ?? null,
    label: label ?? PUBLIC_MARK_LABEL,
    state: (state as MarkNow["state"] | undefined) ?? "na",
    ...(staleText ? { staleText } : {}),
    ...(restLabel ? { restLabel } : {}),
    openRGross: publicNumber(mark.openRGross) ?? null,
    openRNet: publicNumber(mark.openRNet) ?? null,
    grossUsd: publicNumber(mark.grossUsd) ?? null,
    riskUsd: publicNumber(mark.riskUsd) ?? 0,
    quoteFresh: mark.quoteFresh === true,
    rows,
  };
}

function publicFills(rows: DashboardView["fills"]): DashboardView["fills"] {
  return (rows ?? []).map((row) => {
    const classId = typeof row.classId === "string" ? publicScalar(row.classId, "classId") : undefined;
    const word = publicEnum(row.execCost, EXEC_WORD);
    const grade = publicEnum(row.stressGrade, STRESS_GRADE);
    const execCost: ExecWord = word === "yellow" || word === "red" ? word : "ok";
    return {
      ...(classId && classId !== "redacted" ? { classId } : {}),
      share: publicNumber(row.share) ?? 0,
      execCost,
      capHitCount: publicNumber(row.capHitCount) ?? 0,
      missCount: publicNumber(row.missCount) ?? 0,
      missRate: publicNumber(row.missRate) ?? 0,
      gapSlippageBps: publicNumber(row.gapSlippageBps) ?? null,
      stressN: publicNumber(row.stressN) ?? 0,
      stressGrade: (grade as StressGrade | undefined) ?? "insufficient",
      stressNetR: publicNumber(row.stressNetR) ?? null,
      cappedNetR: publicNumber(row.cappedNetR) ?? null,
      spreadFragile: row.spreadFragile === true,
    };
  });
}

/** The strings the /p6 page interpolates into HTML. */
export function formatP6Public(view: DashboardView): {
  incidents: string;
  decisions: string;
  outcome: string;
  causes: string;
  trades: { label: string; netUsd: number | null }[];
  positions: string;
  mark: string;
} {
  const safe = redactP6View(view);
  const outcome = safe.lastRun && typeof safe.lastRun.outcome === "string" ? safe.lastRun.outcome : "no run";
  return {
    incidents: safe.incidents.slice(-20).join(" · "),
    decisions: safe.emitted.slice(-20).join(", ") || "—",
    outcome,
    causes: safe.gaps.map((gap) => (typeof gap.cause === "string" ? gap.cause : "")).filter((cause) => cause.length > 0).join(" · "),
    trades: safe.closed.slice(-20).map((row) => ({
      label: `${row.productId ?? ""} · ${row.classId ?? ""}`,
      netUsd: typeof row.netUsd === "number" ? row.netUsd : null,
    })),
    positions: safe.positions.map((row) => [row.productId, row.id].filter((part) => part && part.length > 0).join(" ")).join(" | "),
    mark: markLine(safe),
  };
}

function markLine(view: DashboardView): string {
  const mark = view.mark;
  if (!mark) return "";
  const pnl = mark.state === "na" || mark.pnlNow == null ? "n/a" : mark.pnlNow.toFixed(2);
  const grossUsd = mark.grossUsd == null ? "n/a" : mark.grossUsd.toFixed(2);
  const openR = mark.openRGross == null ? "n/a" : `${mark.openRGross.toFixed(2)}R`;
  const netR = mark.openRNet == null ? "n/a" : `${mark.openRNet.toFixed(2)}R`;
  const rows = mark.rows
    .map((row) => {
      const id = row.productId ?? "";
      const gross = row.grossR == null ? "n/a" : `${row.grossR.toFixed(2)}R`;
      const basis = view.positions.find((position) => position.productId === row.productId);
      const labels = [basis?.mfeBasis, basis?.maeBasis, basis?.mfe15Basis, basis?.mae15Basis].filter((part) => part && part.length > 0);
      return [id, gross, ...labels].filter((part) => part && part.length > 0).join(" ");
    })
    .join(" | ");
  const fills = (view.fills ?? [])
    .filter((row) => row.execCost === "yellow" || row.execCost === "red")
    .map((row) => `${row.classId ?? ""} ${row.execCost}`.trim())
    .join(" ");
  const caps = (view.fills ?? [])
    .filter((row) => (row.capHitCount ?? 0) > 0)
    .map((row) => `${row.classId ?? ""} cap ${row.capHitCount}`.trim())
    .join(" ");
  const gaps = (view.fills ?? [])
    .filter((row) => row.gapSlippageBps != null)
    .map((row) => `${row.classId ?? ""} gap slippage ${row.gapSlippageBps!.toFixed(2)}`.trim())
    .join(" ");
  const stress = (view.fills ?? [])
    .filter((row) => (row.stressN ?? 0) > 0)
    .map((row) => stressLine(row))
    .filter((line) => line.length > 0)
    .join(" ");
  const misses = (view.fills ?? [])
    .filter((row) => (row.missCount ?? 0) > 0)
    .map((row) => `${row.classId ?? ""} misses ${row.missCount} ${(row.missRate ?? 0).toFixed(2)}`.trim())
    .join(" ");
  const fresh = mark.quoteFresh === false ? "stale quote" : undefined;
  const run = view.runLabel === "non-X1" ? "non-X1" : undefined;
  return [mark.label, mark.state, fresh, `gross $${grossUsd}`, `net $${pnl}`, `open R ${openR} gross ${netR} net`, rows, fills, caps, gaps, stress, misses, run]
    .filter((part) => part && part.length > 0)
    .join(" · ");
}

function stressLine(row: NonNullable<DashboardView["fills"]>[number]): string {
  const id = row.classId ?? "";
  if (row.stressGrade === "insufficient" || (row.stressN ?? 0) < 10) return `${id} insufficient n ${row.stressN ?? 0}`.trim();
  const fragile = row.spreadFragile === true ? "spread-fragile" : row.stressGrade ?? "";
  const net = row.stressNetR == null ? "" : `${row.stressNetR.toFixed(2)}R`;
  const capped = row.cappedNetR == null ? "" : `2x capped, report-only ${row.cappedNetR.toFixed(2)}R`;
  return [id, fragile, net, capped].filter((part) => part && part.length > 0).join(" ");
}

export interface DashboardLease {
  holder: string;
  untilMs: number;
}

export interface DashboardPosition {
  productId?: string;
  id?: string;
  mfeBid1m?: number;
  maeBid1m?: number;
  mfeTs?: number;
  maeTs?: number;
  mfe15?: number;
  mae15?: number;
  mfeBasis?: string;
  maeBasis?: string;
  mfe15Basis?: string;
  mae15Basis?: string;
  grossR?: number;
  netR?: number;
}

export interface DashboardClosed {
  productId?: string;
  classId?: string;
  netUsd?: number;
  mfeR?: number;
  maeR?: number;
  mfeBasis?: string;
  maeBasis?: string;
  fillSrc?: string;
  execCostBps?: number;
  driftBps?: number;
  delayBps?: number;
  shadowNetUsd?: number;
  shadowNetR?: number;
}

export interface DashboardView {
  lease: DashboardLease | null;
  lastRun: Record<string, unknown> | null;
  killSwitch: boolean;
  incidents: string[];
  gaps: { startMs: number; endMs: number; cause?: string }[];
  positions: DashboardPosition[];
  closed: DashboardClosed[];
  emitted: string[];
  mark?: MarkNow | null;
  fills?: {
    classId?: string;
    share: number;
    execCost: ExecWord;
    capHitCount?: number;
    missCount?: number;
    missRate?: number;
    gapSlippageBps?: number | null;
    stressN?: number;
    stressGrade?: StressGrade;
    stressNetR?: number | null;
    cappedNetR?: number | null;
    spreadFragile?: boolean;
  }[];
  /** Parity runs are non-X1 and are excluded from the X1 promotion stats above. */
  runLabel?: "X1" | "non-X1";
  /** Present only between the hot read and the mark build. Redact drops it. */
  markInputs?: { positions: MarkPosition[]; quotes: Record<string, MarkQuote>; disconnected: boolean };
}

function leaseOf(raw: string | null): DashboardLease | null {
  if (!raw) return null;
  try {
    const body = JSON.parse(raw) as { holder?: unknown; untilMs?: unknown };
    if (typeof body.holder !== "string" || typeof body.untilMs !== "number") return null;
    return { holder: body.holder, untilMs: body.untilMs };
  } catch {
    return null;
  }
}

/** One mget of lastRun, hot, and the lease. No INFO and no writes. */
export async function readP6Dashboard(kv: Pick<Kv, "mget">): Promise<DashboardView> {
  const values = await kv.mget([LAST_RUN_KEY, HOT_KEY, LEASE_KEY]);
  const lastRaw = values[0] ?? null;
  const hotRaw = values[1] ?? null;
  const leaseRaw = values[2] ?? null;
  const hot = hotRaw ? (JSON.parse(hotRaw) as Record<string, unknown>) : {};
  const incidents = Array.isArray(hot.incidents) ? hot.incidents.filter((row): row is string => typeof row === "string").map(stripUrls) : [];
  const gaps = Array.isArray(hot.gaps) ? (hot.gaps as DashboardView["gaps"]) : [];
  const positions = Array.isArray(hot.positions) ? (hot.positions as DashboardView["positions"]) : [];
  const closed = Array.isArray(hot.closed) ? (hot.closed as DashboardView["closed"]) : [];
  const quotes: Record<string, MarkQuote> = {};
  if (Array.isArray(hot.quotes)) {
    for (const row of hot.quotes) {
      if (!Array.isArray(row) || row.length < 3) continue;
      const [productId, bid, tsMs, levels] = row as [unknown, unknown, unknown, unknown];
      if (typeof productId !== "string" || typeof bid !== "number" || typeof tsMs !== "number") continue;
      const bids = bidLevels(levels);
      quotes[productId] = bids ? { bid, tsMs, bids } : { bid, tsMs };
    }
  }
  const markPositions: MarkPosition[] = positions.map((row) => {
    const source = row as DashboardPosition & { fillPrice?: unknown; units?: unknown; entryFeeUsd?: unknown; riskUsd?: unknown };
    return {
      productId: typeof source.productId === "string" ? source.productId : "",
      fillPrice: typeof source.fillPrice === "number" ? source.fillPrice : Number.NaN,
      units: typeof source.units === "number" ? source.units : Number.NaN,
      entryFeeUsd: typeof source.entryFeeUsd === "number" ? source.entryFeeUsd : Number.NaN,
      riskUsd: typeof source.riskUsd === "number" ? source.riskUsd : Number.NaN,
    };
  });
  const runLabel = hot.runLabel === "non-X1" ? "non-X1" : "X1";
  const stressRows = runLabel === "non-X1" ? [] : stressTrades(closed);
  const fills = (["A", "B", "C", "D", "E"] as const).map((classId) => {
    const mine = stressRows.filter((row) => row.classId === classId);
    const share = modelledShare(
      mine.map((row) => ({
        classId: row.classId,
        side: "entry" as const,
        fillSrc: row.exitFillSrc === "modelled" || row.exitFillSrc === "stale_quote_modelled" ? row.exitFillSrc : row.fillSrc,
        anchorMissing: row.anchorMissing,
      })),
      classId,
    );
    const stress: ClassStress = classStress(mine, classId);
    const misses = quoteMissStats(
      mine.flatMap((row) => [
        { classId: row.classId, fillSrc: row.fillSrc },
        { classId: row.classId, fillSrc: row.exitFillSrc },
      ]),
      classId,
    );
    const gaps = mine.filter((row) => row.gap === true && row.gapSlippageBps != null && Number.isFinite(row.gapSlippageBps));
    const gapSlippageBps = gaps.length === 0 ? null : gaps.reduce((sum, row) => sum + (row.gapSlippageBps ?? 0), 0) / gaps.length;
    return {
      classId,
      share,
      execCost: execCostWord(share),
      capHitCount: stress.capHitCount,
      missCount: misses.missCount,
      missRate: misses.missRate,
      gapSlippageBps,
      stressN: stress.n,
      stressGrade: stress.grade,
      stressNetR: stress.netR2xUncapped,
      cappedNetR: stress.netR2xCapped,
      spreadFragile: stress.spreadFragile,
    };
  });
  const emitted = Array.isArray(hot.emitted) ? hot.emitted.filter((row): row is string => typeof row === "string") : [];
  let lastRun: Record<string, unknown> | null = null;
  if (lastRaw) {
    const parsed = JSON.parse(lastRaw) as Record<string, unknown>;
    lastRun = parsed;
  }
  return {
    lease: leaseOf(leaseRaw),
    lastRun,
    killSwitch: hot.killSwitch === true,
    incidents,
    gaps,
    positions,
    closed,
    emitted,
    mark: null,
    fills,
    runLabel,
    markInputs: { positions: markPositions, quotes, disconnected: hot.feedLive === false },
  };
}

function bidLevels(value: unknown): [number, number][] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels: [number, number][] = [];
  for (const row of value) {
    if (!Array.isArray(row) || row.length < 2) return undefined;
    const price = typeof row[0] === "number" ? row[0] : Number.NaN;
    const qty = typeof row[1] === "number" ? row[1] : Number.NaN;
    if (!(price > 0) || !(qty > 0) || !Number.isFinite(price) || !Number.isFinite(qty)) return undefined;
    levels.push([price, qty]);
  }
  return levels.length > 0 ? levels : undefined;
}

function stressTrades(closed: DashboardView["closed"]): StressTrade[] {
  return closed.map((row) => {
    const source = row as DashboardView["closed"][number] & Record<string, unknown>;
    const num = (key: string): number | null => {
      const value = source[key];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
    return {
      classId: typeof source.classId === "string" ? source.classId : "",
      netUsd: num("netUsd") ?? 0,
      riskUsd: num("riskUsd") ?? 0,
      notionalUsd: num("notionalUsd") ?? 0,
      ...(num("exitNotionalUsd") != null ? { exitNotionalUsd: num("exitNotionalUsd")! } : {}),
      sBtUncappedBps: num("sBtUncappedBps"),
      sBtMagnitudeBps: num("sBtMagnitudeBps"),
      sBtCapped: source.sBtCapped === true,
      fillSrc: typeof source.fillSrc === "string" ? source.fillSrc : null,
      exitFillSrc: typeof source.exitFillSrc === "string" ? source.exitFillSrc : null,
      anchorMissing: source.anchorMissing === true,
      gap: source.gap === true,
      gapSlippageBps: num("gapSlippageBps"),
    };
  });
}

function refuse(): never {
  throw new Error("dashboard is read-only");
}

type Reply = string | null | Reply[];

function encode(parts: readonly string[]): string {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) out += `$${Buffer.byteLength(part)}\r\n${part}\r\n`;
  return out;
}

function take(buf: string): { reply: Reply; rest: string } | null {
  if (buf.startsWith("$-1")) {
    const end = "$-1\r\n".length;
    if (buf.length < end) return null;
    return { reply: null, rest: buf.slice(end) };
  }
  if (buf.startsWith("*")) {
    const nl = buf.indexOf("\r\n");
    if (nl < 0) return null;
    const count = Number(buf.slice(1, nl));
    if (count < 0) return { reply: null, rest: buf.slice(nl + 2) };
    let rest = buf.slice(nl + 2);
    const items: Reply[] = [];
    for (let i = 0; i < count; i += 1) {
      const part = take(rest);
      if (!part) return null;
      items.push(part.reply);
      rest = part.rest;
    }
    return { reply: items, rest };
  }
  if (buf.startsWith("+") || buf.startsWith(":") || buf.startsWith("-")) {
    const nl = buf.indexOf("\r\n");
    if (nl < 0) return null;
    const line = buf.slice(0, nl);
    if (line.startsWith("-")) throw new Error(line.slice(1));
    return { reply: line.slice(1), rest: buf.slice(nl + 2) };
  }
  if (buf.startsWith("$")) {
    const nl = buf.indexOf("\r\n");
    if (nl < 0) return null;
    const len = Number(buf.slice(1, nl));
    const start = nl + 2;
    if (buf.length < start + len + 2) return null;
    return { reply: buf.slice(start, start + len), rest: buf.slice(start + len + 2) };
  }
  return null;
}

function endpoint(url: string): { host: string; port: number; tls: boolean; username: string; password: string } {
  const parsed = new URL(url);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") throw new Error("REDIS_URL must be redis:// or rediss://");
  const tls = parsed.protocol === "rediss:";
  return {
    host: parsed.hostname,
    port: Number(parsed.port || (tls ? 6380 : 6379)),
    tls,
    username: parsed.username ? decodeURIComponent(parsed.username) : "",
    password: parsed.password ? decodeURIComponent(parsed.password) : "",
  };
}

function command(url: string, parts: readonly string[]): Promise<Reply> {
  const target = endpoint(url);
  const socket = target.tls
    ? connectTls({ host: target.host, port: target.port, ...(isIP(target.host) === 0 ? { servername: target.host } : {}) })
    : connectNet({ host: target.host, port: target.port });
  return new Promise((resolve, reject) => {
    let buf = "";
    const pending: string[] = [];
    const auth = target.username && target.password ? ["AUTH", target.username, target.password] : target.password ? ["AUTH", target.password] : null;
    if (auth) pending.push(encode(auth));
    pending.push(encode(parts));
    let authed = !auth;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.on("error", (error: Error) => {
      if (settled) return;
      fail(error);
    });
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString("utf8");
      try {
        if (!authed) {
          const first = take(buf);
          if (!first) return;
          if (first.reply !== "OK") return fail(new Error("redis auth failed"));
          buf = first.rest;
          authed = true;
        }
        const body = take(buf);
        if (!body) return;
        settled = true;
        resolve(body.reply);
        queueMicrotask(() => socket.destroy());
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("connect", () => {
      socket.write(pending.join(""));
    });
  });
}

async function mgetRaw(url: string, keys: string[]): Promise<(string | null)[]> {
  if (keys.length === 0) return [];
  const reply = await command(url, ["MGET", ...keys]);
  if (!Array.isArray(reply)) return keys.map(() => null);
  return reply.map((item) => (typeof item === "string" ? item : null));
}

function numField(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Second read of a page load. One MGET of the hourly equity keys, the per-hour aggregates, and p6:eq:first.
 * Does not read p6:fills or p6:ledger. A book reset must delete p6:eq:* (deferred; not built).
 */
export async function readPnlWindows(kv: Pick<Kv, "mget">, nowMs: number): Promise<{
  first: EqPoint | null;
  points: EqPoint[];
  trades: Map<number, HourAgg | null>;
}> {
  const keys = pnlMgetKeys(nowMs);
  const values = await kv.mget(keys);
  const points: EqPoint[] = [];
  const trades = new Map<number, HourAgg | null>();
  let first: EqPoint | null = null;
  keys.forEach((key, index) => {
    const raw = values[index] ?? null;
    if (key === EQ_FIRST_KEY) {
      first = parsePoint(raw, 0);
      if (first) first = { ...first, hourStartSec: Math.floor(first.ts / 3_600_000) * 3600 };
      return;
    }
    if (key.startsWith("p6:eq:tr:")) {
      const hour = Number(key.slice("p6:eq:tr:".length));
      trades.set(hour, parseHourAgg(raw));
      return;
    }
    if (key.startsWith("p6:eq:")) {
      const hour = Number(key.slice("p6:eq:".length));
      const point = parsePoint(raw, hour);
      if (point) points.push(point);
    }
  });
  return { first, points, trades };
}

/**
 * Clock of the last completed engine flush on p6:lastRun.
 * `end` moves on every heartbeat while outcome is still "running", so it is not the completion.
 * A running row with no finished `completed` stamp has no clock. Never substitute the render time.
 */
export function completedFlushMs(last: Record<string, unknown> | null | undefined): number | null {
  if (last == null) return null;
  const completedEnd = finishedCompletedEnd(last.completed);
  const outcome = last.outcome;
  if (outcome === "running" || outcome === "") return completedEnd;
  if (completedEnd != null) return completedEnd;
  return typeof last.end === "number" && Number.isFinite(last.end) ? last.end : null;
}

function finishedCompletedEnd(completed: unknown): number | null {
  if (completed == null || typeof completed !== "object") return null;
  const row = completed as { end?: unknown; outcome?: unknown };
  if (row.outcome === "running" || row.outcome === "") return null;
  return typeof row.end === "number" && Number.isFinite(row.end) ? row.end : null;
}

/** Header clock, health word, and stale banner. Age uses STALE_MS via endIsStale. Exactly that age is not stale. */
export function summaryFreshness(input: { hasLastRun: boolean; flushMs: number | null; nowMs: number }): {
  health: "Healthy" | "Stale" | "Error";
  stale: boolean;
  lastUpdatedText: string;
  banner: { staleClass: boolean; text: string } | null;
} {
  const flushMs = typeof input.flushMs === "number" && Number.isFinite(input.flushMs) ? input.flushMs : null;
  const stale = endIsStale(input.nowMs, flushMs);
  const health = input.hasLastRun ? (stale ? "Stale" : "Healthy") : "Error";
  const lastUpdatedText = flushMs == null ? "—" : formatCt(flushMs, false);
  if (!stale) return { health, stale, lastUpdatedText, banner: null };
  const ageMin = flushMs == null ? null : Math.max(0, Math.floor((input.nowMs - flushMs) / 60000));
  const text =
    flushMs == null
      ? "There is no last run time. Numbers below are stale after 20 min."
      : `The last run finished at ${formatCt(flushMs, false)}, ${ageMin} min ago. Numbers below are from that run (stale after 20 min).`;
  return { health, stale, lastUpdatedText, banner: { staleClass: flushMs != null, text } };
}

/** Dashboard mget plus the equity mget. Both are reads. */
export async function readP6Page(
  kv: Pick<Kv, "mget">,
  nowMs: number,
  fetchImpl?: (url: string) => Promise<Pick<Response, "ok" | "json">>,
): Promise<{ view: DashboardView; block: PnlBlock }> {
  const [view, equity] = await Promise.all([readP6Dashboard(kv), readPnlWindows(kv, nowMs)]);
  const inputs = view.markInputs;
  delete view.markInputs;
  if (inputs && inputs.positions.length > 0) {
    const first = closedNow(inputs.positions, inputs.quotes, nowMs, { disconnected: inputs.disconnected });
    let restBids: Record<string, number> | undefined;
    if (first.state === "rest") {
      restBids = await fetchRestBids(
        inputs.positions.map((position) => position.productId),
        nowMs,
        fetchImpl,
      );
    }
    view.mark = closedNow(inputs.positions, inputs.quotes, nowMs, { disconnected: inputs.disconnected, restBids });
    for (const row of view.mark.rows) {
      const position = view.positions.find((item) => item.productId === row.productId);
      if (!position) continue;
      if (row.grossR != null) position.grossR = row.grossR;
      if (row.netR != null) position.netR = row.netR;
    }
  }
  const last = view.lastRun;
  const pnl = last && typeof last.pnl === "object" && last.pnl != null ? (last.pnl as Record<string, unknown>) : null;
  const block = buildPnlBlock({
    nowMs,
    lastEndMs: completedFlushMs(last),
    equityNow: pnl ? numField(pnl, "equityUsd") : null,
    realizedNow: pnl ? numField(pnl, "realizedUsd") : null,
    unrealizedNow: pnl ? numField(pnl, "unrealizedUsd") : null,
    feesNow: pnl ? numField(pnl, "feesUsd") : null,
    spreadNow: pnl ? numField(pnl, "spreadSlipUsd") : null,
    openPositions: view.positions.length,
    first: equity.first,
    points: equity.points,
    trades: equity.trades,
  });
  return { view, block };
}

/** A Kv that can only MGET. Every write throws before a socket opens. */
export function openDashboardKv(url: string): Kv {
  return {
    get: async (key) => (await mgetRaw(url, [key]))[0] ?? null,
    mget: (keys) => mgetRaw(url, keys),
    set: async () => refuse(),
    del: async () => refuse(),
    cas: async () => refuse(),
    ownedSet: async () => refuse(),
    ownedAppend: async () => refuse(),
    ownedFlush: async () => refuse(),
    readLists: async () => refuse(),
  };
}
