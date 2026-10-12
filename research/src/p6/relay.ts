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
/** Survives the lease TTL so a kill is visible after Redis expires the live key. */
export const LEASE_META_KEY = "p6:lease-meta";
export const STATE_KEY = "p6:state";
export const CRON_KEY = "p6:cron";

export interface Kv {
  get(key: string): Promise<string | null>;
  /** Returns true when the write happened. nx refuses an existing key. px is a TTL in milliseconds. */
  set(key: string, value: string, opts?: { nx?: boolean; px?: number }): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Write only when the current value equals `expect`. `null` means the key is absent. px is a TTL. */
  cas(key: string, expect: string | null, value: string, opts?: { px?: number }): Promise<boolean>;
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
    async cas(key, expect, value, opts) {
      const current = live(key);
      const actual = current?.value ?? null;
      if (actual !== expect) return false;
      rows.set(key, { value, expiresAt: opts?.px != null ? Date.now() + opts.px : null });
      return true;
    },
  };
}

export interface Lease {
  holder: string;
  untilMs: number;
  release: "deadline" | "crash" | "none";
  /** Identifies the holder that may release. A release checks this before it writes. */
  token?: string;
  /** Last heartbeat or save. A crash gap starts here, not at lease expiry. */
  savedAtMs?: number;
}

export function encodeLease(lease: Lease): string {
  return JSON.stringify(lease);
}

export function decodeLease(raw: string | null): Lease | null {
  if (!raw) return null;
  const body = JSON.parse(raw) as Lease;
  if (!body.holder || !(body.untilMs > 0)) return null;
  return {
    holder: body.holder,
    untilMs: body.untilMs,
    release: body.release ?? "none",
    ...(body.token ? { token: body.token } : {}),
    ...(body.savedAtMs != null ? { savedAtMs: body.savedAtMs } : {}),
  };
}

/** One applied bar. The value is a marker. The book lives on the state key, and static warmup on its own key. */
export function barKey(productId: string, startSec: number): string {
  return `p6:bar:${productId}:${startSec}`;
}

/** Static daily warmup. Written once, not on each bar key. */
export const WARMUP_KEY = "p6:warmup";

export function barMarker(productId: string, startSec: number): string {
  return JSON.stringify({ productId, startSec });
}

/** Payload bytes of one day's bar markers. Redis object overhead is extra and is measured on a server. */
export function markerBytesPerDay(products: number, example = barMarker("BTC-USD", 1_700_000_000)): number {
  return products * 96 * Buffer.byteLength(example);
}

export async function saveState(kv: Kv, body: PaperStateBody, opts?: { writeWarmup?: boolean }): Promise<void> {
  const { warmup, ...live } = body;
  await kv.set(STATE_KEY, JSON.stringify(live));
  if (opts?.writeWarmup === false || !warmup) return;
  if (await kv.get(WARMUP_KEY)) return;
  await kv.set(WARMUP_KEY, JSON.stringify(warmup));
}

export async function loadState(kv: Kv): Promise<PaperStateBody | null> {
  const raw = await kv.get(STATE_KEY);
  if (!raw) return null;
  const body = JSON.parse(raw) as PaperStateBody;
  if (!body.warmup) {
    const warm = await kv.get(WARMUP_KEY);
    if (warm) body.warmup = JSON.parse(warm) as PaperStateBody["warmup"];
  }
  return body;
}

export async function commitBar(kv: Kv, productId: string, startSec: number, body: PaperStateBody): Promise<"applied" | "duplicate"> {
  const wrote = await kv.set(barKey(productId, startSec), barMarker(productId, startSec), { nx: true });
  if (!wrote) return "duplicate";
  await saveState(kv, body, { writeWarmup: false });
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
      return loadState(kv);
    },
    async save(body) {
      await saveState(kv, body);
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
    const since = opts.lastCronMs == null ? Number.POSITIVE_INFINITY : opts.nowMs - opts.lastCronMs;
    const missed = opts.lastCronMs != null && since > every + 60_000;
    if (since < 60_000) return { action: "duplicate", socketGap: false, feedGapMs: 0, cause: "duplicate" };
    return { action: "overlap", socketGap: false, feedGapMs: 0, cause: missed ? "missed-cron-covered" : "overlap-warm" };
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
  const raw = await kv.get(LEASE_KEY);
  const current = decodeLease(raw);
  if (current && current.untilMs > nowMs && current.holder !== self) return false;
  const ttl = Math.max(1, untilMs - nowMs);
  const token = current && current.holder === self && current.token ? current.token : `${self}:${nowMs}`;
  const savedAtMs = current && current.holder === self && current.savedAtMs != null ? current.savedAtMs : nowMs;
  const next = encodeLease({ holder: self, untilMs, release: "none", token, savedAtMs });
  const won = await kv.cas(LEASE_KEY, raw, next, { px: ttl });
  if (!won) return false;
  await kv.set(LEASE_META_KEY, next);
  return true;
}

