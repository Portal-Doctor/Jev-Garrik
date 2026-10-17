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
  /** One EVAL: check the lease token, renew it, then write the flush. 1 applied, 0 lost, 3 over 1 MB (nothing written). */
  ownedFlush(leaseKey: string, token: string, nowMs: number, payload: string): Promise<number>;
  /** One command for many string keys. */
  mget(keys: string[]): Promise<(string | null)[]>;
  /** One command. Each entry is the JSON text of one list element, oldest first. */
  readLists(keys: string[]): Promise<string[][]>;
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
  const kv: Kv = {
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
    async ownedFlush(leaseKey, token, nowMs, payload) {
      if (Buffer.byteLength(payload) <= VALUE_MAX_BYTES) {
        const hot = (JSON.parse(payload) as { hot?: string }).hot ?? "";
        if (hot !== "" && Buffer.byteLength(hot) <= VALUE_MAX_BYTES) await kv.ownedSet(leaseKey, token, HOT_KEY, hot);
      }
      return applyMemoryFlush(rows, clock, leaseKey, token, nowMs, payload);
    },
    async mget(keys) {
      return Promise.all(keys.map(async (key) => live(key)?.value ?? null));
    },
    async readLists(keys) {
      return keys.map((key) => listItems(live(key)?.value ?? null));
    },
  };
  return kv;
}

function listItems(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row) => (typeof row === "string" ? row : JSON.stringify(row)));
  } catch {
    return [];
  }
}

/** Memory stand-in for FLUSH_LUA. A bad token or a value over 1 MB writes nothing. */
export function applyMemoryFlush(
  rows: Map<string, { value: string; expiresAt: number | null }>,
  clock: () => number,
  leaseKey: string,
  token: string,
  nowMs: number,
  payload: string,
): number {
  const current = rows.get(leaseKey);
  if (!current || (current.expiresAt != null && current.expiresAt <= clock())) return 0;
  const lease = decodeLease(current.value);
  if (!lease || lease.token !== token || lease.release !== "none") return 0;
  if (Buffer.byteLength(payload) > VALUE_MAX_BYTES) return 3;
  const body = JSON.parse(payload) as FlushBody;
  const values = [
    body.hot ?? "",
    ...(body.tapes ?? []).map((row) => row.value),
    ...(body.rings ?? []).map((row) => row.value),
    ...(body.bars ?? []).map((row) => row.value),
    ...(body.marks ?? []).map((row) => row.value),
    ...(body.warm ?? []).map((row) => row.value),
    ...(body.extra ?? []).map((row) => row.value),
  ];
  if (values.some((value) => Buffer.byteLength(value) > VALUE_MAX_BYTES)) return 3;
  const staged = new Map<string, { value: string; px: number }>();
  const currentRaw = (key: string): string | null => staged.get(key)?.value ?? rows.get(key)?.value ?? null;
  for (const bar of body.bars ?? []) {
    const list = listItems(currentRaw(bar.key)).map((row) => JSON.parse(row) as Record<string, unknown>);
    if (!list.some((row) => String(row[bar.field]) === bar.id)) list.push(JSON.parse(bar.value) as Record<string, unknown>);
    const max = bar.max ?? 0;
    const trimmed = max > 0 && list.length > max ? list.slice(list.length - max) : list;
    const encoded = JSON.stringify(trimmed);
    if (Buffer.byteLength(encoded) > VALUE_MAX_BYTES) return 3;
    staged.set(bar.key, { value: encoded, px: bar.px ?? 0 });
  }
  for (const ring of body.rings ?? []) {
    const list = listItems(currentRaw(ring.key)).map((row) => JSON.parse(row) as Record<string, unknown>);
    if (!list.some((row) => String(row.ts) === ring.id)) list.push(JSON.parse(ring.value) as Record<string, unknown>);
    const trimmed = list.length > 120 ? list.slice(list.length - 120) : list;
    const encoded = JSON.stringify(trimmed);
    if (Buffer.byteLength(encoded) > VALUE_MAX_BYTES) return 3;
    staged.set(ring.key, { value: encoded, px: ring.px ?? 0 });
  }
  const ttl = Math.min(LEASE_TTL_MS, Math.max(1, lease.untilMs - nowMs));
  const next = encodeLease({ ...lease, savedAtMs: nowMs });
  const exp = clock() + ttl;
  rows.set(leaseKey, { value: next, expiresAt: exp });
  rows.set(LEASE_META_KEY, { value: next, expiresAt: null });
  if (body.hot) rows.set(HOT_KEY, { value: body.hot, expiresAt: null });
  for (const tape of body.tapes ?? []) rows.set(tape.key, { value: tape.value, expiresAt: clock() + tape.px });
  for (const [key, row] of staged) rows.set(key, { value: row.value, expiresAt: row.px > 0 ? clock() + row.px : null });
  for (const mark of body.marks ?? []) {
    if (!rows.get(mark.key)) rows.set(mark.key, { value: mark.value, expiresAt: null });
  }
  for (const warm of body.warm ?? []) {
    if (!rows.get(warm.key)) rows.set(warm.key, { value: warm.value, expiresAt: null });
  }
  for (const key of body.drop ?? []) {
    if (key.startsWith("p6:seed:wm:")) rows.delete(key);
  }
  for (const row of body.extra ?? []) {
    if (row.nx && rows.get(row.key)) continue;
    rows.set(row.key, { value: row.value, expiresAt: row.px != null && row.px > 0 ? clock() + row.px : null });
  }
  return 1;
}

