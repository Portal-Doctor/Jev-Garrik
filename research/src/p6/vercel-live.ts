/**
 * The cron route's adapter. The book still moves only through the host and the engine.
 * Redis is a Kv. This file does not choose a Marketplace vendor.
 */

import { loadSplit, persistSplit } from "./hot-store";
import { acceptRestBar, attachMemberCloses, catchUpHistory, driveHost, installPaperState, releaseForDeadline, replayHandover, resyncBooksFromRest, retainFifteens, startPaperHost, warmSeriesFromRest, type PaperHost } from "./paper-host";
import type { OhlcvBar } from "./rest-bars";
import {
  commitBar,
  cronAuthorized,
  dashboard,
  decodeLease,
  HOT_KEY,
  LEASE_KEY,
  MAX_DURATION_MS,
  renewLease,
  runInvocation,
  WARMUP_KEY,
  type Dashboard,
  type InvocationResult,
  type Kv,
} from "./relay";

/** Lease-checked hot write plus appends. The warmup key is not read on this path. */
export async function persistRun(kv: Kv, host: PaperHost): Promise<void> {
  const pending = host.fifteen.slice();
  host.fifteen = retainFifteens(host.fifteen, Math.floor(host.clock() / 1000));
  await persistSplit(kv, host);
  const seen = new Set<string>();
  for (const bar of pending) {
    const key = `${bar.productId}:${bar.startSec}`;
    if (seen.has(key) || host.persistedBars.has(`bar:${key}`)) continue;
    seen.add(key);
    const result = await commitBar(kv, bar.productId, bar.startSec);
    if (result === "applied" || result === "duplicate") host.persistedBars.add(`bar:${key}`);
  }
}

function rememberPersistedBars(host: PaperHost): void {
  for (const bar of host.fifteen) host.persistedBars.add(`${bar.productId}:${bar.startSec}`);
}

export function hostHolder(host: PaperHost, kv: Kv, bars: readonly OhlcvBar[] = []): {
  warm(): Promise<void>;
  applyDueBars(): Promise<string[]>;
  releaseDeadline(): void;
  persist(): Promise<void>;
  recordGap(gap: { startMs: number; endMs: number; cause: string }): void;
  reload(): Promise<void>;
  confirmHandover(): Promise<boolean>;
  sampleUntil(untilMs: number): Promise<void>;
  watchUntil(untilMs: number): Promise<void>;
} {
  return {
    async warm() {
      const saved = await loadSplit(kv, host);
      if (saved) installPaperState(host, saved);
      if (!host.warmupStored && [...host.products].some((id) => (host.warmup.get(id)?.length ?? 0) === 0)) {
        const warm = await kv.get(WARMUP_KEY);
        if (warm) {
          const rows = JSON.parse(warm) as [string, NonNullable<NonNullable<typeof saved>["warmup"]>[number][1]][];
          for (const [id, days] of rows) {
            if ((host.warmup.get(id)?.length ?? 0) === 0 && days.length > 0) host.warmup.set(id, days);
          }
          host.warmupStored = true;
        }
      }
      rememberPersistedBars(host);
      if (host.restWarm && (host.warmup.size === 0 || [...host.products].some((id) => (host.hourWarm.get(id)?.length ?? 0) === 0 || (host.fourBars.get(id)?.length ?? 0) < 200))) {
        await warmSeriesFromRest(host);
      }
      if (!saved || host.restWarm) await catchUpHistory(host);
      attachMemberCloses(host);
    },
    async reload() {
      const saved = await loadSplit(kv, host);
      if (!saved) return;
      installPaperState(host, saved);
      rememberPersistedBars(host);
      attachMemberCloses(host);
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
    releaseDeadline() {
      releaseForDeadline(host);
    },
    persist() {
      return persistRun(kv, host);
    },
    recordGap(gap) {
      host.gaps.push(gap);
    },
    async confirmHandover() {
      const ok = replayHandover(host);
      if (!ok) await resyncBooksFromRest(host);
      return ok;
    },
    async sampleUntil(untilMs: number) {
      const lease = decodeLease(await kv.get(LEASE_KEY));
      if (lease?.token) host.leaseToken = lease.token;
      return driveHost(host, untilMs, {
        persist: () => persistRun(kv, host),
        onBar: async (bar) => {
          const result = await commitBar(kv, bar.productId, bar.startSec);
          if (result === "applied" || result === "duplicate") host.persistedBars.add(`bar:${bar.productId}:${bar.startSec}`);
        },
        heartbeat: async () => {
          if (host.leaseToken) {
            const renewed = await renewLease(kv, host.clock());
            if (!renewed) {
              host.stopped = true;
              host.book.incidents.push("lease lost");
              return;
            }
          }
          try {
            await persistRun(kv, host);
          } catch (error) {
            const message = error instanceof Error ? error.message : "failed";
            host.book.incidents.push(message.startsWith("kv set") || message.includes("lease lost") ? message : `kv set ${message}`);
            if (message.includes("lease lost")) host.stopped = true;
          }
        },
      });
    },
    watchUntil(untilMs: number) {
      host.bufferFeeds = true;
      return driveHost(host, untilMs, {
        applyBars: false,
        stopWhen: async () => {
          const lease = decodeLease(await kv.get(LEASE_KEY));
          return !lease || lease.untilMs <= host.clock();
        },
      });
    },
  };
}

export async function loadDashboard(kv: Kv): Promise<Dashboard> {
  const raw = await kv.get(HOT_KEY);
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
      })
    : null;
  return dashboard({
    positions: body?.positions ?? [],
    gates: body?.killSwitch ? ["kill-switch"] : [],
    leaseHolder: lease && lease.untilMs > Date.now() ? lease.holder : null,
    incidents: body?.incidents ?? [],
    weekMs: 7 * 24 * 60 * 60 * 1000,
    gaps: body?.gaps ?? [],
    hours: body?.volHours ?? [],
    jevSkipped: body?.jevSkipped ?? 0,
    jevPackets: body?.jevPackets ?? 0,
    dIndeterminate: body?.dIndeterminate ?? 0,
    dSubmitted: body?.dSubmitted ?? 0,
  });
}

export async function handleEngineRequest(
  request: Request,
  env: Record<string, string | undefined>,
  deps?: {
    kv: Kv;
    nowMs?: number;
    deadlineMs?: number;
    self?: string;
    holder?: {
      warm(): Promise<void>;
      applyDueBars(): Promise<string[]>;
      releaseDeadline(): void;
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
  if (host) host.restWarm = true;
  const holder = deps?.holder ?? hostHolder(host!, kv);
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
