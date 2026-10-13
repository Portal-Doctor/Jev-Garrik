/**
 * Vercel relay. The engine does not know about cron or Redis.
 * Marketplace Redis is not chosen: callers pass a Kv. A memory Kv runs the tests.
 * Only the lease holder applies a bar, and each bar key is written once.
 */

import { GAP_MAX_MS, gapWeekReport, handoverCause, type VolHour } from "./amendment-v6";
import { SAVE_HEARTBEAT_MS, type PaperStateBody } from "./paper-host";

export { SAVE_HEARTBEAT_MS };

export const CRON_EVERY_MS = 15 * 60 * 1000;
export const MAX_DURATION_MS = 1_800_000;
export const HANDOVER_MARGIN_MS = 60_000;
/**
 * Live lease TTL. The 60s heartbeat renews it. A crash drops the key inside
 * this window, so the overlap watcher is not stuck until the function deadline.
 */
export const LEASE_TTL_MS = 180_000;
export const LEASE_KEY = "p6:lease";
/** Survives the lease TTL so a kill is visible after Redis expires the live key. */
export const LEASE_META_KEY = "p6:lease-meta";
export const STATE_KEY = "p6:state";
export const HOT_KEY = "p6:hot";
export const CRON_KEY = "p6:cron";
/** Architect's cap. Upstash's published request cap is larger; this process stays under 1 MB. */
export const VALUE_MAX_BYTES = 1_048_576;

export interface Kv {
  get(key: string): Promise<string | null>;
  /** Returns true when the write happened. nx refuses an existing key. px is a TTL in milliseconds. */
  set(key: string, value: string, opts?: { nx?: boolean; px?: number }): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Write only when the current value equals `expect`. `null` means the key is absent. px is a TTL. */
  cas(key: string, expect: string | null, value: string, opts?: { px?: number }): Promise<boolean>;
  /** SET only when the lease JSON token matches. One Lua script on Redis. False means the lease is gone. */
  ownedSet(leaseKey: string, token: string, key: string, value: string, opts?: { px?: number }): Promise<boolean>;
  /**
   * Append one JSON object to a JSON array only when the lease token matches.
   * 1 applied, 2 duplicate, 0 lost the lease, 3 the value would exceed 1 MB.
   */
  ownedAppend(
    leaseKey: string,
    token: string,
    key: string,
    member: string,
    opts: { id: string; field: string; max?: number; px?: number },
  ): Promise<number>;
}

export function memoryKv(clock: () => number = Date.now): Kv {
  const rows = new Map<string, { value: string; expiresAt: number | null }>();
  const live = (key: string, now = clock()) => {
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
      rows.set(key, { value, expiresAt: opts?.px != null ? clock() + opts.px : null });
      return true;
    },
    async del(key) {
      rows.delete(key);
    },
    async cas(key, expect, value, opts) {
      const current = live(key);
      const actual = current?.value ?? null;
      if (actual !== expect) return false;
      rows.set(key, { value, expiresAt: opts?.px != null ? clock() + opts.px : null });
      return true;
    },
    async ownedSet(leaseKey, token, key, value, opts) {
      const lease = decodeLease(live(leaseKey)?.value ?? null);
      if (!lease || lease.token !== token || lease.release !== "none") return false;
      if (Buffer.byteLength(value) > VALUE_MAX_BYTES) return false;
      rows.set(key, { value, expiresAt: opts?.px != null ? clock() + opts.px : null });
      return true;
    },
    async ownedAppend(leaseKey, token, key, member, opts) {
      const lease = decodeLease(live(leaseKey)?.value ?? null);
      if (!lease || lease.token !== token || lease.release !== "none") return 0;
      const current = live(key)?.value;
      const list = current ? (JSON.parse(current) as Record<string, unknown>[]) : [];
      if (list.some((row) => String(row[opts.field]) === opts.id)) return 2;
      list.push(JSON.parse(member) as Record<string, unknown>);
      const max = opts.max ?? 0;
      const trimmed = max > 0 && list.length > max ? list.slice(list.length - max) : list;
      const encoded = JSON.stringify(trimmed);
      if (Buffer.byteLength(encoded) > VALUE_MAX_BYTES) return 3;
      rows.set(key, { value: encoded, expiresAt: opts.px != null ? clock() + opts.px : null });
      return 1;
    },
  };
}