interface FlushBody {
  hot?: string;
  tapes?: { key: string; value: string; px: number }[];
  rings?: { key: string; value: string; id: string; px: number }[];
  bars?: { key: string; value: string; id: string; field: string; max: number; px: number }[];
  marks?: { key: string; value: string }[];
  warm?: { key: string; value: string }[];
  extra?: { key: string; value: string; px?: number; nx?: boolean }[];
  drop?: string[];
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
  /** Wall clock when this holder first took the lease. Renewals do not move it. */
  acquiredAtMs?: number;
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
    ...(body.acquiredAtMs != null ? { acquiredAtMs: body.acquiredAtMs } : {}),
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

/**
 * Writes p6:hot from a snapshot. A restore (T5/T11) must not put a `seq` or any `keySeq`
 * value on this body that is lower than a sequence already published. This function does
 * not assign a sequence. The flush uses max(loaded + 1, clock seconds).
 */
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

/**
 * Redis, or any Kv, behind the same snapshot the file store writes. The vendor client is not imported.
 * A restore (T5/T11) must not store a `seq` or any `keySeq` value lower than a sequence already
 * published on p6:hot. This writer does not assign one. The flush stamps max(loaded + 1, clock seconds).
 */
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
  const acquiredAtMs = same && current!.acquiredAtMs != null ? current!.acquiredAtMs : nowMs;
  const next = encodeLease({ holder: self, untilMs, release: "none", token, savedAtMs, releaseAtMs: untilMs - HANDOVER_MARGIN_MS, acquiredAtMs });
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
  action: RelayPlan["action"] | "crash";
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
    releaseDeadline(cause?: string): void;
    /** Bars accepted while sampling. Merged into the response after the run. */
    appliedDuringRun?(): string[];
    sampleUntil?(untilMs: number): Promise<void>;
    /** Subscribe before this instance owns the lease. A normal handover then has no feed gap. */
    watchUntil?(untilMs: number): Promise<void>;
    persist?(): Promise<void>;
    recordGap?(gap: { startMs: number; endMs: number; cause: string }): void;
    /** Load p6:state after this instance owns the lease, before it records or saves. */
    reload?(): Promise<void>;
    /** One-shot cold reset. Runs only after this invocation holds the lease. */
    resetCold?(): Promise<void>;
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
  const releaseFinal = async (at: number, tookCrash = false) => {
    opts.holder.releaseDeadline(tookCrash ? "crash" : undefined);
    const saved = await persistFinal();
    opts.holder.recordGap?.({ startMs: at, endMs: at, cause: saved ? "handover" : "save failed" });
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
  await opts.holder.resetCold?.();
  if (opts.holder.confirmHandover) {
    const feedOk = await opts.holder.confirmHandover();
    for (const gap of staged) {
      if (gap.cause !== "handover" && gap.cause !== "uncovered") continue;
      gap.cause = handoverCause(Math.max(0, gap.endMs - gap.startMs), feedOk);
    }
  }
  const tookCrash = staged.some((gap) => gap.cause === "crash");
  flushStaged();
  const seeded = await opts.holder.applyDueBars();
  const appliedOf = () => [...new Set([...seeded, ...(opts.holder.appliedDuringRun?.() ?? [])])];
  let sampled = false;
  if (opts.holder.sampleUntil && nowMs < opts.deadlineMs - HANDOVER_MARGIN_MS) {
    try {
      await opts.holder.sampleUntil(opts.deadlineMs - HANDOVER_MARGIN_MS);
      sampled = true;
    } catch (error) {
      opts.holder.releaseDeadline("crash");
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
    const saved = await releaseFinal(at, tookCrash);
    return {
      action: tookCrash ? "crash" : "handover",
      applied: appliedOf(),
      socketGap: false,
      feedGapMs,
      cause: tookCrash ? "crash" : saved ? (plan.cause ?? "handover") : "uncovered",
      holder: null,
    };
  }
  await persistBook();
  await noteLeaseSave(opts.kv, nowMs);
  return { action: "hold", applied: appliedOf(), socketGap: plan.socketGap, feedGapMs, cause: plan.cause, holder: opts.self };
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
  catchUpDays?: Parameters<typeof gapWeekReport>[0]["catchUpDays"];
  nowMs?: number;
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

/** A small subset of RESP: bulk strings, simple strings, integers, arrays, and nil. */
export type RedisReply = string | null | RedisReply[];

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
export function takeReply(buf: string): { reply: RedisReply; rest: string } | null {
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
    const items: RedisReply[] = [];
    for (let i = 0; i < count; i += 1) {
      const part = takeReply(rest);
      if (!part) return null;
      items.push(part.reply);
      rest = part.rest;
    }
    return { reply: items, rest };
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

const FLUSH_LUA = [
  "local raw = redis.call('GET', KEYS[1])",
  "if not raw then return 0 end",
  "local ok, lease = pcall(cjson.decode, raw)",
  "if not ok or type(lease) ~= 'table' then return 0 end",
  "if lease['token'] ~= ARGV[1] or lease['release'] ~= 'none' then return 0 end",
  "if string.len(ARGV[2]) > 1048576 then return 3 end",
  "local okb, body = pcall(cjson.decode, ARGV[2])",
  "if not okb or type(body) ~= 'table' then return 3 end",
  "local function big(s) return type(s) == 'string' and string.len(s) > 1048576 end",
  "if big(body['hot']) then return 3 end",
  "local function scan(list, field) ",
  "  if type(list) ~= 'table' then return false end",
  "  for _, row in ipairs(list) do",
  "    if type(row) == 'table' and big(row[field or 'value']) then return true end",
  "  end",
  "  return false",
  "end",
  "if scan(body['tapes']) or scan(body['rings']) or scan(body['bars']) or scan(body['marks']) or scan(body['warm']) or scan(body['extra']) then return 3 end",
  "local pending = {}",
  "local function remember(key, encoded, px)",
  "  if string.len(encoded) > 1048576 then return false end",
  "  pending[key] = {encoded, px or 0}",
  "  return true",
  "end",
  "local function current_raw(key)",
  "  if pending[key] then return pending[key][1] end",
  "  local cur = redis.call('GET', key)",
  "  if type(cur) == 'string' then return cur end",
  "  return nil",
  "end",
  "if type(body['bars']) == 'table' then",
  "  for _, bar in ipairs(body['bars']) do",
  "    local cur = current_raw(bar['key'])",
  "    local arr = {}",
  "    if type(cur) == 'string' and cur ~= '' then",
  "      local oka, parsed = pcall(cjson.decode, cur)",
  "      if oka and type(parsed) == 'table' then arr = parsed end",
  "    end",
  "    local found = false",
  "    for _, item in ipairs(arr) do",
  "      if type(item) == 'table' and tostring(item[bar['field']]) == tostring(bar['id']) then found = true; break end",
  "    end",
  "    if not found then",
  "      local okm, member = pcall(cjson.decode, bar['value'])",
  "      if okm and type(member) == 'table' then table.insert(arr, member) end",
  "    end",
  "    local maxn = tonumber(bar['max']) or 0",
  "    while maxn > 0 and #arr > maxn do table.remove(arr, 1) end",
  "    if not remember(bar['key'], cjson.encode(arr), tonumber(bar['px']) or 0) then return 3 end",
  "  end",
  "end",
  "local now = tonumber(ARGV[3])",
  "local ttl = tonumber(lease['untilMs']) - now",
  "if ttl < 1 then ttl = 1 end",
  "if ttl > 180000 then ttl = 180000 end",
  "lease['savedAtMs'] = now",
  "local encodedLease = cjson.encode(lease)",
  "redis.call('SET', KEYS[1], encodedLease, 'PX', ttl)",
  "redis.call('SET', 'p6:lease-meta', encodedLease)",
  "if type(body['hot']) == 'string' and body['hot'] ~= '' then redis.call('SET', 'p6:hot', body['hot']) end",
  "if type(body['tapes']) == 'table' then",
  "  for _, tape in ipairs(body['tapes']) do",
  "    redis.call('SET', tape['key'], tape['value'], 'PX', tonumber(tape['px']) or 7200000)",
  "  end",
  "end",
  "if type(body['rings']) == 'table' then",
  "  for _, ring in ipairs(body['rings']) do",
  "    local typ = redis.call('TYPE', ring['key'])",
  "    local kind = type(typ) == 'table' and typ['ok'] or typ",
  "    if kind ~= 'list' and kind ~= 'none' then redis.call('DEL', ring['key']) end",
  "    local rows = redis.call('LRANGE', ring['key'], 0, -1)",
  "    local seen = false",
  "    for _, row in ipairs(rows) do",
  "      local okr, item = pcall(cjson.decode, row)",
  "      if okr and type(item) == 'table' and tostring(item['ts']) == tostring(ring['id']) then seen = true; break end",
  "    end",
  "    if not seen then redis.call('RPUSH', ring['key'], ring['value']) end",
  "    redis.call('LTRIM', ring['key'], -120, -1)",
  "    redis.call('PEXPIRE', ring['key'], tonumber(ring['px']) or 7200000)",
  "  end",
  "end",
  "for key, row in pairs(pending) do",
  "  local px = tonumber(row[2]) or 0",
  "  if px > 0 then redis.call('SET', key, row[1], 'PX', px) else redis.call('SET', key, row[1]) end",
  "end",
  "if type(body['marks']) == 'table' then",
  "  for _, mark in ipairs(body['marks']) do",
  "    redis.call('SET', mark['key'], mark['value'], 'NX')",
  "  end",
  "end",
  "if type(body['warm']) == 'table' then",
  "  for _, warm in ipairs(body['warm']) do",
  "    if redis.call('EXISTS', warm['key']) == 0 then redis.call('SET', warm['key'], warm['value']) end",
  "  end",
  "end",
  "if type(body['drop']) == 'table' then",
  "  for _, key in ipairs(body['drop']) do",
  "    if type(key) == 'string' and string.sub(key, 1, 11) == 'p6:seed:wm:' then redis.call('DEL', key) end",
  "  end",
  "end",
  "if type(body['extra']) == 'table' then",
  "  for _, row in ipairs(body['extra']) do",
  "    local px = tonumber(row['px']) or 0",
  "    if row['nx'] and redis.call('EXISTS', row['key']) == 1 then",
  "    elseif px > 0 then redis.call('SET', row['key'], row['value'], 'PX', px)",
  "    else redis.call('SET', row['key'], row['value']) end",
  "  end",
  "end",
  "return 1",
].join("\n");

const READ_LISTS_LUA = [
  "local out = {}",
  "for i = 1, #KEYS do",
  "  local typ = redis.call('TYPE', KEYS[i])",
  "  local kind = type(typ) == 'table' and typ['ok'] or typ",
  "  if kind == 'list' then",
  "    out[i] = cjson.encode(redis.call('LRANGE', KEYS[i], 0, -1))",
  "  else",
  "    local raw = redis.call('GET', KEYS[i])",
  "    out[i] = raw or '[]'",
  "  end",
  "end",
  "return out",
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
    resolve: (reply: RedisReply) => void;
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

  const writeCommand = (parts: string[]): Promise<RedisReply> => {
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

  const send = async (parts: string[]): Promise<RedisReply> => {
    await ensure();
    return writeCommand(parts);
  };
  const asString = (reply: RedisReply): string | null => (typeof reply === "string" ? reply : null);
  return {
    async get(key) {
      return asString(await send(["GET", key]));
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
    async ownedFlush(leaseKey, token, nowMs, payload) {
      const reply = await send(["EVAL", FLUSH_LUA, "1", leaseKey, token, payload, String(nowMs)]);
      const code = Number(reply);
      return code === 1 || code === 3 ? code : 0;
    },
    async mget(keys) {
      if (keys.length === 0) return [];
      const reply = await send(["MGET", ...keys]);
      if (!Array.isArray(reply)) return keys.map(() => null);
      return reply.map((item) => (typeof item === "string" ? item : null));
    },
    async readLists(keys) {
      if (keys.length === 0) return [];
      const reply = await send(["EVAL", READ_LISTS_LUA, String(keys.length), ...keys]);
      if (!Array.isArray(reply)) return keys.map(() => []);
      return reply.map((item) => {
        if (typeof item !== "string") return [];
        try {
          const parsed = JSON.parse(item) as unknown;
          if (!Array.isArray(parsed)) return [];
          return parsed.map((row) => (typeof row === "string" ? row : JSON.stringify(row)));
        } catch {
          return [];
        }
      });
    },
  };
}

export { GAP_MAX_MS };
