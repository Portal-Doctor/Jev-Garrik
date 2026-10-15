import { expect, test } from "bun:test";
import { memoryKv } from "./relay";
import { LAST_RUN_KEY, loadSplit, persistSplit, warmReadyCount } from "./hot-store";
import { SEED_BUDGET } from "./rest-limit";
import { hostHolder } from "./vercel-live";
import { acceptRestBar, backfillTapeIfNeeded, fourSeriesReady, installPaperState, seedBudgeted, seedFourHours, seedMarkKey, SEED_PRODUCTS_PER_RUN, SEED_REQUESTS_PER_PRODUCT, startPaperHost } from "./paper-host";
import { hourPagesForKeep } from "./warm-caps";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");

function candle(ts: number): number[] {
  return [ts, 99, 101, 100, 100.5, 10];
}

test("a product listed 30 days ago stops when the page before the listing is empty", async () => {
  const host = startPaperHost(["THIN-USD"], {});
  host.clock = () => NOW;
  const listed = Math.floor(NOW / 1000) - 30 * 86_400;
  let calls = 0;
  await seedFourHours(host, async (url) => {
    calls += 1;
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get("start"));
    const end = Number(parsed.searchParams.get("end"));
    const rows: number[][] = [];
    for (let ts = Math.max(start, listed); ts <= end && rows.length < 300; ts += 3_600) rows.push(candle(ts));
    return { ok: true, status: 200, json: async () => rows };
  });
  expect(calls).toBe(4);
  expect(host.seedMarks.get("THIN-USD")?.reason).toBe("listing");
  expect(host.cold.has("THIN-USD")).toBe(true);
});

test("a no-trade hole keeps both sides of the offline fold and the series is warm", async () => {
  const host = startPaperHost(["ICP-USD"], {});
  host.clock = () => NOW;
  const end0 = Math.floor(NOW / 1000 / 3_600) * 3_600 - 3_600;
  const bucket = Math.floor(end0 / 14_400) * 14_400;
  const tailStart = bucket - 949 * 14_400;
  const gapStart = tailStart - 12 * 3_600;
  let calls = 0;
  await seedFourHours(host, async (url) => {
    calls += 1;
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get("start"));
    const end = Number(parsed.searchParams.get("end"));
    const rows: number[][] = [];
    for (let ts = start; ts <= end && rows.length < 300; ts += 3_600) {
      if (ts >= gapStart && ts < tailStart) continue;
      rows.push(candle(ts));
    }
    return { ok: true, status: 200, json: async () => rows };
  });
  const bars = host.fourBars.get("ICP-USD") ?? [];
  const ordered = bars.slice().sort((a, b) => a.ts - b.ts);
  expect(host.cold.has("ICP-USD")).toBe(false);
  expect(host.seedMarks.get("ICP-USD")).toMatchObject({ status: "warm", reason: "seeded" });
  expect(bars.length).toBeGreaterThanOrEqual(1000);
  expect(fourSeriesReady(bars)).toBe(true);
  expect(ordered.some((bar) => bar.ts < gapStart)).toBe(true);
  expect(ordered.some((bar) => bar.ts >= tailStart)).toBe(true);
  expect(ordered.some((bar, index) => index > 0 && bar.ts - ordered[index - 1]!.ts > 14_400)).toBe(true);
  expect(calls).toBeLessThanOrEqual(1 + hourPagesForKeep());
});