/** PX for a live lease. Never longer than the function deadline, and never longer than LEASE_TTL_MS. */
export function leasePx(untilMs: number, nowMs: number): number {
  return Math.min(LEASE_TTL_MS, Math.max(1, untilMs - nowMs));
}

export interface Lease {
  holder: string;
  untilMs: number;
  release: "deadline" | "crash" | "none";
  /** Identifies the holder that may release. A release checks this before it writes. */
  token?: string;
  /** Last heartbeat or save. A crash gap starts here, not at lease expiry. */
  savedAtMs?: number;
  /** The final book write failed. The next holder treats the handover as uncovered. */
  saveFailed?: boolean;
  /** Set as the holder's last write. The watcher takes over when it sees this. */
  released?: boolean;
  /** Planned release, getDeadline() minus 60s. The watcher polls faster near this time. */
  releaseAtMs?: number;
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
    ...(body.saveFailed ? { saveFailed: true } : {}),
    ...(body.released ? { released: true } : {}),
    ...(body.releaseAtMs != null ? { releaseAtMs: body.releaseAtMs } : {}),
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
  const { warmup, memberCloses, fifteen, hourWarm, dailyCloses, dailyBars, fourBars, rings, tape, ...live } = body;
  void memberCloses;
  void fifteen;
  void hourWarm;
  void dailyCloses;
  void dailyBars;
  void fourBars;
  void rings;
  void tape;
  const wrote = await kv.set(HOT_KEY, JSON.stringify(live));
  if (!wrote) throw new Error("kv set p6:hot failed");
  if (opts?.writeWarmup !== true || !warmup) return;
  const warmWrote = await kv.set(WARMUP_KEY, JSON.stringify(warmup));
  if (!warmWrote) throw new Error("kv set p6:warmup failed");
}

export async function loadState(kv: Kv): Promise<PaperStateBody | null> {
  const raw = await kv.get(HOT_KEY);
  if (!raw) return null;
  const body = JSON.parse(raw) as PaperStateBody;
  if (!body.warmup) {
    const warm = await kv.get(WARMUP_KEY);
    if (warm) body.warmup = JSON.parse(warm) as PaperStateBody["warmup"];
  }
  return body;
}

/** Idempotent marker only. The book is one state write, from the run's persist, not from the marker. */
export async function commitBar(kv: Kv, productId: string, startSec: number): Promise<"applied" | "duplicate"> {
  const wrote = await kv.set(barKey(productId, startSec), barMarker(productId, startSec), { nx: true });
  return wrote ? "applied" : "duplicate";
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
  const held = lease != null && lease.released !== true && lease.untilMs > opts.nowMs;
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
  if (current && current.released !== true && current.untilMs > nowMs && current.holder !== self) return false;
  const ttl = leasePx(untilMs, nowMs);
  const same = current && current.holder === self && current.released !== true;
  const token = same && current!.token ? current!.token : `${self}:${nowMs}`;
  const savedAtMs = same && current!.savedAtMs != null ? current!.savedAtMs : nowMs;
  const next = encodeLease({ holder: self, untilMs, release: "none", token, savedAtMs, releaseAtMs: untilMs - HANDOVER_MARGIN_MS });
  const won = await kv.cas(LEASE_KEY, raw, next, { px: ttl });
  if (!won) return false;
  await kv.set(LEASE_META_KEY, next);
  return true;
}

/**
 * Extend the live key by one TTL and move the crash clock. This does not save the book.
 * A lost compare-and-swap means this process no longer holds the lease.
 */
