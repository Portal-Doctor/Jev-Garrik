import { config } from "./config";
import type { Fill, Quote } from "./market";
import type { BlockEvent } from "./trader";
import { taxLotsCsv, type TaxReport } from "../cb/tax";

interface Meta { model: string; wallet: string | null; dryRun: boolean; market: string; startedAt: number; kuruMode: "maker"; runId?: string }

const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, OPTIONS" };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

export interface ServerExtras {
  report?: () => Promise<unknown>;
  tax?: () => Promise<TaxReport>;
  reset?: () => Promise<void>;
  latest?: () => BlockEvent | null;
  activity?: () => { quotes: BlockEvent[]; fills: unknown[] };
}

/** GET / snapshot · GET /history recent blocks · GET /events SSE · GET /report (maker paper) */
export function startServer(meta: Meta, history: () => BlockEvent[], extras: ServerExtras = {}) {
  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>();
  const enc = new TextEncoder();
  const send = (c: ReadableStreamDefaultController<Uint8Array>, type: string, data: unknown) => {
    try { c.enqueue(enc.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); } catch { clients.delete(c); }
  };
  setInterval(() => clients.forEach((c) => send(c, "ping", Date.now())), 15_000);

  Bun.serve({
    port: config.port,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
      if (pathname === "/health") return json({ status: "ok", kuruMode: meta.kuruMode, runId: meta.runId ?? null, dryRun: meta.dryRun, ts: Date.now() });
      if (pathname === "/") {
        const activity = extras.activity?.() ?? { quotes: history().slice(-30).reverse(), fills: [] };
        return json({ ...meta, latest: extras.latest?.() ?? history().at(-1) ?? null, quotes: activity.quotes, fills: activity.fills });
      }
      if (pathname === "/history") return json(history());
      if (pathname === "/report") {
        if (!extras.report) return json({ error: "report is maker-mode only (KURU_MODE=maker)" }, 404);
        return json(await extras.report());
      }
      if (pathname === "/tax") {
        if (!extras.tax) return json({ error: "tax is maker-mode only" }, 404);
        return json(await extras.tax());
      }
      if (pathname === "/tax.csv") {
        if (!extras.tax) return json({ error: "tax is maker-mode only" }, 404);
        const report = await extras.tax();
        const csv = taxLotsCsv(report, "kuru");
        return new Response(csv, {
          headers: {
            ...CORS,
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": 'attachment; filename="kuru-tax-lots.csv"',
          },
        });
      }
      if (pathname === "/reset" && req.method === "POST") {
        if (!extras.reset) return json({ error: "reset is maker-mode only" }, 404);
        await extras.reset();
        return json({ ok: true, message: "Kuru paper data cleared. The engine is restarting." });
      }
      if (pathname === "/events") {
        const stream = new ReadableStream<Uint8Array>({
          start(c) { clients.add(c); send(c, "snapshot", { ...meta, history: history() }); },
          cancel(c) { clients.delete(c); },
        });
        return new Response(stream, { headers: { ...CORS, "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
      }
      return json({ error: "not found" }, 404);
    },
  });

  const broadcast = (type: string, data: unknown) => clients.forEach((c) => send(c, type, data));
  return {
    broadcast: (e: BlockEvent) => broadcast("block", e),
    /** A quote's receipt landed: placed (with order id) or reverted, and the real gas. */
    broadcastQuote: (block: number, quote: Quote) => broadcast("quote", { block, quote }),
    /** A taker hit one of our resting orders in `block`. */
    broadcastFill: (block: number, fill: Fill) => broadcast("fill", { block, fill }),
  };
}
