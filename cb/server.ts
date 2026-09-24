import { loadAllBacktests, loadHistoricalBacktest } from "./backtest";
import { config, MEASURED_HORIZONS_SEC } from "./config";
import { Store } from "./db/store";
import { gateFromState } from "./gate";
import { brier, calibration, buildReport } from "./report";
import { buildTaxFromStore, taxLotsCsv } from "./tax";

export interface RunMeta {
  runId: string;
  mode: "paper" | "live";
  model: string;
  pairs: string[];
  startedAt: number;
  /** Decision cadence in seconds; the UI uses it to size the per-pair countdown. */
  decideSec: number;
}

export interface ServerCtx {
  meta: RunMeta;
  store: Store;
  /** Live snapshot for GET / and the SSE `snapshot` event (feed + positions + last decisions). */
  snapshot: () => unknown | Promise<unknown>;
  incidentsPerDay: () => number;
  /** Wipes all paper-trading tables and restarts the service so in-memory state (positions, open
   *  orders, run id) starts fresh too. Resolves once the DB is cleared; the process exit happens
   *  shortly after so the HTTP response reaches the client first. */
  reset: () => Promise<void>;
}

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*" };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const num = (v: string | null, fallback: number) => (v == null || v === "" ? fallback : Number(v));

/**
 * Bun.serve REST + SSE.
 *
 * GET /health      liveness probe (status + runId + uptime), polled by the UI
 * GET /            run meta + live per-pair snapshot
 * GET /events      SSE: snapshot on connect, then tick / decision / order / fill / equity / ping
 * GET /decisions   ?pair=&limit=  decision log with outcomes joined
 * GET /equity      ?pair=&fromTs=  snapshot series for the equity curve
 * GET /calibration ?pair=&horizon= bucketed calibration data + Brier
 * GET /report      full metrics JSON including the promotion-gate booleans
 * GET /backtest    ?months=1|3|6&pair=  historical replay and scorecard
 * GET /backtest/all ?months=1|3|6  the six books, sequential, plus a totals row
 * GET /tax         FIFO lot worksheet for the Coinbase venue (fills, months, pairs)
 * POST /reset       clears all paper-trading data (runs/decisions/outcomes/orders/fills/snapshots)
 *                    and restarts the service; irreversible, meant for the dashboard's admin button
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
    // A cold 6 month replay can sit quiet while candles download and the oracle runs.
    idleTimeout: 120,
    async fetch(req) {
      const url = new URL(req.url);
      const { pathname, searchParams } = url;
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

      // Lightweight liveness probe the UI polls; no DB access so it stays cheap.
      if (pathname === "/health")
        return json({ status: "ok", runId: meta.runId, ts: Date.now(), uptimeMs: Date.now() - meta.startedAt });

      if (pathname === "/") return json({ ...meta, snapshot: await ctx.snapshot() });

      if (pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            clients.add(c);
            void Promise.resolve(ctx.snapshot()).then((snap) => send(c, "snapshot", { ...meta, snapshot: snap }));
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
        const rows = await store.recentDecisions({ pair, limit, venue: "paper" });
        return json(
          rows.map((d) => {
            const gate = gateFromState(d.state);
            return { ...d, approved: gate.approved, reason: gate.reason, hurdleBps: gate.hurdleBps };
          }),
        );
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
        return json(await buildReport(store, { incidentsPerDay: ctx.incidentsPerDay(), runId: meta.runId }));
      }

      if (pathname === "/backtest/all") {
        const months = num(searchParams.get("months"), 1);
        if (months !== 1 && months !== 3 && months !== 6) return json({ error: "months must be 1, 3, or 6" }, 400);
        try {
          return json(await loadAllBacktests(months));
        } catch (err) {
          const message = err instanceof Error ? err.message : "backtest failed";
          return json({ error: message }, 502);
        }
      }

      if (pathname === "/backtest") {
        const months = num(searchParams.get("months"), 1);
        if (months !== 1 && months !== 3 && months !== 6) return json({ error: "months must be 1, 3, or 6" }, 400);
        const pair = searchParams.get("pair") ?? config.pairs[0] ?? "UNI-USD";
        try {
          return json(await loadHistoricalBacktest(pair, months));
        } catch (err) {
          const message = err instanceof Error ? err.message : "backtest failed";
          return json({ error: message }, 502);
        }
      }

      if (pathname === "/tax") {
        return json(await buildTaxFromStore(store, "paper"));
      }

      if (pathname === "/tax.csv") {
        const report = await buildTaxFromStore(store, "paper");
        return new Response(taxLotsCsv(report, "coinbase"), {
          headers: {
            ...CORS,
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="coinbase-tax-lots.csv"',
          },
        });
      }

      if (pathname === "/reset" && req.method === "POST") {
        await ctx.reset();
        return json({ ok: true, message: "Paper trading data cleared. The service is restarting." });
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
