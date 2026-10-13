import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { coldProducts, isCold, limited, resetRestLimit, restStats } from "./rest-limit";

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

test("no raw fetch( outside rest-limit.ts", () => {
  const dir = join(import.meta.dir);
  const files = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "rest-limit.ts");
  const hits = files.filter((name) => readFileSync(join(dir, name), "utf8").includes("fetch("));
  expect(hits).toEqual([]);
});
