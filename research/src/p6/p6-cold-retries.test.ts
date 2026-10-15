import { expect, test } from "bun:test";
import { FILLS_KEY, LAST_RUN_KEY, bar4hKey, loadSplit, persistSplit, writeThroughBook } from "./hot-store";
import { FOUR_KEEP, catchUpHistory, installPaperState, seedBudgeted, seedMarkKey, SEED_CURSOR_KEY, startPaperHost, type PaperHost } from "./paper-host";
import { decodeLease, LEASE_KEY, memoryKv, tryAcquire } from "./relay";
import { hostHolder } from "./vercel-live";
import type { LegLog } from "./legs";
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

/** Sleep moves the clock. A fixed `now` never leaves the 1s send window, so the fifth attempt would wait forever. */
function movingClock(start = 0, deadlineMs = 1_000_000_000_000): Pick<RestRun["deps"], "now" | "sleep" | "rand" | "deadlineMs"> {
  let now = start;
  return {
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
    rand: () => 0,
    deadlineMs: () => deadlineMs,
  };
}

function quiet(run: RestRun, fetchImpl: (url: string) => Promise<Response>, start = 0, deadlineMs = 1_000_000_000_000): void {
  const clock = movingClock(start, deadlineMs);
  run.deps.now = clock.now;
  run.deps.sleep = clock.sleep;
  run.deps.rand = clock.rand;
  run.deps.deadlineMs = clock.deadlineMs;
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
    ...movingClock(),
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
    ...movingClock(),
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
    ...movingClock(1_000_000, 1_000_000),
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
    ...movingClock(),
    fetch: async () => {
      throw new Error("injected");
    },
  });
  const threw = await limited(`${EXCHANGE}/products/BTC-USD/trades`, thrown, { cold: false, backfill: true });
  expect(threw.status).toBe(599);
  expect(restStats(thrown).n).toBe(REST_MAX_ATTEMPTS);
  expect(isCold("BTC-USD", thrown)).toBe(false);

  const unavailable = createRestRun(1_000_000_000_000, {
    ...movingClock(),
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

function seededPage(url: string): Response {
  const parsed = new URL(url);
  const gran = Number(parsed.searchParams.get("granularity"));
  const start = Number(parsed.searchParams.get("start"));
  const end = Number(parsed.searchParams.get("end"));
  if (gran === 86_400) return new Response(JSON.stringify([[start, 99, 101, 100, 100.5, 10]]), { status: 200 });
  const rows: number[][] = [];
  for (let ts = start; ts <= end && rows.length < 300; ts += 3_600) rows.push([ts, 99, 101, 100, 100.5, 10]);
  return new Response(JSON.stringify(rows), { status: 200 });
}

test("S: a product being seeded is not stored and is retried after a transient failure", async () => {
  for (const mode of ["throw", "503", "deadline"] as const) {
    const kv = memoryKv(() => NOW);
    const host = startPaperHost(["BTC-USD"], {});
    host.clock = () => NOW;
    let sent = 0;
    const failing = async () => {
      sent += 1;
      if (mode === "throw") throw new Error("fetch failed");
      if (mode === "503") return new Response("", { status: 503 });
      return seededPage("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=3600&start=0&end=0");
    };
    quiet(host.restRun, failing, NOW, mode === "deadline" ? NOW + 60_000 : NOW + 800_000);
    host.seedCursor = { order: ["BTC-USD"], idx: 0, runId: "s" };
    await seedBudgeted(host);
    expect(sent).toBe(mode === "deadline" ? 0 : REST_MAX_ATTEMPTS);
    expect(host.seedCursor.idx).toBe(1);
    expect(host.seedCursor.retry).toEqual(["BTC-USD"]);
    expect(host.seedCursor.order).toEqual(["BTC-USD"]);
    expect(host.seedCursor.runId).toBe("s");
    expect(host.seedMarks.has("BTC-USD")).toBe(false);
    expect(host.cold.has("BTC-USD")).toBe(true);
    host.warmupStored = true;
    await persistSplit(kv, host);
    expect(await kv.get(seedMarkKey("BTC-USD"))).toBeNull();

    const next = startPaperHost(["BTC-USD"], {});
    next.clock = () => NOW;
    let retried = 0;
    quiet(next.restRun, async (url) => {
      retried += 1;
      return seededPage(url);
    }, NOW, NOW + 800_000);
    const saved = await loadSplit(kv, next);
    expect(saved).toBeTruthy();
    if (saved) installPaperState(next, saved);
    expect(next.seedCursor.idx).toBe(1);
    expect(next.seedCursor.retry).toEqual(["BTC-USD"]);
    expect(next.cold.has("BTC-USD")).toBe(false);
    await seedBudgeted(next);
    expect(retried).toBeGreaterThan(0);
    expect(next.seedMarks.get("BTC-USD")).toMatchObject({ status: "warm", reason: "seeded" });
    expect(next.seedCursor.retry).toEqual([]);
    expect(next.cold.has("BTC-USD")).toBe(false);
  }
});

test("a 404 on the first seed walk still stores cold and advances the cursor", async () => {
  const host = startPaperHost(["GONE-USD"], {});
  host.clock = () => NOW;
  quiet(host.restRun, async () => new Response("", { status: 404 }), NOW, NOW + 800_000);
  host.seedCursor = { order: ["GONE-USD"], idx: 0, runId: "gone" };
  await seedBudgeted(host);
  expect(host.seedMarks.get("GONE-USD")).toMatchObject({ status: "cold", reason: "http-404" });
  expect(host.seedCursor.idx).toBe(1);
  expect(host.seedCursor.retry).toEqual([]);
});

test("a persistent 503 or throw seeds the products behind it and retries the failed one", async () => {
  const order = ["BAD", "AAA", "BBB", "CCC"];
  for (const mode of ["503", "throw"] as const) {
    const kv = memoryKv(() => NOW);
    const calls = new Map<string, number>(order.map((id) => [id, 0]));
    let badHealthy = false;
    let runId = "";
    for (let run = 0; run < 3; run += 1) {
      const beforeBad = calls.get("BAD") ?? 0;
      const host = startPaperHost(order, {});
      host.clock = () => NOW;
      quiet(host.restRun, async (url) => {
        const id = decodeURIComponent(new URL(url).pathname.split("/")[2] ?? "");
        calls.set(id, (calls.get(id) ?? 0) + 1);
        if (id === "BAD" && !badHealthy) {
          if (mode === "throw") throw new Error("fetch failed");
          return new Response("", { status: 503 });
        }
        return seededPage(url);
      }, NOW, NOW + 800_000);
      const saved = await loadSplit(kv, host);
      if (saved) installPaperState(host, saved);
      if (host.seedCursor.order.length === 0) host.seedCursor = { order: [...order], idx: 0, runId: "starve", retry: [] };
      await seedBudgeted(host);
      expect(host.seedCursor.order).toEqual(order);
      expect(host.seedCursor.runId).toBe("starve");
      expect(host.seedCursor.retry).toEqual(["BAD"]);
      expect(host.seedCursor.idx).toBe(order.length);
      expect(host.seedMarks.has("BAD")).toBe(false);
      expect(host.cold.has("BAD")).toBe(true);
      for (const id of ["AAA", "BBB", "CCC"]) {
        expect(host.seedMarks.get(id)).toMatchObject({ status: "warm", reason: "seeded" });
      }
      expect((calls.get("BAD") ?? 0) - beforeBad).toBe(REST_MAX_ATTEMPTS);
      host.warmupStored = true;
      await persistSplit(kv, host);
      expect(await kv.get(seedMarkKey("BAD"))).toBeNull();
      const stored = JSON.parse((await kv.get(SEED_CURSOR_KEY)) ?? "{}") as { order?: string[]; runId?: string; retry?: string[]; idx?: number };
      expect(stored.order).toEqual(order);
      expect(stored.runId).toBe("starve");
      expect(stored.retry).toEqual(["BAD"]);
      runId = stored.runId ?? "";
    }
    expect(runId).toBe("starve");
    for (const id of ["AAA", "BBB", "CCC"]) expect((calls.get(id) ?? 0)).toBeGreaterThan(0);

    badHealthy = true;
    const host = startPaperHost(order, {});
    host.clock = () => NOW;
    quiet(host.restRun, async (url) => {
      const id = decodeURIComponent(new URL(url).pathname.split("/")[2] ?? "");
      calls.set(id, (calls.get(id) ?? 0) + 1);
      return seededPage(url);
    }, NOW, NOW + 800_000);
    const saved = await loadSplit(kv, host);
    expect(saved).toBeTruthy();
    if (saved) installPaperState(host, saved);
    expect(host.seedCursor.retry).toEqual(["BAD"]);
    expect(host.cold.has("BAD")).toBe(false);
    await seedBudgeted(host);
    expect(host.seedMarks.get("BAD")).toMatchObject({ status: "warm", reason: "seeded" });
    expect(host.seedCursor.retry).toEqual([]);
    expect(host.seedCursor.order).toEqual(order);
    expect(host.seedCursor.runId).toBe("starve");
    expect(host.cold.has("BAD")).toBe(false);
    for (const id of ["AAA", "BBB", "CCC"]) {
      expect(host.seedMarks.get(id)).toMatchObject({ status: "warm", reason: "seeded" });
    }
  }
});

test("the default fetch aborts a hung call inside the deadline margin", async () => {
  expect(REST_FETCH_TIMEOUT_MS).toBe(20_000);
  expect(REST_FETCH_TIMEOUT_MS).toBeLessThan(REST_DEADLINE_MARGIN_MS);
  const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> =>
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

test("warm hour deltas run before the retry list so catch-up still reaches every warm product", async () => {
  const warm = Array.from({ length: 30 }, (_, index) => `W${String(index).padStart(2, "0")}`);
  const retry = Array.from({ length: 20 }, (_, index) => `R${String(index).padStart(2, "0")}`);
  const products = [...warm, ...retry];
  const host = startPaperHost(products, {});
  host.clock = () => NOW;
  const nowSec = Math.floor(NOW / 1000);
  const newest15 = Math.floor(nowSec / 900) * 900 - 900;
  for (const id of warm) {
    host.seedMarks.set(id, { oldestTs: 1, newestTs: nowSec - 2 * 3_600, status: "warm", reason: "seeded" });
    host.restCursor.set(id, newest15);
  }
  host.seedCursor = { order: products, idx: warm.length, runId: "y", retry: [...retry] };
  const hour = new Set<string>();
  const caught = new Set<string>();
  let retryBeforeDeltas = false;
  quiet(host.restRun, async (url) => {
    const parsed = new URL(url);
    const id = decodeURIComponent(parsed.pathname.split("/")[2] ?? "");
    const gran = Number(parsed.searchParams.get("granularity"));
    if (retry.includes(id) && hour.size < warm.length) retryBeforeDeltas = true;
    if (gran === 3_600 && warm.includes(id)) hour.add(id);
    if (gran === 900 && warm.includes(id)) caught.add(id);
    return seededPage(url);
  }, NOW, NOW + 800_000);
  await seedBudgeted(host);
  await catchUpHistory(host);
  expect(retryBeforeDeltas).toBe(false);
  expect(hour.size).toBe(warm.length);
  expect(caught.size).toBe(warm.length);
});

function fillLeg(id: string): LegLog {
  return {
    id,
    productId: "ETH-USD",
    classId: "A",
    side: "entry",
    arrivalMid: 1,
    arrivalBid: 1,
    arrivalAsk: 1,
    arrivalSnapshotTs: NOW,
    orderSendTs: NOW,
    decisionMid: 1,
    activeStop: null,
    triggerBarTs: null,
    fillPrice: 1,
    units: 1,
    feesUsd: 0,
  };
}

test("a hung product renews the lease and the run's saves persist", async () => {
  for (const mode of ["one-hang", "three-hangs"] as const) {
    const products = ["AVAX-USD", "BCH-USD", "BTC-USD", "ETH-USD", "SOL-USD"];
    let now = NOW;
    const kv = memoryKv(() => now);
    expect(await tryAcquire(kv, "cron", NOW + 1_800_000, NOW)).toBe(true);
    now = NOW + 130_000;
    const host = startPaperHost(products, {});
    host.clock = () => now;
    host.restWarm = true;
    host.shards = [];
    host.openSockets = [];
    host.seedCursor = { order: [...products], idx: 0, runId: "lease", retry: [] };
    const calls = new Map<string, number>();
    host.restRun.deps.now = () => now;
    host.restRun.deps.sleep = async (ms) => {
      now += ms;
    };
    host.restRun.deps.rand = () => 0;
    host.restRun.deps.deadlineMs = () => NOW + 800_000;
    host.restRun.deps.fetch = async (url) => {
      const id = decodeURIComponent(new URL(url).pathname.split("/")[2] ?? "");
      calls.set(id, (calls.get(id) ?? 0) + 1);
      if (id === "BTC-USD") {
        now += 100_000;
        throw new DOMException("The operation was aborted", "AbortError");
      }
      if (mode === "three-hangs" && id === "AVAX-USD") throw new Error("fetch failed");
      if (mode === "three-hangs" && id === "BCH-USD") return new Response("", { status: 503 });
      const gran = Number(new URL(url).searchParams.get("granularity"));
      if (gran === 86_400) {
        const start = Number(new URL(url).searchParams.get("start"));
        return new Response(JSON.stringify([[start, 1, 1, 1, 1, 1]]), { status: 200 });
      }
      return new Response("[]", { status: 200 });
    };
    const holder = hostHolder(host, kv);
    await holder.sampleUntil(NOW);
    expect(host.book.incidents.some((row) => row.includes("lease lost"))).toBe(false);
    const lease = decodeLease(await kv.get(LEASE_KEY));
    expect(lease?.release).toBe("none");
    expect(lease?.savedAtMs).toBeGreaterThanOrEqual(NOW + 130_000);
    const cursor = JSON.parse((await kv.get(SEED_CURSOR_KEY)) ?? "null") as { retry?: string[]; order?: string[]; runId?: string } | null;
    expect(cursor?.order).toEqual(products);
    expect(cursor?.runId).toBe("lease");
    expect(cursor?.retry).toContain("BTC-USD");
    expect(await kv.get(seedMarkKey("BTC-USD"))).toBeNull();
    expect(calls.get("BTC-USD")).toBe(1);
    const eth = JSON.parse((await kv.get(seedMarkKey("ETH-USD"))) ?? "null") as { status?: string } | null;
    expect(eth?.status).toBe("cold");
    if (mode === "three-hangs") {
      expect(cursor?.retry).toEqual(["AVAX-USD", "BCH-USD", "BTC-USD"]);
      expect(calls.get("AVAX-USD")).toBe(REST_MAX_ATTEMPTS);
      expect(await kv.get(seedMarkKey("AVAX-USD"))).toBeNull();
      expect(await kv.get(seedMarkKey("BCH-USD"))).toBeNull();
    }
    host.book.legs.push(fillLeg(`fill-${mode}`));
    await writeThroughBook(kv, host);
    expect(await kv.get(FILLS_KEY)).toContain(`fill-${mode}`);
  }
}, 20_000);
