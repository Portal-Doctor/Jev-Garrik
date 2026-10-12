/**
 * The cron route's adapter. The book still moves only through the host and the engine.
 * Redis is a Kv. This file does not choose a Marketplace vendor.
 */

import { acceptRestBar, capturePaperState, catchUpHistory, driveHost, installPaperState, releaseForDeadline, startPaperHost, type PaperHost } from "./paper-host";
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

export function hostHolder(host: PaperHost, kv: Kv, bars: readonly OhlcvBar[] = []): {
  warm(): Promise<void>;
  applyDueBars(): Promise<string[]>;
  releaseDeadline(): void;
} {
  return {
    async warm() {
      const saved = await kvPaperStore(kv).load();
      if (saved) installPaperState(host, saved);
      else await catchUpHistory(host);
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
  };
}

export async function loadDashboard(kv: Kv): Promise<Dashboard> {
  const raw = await kv.get(STATE_KEY);
  const lease = decodeLease(await kv.get(LEASE_KEY));
  const body = raw ? (JSON.parse(raw) as { positions?: Dashboard["positions"]; incidents?: string[]; jevSkipped?: number; jevPackets?: number }) : null;
  return dashboard({
    positions: body?.positions ?? [],
    gates: [],
    leaseHolder: lease && lease.untilMs > Date.now() ? lease.holder : null,
    incidents: body?.incidents ?? [],
    weekMs: 7 * 24 * 60 * 60 * 1000,
    gaps: [],
    hours: [],
    jevSkipped: body?.jevSkipped ?? 0,
    jevPackets: body?.jevPackets ?? 0,
    dIndeterminate: 0,
    dSubmitted: 0,
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
    holder?: { warm(): Promise<void>; applyDueBars(): Promise<string[]>; releaseDeadline(): void; sampleUntil?(untilMs: number): Promise<void> };
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
  const holder = deps?.holder ?? {
    ...hostHolder(host!, kv),
    sampleUntil(untilMs: number) {
      return driveHost(host!, untilMs);
    },
  };
  const result: InvocationResult = await runInvocation({ kv, self, nowMs, deadlineMs, holder });
  return Response.json({ ...result, readOnly: false, writes: "cron-only" });
}
