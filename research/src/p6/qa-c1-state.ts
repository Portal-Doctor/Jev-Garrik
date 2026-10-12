import { redisKvFromUrl, STATE_KEY, kvPaperStore } from "./relay";
import { startPaperHost, warmSeriesFromRest, capturePaperState, volHoursFromFifteens, publishLiveQuote, ensureSendQuote, flushEntries } from "./paper-host";
import { hostHolder, persistRun, loadDashboard } from "./vercel-live";
const kv = redisKvFromUrl(process.env.QA_REDIS!);
const scen = process.argv[2];
if (scen === "rest") {
  const h = startPaperHost(["BTC-USD", "ETH-USD"], {});
  h.warmup.clear(); h.hourWarm.clear(); h.restWarm = true; h.book.incidents.length = 0;
  const urls: string[] = [];
  await warmSeriesFromRest(h, async (u) => { urls.push(u); return fetch(u); });
  console.log("urls", urls.length, urls[0]);
  for (const id of ["BTC-USD", "ETH-USD"]) { const w = h.warmup.get(id) ?? []; console.log(id, "daily", w.length, w[0]?.date, w.at(-1)?.date, "hour", h.hourWarm.get(id)?.length ?? 0); }
  console.log("incidents", h.book.incidents);
  console.log("memberCloses", h.book.config.memberCloses?.length ?? 0, "btcCloses", h.book.config.btcCloses?.length ?? 0, "historyFrom", [...h.historyFrom.entries()]);
}
if (scen === "roundtrip") {
  await kv.del(STATE_KEY);
  const h1 = startPaperHost(["BTC-USD", "ETH-USD"], {});
  h1.gaps.push({ startMs: 1, endMs: 61_000, cause: "handover" });
  h1.book.submittedByClass.D = 7; h1.book.indeterminateByClass.D = 2;
  (h1.book as { cashUsd?: number }).cashUsd = (h1.book as { cashUsd?: number }).cashUsd ?? 0;
  const t = 1791820800; for (let i = 0; i < 8; i++) { h1.fifteen.push({ productId: "BTC-USD", startSec: t + i * 900, open: 1, high: 1, low: 1, close: 60000 + i, volume: 1 }); h1.fifteen.push({ productId: "ETH-USD", startSec: t + i * 900, open: 1, high: 1, low: 1, close: 2400 + i, volume: 1 }); }
  const before = capturePaperState(h1);
  await persistRun(kv, h1);
  const raw = (await kv.get(STATE_KEY))!; console.log("state bytes", raw.length);
  const h2 = startPaperHost(["BTC-USD", "ETH-USD"], {});
  h2.warmup.clear(); h2.hourWarm.clear();
  await hostHolder(h2, kv).warm();
  const after = capturePaperState(h2);
  for (const k of Object.keys(before) as (keyof typeof before)[]) { const a = JSON.stringify(before[k]), b = JSON.stringify(after[k]); if (a !== b) console.log("DIFF", k, (a ?? "").slice(0, 80), "|", (b ?? "").slice(0, 80)); }
  console.log("keys", Object.keys(before).length, "memberCloses", before.memberCloses?.length, after.memberCloses?.length, "warmup", before.warmup?.length, after.warmup?.length, "hourWarm", before.hourWarm.length, after.hourWarm.length);
  console.log("volHours mixed-product", JSON.stringify(volHoursFromFifteens(h1.fifteen, []).slice(0, 2)));
  console.log("volHours BTC-only", JSON.stringify(volHoursFromFifteens(h1.fifteen.filter(b => b.productId === "BTC-USD"), []).slice(0, 2)));
  const d = await loadDashboard(kv); console.log("dash", JSON.stringify((d as any).gaps ?? d).slice(0, 400));
}
if (scen === "trip") {
  const week = 7 * 86400e3; const base = Date.now() - week;
  const h = startPaperHost(["BTC-USD"], {});
  for (let i = 0; i < 7 * 24 * 4; i++) h.fifteen.push({ productId: "BTC-USD", startSec: Math.floor(base / 1000) + i * 900, open: 1, high: 1, low: 1, close: 60000 * (1 + (i % 40 === 0 ? 0.03 : 0.0005) * (i % 2 ? 1 : -1)), volume: 1 });
  for (const [label, gaps] of [["none", []], ["16min", [{ startMs: base + 3600e3, endMs: base + 3600e3 + 16 * 60e3, cause: "crash" }]], ["2x60s/h", Array.from({ length: 168 }, (_, k) => ({ startMs: base + k * 3600e3, endMs: base + k * 3600e3 + 60e3, cause: "uncovered" }))]] as const) {
    h.gaps = gaps.map(g => ({ ...g })); h.fifteen = h.fifteen.slice(-5000);
    await persistRun(kv, h); const d: any = await loadDashboard(kv);
    console.log(label, "g0", d.g0, JSON.stringify({ share: d.gaps?.gappedShare, longest: d.gaps?.longestMs, vol: d.gaps?.volRate, overall: d.gaps?.overallRate, flags: d.gaps?.flags }));
  }
  h.gaps = Array.from({ length: 10 }, (_, k) => ({ startMs: base + (k * 40) * 900e3, endMs: base + (k * 40) * 900e3 + 300e3, cause: "x" }));
  await persistRun(kv, h); const d: any = await loadDashboard(kv); console.log("vol-hour gaps", "g0", d.g0, JSON.stringify(d.gaps?.flags), d.gaps?.volRate, d.gaps?.overallRate);
}
if (scen === "stale") {
  const h = startPaperHost(["BTC-USD"], {});
  const now = Date.now();
  h.books.set("BTC-USD", { bids: new Map([[60000, 1]]), asks: new Map([[60001, 1]]) } as any);
  h.l2Ts.set("BTC-USD", now - 16_000);
  let calls = 0;
  const stub = async () => { calls++; await new Promise(r => setTimeout(r, 50)); return { ok: true, status: 200, json: async () => ({ bids: [["59999", "1"]], asks: [["60002", "1"]], time: new Date().toISOString() }) } as any; };
  console.log("ensureSendQuote awaited ->", await ensureSendQuote(h, "BTC-USD", Date.now(), stub), "calls", calls);
  // driveHost-style ordering: void ensure, then flush immediately
  const h2 = startPaperHost(["BTC-USD"], {});
  h2.books.set("BTC-USD", { bids: new Map([[60000, 1]]), asks: new Map([[60001, 1]]) } as any);
  h2.l2Ts.set("BTC-USD", Date.now() - 16_000); h2.ticks.set("BTC-USD", 0.01);
  h2.queued.set("x", { kind: "x1", classId: "C", productId: "BTC-USD", tsMs: Date.now() - 30_000, nextOpen: 60000, stop: 59000, dailyAtr: 1000, priorDailyCloses: [], signalDate: "2026-10-12" } as any);
  const t = Date.now(); void ensureSendQuote(h2, "BTC-USD", t, stub); flushEntries(h2, t);
  console.log("driveHost order: rejected", JSON.stringify(h2.book.rejected), "restQuotes after flush", h2.restQuotes.size);
  await new Promise(r => setTimeout(r, 100)); console.log("restQuotes 100ms later", h2.restQuotes.size);
  // fresh book, 30s after close
  const h3 = startPaperHost(["BTC-USD"], {});
  h3.books.set("BTC-USD", { bids: new Map([[60000, 1]]), asks: new Map([[60001, 1]]) } as any);
  h3.l2Ts.set("BTC-USD", Date.now() - 500); h3.ticks.set("BTC-USD", 0.01);
  h3.queued.set("y", { kind: "x1", classId: "C", productId: "BTC-USD", tsMs: Date.now() - 30_000, nextOpen: 60000, stop: 59000, dailyAtr: 1000, priorDailyCloses: [], signalDate: "2026-10-12" } as any);
  flushEntries(h3, Date.now()); console.log("fresh L2, 30s after close: rejected", JSON.stringify(h3.book.rejected), "positions", h3.book.positions.length, "legs", JSON.stringify((h3.book as any).legs?.at?.(-1) ?? null).slice(0, 200));
}
process.exit(0);
