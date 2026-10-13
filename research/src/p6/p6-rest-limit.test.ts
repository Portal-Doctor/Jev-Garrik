import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKFILL_CAP, OPERATING_CAP, REST_HARD_CAP, SEED_BUDGET, coldProducts, coldReasons, createRestRun, isCold, limited, resetRestLimit, restStats } from "./rest-limit";

const host = "https://api.exchange.coinbase.com";

test("a 429 with Retry-After 2 waits at least 2s and then returns 200", async () => {
  let now = 0;
  let calls = 0;
  resetRestLimit({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    rand: () => 0,
    deadlineMs: () => 1_000_000_000,
    fetch: async () => {
      calls += 1;
      if (calls === 1) return new Response("", { status: 429, headers: { "retry-after": "2" } });
      return new Response("ok", { status: 200 });
    },
  });
  const response = await limited(`${host}/products/BTC-USD/book?level=1`);
  expect(response.status).toBe(200);
  expect(now).toBeGreaterThanOrEqual(2_000);
  expect(restStats().r429).toBe(1);
  expect(calls).toBe(2);
});

test("five 429s flag that product cold and the next product still runs", async () => {
  let now = 0;
  resetRestLimit({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    rand: () => 0,
    deadlineMs: () => 1_000_000_000,
    fetch: async (url) => {
      if (url.includes("AAA-USD")) return new Response("", { status: 429, headers: { "retry-after": "0" } });
      return new Response("[]", { status: 200 });
    },
  });
  const denied = await limited(`${host}/products/AAA-USD/candles`);
  const next = await limited(`${host}/products/BBB-USD/candles`);
  expect(denied.status).toBe(429);
  expect(next.ok).toBe(true);
  expect(isCold("AAA-USD")).toBe(true);
  expect(isCold("BBB-USD")).toBe(false);
  expect(coldProducts()).toEqual(["AAA-USD"]);
  expect(restStats().n).toBe(6);
  expect(restStats().r429).toBe(5);
});

test("the lane never sends more than 4 requests in any 1s window", async () => {
  let now = 0;
  resetRestLimit({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    rand: () => 0,
    deadlineMs: () => 1_000_000_000,
    fetch: async () => new Response("ok", { status: 200 }),
  });
  const sent: number[] = [];
  for (let i = 0; i < 8; i += 1) {
    await limited(`${host}/products/BTC-USD/book?level=2`);
    sent.push(now);
  }
  expect(restStats().n).toBe(8);
  for (const start of sent) {
    const inWindow = sent.filter((at) => at >= start && at < start + 1_000).length;
    expect(inWindow).toBeLessThanOrEqual(4);
  }
});

test("retries stop at the deadline minus 90s", async () => {
  let now = 0;
  let calls = 0;
  resetRestLimit({
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    rand: () => 1,
    deadlineMs: () => 90_000 + 100,
    fetch: async () => {
      calls += 1;
      return new Response("", { status: 500 });
    },
  });
  const response = await limited(`${host}/products/BTC-USD/candles`);
  expect(response.status).toBe(500);
  expect(calls).toBe(1);
  expect(isCold("BTC-USD")).toBe(true);
});

test("a 404 is one attempt and that product is cold", async () => {
  let calls = 0;
  resetRestLimit({
    now: () => 0,
    sleep: async () => undefined,
    rand: () => 0,
    deadlineMs: () => 1_000_000_000,
    fetch: async () => {
      calls += 1;
      return new Response("", { status: 404 });
    },
  });
  const response = await limited(`${host}/products/GONE-USD/candles`);
  expect(response.status).toBe(404);
  expect(calls).toBe(1);
  expect(restStats().n).toBe(1);
  expect(isCold("GONE-USD")).toBe(true);
  expect(coldReasons()).toEqual([{ id: "GONE-USD", reason: "http-404" }]);
});

test("two runs do not share counters", async () => {
  const deps = {
    now: () => 0,
    sleep: async () => undefined,
    rand: () => 0,
    fetch: async () => new Response("ok", { status: 200 }),
  };
  const a = createRestRun(1_000_000_000, deps);
  const b = createRestRun(1_000_000_000, deps);
  await limited(`${host}/products/AAA-USD/candles`, a);
  await limited(`${host}/products/BBB-USD/candles`, b);
  await limited(`${host}/products/AAA-USD/book?level=1`, a);
  expect(restStats(a).n).toBe(2);
  expect(restStats(b).n).toBe(1);
  expect(isCold("AAA-USD", a)).toBe(false);
});

test("a spent budget does not mark the product cold, and live confirms still send", async () => {
  let now = 0;
  const run = createRestRun(1_000_000_000, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    rand: () => 0,
    fetch: async () => new Response("[]", { status: 200 }),
  });
  for (let i = 0; i < SEED_BUDGET; i += 1) {
    const response = await limited(`${host}/products/BTC-USD/candles?granularity=86400`, run, { seed: true });
    expect(response.status).toBe(200);
  }
  const seedStop = await limited(`${host}/products/ETH-USD/candles?granularity=86400`, run, { seed: true });
  expect(seedStop.headers.get("x-p6-budget")).toBe("seed");
  expect(seedStop.status).toBe(429);
  expect(isCold("ETH-USD", run)).toBe(false);
  expect(restStats(run).n).toBe(SEED_BUDGET);

  while (restStats(run).n < OPERATING_CAP) {
    const response = await limited(`${host}/products/SOL-USD/candles`, run);
    expect(response.status).toBe(200);
  }
  const booksStop = await limited(`${host}/products/SOL-USD/book?level=2`, run);
  expect(booksStop.headers.get("x-p6-budget")).toBe("reserve");
  expect(isCold("SOL-USD", run)).toBe(false);
  expect(restStats(run).n).toBe(OPERATING_CAP);

  const backfill = await limited(`${host}/products/BTC-USD/trades`, run, { backfill: true, cold: false });
  expect(backfill.status).toBe(200);
  while (restStats(run).n < BACKFILL_CAP) {
    await limited(`${host}/products/BTC-USD/trades`, run, { backfill: true, cold: false });
  }
  const backfillStop = await limited(`${host}/products/ADA-USD/trades`, run, { backfill: true, cold: false });
  expect(backfillStop.headers.get("x-p6-budget")).toBe("reserve");
  expect(isCold("ADA-USD", run)).toBe(false);
  expect(restStats(run).n).toBe(BACKFILL_CAP);

  const live = await limited(`${host}/products/BTC-USD/candles?granularity=900`, run, { live: true });
  expect(live.status).toBe(200);
  while (restStats(run).n < REST_HARD_CAP) {
    await limited(`${host}/products/BTC-USD/candles?granularity=900`, run, { live: true });
  }
  const liveStop = await limited(`${host}/products/DOGE-USD/candles?granularity=900`, run, { live: true });
  expect(liveStop.headers.get("x-p6-budget")).toBe("hard");
  expect(isCold("DOGE-USD", run)).toBe(false);
  expect(isCold("BTC-USD", run)).toBe(false);
  expect(restStats(run).n).toBe(REST_HARD_CAP);
});

test("no raw fetch( outside rest-limit.ts", () => {
  const dir = join(import.meta.dir);
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "rest-limit.ts");
  const hits = files.filter((name) => readFileSync(join(dir, name), "utf8").includes("fetch("));
  expect(hits).toEqual([]);
});
