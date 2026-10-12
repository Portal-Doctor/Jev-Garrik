/**
 * Vercel relay. The engine does not know about cron or Redis.
 * Marketplace Redis is not chosen: callers pass a Kv. A memory Kv runs the tests.
 * Only the lease holder applies a bar, and each bar key is written once.
 */

import type { PaperStateBody } from "./paper-host";
import { GAP_MAX_MS, gapWeekReport, type VolHour } from "./amendment-v6";

export const CRON_EVERY_MS = 15 * 60 * 1000;
export const MAX_DURATION_MS = 1_800_000;
export const HANDOVER_MARGIN_MS = 60_000;
export const LEASE_KEY = "p6:lease";
export const STATE_KEY = "p6:state";
export const CRON_KEY = "p6:cron";

export interface Kv {
  get(key: string): Promise<string | null>;
  /** Returns true when the write happened. nx refuses an existing key. px is a TTL in milliseconds. */
  set(key: string, value: string, opts?: { nx?: boolean; px?: number }): Promise<boolean>;
  del(key: string): Promise<void>;
}

export function memoryKv(): Kv {
  const rows = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string, now = Date.now()) => {
    const row = rows.get(key);
    if (!row) return null;
    if (row.expiresAt != null && row.expiresAt <= now) {
      rows.delete(key);
      return null;
    }
    return row;
  };
  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, opts) {
      const current = live(key);
      if (opts?.nx && current) return false;
      rows.set(key, { value, expiresAt: opts?.px != null ? Date.now() + opts.px : null });
      return true;
    },
    async del(key) {
      rows.delete(key);
    },
  };
}

export interface Lease {
  holder: string;
  untilMs: number;
  release: "deadline" | "crash" | "none";
}

export function encodeLease(lease: Lease): string {
  return JSON.stringify(lease);
}

export function decodeLease(raw: string | null): Lease | null {
  if (!raw) return null;
  const body = JSON.parse(raw) as Lease;
  if (!body.holder || !(body.untilMs > 0)) return null;
  return { holder: body.holder, untilMs: body.untilMs, release: body.release ?? "none" };
}

/** One applied bar. The body is the book, orders, bars, B weeks, rings, tape, cursors, and Jev history. */
export function barKey(productId: string, startSec: number): string {
  return `p6:bar:${productId}:${startSec}`;
}

export async function commitBar(kv: Kv, productId: string, startSec: number, body: PaperStateBody): Promise<"applied" | "duplicate"> {
  const encoded = JSON.stringify(body);
  const wrote = await kv.set(barKey(productId, startSec), encoded, { nx: true });
  if (!wrote) return "duplicate";
  await kv.set(STATE_KEY, encoded);
  return "applied";
}

export interface AsyncPaperStore {
  load(): Promise<PaperStateBody | null>;
  save(body: PaperStateBody): Promise<void>;
}

/** Redis, or any Kv, behind the same snapshot the file store writes. The vendor client is not imported. */
export function kvPaperStore(kv: Kv): AsyncPaperStore {
  return {
    async load() {
      const raw = await kv.get(STATE_KEY);
      return raw ? (JSON.parse(raw) as PaperStateBody) : null;
    },
    async save(body) {
      await kv.set(STATE_KEY, JSON.stringify(body));
    },
  };
}

export interface RelayPlan {
  action: "hold" | "handover" | "acquire" | "overlap" | "duplicate";
  /** A socket closed at the deadline is not a gap on the next instance. */
  socketGap: boolean;
  /** Wall-clock time with nobody holding the lease. */
  feedGapMs: number;
  cause: string | null;
}

