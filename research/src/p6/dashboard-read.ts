/**
 * Read-only /p6 view. get and mget only. Write methods throw.
 * This file does not import the host, the hot store, or the relay client.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { connect as connectNet, isIP } from "node:net";
import { connect as connectTls } from "node:tls";
import { classifyStored, GZIP_PREFIX, readText } from "./redis-gzip";
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

export { type PnlBlock };

export { commandBudget, healthStale, monthCommands, nextCronMs, projectionTone };

export const LAST_RUN_KEY = "p6:lastRun";
const HOT_KEY = "p6:hot";
const LEASE_KEY = "p6:lease";

/**
 * How to open the dashboard.
 *
 * Path: GET /p6. A plain GET is enough. POST is not required and is not a login step.
 * Query: put the dashboard token in the `token` parameter:
 * https://<your-vercel-domain>/p6?token=<DASHBOARD_TOKEN>
 * Do not send the token in the path. A valid `token` answers 302 to the same path with that
 * parameter removed (other query parameters stay), and sets the cookie below.
 * The follow-up GET carries the cookie and renders the page. The token does not stay in the
 * address bar.
 *
 * Cookie name: p6_dash
 * Attributes: HttpOnly; Secure; SameSite=Strict; Path=/p6; Max-Age=2592000 (30 days). No Domain.
 * Value: hex HMAC-SHA256, keyed by DASHBOARD_TOKEN, over the fixed label "p6-dashboard-v1".
 * The cookie is not the raw token. Rotating DASHBOARD_TOKEN invalidates existing cookies.
 * There is no new environment variable.
 *
 * Precedence when Authorization, the cookie, and `?token=` are all present:
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
    params.delete("token");
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

/** Proxy result for /p6. GET is enough. The status does not depend on POST. */
export function applyDashboardProxy(request: Request, dashboardToken: string | undefined): { status: number; body: string | null; headers: Record<string, string> } {
  const url = new URL(request.url);
  const headers: Record<string, string> = {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  };
  const path = dashboardPathname(url.pathname);
  if (!path) return { status: 401, body: "unauthorized", headers };
  const tokenParam = url.searchParams.has("token") ? (url.searchParams.get("token") ?? "") : null;
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

export interface DashboardLease {
  holder: string;
  untilMs: number;
}

export interface DashboardView {
  lease: DashboardLease | null;
  lastRun: Record<string, unknown> | null;
  killSwitch: boolean;
  incidents: string[];
  gaps: { startMs: number; endMs: number; cause?: string }[];
  positions: { productId?: string; id?: string }[];
  closed: { productId?: string; classId?: string; netUsd?: number }[];
  emitted: string[];
  /** True when p6:hot was present and could not be decoded. Missing hot stays false. */
  unreadable: boolean;
  /** True when p6:lastRun was present and could not be decoded. Missing lastRun stays false. */
  lastUnreadable: boolean;
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

/** One read of lastRun, hot, and the lease. No INFO and no writes. */
export async function readP6Dashboard(kv: Pick<Kv, "readMany">): Promise<DashboardView> {
  const tagged = await kv.readMany([LAST_RUN_KEY, HOT_KEY, LEASE_KEY]);
  // Plain JSON and gz1: both decode. A corrupt hot is flagged, not shown as an empty book.
  const lastRead = tagged[0] ?? { tag: "missing" as const };
  const hotRead = tagged[1] ?? { tag: "missing" as const };
  const lastRaw = readText(lastRead);
  const hotRaw = readText(hotRead);
  const leaseRaw = readText(tagged[2] ?? { tag: "missing" });
  const unreadable = hotRead.tag === "unreadable";
  const lastUnreadable = lastRead.tag === "unreadable";
  const hot = hotRaw ? (JSON.parse(hotRaw) as Record<string, unknown>) : {};
  const incidents = Array.isArray(hot.incidents) ? hot.incidents.filter((row): row is string => typeof row === "string").map(stripUrls) : [];
  const gaps = Array.isArray(hot.gaps) ? (hot.gaps as DashboardView["gaps"]) : [];
  const positions = Array.isArray(hot.positions) ? (hot.positions as DashboardView["positions"]) : [];
  const closed = Array.isArray(hot.closed) ? (hot.closed as DashboardView["closed"]) : [];
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
    unreadable,
    lastUnreadable,
  };
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
export async function readP6Page(kv: Pick<Kv, "mget" | "readMany">, nowMs: number): Promise<{ view: DashboardView; block: PnlBlock }> {
  const [view, equity] = await Promise.all([readP6Dashboard(kv), readPnlWindows(kv, nowMs)]);
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

/**
 * Bytes the socket assembled. A plain bulk string is returned as stored, including
 * one that is not JSON. A gz1: value is decoded. A gzip that does not decode is null.
 * JSON shape is decided by the view, not by this packet reader.
 */
function dashboardValue(key: string, raw: string | null): string | null {
  if (raw == null) return null;
  if (!raw.startsWith(GZIP_PREFIX)) return raw;
  return readText(classifyStored(key, raw));
}

/** A Kv that can only MGET. Every write throws before a socket opens. */
export function openDashboardKv(url: string): Kv {
  const readMany = async (keys: string[]) => {
    const raw = await mgetRaw(url, keys);
    return keys.map((key, index) => classifyStored(key, raw[index] ?? null));
  };
  return {
    async read(key) {
      return (await readMany([key]))[0]!;
    },
    async readMany(keys) {
      return readMany(keys);
    },
    async get(key) {
      const raw = (await mgetRaw(url, [key]))[0] ?? null;
      return dashboardValue(key, raw);
    },
    async mget(keys) {
      const raw = await mgetRaw(url, keys);
      return keys.map((key, index) => dashboardValue(key, raw[index] ?? null));
    },
    set: async () => refuse(),
    del: async () => refuse(),
    cas: async () => refuse(),
    ownedSet: async () => refuse(),
    ownedAppend: async () => refuse(),
    ownedFlush: async () => refuse(),
    readLists: async () => refuse(),
  };
}
