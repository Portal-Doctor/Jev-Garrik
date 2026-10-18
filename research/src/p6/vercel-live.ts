/**
 * The cron route's adapter. The book still moves only through the host and the engine.
 * Redis is a Kv. This file does not choose a Marketplace vendor.
 */

import type { SourceDay } from "../p3/bar-access";
import { loadSplit, noteReadBytes, persistSplit, reloadSplit, warmReadyCount, warmupKey } from "./hot-store";
import { decodeStored } from "./redis-gzip";
import { acceptRestBar, applyRestCold, attachMemberCloses, attachRestLease, backfillTapeIfNeeded, catchUpHistory, coldResetEnabled, driveHost, installPaperState, markOrdersBeforeTape, releaseForDeadline, replayHandover, resyncBooksFromRest, retainFifteens, seedRetryList, stageColdReset, startPaperHost, warmSeriesFromRest, type PaperHost } from "./paper-host";
import { createRestRun, restLogLine } from "./rest-limit";
import type { OhlcvBar } from "./rest-bars";
import {
  commitBar,
  cronAuthorized,
  dashboard,
  decodeLease,
  HOT_KEY,
  LEASE_KEY,
  MAX_DURATION_MS,
  runInvocation,
  WARMUP_KEY,
  type Dashboard,
  type InvocationResult,
  type Kv,
} from "./relay";

/** Watcher lease poll. Slow until 5s before the announced release, then fast. */
export const LEASE_POLL_SLOW_MS = 15_000;
export const LEASE_POLL_FAST_MS = 200;
export const LEASE_POLL_FAST_BEFORE_MS = 5_000;

export function leasePollWaitMs(nowMs: number, releaseAtMs: number): number {
  return nowMs >= releaseAtMs - LEASE_POLL_FAST_BEFORE_MS ? LEASE_POLL_FAST_MS : LEASE_POLL_SLOW_MS;
}

/** One lease-checked flush. Bar markers ride in that same EVAL. */
export async function persistRun(kv: Kv, host: PaperHost): Promise<void> {
  const nowSec = Math.floor(host.clock() / 1000);
  const kept = retainFifteens(host.fifteen, nowSec);
  const keptIds = new Set(kept.map((bar) => `${bar.productId}:${bar.startSec}`));
  for (const bar of host.fifteen) {
    const id = `${bar.productId}:${bar.startSec}`;
    if (keptIds.has(id)) continue;
    if (host.persistedBars.has(`bar:${id}`)) continue;
    if (host.closingMarks.some((row) => row.productId === bar.productId && row.startSec === bar.startSec)) continue;
    host.closingMarks.push({ productId: bar.productId, startSec: bar.startSec });
  }
  host.fifteen = kept;
  await persistSplit(kv, host);
}

function rememberPersistedBars(host: PaperHost): void {
  for (const bar of host.fifteen) host.persistedBars.add(`${bar.productId}:${bar.startSec}`);
}