test("a recent no-trade hole does not stop the walk before 1000 folded bars", async () => {
  const host = startPaperHost(["MAGIC-USD"], {});
  host.clock = () => NOW;
  const end0 = Math.floor(NOW / 1000 / 3_600) * 3_600 - 3_600;
  const holeBucket = Math.floor((end0 - 80 * 3_600) / 14_400) * 14_400;
  let calls = 0;
  await seedFourHours(host, async (url) => {
    calls += 1;
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get("start"));
    const end = Number(parsed.searchParams.get("end"));
    const rows: number[][] = [];
    for (let ts = start; ts <= end && rows.length < 300; ts += 3_600) {
      if (ts >= holeBucket && ts < holeBucket + 4 * 3_600) continue;
      rows.push(candle(ts));
    }
    return { ok: true, status: 200, json: async () => rows };
  });
  const bars = host.fourBars.get("MAGIC-USD") ?? [];
  const ordered = bars.slice().sort((a, b) => a.ts - b.ts);
  expect(calls).toBeGreaterThan(3);
  expect(host.cold.has("MAGIC-USD")).toBe(false);
  expect(host.seedMarks.get("MAGIC-USD")).toMatchObject({ status: "warm", reason: "seeded" });
  expect(bars.length).toBeGreaterThanOrEqual(1000);
  expect(ordered.some((bar) => bar.ts < holeBucket)).toBe(true);
  expect(ordered.some((bar) => bar.ts >= holeBucket + 14_400)).toBe(true);
  expect(ordered.some((bar, index) => index > 0 && bar.ts - ordered[index - 1]!.ts > 14_400)).toBe(true);
});

test("a 503 during the 4h seed skips this run and stores no cold mark", async () => {
  const host = startPaperHost(["ERR-USD"], {});
  host.clock = () => NOW;
  let calls = 0;
  await seedFourHours(host, async (url) => {
    calls += 1;
    if (calls === 2) return { ok: false, status: 503, json: async () => [] };
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get("start"));
    const end = Number(parsed.searchParams.get("end"));
    const rows: number[][] = [];
    for (let ts = start; ts <= end && rows.length < 300; ts += 3_600) rows.push(candle(ts));
    return { ok: true, status: 200, json: async () => rows };
  });
  expect(calls).toBe(2);
  expect(host.seedMarks.has("ERR-USD")).toBe(false);
  expect(host.cold.has("ERR-USD")).toBe(true);
});

test("a hole costs one page past the gap and then stops", async () => {
  const host = startPaperHost(["HOLE-USD"], {});
  host.clock = () => NOW;
  let calls = 0;
  await seedFourHours(host, async (url) => {
    calls += 1;
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get("start"));
    const end = Number(parsed.searchParams.get("end"));
    const rows: number[][] = [];
    const shift = calls === 1 ? 0 : 86_400;
    for (let ts = start; ts <= end && rows.length < 300; ts += 3_600) rows.push(candle(ts - shift));
    return { ok: true, status: 200, json: async () => rows };
  });
  expect(calls).toBe(2);
  expect(host.seedMarks.get("HOLE-USD")?.reason).toBe("hole");
  expect(host.cold.has("HOLE-USD")).toBe(true);
});

test("50 products at the seed budget finish in 4 runs and the cursor resumes", async () => {
  expect(SEED_PRODUCTS_PER_RUN).toBe(13);
  expect(SEED_REQUESTS_PER_PRODUCT).toBe(1 + hourPagesForKeep());
  expect(SEED_BUDGET).toBe(250);
  const ids = Array.from({ length: 50 }, (_, index) => `P${String(index).padStart(2, "0")}-USD`);
  const fetchImpl = async (url: string) => {
    const parsed = new URL(url);
    const gran = Number(parsed.searchParams.get("granularity"));
    const start = Number(parsed.searchParams.get("start"));
    const end = Number(parsed.searchParams.get("end"));
    if (gran === 86_400) return { ok: true, status: 200, json: async () => [candle(start)] };
    const rows: number[][] = [];
    for (let ts = start; ts <= end && rows.length < 300; ts += 3_600) rows.push(candle(ts));
    return { ok: true, status: 200, json: async () => rows };
  };
  const kv = memoryKv(() => NOW);
  const deltas: number[] = [];
  let idx = 0;
  for (let run = 0; run < 4; run += 1) {
    const host = startPaperHost(ids, {});
    host.clock = () => NOW;
    if (run > 0) {
      const saved = await loadSplit(kv, host);
      expect(saved).toBeTruthy();
      installPaperState(host, saved!);
    }
    const before = host.seedCursor.idx;
    await seedBudgeted(host, fetchImpl);
    expect(host.restRun.seedUsed).toBeLessThanOrEqual(SEED_BUDGET);
    expect(host.seedCursor.idx).toBeGreaterThan(before);
    deltas.push(host.seedCursor.idx - before);
    idx = host.seedCursor.idx;
    await persistSplit(kv, host);
    const cursor = JSON.parse((await kv.get("p6:seed:cursor")) ?? "{}") as { idx: number };
    expect(cursor.idx).toBe(idx);
    expect(await kv.get(LAST_RUN_KEY)).toBeTruthy();
  }
  expect(deltas).toEqual([13, 13, 13, 11]);
  expect(idx).toBe(50);
});