export async function renewLease(kv: Kv, nowMs: number, token?: string): Promise<boolean> {
  const raw = await kv.get(LEASE_KEY);
  const current = decodeLease(raw);
  if (!current || current.release !== "none") return false;
  if (current.token && current.token !== token) return false;
  const next = encodeLease({ ...current, savedAtMs: nowMs });
  const won = await kv.cas(LEASE_KEY, raw, next, { px: leasePx(current.untilMs, nowMs) });
  if (!won) return false;
  const metaWrote = await kv.set(LEASE_META_KEY, next);
  if (!metaWrote) throw new Error("kv set p6:lease-meta failed");
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
export async function releaseLease(
  kv: Kv,
  self: string,
  release: "deadline" | "crash",
  nowMs: number,
  opts?: { saveFailed?: boolean },
): Promise<void> {
  const raw = await kv.get(LEASE_KEY);
  const current = decodeLease(raw);
  if (!current || current.holder !== self || !current.token) return;
  const next = encodeLease({
    holder: current.holder,
    token: current.token,
    untilMs: nowMs,
    release,
    released: true,
    ...(current.releaseAtMs != null ? { releaseAtMs: current.releaseAtMs } : {}),
    ...(current.savedAtMs != null ? { savedAtMs: current.savedAtMs } : {}),
    ...(opts?.saveFailed ? { saveFailed: true } : {}),
  });
  const won = await kv.cas(LEASE_KEY, raw, next);
  if (!won) return;
  const still = decodeLease(await kv.get(LEASE_KEY));
  if (!still || still.token !== current.token) return;
  await kv.set(LEASE_META_KEY, next);
  await kv.del(LEASE_KEY);
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
    /** Load p6:state after this instance owns the lease, before it records or saves. */
    reload?(): Promise<void>;
    /**
     * Replay the overlap buffer. True only when the incoming socket, the cut, and the
     * buffer satisfy the reworded handover rule.
     */
    confirmHandover?(): Promise<boolean>;
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
  const staged: { startMs: number; endMs: number; cause: string }[] = [];
  const stage = (gap: { startMs: number; endMs: number; cause: string }) => {
    staged.push(gap);
  };
  const flushStaged = () => {
    for (const gap of staged) opts.holder.recordGap?.(gap);
    staged.length = 0;
  };
  const leaseLostError = (error: unknown) => error instanceof Error && error.message.includes("lease lost");
  const writeFailure = (error: unknown) => {
    if (leaseLostError(error)) return false;
    const message = error instanceof Error ? error.message : "failed";
    return message.includes("kv set") || message.includes("256 KB") || message.includes("1 MB") || message.includes("redis timeout") || message.includes("redis closed") || message.startsWith("redis ");
  };
  // A failed book write is an incident. It must not skip the lease release or kill the holder.
  const persistBook = async () => {
    try {
      await opts.holder.persist?.();
    } catch (error) {
      if (writeFailure(error)) return;
      throw error;
    }
  };
  // Retry a final save until the deadline minus 10s. A frozen injected clock tries once.
  const persistFinal = async (): Promise<boolean> => {
    const limit = opts.deadlineMs - 10_000;
    for (;;) {
      try {
        await opts.holder.persist?.();
        return true;
      } catch (error) {
        if (leaseLostError(error)) return false;
        if (!writeFailure(error)) throw error;
        const now = opts.clock ? opts.clock() : Date.now();
        if (now >= limit) return false;
        await new Promise((resolve) => setTimeout(resolve, 250));
        const after = opts.clock ? opts.clock() : Date.now();
        if (after === now) return false;
      }
    }
  };
  const releaseFinal = async (at: number) => {
    const saved = await persistFinal();
    opts.holder.recordGap?.({ startMs: at, endMs: at, cause: saved ? "handover" : "save failed" });
    opts.holder.releaseDeadline();
    await releaseLease(opts.kv, opts.self, "deadline", at, saved ? undefined : { saveFailed: true });
    return saved;
  };
  if (plan.action === "duplicate") {
    return { ...plan, applied: [], holder: lease0?.holder ?? null };
  }
  if (plan.action === "handover") {
    const saved = await releaseFinal(nowMs);
    return { ...plan, applied: [], holder: null, cause: saved ? plan.cause : "uncovered" };
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
    stage({ startMs: start, endMs: end, cause: "crash" });
  } else if (meta?.release === "deadline" && meta.holder !== opts.self) {
    const width = Math.max(0, nowMs - meta.untilMs);
    feedGapMs = width;
    const missed = lastCronMs != null && nowMs - lastCronMs > CRON_EVERY_MS + 60_000;
    stage({
      startMs: width === 0 ? nowMs : meta.untilMs,
      endMs: width === 0 ? nowMs : nowMs,
      cause: meta.saveFailed ? "save failed" : width === 0 ? "handover" : missed ? "missed-cron" : "uncovered",
    });
  } else if (plan.feedGapMs > 0) {
    const start = lease?.untilMs ?? nowMs - plan.feedGapMs;
    feedGapMs = Math.max(0, nowMs - start);
    stage({ startMs: start, endMs: nowMs, cause: plan.cause === "kill" ? "crash" : (plan.cause ?? "uncovered") });
  }
  const acquired = await tryAcquire(opts.kv, opts.self, opts.deadlineMs, nowMs);
  if (!acquired) {
    return { action: "duplicate", applied: [], socketGap: false, feedGapMs: 0, cause: "duplicate", holder: lease?.holder ?? null };
  }
  await opts.holder.reload?.();
  if (opts.holder.confirmHandover) {
    const feedOk = await opts.holder.confirmHandover();
    for (const gap of staged) {
      if (gap.cause !== "handover" && gap.cause !== "uncovered") continue;
      gap.cause = handoverCause(Math.max(0, gap.endMs - gap.startMs), feedOk);
    }
  }
  flushStaged();
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
      opts.holder.recordGap?.({ startMs: savedAt, endMs: Math.max(savedAt, failedAt), cause: "crash" });
      try {
        await persistBook();
      } finally {
        await releaseLease(opts.kv, opts.self, "crash", failedAt);
      }
      throw error;
    }
  }
  if (sampled) {
    const at = opts.deadlineMs - HANDOVER_MARGIN_MS;
    const saved = await releaseFinal(at);
    return { action: "handover", applied, socketGap: false, feedGapMs, cause: saved ? (plan.cause ?? "handover") : "uncovered", holder: null };
  }
  await persistBook();
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

