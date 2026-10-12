/**
 * The cron route's adapter. The book still moves only through the host and the engine.
 * Redis is a Kv. This file does not choose a Marketplace vendor.
 */

import { acceptRestBar, capturePaperState, catchUpHistory, driveHost, installPaperState, releaseForDeadline, startPaperHost, warmSeriesFromRest, type PaperHost } from "./paper-host";
import type { OhlcvBar } from "./rest-bars";
import {
  commitBar,
  cronAuthorized,
  dashboard,
  decodeLease,
  kvPaperStore,
  LEASE_KEY,
  MAX_DURATION_MS,
  runInvocation,
  STATE_KEY,
  type Dashboard,
  type InvocationResult,
  type Kv,
} from "./relay";

/** State, member closes, gaps, vol hours, and D counts. New 15m bars also get an idempotent bar key. */
export async function persistRun(kv: Kv, host: PaperHost): Promise<void> {
  const body = capturePaperState(host);
  await kvPaperStore(kv).save(body);
  const seen = new Set<string>();
  for (const bar of host.fifteen) {
    const key = `${bar.productId}:${bar.startSec}`;
    if (seen.has(key) || host.persistedBars.has(key)) continue;
    seen.add(key);
    const result = await commitBar(kv, bar.productId, bar.startSec, body);
    if (result === "applied" || result === "duplicate") host.persistedBars.add(key);
  }
}

export function hostHolder(host: PaperHost, kv: Kv, bars: readonly OhlcvBar[] = []): {
  warm(): Promise<void>;
  applyDueBars(): Promise<string[]>;
  releaseDeadline(): void;
  persist(): Promise<void>;
  recordGap(gap: { startMs: number; endMs: number; cause: string }): void;
  sampleUntil(untilMs: number): Promise<void>;
  watchUntil(untilMs: number): Promise<void>;
} {
  return {
    async warm() {
      const saved = await kvPaperStore(kv).load();
      if (saved) installPaperState(host, saved);
      if (host.restWarm && (host.warmup.size === 0 || [...host.products].some((id) => (host.hourWarm.get(id)?.length ?? 0) === 0))) {
        await warmSeriesFromRest(host);
      }
      if (!saved || host.restWarm) await catchUpHistory(host);
    },
    async applyDueBars() {
      const applied: string[] = [];
      for (const bar of bars) {
        const before = host.fifteen.length;
        const status = host.fifteen.some((row) => row.productId === bar.productId && row.startSec === bar.startSec) ? "already" : "new";
        if (status === "new") acceptRestBar(host, bar);
        if (host.fifteen.length === before && status === "new") continue;
        const result = await commitBar(kv, bar.productId, bar.startSec, capturePaperState(host));
        if (result === "applied") applied.push(`${bar.productId}:${bar.startSec}`);
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
    sampleUntil(untilMs: number) {
      return driveHost(host, untilMs, {
        persist: () => persistRun(kv, host),
        onBar: async (bar) => {
          await commitBar(kv, bar.productId, bar.startSec, capturePaperState(host));
        },
      });
    },
    watchUntil(untilMs: number) {
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
  const raw = await kv.get(STATE_KEY);
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
  const holder = deps?.holder ?? {
    ...hostHolder(host!, kv),
    sampleUntil(untilMs: number) {
      return driveHost(host!, untilMs);
    },
  };
  const result: InvocationResult = await runInvocation({ kv, self, nowMs, deadlineMs, holder });
  return Response.json({ ...result, readOnly: false, writes: "cron-only" });
}