export function planRelay(opts: {
  nowMs: number;
  deadlineMs: number;
  self: string;
  lease: Lease | null;
  lastCronMs: number | null;
  cronEveryMs?: number;
}): RelayPlan {
  const every = opts.cronEveryMs ?? CRON_EVERY_MS;
  const lease = opts.lease;
  const held = lease != null && lease.untilMs > opts.nowMs;
  if (held && lease!.holder === opts.self && opts.nowMs >= opts.deadlineMs - HANDOVER_MARGIN_MS) {
    return { action: "handover", socketGap: false, feedGapMs: 0, cause: null };
  }
  if (held && lease!.holder !== opts.self) {
    const missed = opts.lastCronMs != null && opts.nowMs - opts.lastCronMs > every + 60_000;
    return { action: missed ? "overlap" : "duplicate", socketGap: false, feedGapMs: 0, cause: missed ? "missed-cron-covered" : "duplicate" };
  }
  if (held && lease!.holder === opts.self) {
    return { action: "hold", socketGap: false, feedGapMs: 0, cause: null };
  }
  const expired = lease != null && lease.untilMs <= opts.nowMs;
  const deadlineRelease = expired && lease!.release === "deadline";
  const crash = expired && lease!.release === "crash";
  const uncovered = expired ? Math.max(0, opts.nowMs - lease!.untilMs) : 0;
  const missed = opts.lastCronMs != null && opts.nowMs - opts.lastCronMs > every + 60_000;
  if (deadlineRelease && uncovered === 0) {
    return { action: "acquire", socketGap: false, feedGapMs: 0, cause: null };
  }
  if (deadlineRelease) {
    return { action: "acquire", socketGap: false, feedGapMs: uncovered, cause: missed ? "missed-cron" : "uncovered" };
  }
  if (crash) {
    return { action: "acquire", socketGap: true, feedGapMs: uncovered, cause: "kill" };
  }
  return { action: "acquire", socketGap: false, feedGapMs: 0, cause: null };
}

export async function tryAcquire(kv: Kv, self: string, untilMs: number, nowMs = Date.now()): Promise<boolean> {
  const current = decodeLease(await kv.get(LEASE_KEY));
  if (current && current.untilMs > nowMs) return current.holder === self;
  if (current) await kv.del(LEASE_KEY);
  return kv.set(LEASE_KEY, encodeLease({ holder: self, untilMs, release: "none" }), { nx: true });
}

export async function releaseLease(kv: Kv, self: string, release: "deadline" | "crash", nowMs: number): Promise<void> {
  const current = decodeLease(await kv.get(LEASE_KEY));
  if (current && current.holder !== self) return;
  await kv.set(LEASE_KEY, encodeLease({ holder: self, untilMs: nowMs, release }));
}

export interface InvocationResult {
  action: RelayPlan["action"];
  applied: string[];
  socketGap: boolean;
  feedGapMs: number;
  cause: string | null;
  holder: string | null;
}

export async function runInvocation(opts: {
  kv: Kv;
  self: string;
  nowMs: number;
  deadlineMs: number;
  lastCronMs?: number | null;
  holder: {
    warm(): Promise<void>;
    applyDueBars(): Promise<string[]>;
    releaseDeadline(): void;
    sampleUntil?(untilMs: number): Promise<void>;
  };
}): Promise<InvocationResult> {
  const lease = decodeLease(await opts.kv.get(LEASE_KEY));
  const storedCron = await opts.kv.get(CRON_KEY);
  const lastCronMs = opts.lastCronMs !== undefined ? opts.lastCronMs : storedCron == null ? null : Number(storedCron);
  await opts.kv.set(CRON_KEY, String(opts.nowMs));
  const plan = planRelay({ nowMs: opts.nowMs, deadlineMs: opts.deadlineMs, self: opts.self, lease, lastCronMs });
  if (plan.action === "overlap" || plan.action === "duplicate") {
    return { ...plan, applied: [], holder: lease?.holder ?? null };
  }
  if (plan.action === "handover") {
    opts.holder.releaseDeadline();
    await releaseLease(opts.kv, opts.self, "deadline", opts.nowMs);
    return { ...plan, applied: [], holder: null };
  }
  const acquired = await tryAcquire(opts.kv, opts.self, opts.deadlineMs, opts.nowMs);
  if (!acquired) {
    return { action: "duplicate", applied: [], socketGap: false, feedGapMs: 0, cause: "duplicate", holder: lease?.holder ?? null };
  }
  await opts.holder.warm();
  const applied = await opts.holder.applyDueBars();
  if (opts.holder.sampleUntil && opts.nowMs < opts.deadlineMs - HANDOVER_MARGIN_MS) {
    await opts.holder.sampleUntil(opts.deadlineMs - HANDOVER_MARGIN_MS);
  }
  if (opts.nowMs >= opts.deadlineMs - HANDOVER_MARGIN_MS) {
    opts.holder.releaseDeadline();
    await releaseLease(opts.kv, opts.self, "deadline", opts.nowMs);
    return { action: "handover", applied, socketGap: false, feedGapMs: plan.feedGapMs, cause: plan.cause, holder: null };
  }
  return { action: "hold", applied, socketGap: plan.socketGap, feedGapMs: plan.feedGapMs, cause: plan.cause, holder: opts.self };
}

