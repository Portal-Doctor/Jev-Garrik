import { expect, test } from "bun:test";
import { LAST_RUN_KEY, bar4hKey, loadSplit, persistSplit } from "./hot-store";
import { FOUR_KEEP, installPaperState, seedMarkKey, startPaperHost, type PaperHost } from "./paper-host";
import { memoryKv } from "./relay";
import {
  REST_DEADLINE_MARGIN_MS,
  REST_FETCH_TIMEOUT_MS,
  REST_MAX_ATTEMPTS,
  coldReasons,
  createRestRun,
  fetchWithTimeout,
  isCold,
  limited,
  markCold,
  restStats,
  type RestRun,
} from "./rest-limit";

const NOW = Date.parse("2026-10-14T12:00:00.000Z");
const EXCHANGE = "https://api.exchange.coinbase.com";

function candles(productId: string): string {
  return `${EXCHANGE}/products/${productId}/candles`;
}

function quiet(run: RestRun, fetchImpl: (url: string) => Promise<Response>, now = 0, deadlineMs = 1_000_000_000_000): void {
  run.deps.now = () => now;
  run.deps.sleep = async () => undefined;
  run.deps.rand = () => 0;
  run.deps.deadlineMs = () => deadlineMs;
  run.deps.fetch = fetchImpl;
}

function warmBars(): { ts: number; open: number; high: number; low: number; close: number; volume: number }[] {
  return Array.from({ length: FOUR_KEEP }, (_, index) => ({
    ts: index * 14_400,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
  }));
}

/** A stored warm series. The bars are written as one value so the flush does not rebuild them. */
async function warmProduct(productId: string): Promise<{ kv: ReturnType<typeof memoryKv>; host: PaperHost }> {
  const kv = memoryKv(() => NOW);
  const seeded = startPaperHost([productId], {});
  seeded.clock = () => NOW;
  await persistSplit(kv, seeded);
  const bars = warmBars();
  const mark = { oldestTs: bars[0]!.ts, newestTs: bars[bars.length - 1]!.ts, status: "warm", reason: "seeded" };
  await kv.set(seedMarkKey(productId), JSON.stringify(mark));
  await kv.set(bar4hKey(productId), JSON.stringify(bars));
  const host = startPaperHost([productId], {});
  host.clock = () => NOW;
  const body = await loadSplit(kv, host);
  expect(body).toBeTruthy();
  installPaperState(host, body!);
  expect(host.seedMarks.get(productId)).toMatchObject(mark);
  expect(host.cold.has(productId)).toBe(false);
  expect(host.fourFlushed.has(productId)).toBe(true);
  return { kv, host };
}

async function expectStillWarm(kv: ReturnType<typeof memoryKv>, productId: string): Promise<void> {
  const stored = JSON.parse((await kv.get(seedMarkKey(productId))) ?? "null") as { status?: string; reason?: string } | null;
  expect(stored).toMatchObject({ status: "warm", reason: "seeded" });
  const last = JSON.parse((await kv.get(LAST_RUN_KEY)) ?? "{}") as { cold?: { id: string }[] };
  expect(last.cold ?? []).toEqual([]);
  const next = startPaperHost([productId], {});
  next.clock = () => NOW;
  expect(await loadSplit(kv, next)).toBeTruthy();
  expect(next.seedMarks.get(productId)).toMatchObject({ status: "warm", reason: "seeded" });
  expect(next.cold.has(productId)).toBe(false);
}

test("five injected throws mark retries for this run only", async () => {
  let calls = 0;
  const run = createRestRun(1_000_000_000_000, {
    now: () => 0,
    sleep: async () => undefined,
    rand: () => 0,
    fetch: async () => {
      calls += 1;
      throw new Error("injected");
    },
  });
  const response = await limited(candles("AVAX-USD"), run);
  expect(response.status).toBe(599);
  expect(calls).toBe(REST_MAX_ATTEMPTS);
  expect(restStats(run).n).toBe(REST_MAX_ATTEMPTS);
  expect(coldReasons(run)).toEqual([{ id: "AVAX-USD", reason: "retries" }]);
});