export function hostHolder(host: PaperHost, kv: Kv, bars: readonly OhlcvBar[] = [], self?: string): {
  warm(): Promise<void>;
  applyDueBars(): Promise<string[]>;
  releaseDeadline(cause?: string): void;
  appliedDuringRun(): string[];
  persist(): Promise<void>;
  recordGap(gap: { startMs: number; endMs: number; cause: string }): void;
  reload(): Promise<void>;
  resetCold(): Promise<void>;
  confirmHandover(): Promise<boolean>;
  sampleUntil(untilMs: number): Promise<void>;
  watchUntil(untilMs: number): Promise<void>;
} {
  host.kv = kv;
  return {
    async warm() {
      const saved = await loadSplit(kv, host);
      if (saved) installPaperState(host, saved);
      await loadWarmup(kv, host);
      rememberPersistedBars(host);
      attachMemberCloses(host);
    },
    async reload() {
      host.seedChecked = false;
      if (!host.stopped && self) {
        const lease = decodeLease(await kv.get(LEASE_KEY));
        if (lease?.token && lease.holder === self && lease.release === "none" && lease.untilMs > host.clock()) {
          host.leaseToken = lease.token;
          if (host.holderId == null) host.holderId = self;
          if (host.leaseFromMs == null) host.leaseFromMs = lease.acquiredAtMs ?? host.clock();
          host.leaseUntilMs = lease.untilMs;
        }
      }
      try {
        const saved = await reloadSplit(kv, host);
        if (!saved) return;
        installPaperState(host, saved);
        rememberPersistedBars(host);
        attachMemberCloses(host);
      } finally {
        // One reload after the lease. The raw strings exist so that reload can reuse unchanged keys.
        host.redisRaw = null;
        host.redisRings = null;
      }
    },
    async resetCold() {
      if (!coldResetEnabled(process.env) || host.stopped) return;
      const lease = decodeLease(await kv.get(LEASE_KEY));
      const priorMarks = new Map(host.seedMarks);
      const priorCold = new Set(host.cold);
      const priorRest = new Map(host.restRun.cold);
      const priorCursor = {
        order: host.seedCursor.order.slice(),
        idx: host.seedCursor.idx,
        runId: host.seedCursor.runId,
        retry: seedRetryList(host.seedCursor),
        ...(host.seedCursor.coldReset === true ? { coldReset: true as const } : {}),
      };
      const priorDrops = host.seedDropKeys.slice();
      const ids = stageColdReset(host, true, self, lease);
      if (ids == null) return;
      try {
        await persistRun(kv, host);
      } catch (error) {
        host.seedMarks = priorMarks;
        host.cold = priorCold;
        host.restRun.cold = priorRest;
        host.seedCursor = priorCursor;
        host.seedDropKeys = priorDrops;
        const message = error instanceof Error ? error.message : "";
        if (message.includes("lease lost")) {
          host.stopped = true;
          return;
        }
        throw error;
      }
      console.log(`p6 cold reset ${ids.length}${ids.length > 0 ? `: ${ids.join(" ")}` : ""}`);
    },
    async applyDueBars() {
      const applied: string[] = [];
      for (const bar of bars) {
        const before = host.fifteen.length;
        const status = host.fifteen.some((row) => row.productId === bar.productId && row.startSec === bar.startSec) ? "already" : "new";
        if (status === "new") acceptRestBar(host, bar);
        if (host.fifteen.length === before && status === "new") continue;
        const result = await commitBar(kv, bar.productId, bar.startSec);
        if (result === "applied") {
          host.persistedBars.add(`${bar.productId}:${bar.startSec}`);
          applied.push(`${bar.productId}:${bar.startSec}`);
        }
      }
      return applied;
    },
    releaseDeadline(cause?: string) {
      if (cause) host.runOutcome = cause;
      releaseForDeadline(host);
    },
    appliedDuringRun() {
      return [...host.runApplied];
    },
    persist() {
      return persistRun(kv, host);
    },
    recordGap(gap) {
      if (gap.cause === "crash" || gap.cause === "kill") {
        host.tapeHole = true;
        const from = Math.floor(gap.startMs / 1000);
        host.tapeHoleFromSec = host.tapeHoleFromSec == null ? from : Math.min(host.tapeHoleFromSec, from);
      }
      if (gap.cause === "save failed") {
        host.gaps.push({ ...gap, cause: "uncovered" });
        host.book.incidents.push("save failed");
        for (const order of host.book.working) {
          if (order.status !== "working") continue;
          order.status = "indeterminate";
          host.book.indeterminateByClass[order.classId] += 1;
        }
        return;
      }
      host.gaps.push(gap);
    },
    async confirmHandover() {
      // A failed renew sets stopped. Never take the token that replaced us.
      if (!host.stopped) {
        const lease = decodeLease(await kv.get(LEASE_KEY));
        if (lease?.token && self != null && lease.holder === self) {
          host.leaseToken = lease.token;
          if (host.holderId == null) host.holderId = self;
          if (host.leaseFromMs == null) host.leaseFromMs = lease.acquiredAtMs ?? host.clock();
          host.leaseUntilMs = lease.untilMs;
        }
      }
      if (host.stopped || !host.leaseToken) return false;
      const ok = replayHandover(host);
      if (!ok) await resyncBooksFromRest(host);
      return ok;
    },
    async sampleUntil(untilMs: number) {
      if (!host.stopped) {
        const lease = decodeLease(await kv.get(LEASE_KEY));
        if (lease?.token && self != null && lease.holder === self) {
          host.leaseToken = lease.token;
          if (host.holderId == null) host.holderId = self;
          if (host.leaseFromMs == null) host.leaseFromMs = lease.acquiredAtMs ?? host.clock();
          host.leaseUntilMs = lease.untilMs;
        }
      }
      host.runBaseFills = host.book.legs.length;
      host.runBaseDecisions = host.emitted.size;
      if (host.leaseToken && host.restWarm) {
        await warmSeriesFromRest(host);
        await catchUpHistory(host);
        attachMemberCloses(host);
      }
      if (!host.kv || host.leaseToken) await backfillTapeIfNeeded(host);
      try {
        await driveHost(host, untilMs, {
          persist: () => persistRun(kv, host),
          heartbeat: async () => {
            try {
              await persistRun(kv, host);
            } catch (error: unknown) {
              const message = error instanceof Error ? error.message : "failed";
              host.book.incidents.push(message.startsWith("kv set") || message.includes("lease lost") ? message : `kv set ${message}`);
              if (message.includes("lease lost")) host.stopped = true;
            }
          },
        });
      } finally {
        const cold = [...host.seedMarks.entries()].filter(([, mark]) => mark.status === "cold").map(([id, mark]) => ({ id, reason: mark.reason }));
        const warm = warmReadyCount(host);
        console.log(redisLogLine(host));
        console.log(restLogLine(host.restRun, { warm, total: host.products.length, seedIdx: host.seedCursor.idx, cold }));
      }
    },
    watchUntil(untilMs: number) {
      host.bufferFeeds = true;
      let nextPoll = 0;
      return driveHost(host, untilMs, {
        applyBars: false,
        stopWhen: async () => {
          const now = host.clock();
          if (now < nextPoll) return false;
          const lease = decodeLease(await kv.get(LEASE_KEY));
          const releaseAt = lease?.releaseAtMs ?? now;
          nextPoll = now + leasePollWaitMs(now, releaseAt);
          return !lease || lease.released === true || lease.untilMs <= now;
        },
      });
    },
  };
}