export function cronAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret) return false;
  return header === `Bearer ${secret}`;
}

export interface Dashboard {
  positions: { id: string; productId: string; classId: string }[];
  gates: string[];
  g0: boolean;
  leaseHolder: string | null;
  incidents: string[];
  gaps: ReturnType<typeof gapWeekReport>;
  readOnly: true;
}

export function dashboard(opts: {
  positions: Dashboard["positions"];
  gates: string[];
  leaseHolder: string | null;
  incidents: string[];
  weekMs: number;
  gaps: readonly { startMs: number; endMs: number }[];
  hours: readonly VolHour[];
  jevSkipped: number;
  jevPackets: number;
  dIndeterminate: number;
  dSubmitted: number;
}): Dashboard {
  const gaps = gapWeekReport(opts);
  return {
    positions: opts.positions,
    gates: opts.gates,
    g0: gaps.noGo,
    leaseHolder: opts.leaseHolder,
    incidents: opts.incidents,
    gaps,
    readOnly: true,
  };
}

export function encodeCommand(parts: readonly string[]): string {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) out += `$${Buffer.byteLength(part)}\r\n${part}\r\n`;
  return out;
}

/** A small subset of RESP: bulk strings, simple strings, integers, and nil. */
export function decodeReply(raw: string): string | null {
  if (raw.startsWith("$-1")) return null;
  if (raw.startsWith("+") || raw.startsWith(":")) return raw.slice(1, raw.indexOf("\r\n"));
  if (raw.startsWith("$")) {
    const nl = raw.indexOf("\r\n");
    const len = Number(raw.slice(1, nl));
    return raw.slice(nl + 2, nl + 2 + len);
  }
  if (raw.startsWith("-")) throw new Error(raw.slice(1, raw.indexOf("\r\n")));
  throw new Error("unreadable redis reply");
}

/** One complete reply, or null when the buffer is short. */
export function takeReply(buf: string): { reply: string | null; rest: string } | null {
  if (buf.startsWith("$-1")) {
    const end = "$-1\r\n".length;
    if (buf.length < end) return null;
    return { reply: null, rest: buf.slice(end) };
  }
  if (buf.startsWith("+") || buf.startsWith(":") || buf.startsWith("-")) {
    const nl = buf.indexOf("\r\n");
    if (nl < 0) return null;
    return { reply: decodeReply(buf.slice(0, nl + 2)), rest: buf.slice(nl + 2) };
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

/**
 * Generic Redis over redis://. No Marketplace SDK. One connection per command.
 * Brian's deployment sets REDIS_URL. Tests use memoryKv.
 */
export function redisKvFromUrl(url: string): Kv {
  const parsed = new URL(url);
  const send = async (parts: string[]): Promise<string | null> => {
    const { connect } = await import("node:net");
    const port = Number(parsed.port || 6379);
    const host = parsed.hostname;
    const password = parsed.password ? decodeURIComponent(parsed.password) : "";
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      const pending: string[] = [];
      let buf = "";
      const fail = (error: unknown) => {
        socket.destroy();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      socket.on("error", fail);
      socket.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        for (;;) {
          if (pending.length === 0) return;
          const taken = takeReply(buf);
          if (!taken) return;
          buf = taken.rest;
          const want = pending.shift();
          if (want === "auth") continue;
          socket.end();
          resolve(taken.reply);
          return;
        }
      });
      socket.on("connect", () => {
        if (password) {
          pending.push("auth");
          socket.write(encodeCommand(["AUTH", password]));
        }
        pending.push("cmd");
        socket.write(encodeCommand(parts));
      });
    });
  };
  return {
    async get(key) {
      return send(["GET", key]);
    },
    async set(key, value, opts) {
      const parts = ["SET", key, value];
      if (opts?.nx) parts.push("NX");
      if (opts?.px != null) parts.push("PX", String(opts.px));
      const reply = await send(parts);
      return reply === "OK";
    },
    async del(key) {
      await send(["DEL", key]);
    },
  };
}

export { GAP_MAX_MS };
