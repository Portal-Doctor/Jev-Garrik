import { config, MEASURED_HORIZONS_SEC } from "./config";
import { Store } from "./db/store";
import { brier, calibration, buildReport } from "./report";

export interface RunMeta {
  runId: string;
  mode: "paper" | "live";
  model: string;
  pairs: string[];
  startedAt: number;
}

export interface ServerCtx {
  meta: RunMeta;
  store: Store;
  /** Live snapshot for GET / and the SSE `snapshot` event (feed + positions + last decisions). */
  snapshot: () => unknown;
  incidentsPerDay: () => number;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const num = (v: string | null, fallback: number) => (v == null || v === "" ? fallback : Number(v));

/**
 * Bun.serve REST + SSE, same CORS/SSE conventions as src/server.ts.
 *
 * GET /            run meta + live per-pair snapshot
 * GET /events      SSE: snapshot on connect, then tick / decision / order / fill / equity / ping
 * GET /decisions   ?pair=&limit=  decision log with outcomes joined
 * GET /equity      ?pair=&fromTs=  snapshot series for the equity curve
 * GET /calibration ?pair=&horizon= bucketed calibration data + Brier
 * GET /report      full metrics JSON including the promotion-gate booleans
 */
export function startServer(ctx: ServerCtx) {
  const { meta, store } = ctx;
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => {
    try {
      c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    } catch {
      clients.delete(c);
    }
  };
  setInterval(() => clients.forEach((c) => send(c, "ping", Date.now())), 15_000);

  const server = Bun.serve({
    port: config.port,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname, searchParams } = url;
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

      if (pathname === "/") return json({ ...meta, snapshot: ctx.snapshot() });

      if (pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            clients.add(c);
            send(c, "snapshot", { ...meta, snapshot: ctx.snapshot() });
          },
          cancel(c) {
            clients.delete(c);
          },
        });
        return new Response(stream, {
          headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
        });
      }

      if (pathname === "/decisions") {
        const pair = searchParams.get("pair") ?? undefined;
        const limit = num(searchParams.get("limit"), 100);
        return json(await store.recentDecisions({ pair, limit }));
      }

      if (pathname === "/equity") {
        const pair = searchParams.get("pair") ?? "TOTAL";
        const fromTs = num(searchParams.get("fromTs"), 0);
        return json(await store.snapshotSeries({ pair, fromTs }));
      }

      if (pathname === "/calibration") {
        const pair = searchParams.get("pair") ?? undefined;
        const horizon = num(searchParams.get("horizon"), config.horizonSec);
        const resolved = (await store.resolvedForReport(pair)).filter((r) => Number(r.horizon_sec) === horizon);
        const pts = resolved.map((r) => ({ pBuy: Number(r.p_buy), up: Number(r.move_bps) > 0 ? 1 : 0 }));
        return json({ pair: pair ?? "ALL", horizonSec: horizon, n: pts.length, brier: brier(pts), buckets: calibration(pts) });
      }

      if (pathname === "/report") {
        return json(await buildReport(store, { incidentsPerDay: ctx.incidentsPerDay() }));
      }

      return json({ error: "not found" }, 404);
    },
  });

  return {
    server,
    horizons: MEASURED_HORIZONS_SEC,
    broadcast: (type: string, data: unknown) => clients.forEach((c) => send(c, type, data)),
  };
}