/** Save counters and the bytes this invocation read back from Redis. */
export function redisLogLine(host: PaperHost): string {
  return `redis cmds=${host.saveCommands}, bytes=${host.saveBytes}, readBytes=${host.readBytes}, duplicates=${host.duplicateAppends}, seqInvalid=${host.seqInvalid}, seqOverflow=${host.seqOverflow}`;
}

async function loadWarmup(kv: Kv, host: PaperHost): Promise<void> {
  const missing = [...new Set([...host.products, "BTC-USD"])].filter((id) => (host.warmup.get(id)?.length ?? 0) === 0);
  if (missing.length === 0) return;
  const values = await kv.mget(missing.map((id) => warmupKey(id)));
  for (const raw of values) noteReadBytes(host, raw);
  missing.forEach((id, index) => {
    const raw = values[index];
    if (!raw) return;
    const days = JSON.parse(raw) as SourceDay[];
    if (days.length > 0) host.warmup.set(id, days);
  });
  const still = missing.filter((id) => (host.warmup.get(id)?.length ?? 0) === 0);
  if (still.length > 0) {
    const legacy = await kv.get(WARMUP_KEY);
    noteReadBytes(host, legacy);
    if (legacy) {
      const rows = JSON.parse(legacy) as [string, SourceDay[]][];
      for (const [id, days] of rows) {
        if (!still.includes(id) || days.length === 0) continue;
        if ((host.warmup.get(id)?.length ?? 0) === 0) host.warmup.set(id, days);
      }
    }
  }
  if (missing.every((id) => (host.warmup.get(id)?.length ?? 0) > 0)) host.warmupStored = true;
}

