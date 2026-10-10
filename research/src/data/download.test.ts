import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPacer, downloadUsdSpot } from "./download";
import { BAR_SEC } from "./time";
import { readPairMonth } from "./store";
import type { UsdSpotProduct } from "./products";
import { rootHash } from "./hash";
import { readFileSync } from "node:fs";

const stamp = {
  commitSha: "d".repeat(40),
  dataRootHash: null,
  createdAt: "2026-10-10T00:00:00.000Z",
  phaseId: "P1",
};

function product(productId: string, statusRaw = "online"): UsdSpotProduct {
  return {
    productId,
    base: productId.slice(0, productId.indexOf("-")),
    quote: "USD",
    status: statusRaw === "online" ? "online" : statusRaw === "delisted" ? "delisted" : "other",
    statusRaw,
    tickSize: "0.01",
    tradingDisabled: statusRaw !== "online",
    listingDate: null,
  };
}

function candleResponse(url: string, omit: ReadonlySet<number>): Response {
  const parsed = new URL(url);
  const start = Number(parsed.searchParams.get("start"));
  const end = Number(parsed.searchParams.get("end"));
  const rows: number[][] = [];
  for (let minute = start; minute <= end; minute += BAR_SEC) {
    if (omit.has(minute)) continue;
    rows.push([minute, 1, 2, 1.5, 1.8, 3.25]);
  }
  return new Response(JSON.stringify(rows), { status: 200 });
}

test("pacer spaces requests", async () => {
  let t = 0;
  const sleeps: number[] = [];
  const pace = createPacer(1000, () => t, async (ms) => {
    sleeps.push(ms);
    t += ms;
  });
  await pace();
  await pace();
  expect(sleeps).toEqual([1000]);
});

test("downloader records empty minutes, retries, resumes, and hashes stably", async () => {
  const now = new Date("2023-10-06T12:00:00.000Z");
  const listing = Date.parse("2023-10-02T00:00:00.000Z") / 1000;
  const omit = new Set<number>([listing + BAR_SEC]);
  const dirA = mkdtempSync(join(tmpdir(), "research-dl-"));
  const urls: string[] = [];
  let failuresLeft = 1;
  const fetchImpl = async (url: string | URL | Request) => {
    const href = String(url);
    urls.push(href);
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      return new Response("busy", { status: 500 });
    }
    return candleResponse(href, omit);
  };
  const sleeps: number[] = [];
  const first = await downloadUsdSpot({
    products: [product("AAA-USD")],
    dataDir: dirA,
    now,
    stamp,
    fetchImpl,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    nowMs: () => 0,
    intervalMs: 0,
    maxChunks: 1,
    listingSec: () => listing,
    log: () => {},
  });
  expect(first.stopped).toBe("max-chunks");
  expect(first.completedMonths).toBe(0);
  expect(sleeps[0]).toBe(500);
  expect(existsSync(join(dirA, "candles", "AAA-USD", "2023-10.sqlite"))).toBe(false);

  const second = await downloadUsdSpot({
    products: [product("AAA-USD")],
    dataDir: dirA,
    now,
    stamp,
    fetchImpl,
    sleep: async () => {},
    nowMs: () => 1_000,
    intervalMs: 0,
    listingSec: () => listing,
    log: () => {},
  });
  expect(second.stopped).toBe("finished");
  expect(second.completedMonths).toBe(1);
  const stored = readPairMonth(join(dirA, "candles", "AAA-USD", "2023-10.sqlite"));
  const gap = stored.rows.find((row) => row.minuteSec === listing + BAR_SEC);
  expect(gap).toEqual({ minuteSec: listing + BAR_SEC, empty: true, open: null, high: null, low: null, close: null, volume: null });
  expect(stored.rows[0]?.close).toBe("1.8");
  expect(urls.every((url) => url.includes("/candles?") && !url.includes("order"))).toBe(true);

  const dirB = mkdtempSync(join(tmpdir(), "research-dl-"));
  await downloadUsdSpot({
    products: [product("AAA-USD")],
    dataDir: dirB,
    now,
    stamp,
    fetchImpl: async (url) => candleResponse(String(url), omit),
    sleep: async () => {},
    nowMs: () => 0,
    intervalMs: 0,
    listingSec: () => listing,
    log: () => {},
  });
  const manifestA = JSON.parse(readFileSync(join(dirA, "data-manifest.json"), "utf8")) as { dataRootHash: string; files: { sha256: string }[] };
  const manifestB = JSON.parse(readFileSync(join(dirB, "data-manifest.json"), "utf8")) as { dataRootHash: string; files: { path: string; sha256: string; bytes: number }[] };
  expect(manifestA.dataRootHash).toBe(manifestB.dataRootHash);
  expect(manifestA.dataRootHash).toBe(rootHash(manifestB.files));
});

test("a 404 does not invent empty minutes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-miss-"));
  const summary = await downloadUsdSpot({
    products: [product("GONE-USD", "delisted"), product("AAA-USD")],
    dataDir: dir,
    now: new Date("2023-10-03T12:00:00.000Z"),
    stamp,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("GONE-USD")) return new Response('{"message":"NotFound"}', { status: 404 });
      return candleResponse(href, new Set());
    },
    sleep: async () => {},
    nowMs: () => 0,
    intervalMs: 0,
    listingSec: () => Date.parse("2023-10-02T23:00:00.000Z") / 1000,
    log: () => {},
  });
  expect(summary.completedMonths).toBe(1);
  expect(existsSync(join(dir, "candles", "GONE-USD", "unavailable.json"))).toBe(true);
  expect(existsSync(join(dir, "candles", "GONE-USD", "2023-10.sqlite"))).toBe(false);
  expect(existsSync(join(dir, "candles", "AAA-USD", "2023-10.sqlite"))).toBe(true);
});

test("concurrent products share the pacer and one manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "research-parallel-"));
  const now = new Date("2023-10-03T12:00:00.000Z");
  const listing = Date.parse("2023-10-02T00:00:00.000Z") / 1000;
  const summary = await downloadUsdSpot({
    products: [product("BBB-USD"), product("AAA-USD", "delisted")],
    dataDir: dir,
    now,
    stamp,
    fetchImpl: async (url) => candleResponse(String(url), new Set()),
    sleep: async () => {},
    nowMs: () => 0,
    intervalMs: 0,
    concurrency: 2,
    listingSec: () => listing,
    log: () => {},
  });
  expect(summary.stopped).toBe("finished");
  expect(summary.completedMonths).toBe(2);
  const manifest = JSON.parse(readFileSync(join(dir, "data-manifest.json"), "utf8")) as {
    dataRootHash: string;
    files: { path: string; sha256: string; bytes: number }[];
  };
  expect(manifest.files.map((file) => file.path)).toEqual([
    "candles/AAA-USD/2023-10.sqlite",
    "candles/BBB-USD/2023-10.sqlite",
  ]);
  expect(manifest.dataRootHash).toBe(rootHash(manifest.files));
});