/** redis:// or rediss://. A password may travel with either. rediss:// is TLS. */
export function assertRedisTransport(url: string): RedisEndpoint {
  return redisEndpoint(url);
}

const OWNED_SET_LUA = [
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local ok, lease = pcall(cjson.decode, raw)",
  "if not ok or type(lease) ~= 'table' then return 0 end",
  "if lease['token'] ~= ARGV[1] or lease['release'] ~= 'none' then return 0 end",
  "if string.len(ARGV[2]) > 1048576 then return 0 end",
  "local px = tonumber(ARGV[3])",
  "if px > 0 then redis.call('SET', KEYS[2], ARGV[2], 'PX', px) else redis.call('SET', KEYS[2], ARGV[2]) end",
  "return 1",
].join("\n");

const OWNED_APPEND_LUA = [
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local ok, lease = pcall(cjson.decode, raw)",
  "if not ok or type(lease) ~= 'table' then return 0 end",
  "if lease['token'] ~= ARGV[1] or lease['release'] ~= 'none' then return 0 end",
  "local cur = redis.call('GET', KEYS[2])",
  "local arr = {}",
  "if cur and cur ~= '' then",
  "  local ok2, parsed = pcall(cjson.decode, cur)",
  "  if ok2 and type(parsed) == 'table' then arr = parsed end",
  "end",
  "local field = ARGV[4]",
  "local id = ARGV[3]",
  "for _, item in ipairs(arr) do",
  "  if type(item) == 'table' and tostring(item[field]) == id then return 2 end",
  "end",
  "local ok3, member = pcall(cjson.decode, ARGV[2])",
  "if not ok3 or type(member) ~= 'table' then return 0 end",
  "table.insert(arr, member)",
  "local maxn = tonumber(ARGV[5])",
  "while maxn > 0 and #arr > maxn do table.remove(arr, 1) end",
  "local encoded = cjson.encode(arr)",
  "if string.len(encoded) > 1048576 then return 3 end",
  "local px = tonumber(ARGV[6])",
  "if px > 0 then redis.call('SET', KEYS[2], encoded, 'PX', px) else redis.call('SET', KEYS[2], encoded) end",
  "return 1",
].join("\n");

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
 * Generic Redis over redis:// or rediss://. No Marketplace SDK.
 * One socket for the process. AUTH runs once per connection. A command timeout
 * drops that socket; the next command connects and authenticates again.
 * Brian's deployment sets REDIS_URL. Tests use memoryKv.
 */
