import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { addDays } from "../p5/stats";
import { classAMinOrderBase, classAMinSizeOf, ensureClassAMinSizes, loadClassAMinSizes } from "./class-a-live";
import { emptyClassABook, evaluateSignal, signalCloseMs, type ClassADay, type ClassASignal } from "./class-a-paper";
import { dataFile } from "./live-data";
import nextConfig from "../../../web/next.config";

const PRODUCTS_FILE = "../research/data/products/exchange-products.raw.json";
const PUBLIC_PRODUCTS_URL = "https://api.exchange.coinbase.com/products";
const START = Date.parse("2024-01-01T00:00:00.000Z");

function daysOf(baseVolume = 100_000, last = 100.05): ClassADay[] {
  const n = 70;
  return Array.from({ length: n }, (_, i) => {
    const close = i === n - 1 ? last : 100;
    return {
      date: addDays("2024-01-01", i),
      high: close + 0.05,
      low: close - 0.05,
      close,
      baseVolume,
    };
  });
}

function signal(over: Partial<ClassASignal> = {}): ClassASignal {
  const days = over.days ?? daysOf();
  const index = over.index ?? days.length - 1;
  const close = days[index]!.close;
  const at = signalCloseMs(days[index]!.date);
  return {
    pair: "SOL-USD",
    listedDays: 120,
    btcClose: 110,
    btcEma50: 90,
    btcDailyMove: 0,
    btcSma200: 100,
    btcSma50: 90,
    btcSma50TenAgo: 80,
    spreadBps: 1,
    depthCostBps: 1,
    quoteAgeMs: 100,
    minOrderBase: 0.0001,
    tick: 0.01,
    medianSpreadBps: 10,
    spreadSamples: Array.from({ length: 30 }, () => 10),
    nextHourOpen: close,
    hourAtr14: 0.2,
    prints: [{ tsMs: at + 60_000, price: close - 0.01 }],
    ...over,
    days,
    index,
  };
}

function btcRow(): { base_min_size?: unknown; base_increment?: unknown } {
  const path = dataFile("products", "exchange-products.raw.json");
  if (!path) throw new Error("products file missing");
  const body = JSON.parse(readFileSync(path, "utf8")) as { id?: string; base_min_size?: unknown; base_increment?: unknown }[];
  const row = body.find((item) => item.id === "BTC-USD");
  if (!row) throw new Error("BTC-USD missing");
  return row;
}

test("the committed products file gives BTC-USD a positive minimum", async () => {
  const expected = classAMinSizeOf(btcRow());
  expect(expected).toBeGreaterThan(0);
  expect(classAMinOrderBase("BTC-USD")).toBe(expected);
  let called = false;
  const loaded = await ensureClassAMinSizes(async () => {
    called = true;
    throw new Error("network");
  });
  expect(called).toBe(false);
  expect(loaded.get("BTC-USD")).toBe(expected);
});

test("a missing products file uses the public products endpoint", async () => {
  let url = "";
  let method = "";
  let authorization: string | null = "unset";
  const fetchImpl: typeof fetch = async (input, init) => {
    url = String(input);
    method = init?.method ?? "";
    authorization = new Headers(init?.headers).get("authorization");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return Response.json([
      { id: "ZERO-USD", base_min_size: "0", base_increment: "0" },
      { id: "BTC-USD", base_increment: "0.00000001" },
    ]);
  };
  const store = { current: null as Map<string, number> | null };
  const map = await loadClassAMinSizes(null, fetchImpl, store);
  expect(url).toBe(PUBLIC_PRODUCTS_URL);
  expect(method).toBe("GET");
  expect(authorization).toBeNull();
  expect(map.get("BTC-USD")).toBe(0.00000001);
  expect(map.get("ZERO-USD") ?? null).toBeNull();
  expect(map.has("ZERO-USD")).toBe(false);
});

test("a products fetch failure or timeout stays null and the signal is skip_minsize_unknown", async () => {
  const failing: typeof fetch = async () => {
    throw new Error("down");
  };
  const failed = await loadClassAMinSizes(null, failing, { current: null });
  expect(failed.get("BTC-USD") ?? null).toBeNull();
  const hung: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) {
        reject(new Error("missing timeout"));
        return;
      }
      const abort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
  const timedOut = await loadClassAMinSizes(null, hung, { current: null }, 30);
  expect(timedOut.get("SOL-USD") ?? null).toBeNull();
  const row = evaluateSignal(emptyClassABook(START), signal({ minOrderBase: timedOut.get("SOL-USD") ?? null }));
  expect(row?.skipReason).toBe("skip_minsize_unknown");
});

test("a failed products load is not cached and the next call can succeed", async () => {
  const store = { current: null as Map<string, number> | null };
  let calls = 0;
  const fetchImpl: typeof fetch = async () => {
    calls += 1;
    if (calls === 1) throw new Error("timeout");
    return Response.json([{ id: "BTC-USD", base_increment: "0.00000001" }]);
  };
  const first = await loadClassAMinSizes(null, fetchImpl, store);
  expect(first.get("BTC-USD") ?? null).toBeNull();
  expect(store.current).toBeNull();
  const second = await loadClassAMinSizes(null, fetchImpl, store);
  expect(second.get("BTC-USD")).toBe(0.00000001);
  expect(calls).toBe(2);
  const third = await loadClassAMinSizes(null, fetchImpl, store);
  expect(third.get("BTC-USD")).toBe(0.00000001);
  expect(calls).toBe(2);
});

test("the engine and health traces include the products snapshot", () => {
  const includes = nextConfig.outputFileTracingIncludes;
  if (!includes) throw new Error("tracing includes missing");
  expect(includes["/api/engine"]).toContain(PRODUCTS_FILE);
  expect(includes["/p6/health.json"]).toContain(PRODUCTS_FILE);
});