test("five 503s mark retries for this run only", async () => {
  let calls = 0;
  const run = createRestRun(1_000_000_000_000, {
    now: () => 0,
    sleep: async () => undefined,
    rand: () => 0,
    fetch: async () => {
      calls += 1;
      return new Response("", { status: 503 });
    },
  });
  const response = await limited(candles("CRV-USD"), run);
  expect(response.status).toBe(503);
  expect(calls).toBe(REST_MAX_ATTEMPTS);
  expect(coldReasons(run)).toEqual([{ id: "CRV-USD", reason: "retries" }]);
});

test("a deadline before any request does not mark cold", async () => {
  let calls = 0;
  const run = createRestRun(1_000_000, {
    now: () => 1_000_000,
    sleep: async () => undefined,
    rand: () => 0,
    fetch: async () => {
      calls += 1;
      return new Response("ok", { status: 200 });
    },
  });
  const response = await limited(candles("BTC-USD"), run);
  expect(calls).toBe(0);
  expect(response.status).toBe(429);
  expect(isCold("BTC-USD", run)).toBe(false);
  expect(restStats(run).n).toBe(0);
});

test("cold:false never marks cold after throws, 503s, or a deadline mid-retry", async () => {
  const thrown = createRestRun(1_000_000_000_000, {
    now: () => 0,
    sleep: async () => undefined,
    rand: () => 0,
    fetch: async () => {
      throw new Error("injected");
    },
  });
  const threw = await limited(`${EXCHANGE}/products/BTC-USD/trades`, thrown, { cold: false, backfill: true });
  expect(threw.status).toBe(599);
  expect(restStats(thrown).n).toBe(REST_MAX_ATTEMPTS);
  expect(isCold("BTC-USD", thrown)).toBe(false);

  const unavailable = createRestRun(1_000_000_000_000, {
    now: () => 0,
    sleep: async () => undefined,
    rand: () => 0,
    fetch: async () => new Response("", { status: 503 }),
  });
  const missed = await limited(`${EXCHANGE}/products/ETH-USD/candles?granularity=60`, unavailable, { cold: false, backfill: true });
  expect(missed.status).toBe(503);
  expect(isCold("ETH-USD", unavailable)).toBe(false);

  let now = 0;
  let calls = 0;
  const late = createRestRun(REST_DEADLINE_MARGIN_MS + 50, {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    rand: () => 1,
    fetch: async () => {
      calls += 1;
      return new Response("", { status: 503 });
    },
  });
  await limited(candles("SOL-USD"), late, { cold: false, backfill: true });
  expect(calls).toBe(1);
  expect(isCold("SOL-USD", late)).toBe(false);
});

test("a warm product hit by thrown fetches stays warm on the next run", async () => {
  const { kv, host } = await warmProduct("AVAX-USD");
  let calls = 0;
  quiet(host.restRun, async () => {
    calls += 1;
    throw new Error("injected");
  });
  const response = await limited(candles("AVAX-USD"), host.restRun);
  expect(response.status).toBe(599);
  expect(calls).toBe(REST_MAX_ATTEMPTS);
  expect(host.restRun.cold.get("AVAX-USD")).toBe("retries");
  expect(host.cold.has("AVAX-USD")).toBe(true);
  expect(host.seedMarks.get("AVAX-USD")).toMatchObject({ status: "warm", reason: "seeded" });
  await persistSplit(kv, host);
  await expectStillWarm(kv, "AVAX-USD");
});

test("a warm product hit by 503s stays warm on the next run", async () => {
  const { kv, host } = await warmProduct("CRV-USD");
  quiet(host.restRun, async () => new Response("", { status: 503 }));
  const response = await limited(candles("CRV-USD"), host.restRun);
  expect(response.status).toBe(503);
  expect(host.restRun.cold.get("CRV-USD")).toBe("retries");
  expect(host.cold.has("CRV-USD")).toBe(true);
  expect(host.seedMarks.get("CRV-USD")).toMatchObject({ status: "warm", reason: "seeded" });
  await persistSplit(kv, host);
  await expectStillWarm(kv, "CRV-USD");
});

