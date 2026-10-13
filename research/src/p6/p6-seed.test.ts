import { expect, test } from "bun:test";
import { memoryKv } from "./relay";
import { LAST_RUN_KEY, loadSplit, persistSplit } from "./hot-store";
import { SEED_BUDGET } from "./rest-limit";
import { hostHolder } from "./vercel-live";
import { acceptRestBar, backfillTapeIfNeeded, installPaperState, seedBudgeted, seedFourHours, SEED_REQUESTS_PER_PRODUCT, startPaperHost } from "./paper-host";
import { hourPagesForKeep } from "./warm-caps";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");

function candle(ts: number): number[] {
  return [ts, 99, 101, 100, 100.5, 10];
}

test("a product listed 30 days ago stops on the short page", async () => {
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
  expect(calls).toBeLessThanOrEqual(3);
  expect(host.seedMarks.get("THIN-USD")?.reason).toBe("listing");
  expect(host.cold.has("THIN-USD")).toBe(true);
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

test("50 products at the seed budget finish in 3 runs and the cursor resumes", async () => {
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
  let idx = 0;
  for (let run = 0; run < 3; run += 1) {
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
    idx = host.seedCursor.idx;
    await persistSplit(kv, host);
    const cursor = JSON.parse((await kv.get("p6:seed:cursor")) ?? "{}") as { idx: number };
    expect(cursor.idx).toBe(idx);
    expect(await kv.get(LAST_RUN_KEY)).toBeTruthy();
  }
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

test("bars accepted while sampling are reported", () => {
  const host = startPaperHost(["BTC-USD"], {});
  host.products = [];
  host.shards = [];
  const holder = hostHolder(host, memoryKv());
  expect(holder.appliedDuringRun()).toEqual([]);
  acceptRestBar(host, { productId: "BTC-USD", startSec: 1_700_000_000, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  expect(holder.appliedDuringRun()).toEqual(["BTC-USD:1700000000"]);
});