export async function loadDashboard(kv: Kv): Promise<Dashboard> {
  const raw = decodeStored(HOT_KEY, await kv.get(HOT_KEY));
  const lease = decodeLease(await kv.get(LEASE_KEY));
  const body = raw
    ? (JSON.parse(raw) as {
        positions?: Dashboard["positions"];
        incidents?: string[];
        jevSkipped?: number;
        jevPackets?: number;
        killSwitch?: boolean;
        gaps?: { startMs: number; endMs: number; cause?: string }[];
        volHours?: { rv: number; gappedMs: number; hourMs: number }[];
        dIndeterminate?: number;
        dSubmitted?: number;
        jevSkip?: { jevDays?: { dayMs: number; onTime: number; catchUp: number }[] };
      })
    : null;
  const nowMs = Date.now();
  return dashboard({
    positions: body?.positions ?? [],
    gates: body?.killSwitch ? ["kill-switch"] : [],
    leaseHolder: lease && lease.untilMs > nowMs ? lease.holder : null,
    incidents: body?.incidents ?? [],
    weekMs: 7 * 24 * 60 * 60 * 1000,
    gaps: body?.gaps ?? [],
    hours: body?.volHours ?? [],
    jevSkipped: body?.jevSkipped ?? 0,
    jevPackets: body?.jevPackets ?? 0,
    dIndeterminate: body?.dIndeterminate ?? 0,
    dSubmitted: body?.dSubmitted ?? 0,
    catchUpDays: body?.jevSkip?.jevDays ?? [],
    nowMs,
  });
}

export async function handleEngineRequest(
  request: Request,
  env: Record<string, string | undefined>,
  deps?: {
    kv: Kv;
    jevCaller?: PaperHost["jevCaller"];
    nowMs?: number;
    deadlineMs?: number;
    self?: string;
    holder?: {
      warm(): Promise<void>;
      applyDueBars(): Promise<string[]>;
      releaseDeadline(cause?: string): void;
      appliedDuringRun?(): string[];
      sampleUntil?(untilMs: number): Promise<void>;
      watchUntil?(untilMs: number): Promise<void>;
      persist?(): Promise<void>;
      recordGap?(gap: { startMs: number; endMs: number; cause: string }): void;
      reload?(): Promise<void>;
    };
  },
): Promise<Response> {
  if (!cronAuthorized(request.headers.get("authorization"), env.CRON_SECRET)) {
    return new Response("unauthorized", { status: 401 });
  }
  const url = new URL(request.url);
  const kv = deps?.kv;
  if (!kv) return new Response("REDIS_URL is required", { status: 503 });
  if (request.method === "GET" && url.searchParams.get("read") === "1") {
    return Response.json(await loadDashboard(kv));
  }
  if (request.method !== "GET" && request.method !== "POST") return new Response("method", { status: 405 });
  const nowMs = deps?.nowMs ?? Date.now();
  const deadlineMs = deps?.deadlineMs ?? nowMs + MAX_DURATION_MS;
  const self = deps?.self ?? `cron-${nowMs}`;
  const host = deps?.holder ? null : startPaperHost((env.P6_PRODUCTS ?? "BTC-USD").split(",").filter(Boolean), env);
  if (host) {
    host.restWarm = true;
    host.runStartedMs = nowMs;
    host.deadlineMs = deadlineMs;
    host.runOutcome = "running";
    host.restRun = createRestRun(deadlineMs, {}, (id, reason) => {
      applyRestCold(host, id, reason);
    });
    attachRestLease(host);
    if (deps?.jevCaller) host.jevCaller = deps.jevCaller;
  }
  const holder = deps?.holder ?? hostHolder(host!, kv, [], self);
  const result: InvocationResult = await runInvocation({
    kv,
    self,
    nowMs,
    deadlineMs,
    holder,
    ...(deps?.nowMs == null ? { clock: () => Date.now() } : {}),
  });
  return Response.json({ ...result, readOnly: false, writes: "cron-only" });
}