test("a deadline with no request leaves a warm product warm", async () => {
  const { kv, host } = await warmProduct("BTC-USD");
  let calls = 0;
  quiet(
    host.restRun,
    async () => {
      calls += 1;
      return new Response("ok", { status: 200 });
    },
    1_000_000,
    1_000_000,
  );
  const response = await limited(candles("BTC-USD"), host.restRun);
  expect(calls).toBe(0);
  expect(response.status).toBe(429);
  expect(host.restRun.cold.has("BTC-USD")).toBe(false);
  expect(host.cold.has("BTC-USD")).toBe(false);
  expect(host.seedMarks.get("BTC-USD")).toMatchObject({ status: "warm", reason: "seeded" });
  await persistSplit(kv, host);
  await expectStillWarm(kv, "BTC-USD");
});

test("cap skips this run and does not replace a warm mark", () => {
  const host = startPaperHost(["DOT-USD"], {});
  host.seedMarks.set("DOT-USD", { oldestTs: 1, newestTs: 2, status: "warm", reason: "seeded" });
  markCold("DOT-USD", host.restRun, "cap");
  expect(host.cold.has("DOT-USD")).toBe(true);
  expect(host.restRun.cold.get("DOT-USD")).toBe("cap");
  expect(host.seedMarks.get("DOT-USD")).toMatchObject({ status: "warm", reason: "seeded" });
});

test("a stored hole mark is not replaced by retries", async () => {
  const kv = memoryKv(() => NOW);
  const host = startPaperHost(["IP-USD"], {});
  host.clock = () => NOW;
  host.seedMarks.set("IP-USD", { oldestTs: 1, newestTs: 2, status: "cold", reason: "hole" });
  await persistSplit(kv, host);
  const loaded = startPaperHost(["IP-USD"], {});
  loaded.clock = () => NOW;
  expect(await loadSplit(kv, loaded)).toBeTruthy();
  expect(loaded.seedMarks.get("IP-USD")).toMatchObject({ status: "cold", reason: "hole" });
  quiet(loaded.restRun, async () => {
    throw new Error("injected");
  });
  await limited(candles("IP-USD"), loaded.restRun);
  expect(loaded.restRun.cold.get("IP-USD")).toBe("retries");
  expect(loaded.seedMarks.get("IP-USD")).toMatchObject({ status: "cold", reason: "hole" });
  await persistSplit(kv, loaded);
  const next = startPaperHost(["IP-USD"], {});
  next.clock = () => NOW;
  expect(await loadSplit(kv, next)).toBeTruthy();
  expect(next.seedMarks.get("IP-USD")).toMatchObject({ status: "cold", reason: "hole" });
  expect(next.cold.has("IP-USD")).toBe(true);
});

test("a 404 is still stored as a durable cold mark", async () => {
  const kv = memoryKv(() => NOW);
  const host = startPaperHost(["GONE-USD"], {});
  host.clock = () => NOW;
  quiet(host.restRun, async () => new Response("", { status: 404 }));
  const response = await limited(candles("GONE-USD"), host.restRun);
  expect(response.status).toBe(404);
  expect(restStats(host.restRun).n).toBe(1);
  expect(host.seedMarks.get("GONE-USD")).toMatchObject({ status: "cold", reason: "http-404" });
  await persistSplit(kv, host);
  const next = startPaperHost(["GONE-USD"], {});
  next.clock = () => NOW;
  expect(await loadSplit(kv, next)).toBeTruthy();
  expect(next.seedMarks.get("GONE-USD")).toMatchObject({ status: "cold", reason: "http-404" });
  expect(next.cold.has("GONE-USD")).toBe(true);
});

test("the default fetch aborts a hung call inside the deadline margin", async () => {
  expect(REST_FETCH_TIMEOUT_MS).toBe(20_000);
  expect(REST_FETCH_TIMEOUT_MS).toBeLessThan(REST_DEADLINE_MARGIN_MS);
  const fetchImpl: typeof fetch = (_url, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing abort signal"));
        return;
      }
      signal.addEventListener("abort", () => {
        reject(new DOMException("The operation was aborted", "AbortError"));
      });
    });
  const started = Date.now();
  await expect(fetchWithTimeout("https://example.invalid/products/BTC-USD/candles", 40, fetchImpl)).rejects.toThrow(/abort/i);
  expect(Date.now() - started).toBeLessThan(2_000);
});