export function redisKvFromUrl(url: string): Kv {
  const endpoint = assertRedisTransport(url);
  type Waiter = {
    resolve: (reply: string | null) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    done: boolean;
  };
  let socket: import("node:net").Socket | null = null;
  let buf = "";
  let authed = false;
  let opening: Promise<void> | null = null;
  const waiters: Waiter[] = [];

  const failAll = (error: Error) => {
    authed = false;
    const dead = socket;
    socket = null;
    opening = null;
    buf = "";
    if (dead) {
      dead.removeAllListeners();
      dead.destroy();
    }
    const pending = waiters.splice(0, waiters.length);
    for (const waiter of pending) {
      if (waiter.done) continue;
      waiter.done = true;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };

  const pump = () => {
    for (;;) {
      if (waiters.length === 0) return;
      const taken = takeReply(buf);
      if (!taken) return;
      buf = taken.rest;
      const waiter = waiters.shift();
      if (!waiter || waiter.done) continue;
      waiter.done = true;
      clearTimeout(waiter.timer);
      waiter.resolve(taken.reply);
      releaseIdle();
    }
  };

  const writeCommand = (parts: string[]): Promise<string | null> => {
    const current = socket;
    if (!current) return Promise.reject(new Error("redis closed"));
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve,
        reject,
        done: false,
        timer: setTimeout(() => {
          if (waiter.done) return;
          waiter.done = true;
          failAll(new Error("redis timeout"));
        }, endpoint.timeoutMs),
      };
      waiters.push(waiter);
      current.ref();
      current.write(encodeCommand(parts));
    });
  };

  const releaseIdle = () => {
    if (waiters.length === 0) socket?.unref();
  };

  const connect = async () => {
    const net = await import("node:net");
    const tlsMod = endpoint.tls ? await import("node:tls") : null;
    const sock = tlsMod
      ? tlsMod.connect({
          host: endpoint.host,
          port: endpoint.port,
          ...(net.isIP(endpoint.host) === 0 ? { servername: endpoint.host } : {}),
        })
      : net.connect({ host: endpoint.host, port: endpoint.port });
    socket = sock;
    sock.on("data", (chunk: Buffer) => {
      if (socket !== sock) return;
      buf += chunk.toString("utf8");
      try {
        pump();
      } catch (error) {
        failAll(error instanceof Error ? error : new Error(String(error)));
      }
    });
    sock.on("error", (error: Error) => {
      if (socket === sock) failAll(error);
    });
    sock.on("close", () => {
      if (socket === sock) failAll(new Error("redis closed"));
    });
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("error", (error: Error) => reject(error));
    });
    const auth =
      endpoint.username && endpoint.password
        ? ["AUTH", endpoint.username, endpoint.password]
        : endpoint.password
          ? ["AUTH", endpoint.password]
          : null;
    if (auth) {
      const reply = await writeCommand(auth);
      if (reply !== "OK") throw new Error("redis auth failed");
    }
    authed = true;
  };

  const ensure = async () => {
    if (socket && !socket.destroyed && authed) return;
    if (!opening) {
      opening = connect()
        .catch((error: unknown) => {
          failAll(error instanceof Error ? error : new Error(String(error)));
          throw error;
        })
        .finally(() => {
          opening = null;
        });
    }
    await opening;
  };

  const send = async (parts: string[]): Promise<string | null> => {
    await ensure();
    return writeCommand(parts);
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
    async ownedSet(leaseKey, token, key, value, opts) {
      const reply = await send(["EVAL", OWNED_SET_LUA, "2", leaseKey, key, token, value, String(opts?.px ?? 0)]);
      return reply === "1";
    },
    async ownedAppend(leaseKey, token, key, member, opts) {
      const reply = await send([
        "EVAL",
        OWNED_APPEND_LUA,
        "2",
        leaseKey,
        key,
        token,
        member,
        opts.id,
        opts.field,
        String(opts.max ?? 0),
        String(opts.px ?? 0),
      ]);
      const code = Number(reply);
      return code === 1 || code === 2 || code === 3 ? code : 0;
    },
  };
}

export { GAP_MAX_MS };