/** Move the crash-gap start to this save. A later kill is measured from here, not from the lease deadline. */
export async function noteLeaseSave(kv: Kv, nowMs: number): Promise<void> {
  const raw = await kv.get(LEASE_META_KEY);
  const meta = decodeLease(raw);
  if (!meta || meta.release !== "none") return;
  if (meta.savedAtMs != null && nowMs < meta.savedAtMs) return;
  await kv.set(LEASE_META_KEY, encodeLease({ ...meta, savedAtMs: nowMs }));
}

/**
 * Token-checked. A holder that does not own the lease does not overwrite it.
 * The live key is removed, so a released lease does not look held. The cause stays on the meta key.
 */
export async function releaseLease(kv: Kv, self: string, release: "deadline" | "crash", nowMs: number): Promise<void> {
  const raw = await kv.get(LEASE_KEY);
  const current = decodeLease(raw);
  if (current && current.holder !== self) return;
  const next = encodeLease({
    holder: current?.holder ?? self,
    token: current?.token ?? self,
    untilMs: nowMs,
    release,
    ...(current?.savedAtMs != null ? { savedAtMs: current.savedAtMs } : {}),
  });
  if (current) {
    const won = await kv.cas(LEASE_KEY, raw, next);
    if (!won) return;
    await kv.del(LEASE_KEY);
  }
  await kv.set(LEASE_META_KEY, next);
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
    /** Subscribe before this instance owns the lease. A normal handover then has no feed gap. */
    watchUntil?(untilMs: number): Promise<void>;
    persist?(): Promise<void>;
    recordGap?(gap: { startMs: number; endMs: number; cause: string }): void;
  };
  /** Wall clock after an overlap watch. Injected runs keep `nowMs` unless this is set. */
  clock?: () => number;
}): Promise<InvocationResult> {
  let nowMs = opts.nowMs;
  const lease0 = decodeLease(await opts.kv.get(LEASE_KEY));
  const storedCron = await opts.kv.get(CRON_KEY);
  const lastCronMs = opts.lastCronMs !== undefined ? opts.lastCronMs : storedCron == null ? null : Number(storedCron);
  await opts.kv.set(CRON_KEY, String(nowMs));
  let plan = planRelay({ nowMs, deadlineMs: opts.deadlineMs, self: opts.self, lease: lease0, lastCronMs });
  const record = (gap: { startMs: number; endMs: number; cause: string }) => {
    opts.holder.recordGap?.(gap);
  };
  if (plan.action === "duplicate") {
    return { ...plan, applied: [], holder: lease0?.holder ?? null };
  }
  if (plan.action === "handover") {
    opts.holder.releaseDeadline();
    await releaseLease(opts.kv, opts.self, "deadline", nowMs);
    record({ startMs: nowMs, endMs: nowMs, cause: "handover" });
    await opts.holder.persist?.();
    return { ...plan, applied: [], holder: null };
  }
  await opts.holder.warm();
  if (plan.action === "overlap") {
    if (!opts.holder.watchUntil) {
      return { ...plan, applied: [], holder: lease0?.holder ?? null, cause: plan.cause ?? "overlap-warm" };
    }
    const wall = Date.now();
    await opts.holder.watchUntil(opts.deadlineMs - HANDOVER_MARGIN_MS);
    const waited = Date.now() - wall;
    if (opts.clock) nowMs = opts.clock();
    else if (waited >= 20) nowMs = opts.nowMs + waited;
    plan = planRelay({ nowMs, deadlineMs: opts.deadlineMs, self: opts.self, lease: decodeLease(await opts.kv.get(LEASE_KEY)), lastCronMs });
  }
  const lease = decodeLease(await opts.kv.get(LEASE_KEY));
  const meta = decodeLease(await opts.kv.get(LEASE_META_KEY));
  const heldByOther = lease != null && lease.holder !== opts.self && lease.untilMs > nowMs;
  let feedGapMs = 0;
  if (!heldByOther && meta && meta.release === "none" && meta.holder !== opts.self) {
    const start = meta.savedAtMs ?? nowMs;
    const end = Math.max(start, nowMs);
    feedGapMs = end - start;
    record({ startMs: start, endMs: end, cause: "crash" });
  } else if (meta?.release === "deadline" && meta.holder !== opts.self) {
    const width = Math.max(0, nowMs - meta.untilMs);
    feedGapMs = width;
    const missed = lastCronMs != null && nowMs - lastCronMs > CRON_EVERY_MS + 60_000;
    record({
      startMs: width === 0 ? nowMs : meta.untilMs,
      endMs: width === 0 ? nowMs : nowMs,
      cause: width === 0 ? "handover" : missed ? "missed-cron" : "uncovered",
    });
  } else if (plan.feedGapMs > 0) {
    const start = lease?.untilMs ?? nowMs - plan.feedGapMs;
    feedGapMs = Math.max(0, nowMs - start);
    record({ startMs: start, endMs: nowMs, cause: plan.cause === "kill" ? "crash" : (plan.cause ?? "uncovered") });
  }
  const acquired = await tryAcquire(opts.kv, opts.self, opts.deadlineMs, nowMs);
  if (!acquired) {
    return { action: "duplicate", applied: [], socketGap: false, feedGapMs: 0, cause: "duplicate", holder: lease?.holder ?? null };
  }
  const applied = await opts.holder.applyDueBars();
  let sampled = false;
  if (opts.holder.sampleUntil && nowMs < opts.deadlineMs - HANDOVER_MARGIN_MS) {
    try {
      await opts.holder.sampleUntil(opts.deadlineMs - HANDOVER_MARGIN_MS);
      sampled = true;
    } catch (error) {
      opts.holder.releaseDeadline();
      const failedAt = opts.clock ? opts.clock() : nowMs;
      const savedAt = decodeLease(await opts.kv.get(LEASE_META_KEY))?.savedAtMs ?? nowMs;
      await releaseLease(opts.kv, opts.self, "crash", failedAt);
      record({ startMs: savedAt, endMs: Math.max(savedAt, failedAt), cause: "crash" });
      await opts.holder.persist?.();
      throw error;
    }
  }
  if (sampled) {
    const at = opts.deadlineMs - HANDOVER_MARGIN_MS;
    opts.holder.releaseDeadline();
    await releaseLease(opts.kv, opts.self, "deadline", at);
    record({ startMs: at, endMs: at, cause: "handover" });
    await opts.holder.persist?.();
    return { action: "handover", applied, socketGap: false, feedGapMs, cause: plan.cause ?? "handover", holder: null };
  }
  await opts.holder.persist?.();
  await noteLeaseSave(opts.kv, nowMs);
  return { action: "hold", applied, socketGap: plan.socketGap, feedGapMs, cause: plan.cause, holder: opts.self };
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

export interface RedisEndpoint {
  host: string;
  port: number;
  tls: boolean;
  username: string;
  password: string;
  timeoutMs: number;
}

/** redis:// and rediss://. Username, password, and a command timeout. The Marketplace vendor stays behind Kv. */
export function redisEndpoint(url: string, timeoutMs = Number(process.env.REDIS_TIMEOUT_MS ?? 5_000)): RedisEndpoint {
  const parsed = new URL(url);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") throw new Error("REDIS_URL must be redis:// or rediss://");
  const tls = parsed.protocol === "rediss:";
  return {
    host: parsed.hostname,
    port: Number(parsed.port || (tls ? 6380 : 6379)),
    tls,
    username: parsed.username ? decodeURIComponent(parsed.username) : "",
    password: parsed.password ? decodeURIComponent(parsed.password) : "",
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5_000,
  };
}

const CAS_LUA = [
  "local cur = redis.call('GET', KEYS[1])",
  "if ARGV[1] == '1' then",
  "  if cur then return 0 end",
  "elseif cur ~= ARGV[2] then",
  "  return 0",
  "end",
  "local px = tonumber(ARGV[4])",
  "if px > 0 then redis.call('SET', KEYS[1], ARGV[3], 'PX', px) else redis.call('SET', KEYS[1], ARGV[3]) end",
  "return 1",
].join("\n");

/**
 * Generic Redis over redis:// or rediss://. No Marketplace SDK. One connection per command.
 * Brian's deployment sets REDIS_URL. Tests use memoryKv.
 */
export function redisKvFromUrl(url: string): Kv {
  const endpoint = redisEndpoint(url);
  const send = async (parts: string[]): Promise<string | null> => {
    const net = await import("node:net");
    const tls = endpoint.tls ? await import("node:tls") : null;
    return new Promise((resolve, reject) => {
      const socket = tls
        ? tls.connect({ host: endpoint.host, port: endpoint.port, servername: endpoint.host })
        : net.connect({ host: endpoint.host, port: endpoint.port });
      socket.setTimeout(endpoint.timeoutMs);
      const pending: string[] = [];
      let buf = "";
      let settled = false;
      const finish = (error: unknown, reply?: string | null) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error instanceof Error ? error : new Error(String(error)));
        else resolve(reply ?? null);
      };
      socket.on("timeout", () => finish(new Error("redis timeout")));
      socket.on("error", (error: Error) => finish(error));
      socket.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        try {
          for (;;) {
            if (pending.length === 0) return;
            const taken = takeReply(buf);
            if (!taken) return;
            buf = taken.rest;
            const want = pending.shift();
            if (want === "auth") continue;
            finish(null, taken.reply);
            return;
          }
        } catch (error) {
          finish(error);
        }
      });
      socket.on("connect", () => {
        if (endpoint.username && endpoint.password) {
          pending.push("auth");
          socket.write(encodeCommand(["AUTH", endpoint.username, endpoint.password]));
        } else if (endpoint.password) {
          pending.push("auth");
          socket.write(encodeCommand(["AUTH", endpoint.password]));
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
    async cas(key, expect, value, opts) {
      const reply = await send(["EVAL", CAS_LUA, "1", key, expect == null ? "1" : "0", expect ?? "", value, String(opts?.px ?? 0)]);
      return reply === "1";
    },
  };
}

export { GAP_MAX_MS };