test("a crash hole longer than two minutes is rebuilt from trades and 1m candles", async () => {
  const host = startPaperHost(["BTC-USD"], {});
  const now = NOW;
  host.clock = () => now;
  host.tapeHole = true;
  host.wsTape = false;
  host.tapeHoleFromSec = Math.floor(now / 1000) - 6 * 60;
  const urls: string[] = [];
  await backfillTapeIfNeeded(host, async (url) => {
    urls.push(url);
    if (url.includes("/trades")) return { ok: true, status: 200, json: async () => [] };
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get("start"));
    const end = Number(parsed.searchParams.get("end"));
    const rows: number[][] = [];
    for (let ts = Math.floor(start / 60) * 60; ts <= end; ts += 60) rows.push(candle(ts));
    return { ok: true, status: 200, json: async () => rows };
  });
  expect(urls.some((url) => url.includes("/trades"))).toBe(true);
  expect(urls.some((url) => url.includes("granularity=60"))).toBe(true);
  expect(host.trades.length).toBeGreaterThanOrEqual(5);
  expect(host.book.mids.completed.length).toBeGreaterThanOrEqual(5);
  expect(host.cold.has("BTC-USD")).toBe(false);
});

test("trades in the hole become 1m bars and a covered minute skips candles", async () => {
  const host = startPaperHost(["BTC-USD"], {});
  const now = NOW;
  host.clock = () => now;
  host.tapeHole = true;
  host.wsTape = false;
  const from = Math.floor(now / 1000) - 120;
  host.tapeHoleFromSec = from;
  const minute = Math.floor(from / 60) * 60;
  const rows: { time: string; price: string; size: string; side: string }[] = [];
  for (let ts = minute; ts < Math.floor(now / 1000); ts += 60) {
    rows.push({ time: new Date((ts + 5) * 1000).toISOString(), price: "100", size: "1", side: "buy" });
    rows.push({ time: new Date((ts + 50) * 1000).toISOString(), price: "110", size: "2", side: "sell" });
  }
  const urls: string[] = [];
  await backfillTapeIfNeeded(host, async (url) => {
    urls.push(url);
    if (url.includes("/trades")) return { ok: true, status: 200, json: async () => rows };
    return { ok: true, status: 200, json: async () => [] };
  });
  expect(urls.some((url) => url.includes("granularity=60"))).toBe(false);
  const first = host.book.mids.completed.find((mid) => mid.ts === minute * 1000);
  expect(first).toMatchObject({ open: 100, high: 110, low: 100, close: 110, volumeBase: 3 });
  expect(host.book.mids.completed.length).toBeGreaterThanOrEqual(2);
});

test("a live socket still backfills the hole up to the socket open", async () => {
  const host = startPaperHost(["BTC-USD"], {});
  const now = NOW;
  host.clock = () => now;
  host.tapeHole = true;
  host.wsTape = true;
  host.socketOpenedMs = now - 60_000;
  host.tapeHoleFromSec = Math.floor(now / 1000) - 6 * 60;
  const urls: string[] = [];
  await backfillTapeIfNeeded(host, async (url) => {
    urls.push(url);
    return { ok: true, status: 200, json: async () => [] };
  });
  expect(urls.some((url) => url.includes("/trades"))).toBe(true);
  expect(urls.some((url) => url.includes("granularity=60"))).toBe(true);
  const gap = host.book.incidents.find((row) => row.startsWith("tape gap BTC-USD "));
  expect(gap).toBe("tape gap BTC-USD 5");
  expect(host.cold.has("BTC-USD")).toBe(false);
});

