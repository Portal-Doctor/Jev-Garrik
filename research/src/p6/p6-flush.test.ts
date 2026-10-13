import { expect, test } from "bun:test";
import type { Book } from "./engine";
import { FILLS_KEY, loadSplit, persistSplit, tapeKey, writeThroughBook } from "./hot-store";
import { backfillTapeIfNeeded, installPaperState, startPaperHost } from "./paper-host";
import { decodeLease, HOT_KEY, LEASE_KEY, memoryKv, tryAcquire, VALUE_MAX_BYTES } from "./relay";

const products = Array.from({ length: 50 }, (_, index) => `P${index}-USD`);

test("ten minutes at 50 products is ten flush calls, and a duplicate row is not appended", async () => {
  let now = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
  const kv = memoryKv(() => now);
  expect(await tryAcquire(kv, "K", now + 3_600_000, now)).toBe(true);
  const host = startPaperHost(products, {});
  host.clock = () => now;
  host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
  let flushes = 0;
  const owned = kv.ownedFlush.bind(kv);
  kv.ownedFlush = async (leaseKey, token, nowMs, payload) => {
    flushes += 1;
    return owned(leaseKey, token, nowMs, payload);
  };
  const origin = Math.floor(now / 1000);
  for (let minute = 0; minute < 10; minute += 1) {
    const closed = origin + minute * 60 - 60;
    for (const productId of products) {
      for (let trade = 0; trade < 60; trade += 1) {
        host.trades.push({ productId, tsSec: closed + (trade % 60), price: 1, size: 1, side: "buy" });
      }
    }
    host.fifteen.push({
      productId: products[0]!,
      startSec: origin + minute * 900,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    });
    await persistSplit(kv, host);
    now += 60_000;
  }
  expect(flushes).toBe(10);
  expect(host.duplicateAppends).toBe(0);
  const again = host.fifteen.length;
  await persistSplit(kv, host);
  expect(flushes).toBe(11);
  expect(host.duplicateAppends).toBe(0);
  expect(host.fifteen).toHaveLength(again);
  const stored = JSON.parse((await kv.get(`p6:bar15:${products[0]}:${new Date(origin * 1000).toISOString().slice(0, 10)}`)) ?? "[]") as { startSec: number }[];
  const ids = stored.map((bar) => bar.startSec);
  expect(new Set(ids).size).toBe(ids.length);
});

test("a wrong lease token writes nothing", async () => {
  const now = 1_700_000_000_000;
  const kv = memoryKv(() => now);
  expect(await tryAcquire(kv, "K", now + 60_000, now)).toBe(true);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => now;
  host.leaseToken = "not-the-holder";
  host.book.realizedUsd = 9;
  await expect(persistSplit(kv, host)).rejects.toThrow(/lease lost/);
  expect(await kv.get(HOT_KEY)).toBeNull();
  expect(decodeLease(await kv.get(LEASE_KEY))?.holder).toBe("K");
});

test("a value over 1 MB is refused and logged", async () => {
  let now = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
  const kv = memoryKv(() => now);
  expect(await tryAcquire(kv, "K", now + 60_000, now)).toBe(true);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => now;
  host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
  const closed = Math.floor(now / 1000) - 60;
  host.trades.push({
    productId: "BTC-USD",
    tsSec: closed + 1,
    price: 1,
    size: 1,
    side: "x".repeat(VALUE_MAX_BYTES),
  });
  await persistSplit(kv, host);
  expect(host.book.incidents.some((row) => row.includes("kv value exceeds 1 MB"))).toBe(true);
  expect(await kv.get(HOT_KEY)).toBeNull();
  expect(await kv.get(tapeKey(closed - (closed % 60)))).toBeNull();
});

test("a crash keeps the fills, loses at most 120s of tape, and backfills it", async () => {
  let now = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
  const kv = memoryKv(() => now);
  expect(await tryAcquire(kv, "K", now + 3_600_000, now)).toBe(true);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => now;
  host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
  host.kv = kv;
  host.book.legs.push({ id: "fill-1", productId: "BTC-USD", side: "entry" } as Book["legs"][number]);
  await writeThroughBook(kv, host);
  const open = Math.floor(now / 1000);
  const keptSec = open - 60 + 5;
  const lostSec = open + 15;
  host.trades.push({ productId: "BTC-USD", tsSec: keptSec, price: 10, size: 1, side: "buy" });
  host.trades.push({ productId: "BTC-USD", tsSec: lostSec, price: 11, size: 2, side: "sell" });
  await persistSplit(kv, host);
  now += 90_000;
  const successor = startPaperHost(["BTC-USD"], {});
  successor.clock = () => now;
  const saved = await loadSplit(kv, successor);
  expect(saved?.legs?.map((leg) => leg.id)).toEqual(["fill-1"]);
  expect(saved?.tape?.some((trade) => trade.tsSec === keptSec)).toBe(true);
  expect(saved?.tape?.some((trade) => trade.tsSec === lostSec)).toBe(false);
  expect(now / 1000 - open).toBeLessThanOrEqual(120);
  installPaperState(successor, saved!);
  successor.tapeHole = true;
  successor.wsTape = false;
  successor.book.working.push({
    order: { placedTs: now - 180_000, pair: "BTC-USD", expireTs: now + 60_000 },
    classId: "D",
    status: "working",
  } as Book["working"][number]);
  let fetched = 0;
  await backfillTapeIfNeeded(successor, async (url) => {
    fetched += 1;
    expect(url).toContain("/products/BTC-USD/trades");
    return {
      ok: true,
      status: 200,
      json: async () => [{ time: new Date(lostSec * 1000).toISOString(), price: "11", size: "2", side: "sell" }],
    };
  });
  expect(fetched).toBe(1);
  expect(successor.trades.some((trade) => trade.tsSec === lostSec && trade.price === 11)).toBe(true);
  expect(successor.book.working[0]?.status).toBe("indeterminate");
  expect(await kv.get(FILLS_KEY)).toContain("fill-1");
});
