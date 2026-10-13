/**
 * Read-only /p6 view. get and mget only. Write methods throw.
 * This file does not import the host, the hot store, or the relay client.
 */

import { connect as connectNet, isIP } from "node:net";
import { connect as connectTls } from "node:tls";
import type { Kv } from "./relay";
import { commandBudget, healthStale, monthCommands, nextCronMs, projectionTone } from "./dashboard-format";

export { commandBudget, healthStale, monthCommands, nextCronMs, projectionTone };

export const LAST_RUN_KEY = "p6:lastRun";
const HOT_KEY = "p6:hot";
const LEASE_KEY = "p6:lease";

export function dashboardAuthorized(header: string | null, token: string | undefined): boolean {
  if (!token) return false;
  return header === `Bearer ${token}`;
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