test("a budget stop is labeled budget-stop and is not a 429", async () => {
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => NOW;
  host.tapeHole = true;
  host.wsTape = false;
  host.tapeHoleFromSec = Math.floor(NOW / 1000) - 120;
  await backfillTapeIfNeeded(host, async () => ({
    ok: false,
    status: 429,
    headers: { get: (name: string) => (name === "x-p6-budget" ? "reserve" : null) },
    json: async () => [],
  }));
  expect(host.book.incidents.some((row) => row.includes("budget-stop"))).toBe(true);
  expect(host.book.incidents.some((row) => /\b429\b/.test(row))).toBe(false);
  expect(host.restRun.stats.r429).toBe(0);
});

test("cold marks persist across runs and a short series is not cold", async () => {
  const ids = ["STRK-USD", "BTC-USD"];
  const kv = memoryKv(() => NOW);
  const host = startPaperHost(ids, {});
  host.clock = () => NOW;
  host.seedMarks.set("STRK-USD", { oldestTs: 1, newestTs: 2, status: "cold", reason: "hole" });
  host.cold.add("STRK-USD");
  host.seedMarks.set("BTC-USD", { oldestTs: 1, newestTs: 2, status: "short", reason: "short" });
  await persistSplit(kv, host);
  const first = JSON.parse((await kv.get(LAST_RUN_KEY)) ?? "{}") as { cold: { id: string; reason: string }[]; warm: number; pending: number };
  expect(first.cold).toEqual([{ id: "STRK-USD", reason: "hole" }]);
  expect(first.warm + first.cold.length + first.pending).toBe(ids.length);
  const later = startPaperHost(ids, {});
  later.clock = () => NOW;
  expect(await loadSplit(kv, later)).toBeTruthy();
  expect(later.cold.has("STRK-USD")).toBe(true);
  expect(later.seedMarks.get("BTC-USD")?.status).toBe("short");
  expect(later.cold.has("BTC-USD")).toBe(false);
  await persistSplit(kv, later);
  const third = JSON.parse((await kv.get(LAST_RUN_KEY)) ?? "{}") as { cold: { id: string }[] };
  expect(third.cold.map((row) => row.id)).toEqual(["STRK-USD"]);
});

test("a warm mark without FOUR_KEEP bars is stored short and the next run reseeds it", async () => {
  const kv = memoryKv(() => NOW);
  const host = startPaperHost(["BCH-USD"], {});
  host.clock = () => NOW;
  host.seedMarks.set("BCH-USD", { oldestTs: 1, newestTs: 3_600, status: "warm", reason: "seeded" });
  host.hourWarm.set("BCH-USD", [{ ts: 3_600, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  await persistSplit(kv, host);
  const stored = JSON.parse((await kv.get(seedMarkKey("BCH-USD"))) ?? "{}") as { status: string };
  expect(stored.status).toBe("short");
  expect(host.seedMarks.get("BCH-USD")?.status).toBe("warm");
  await kv.set(seedMarkKey("BCH-USD"), JSON.stringify({ oldestTs: 1, newestTs: 3_600, status: "warm", reason: "seeded" }));
  await kv.del("p6:bar4h:BCH-USD");
  const next = startPaperHost(["BCH-USD"], {});
  next.clock = () => NOW;
  expect(await loadSplit(kv, next)).toBeTruthy();
  expect(next.seedMarks.get("BCH-USD")?.status).toBe("short");
  expect(next.cold.has("BCH-USD")).toBe(false);
  let calls = 0;
  await seedBudgeted(next, async (url) => {
    calls += 1;
    const parsed = new URL(url);
    const start = Number(parsed.searchParams.get("start"));
    const end = Number(parsed.searchParams.get("end"));
    const gran = Number(parsed.searchParams.get("granularity"));
    if (gran === 86_400) return { ok: true, status: 200, json: async () => [candle(start)] };
    const rows: number[][] = [];
    for (let ts = start; ts <= end && rows.length < 300; ts += 3_600) rows.push(candle(ts));
    return { ok: true, status: 200, json: async () => rows };
  });
  expect(calls).toBeGreaterThan(2);
  expect(next.fourBars.get("BCH-USD")?.length ?? 0).toBeGreaterThanOrEqual(1000);
});

test("a flush that splits past 1 MB still marks a full 4h series warm", async () => {
  const kv = memoryKv(() => NOW);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => NOW;
  const pad = "x".repeat(900);
  const rows = Array.from({ length: 1000 }, (_, index) => ({
    ts: index * 14_400,
    open: 1,
    high: 2,
    low: 1,
    close: 1,
    volume: 1,
    pad,
  }));
  host.fourBars.set("BTC-USD", rows);
  host.seedMarks.set("BTC-USD", { oldestTs: 0, newestTs: rows[rows.length - 1]!.ts, status: "warm", reason: "seeded" });
  await persistSplit(kv, host);
  const stored = JSON.parse((await kv.get(seedMarkKey("BTC-USD"))) ?? "{}") as { status: string };
  const bars = JSON.parse((await kv.get("p6:bar4h:BTC-USD")) ?? "[]") as unknown[];
  expect(bars).toHaveLength(1000);
  expect(stored.status).toBe("warm");
  expect(host.seedMarks.get("BTC-USD")?.status).toBe("warm");
  expect(host.saveCommands).toBeGreaterThan(1);
  await kv.set(seedMarkKey("BTC-USD"), JSON.stringify({ oldestTs: 0, newestTs: rows[rows.length - 1]!.ts, status: "short", reason: "short" }));
  const again = startPaperHost(["BTC-USD"], {});
  again.clock = () => NOW;
  expect(await loadSplit(kv, again)).toBeTruthy();
  expect(again.seedMarks.get("BTC-USD")?.status).toBe("warm");
  expect(again.fourFlushed.has("BTC-USD")).toBe(true);
  expect(again.cold.has("BTC-USD")).toBe(false);
});

test("a watcher does not seed or backfill before it holds the lease", async () => {
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => NOW;
  host.restWarm = true;
  host.tapeHole = true;
  host.tapeHoleFromSec = Math.floor(NOW / 1000) - 180;
  const holder = hostHolder(host, memoryKv(() => NOW));
  await holder.warm();
  await holder.sampleUntil(NOW - 1);
  expect(host.leaseToken).toBeNull();
  expect(host.restRun.stats.n).toBe(0);
  expect(host.seedCursor.idx).toBe(0);
  expect(host.trades).toHaveLength(0);
});

test("bars accepted while sampling are reported", () => {
  const host = startPaperHost(["BTC-USD"], {});
  host.products = [];
  host.shards = [];
  const holder = hostHolder(host, memoryKv());
  expect(holder.appliedDuringRun()).toEqual([]);
  acceptRestBar(host, { productId: "BTC-USD", startSec: 1_700_000_000, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  expect(holder.appliedDuringRun()).toEqual(["BTC-USD:1700000000"]);
});

function seededCandles(url: string) {
  const parsed = new URL(url);
  const gran = Number(parsed.searchParams.get("granularity"));
  const start = Number(parsed.searchParams.get("start"));
  const end = Number(parsed.searchParams.get("end"));
  if (gran === 86_400) return { ok: true, status: 200, json: async () => [candle(start)] };
  const rows: number[][] = [];
  for (let ts = start; ts <= end && rows.length < 300; ts += 3_600) rows.push(candle(ts));
  return { ok: true, status: 200, json: async () => rows };
}

/** One product's 4h JSON is near 1 MB, so a run of 13 splits the flush. */
function widenFourBars(host: ReturnType<typeof startPaperHost>): void {
  const pad = "x".repeat(900);
  for (const [id, rows] of host.fourBars) {
    host.fourBars.set(
      id,
      rows.map((bar) => ({ ...bar, pad })) as typeof rows,
    );
  }
}

async function redisWarm(kv: ReturnType<typeof memoryKv>, ids: readonly string[]): Promise<number> {
  let warm = 0;
  for (const id of ids) {
    const raw = await kv.get(seedMarkKey(id));
    if (!raw) continue;
    if ((JSON.parse(raw) as { status: string }).status === "warm") warm += 1;
  }
  return warm;
}

test("a split flush across four runs seeds about 13 products a run and all 50 are warm", async () => {
  const ids = Array.from({ length: 50 }, (_, index) => `P${String(index).padStart(2, "0")}-USD`);
  const kv = memoryKv(() => NOW);
  const added: number[] = [];
  const warmLog: number[] = [];
  const warmRedis: number[] = [];
  for (let run = 0; run < 4; run += 1) {
    const host = startPaperHost(ids, {});
    host.clock = () => NOW;
    if (run > 0) {
      const saved = await loadSplit(kv, host);
      expect(saved).toBeTruthy();
      installPaperState(host, saved!);
    }
    const before = host.seedCursor.idx;
    await seedBudgeted(host, async (url) => seededCandles(url));
    widenFourBars(host);
    host.warmupStored = true;
    const commands = host.saveCommands;
    await persistSplit(kv, host);
    expect(host.saveCommands - commands).toBeGreaterThan(1);
    expect(host.book.incidents.some((row) => row.includes("exceeds 1 MB"))).toBe(false);
    const logged = warmReadyCount(host);
    const stored = await redisWarm(kv, ids);
    const last = JSON.parse((await kv.get(LAST_RUN_KEY)) ?? "{}") as { warm: number };
    expect(logged).toBe(stored);
    expect(last.warm).toBe(stored);
    for (const [id, mark] of host.seedMarks) {
      if ((host.fourBars.get(id)?.length ?? 0) < 1000) continue;
      expect(mark.status).toBe("warm");
      const raw = JSON.parse((await kv.get(seedMarkKey(id))) ?? "{}") as { status: string };
      expect(raw.status).toBe("warm");
    }
    added.push(host.seedCursor.idx - before);
    warmLog.push(logged);
    warmRedis.push(stored);
  }
  expect(added).toEqual([13, 13, 13, 11]);
  expect(warmLog).toEqual([13, 26, 39, 50]);
  expect(warmRedis).toEqual([13, 26, 39, 50]);
}, 60_000);

function warmBars(endTs: number): { ts: number; open: number; high: number; low: number; close: number; volume: number }[] {
  return Array.from({ length: 1000 }, (_, index) => ({
    ts: endTs - (999 - index) * 14_400,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
  }));
}

test("the hour catch-up starts at the newer of the watermark and the last stored hour", async () => {
  const host = startPaperHost(["BTC-USD"], {});
  const nowSec = Math.floor(NOW / 1000);
  host.clock = () => NOW;
  const watermark = nowSec - 500 * 3_600;
  const storedHour = nowSec - 10 * 3_600;
  host.fourBars.set("BTC-USD", warmBars(watermark));
  host.seedMarks.set("BTC-USD", { oldestTs: watermark - 1000 * 14_400, newestTs: watermark, status: "warm", reason: "seeded" });
  host.hourWarm.set("BTC-USD", [{ ts: storedHour, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  host.seedCursor = { order: ["BTC-USD"], idx: 0, runId: "delta" };
  const starts: number[] = [];
  await seedBudgeted(host, async (url) => {
    const parsed = new URL(url);
    if (Number(parsed.searchParams.get("granularity")) === 3_600) starts.push(Number(parsed.searchParams.get("start")));
    return { ok: true, status: 200, json: async () => [] };
  });
  expect(starts).toEqual([storedHour + 3_600]);
});

test("an hour catch-up longer than 300 hours is paged, and a REST error is an incident", async () => {
  const nowSec = Math.floor(NOW / 1000);
  const watermark = nowSec - 400 * 3_600;
  const paged = startPaperHost(["BTC-USD"], {});
  paged.clock = () => NOW;
  paged.fourBars.set("BTC-USD", warmBars(watermark));
  paged.seedMarks.set("BTC-USD", { oldestTs: watermark, newestTs: watermark, status: "warm", reason: "seeded" });
  paged.hourWarm.set("BTC-USD", [{ ts: watermark, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  paged.seedCursor = { order: ["BTC-USD"], idx: 0, runId: "page" };
  const spans: { start: number; end: number }[] = [];
  await seedBudgeted(paged, async (url) => {
    const parsed = new URL(url);
    if (Number(parsed.searchParams.get("granularity")) === 3_600) {
      const start = Number(parsed.searchParams.get("start"));
      const end = Number(parsed.searchParams.get("end"));
      spans.push({ start, end });
      const rows: number[][] = [];
      for (let ts = start; ts <= end && rows.length < 300; ts += 3_600) rows.push(candle(ts));
      return { ok: true, status: 200, json: async () => rows };
    }
    return { ok: true, status: 200, json: async () => [] };
  });
  expect(spans.length).toBeGreaterThan(1);
  expect(spans[0]!.start).toBe(watermark + 3_600);
  expect(spans[0]!.end - spans[0]!.start).toBeLessThanOrEqual(299 * 3_600);
  expect(spans[1]!.start).toBe(spans[0]!.end + 3_600);
  expect(paged.book.incidents.some((line) => line.startsWith("hour delta"))).toBe(false);

  const failed = startPaperHost(["BTC-USD"], {});
  failed.clock = () => NOW;
  failed.fourBars.set("BTC-USD", warmBars(watermark));
  failed.seedMarks.set("BTC-USD", { oldestTs: watermark, newestTs: watermark, status: "warm", reason: "seeded" });
  failed.hourWarm.set("BTC-USD", [{ ts: watermark, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  failed.seedCursor = { order: ["BTC-USD"], idx: 0, runId: "fail" };
  await seedBudgeted(failed, async () => ({ ok: false, status: 400, json: async () => [] }));
  expect(failed.book.incidents.some((line) => line.includes("hour delta BTC-USD 400"))).toBe(true);
  expect(failed.seedMarks.get("BTC-USD")?.newestTs).toBe(watermark);
});

test("taking the lease reloads marks and does not refetch a stored 1000-bar series", async () => {
  const ids = Array.from({ length: 50 }, (_, index) => `P${String(index).padStart(2, "0")}-USD`);
  const kv = memoryKv(() => NOW);
  const seedOnce = async () => {
    const host = startPaperHost(ids, {});
    host.clock = () => NOW;
    const saved = await loadSplit(kv, host);
    if (saved) installPaperState(host, saved);
    await seedBudgeted(host, async (url) => seededCandles(url));
    widenFourBars(host);
    host.warmupStored = true;
    await persistSplit(kv, host);
    return host;
  };
  await seedOnce();
  const watcher = startPaperHost(ids, {});
  watcher.clock = () => NOW;
  const holder = hostHolder(watcher, kv);
  await holder.warm();
  expect(watcher.seedCursor.idx).toBe(13);
  const second = await seedOnce();
  expect(second.seedCursor.idx).toBe(26);
  const poisoned = second.seedCursor.order.slice(13, 26);
  for (const id of poisoned) {
    const mark = JSON.parse((await kv.get(seedMarkKey(id))) ?? "{}") as { status: string };
    expect(mark.status).toBe("warm");
    await kv.set(seedMarkKey(id), JSON.stringify({ ...mark, status: "short", reason: "short" }));
    expect(watcher.seedMarks.get(id)?.status).not.toBe("warm");
  }
  await holder.reload();
  expect(watcher.seedCursor.idx).toBe(26);
  for (const id of poisoned) {
    expect(watcher.seedMarks.get(id)?.status).toBe("warm");
    expect(watcher.fourBars.get(id)?.length ?? 0).toBeGreaterThanOrEqual(1000);
  }
  const calls = new Map<string, number>();
  await seedBudgeted(watcher, async (url) => {
    const id = new URL(url).pathname.split("/")[2] ?? "";
    calls.set(id, (calls.get(id) ?? 0) + 1);
    return seededCandles(url);
  });
  for (const id of poisoned) expect(calls.get(id) ?? 0).toBeLessThanOrEqual(1);
  const reseeded = [...calls.entries()].filter(([, n]) => n > 2);
  expect(reseeded).toHaveLength(13);
  expect(watcher.seedCursor.idx).toBe(39);
}, 60_000);
