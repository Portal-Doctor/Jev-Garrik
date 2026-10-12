import { expect, test } from "bun:test";
import recorded from "./fixtures/coinbase-two-sockets.json";
import { amendmentV61CiteBody, AMENDMENT_V61_SHA256 } from "./amendment-v61";
import { deriveForwardBook } from "./generate";
import {
  bar15Key,
  bar1hKey,
  bar4hKey,
  captureHot,
  d1Key,
  HOT_MAX_BYTES,
  hotBytes,
  loadSplit,
  persistSplit,
  UPSTASH_LIMITS,
} from "./hot-store";
import {
  FEED_BUFFER_MAX,
  FIFTEEN_RETAIN_DAYS,
  FOUR_KEEP,
  HOUR_KEEP,
  foldBars,
  ingestSocketMessage,
  feedFramesContiguous,
  replayHandover,
  resyncBooksFromRest,
  rollSettled,
  SAVE_HEARTBEAT_MS,
  startPaperHost,
  acceptRestBar,
} from "./paper-host";
import { decodeLease, HOT_KEY, LEASE_KEY, LEASE_META_KEY, memoryKv, renewLease, runInvocation, tryAcquire } from "./relay";
import { hostHolder, persistRun } from "./vercel-live";

test("a failed save keeps the lease, and a lost lease stops the holder", async () => {
  let now = 8_000_000;
  const kv = memoryKv(() => now);
  expect(await tryAcquire(kv, "K", now + 1_800_000, now)).toBe(true);
  const host = startPaperHost(["ZZ-LEASE"], {});
  host.products = [];
  host.shards = [];
  host.openSockets = [];
  host.rest.clear();
  host.clock = () => now;
  let fail = true;
  const owned = kv.ownedSet.bind(kv);
  kv.ownedSet = async (leaseKey, token, key, value, opts) => {
    if (fail && key === HOT_KEY) throw new Error("kv set p6:hot failed");
    return owned(leaseKey, token, key, value, opts);
  };
  const start = now;
  const pending = hostHolder(host, kv).sampleUntil(start + SAVE_HEARTBEAT_MS * 2 + 10);
  await new Promise((resolve) => setTimeout(resolve, 250));
  now = start + SAVE_HEARTBEAT_MS + 1;
  await new Promise((resolve) => setTimeout(resolve, 400));
  expect(host.stopped).toBe(false);
  expect(host.book.incidents.some((row) => row.includes("kv set"))).toBe(true);
  expect(decodeLease(await kv.get(LEASE_KEY))?.holder).toBe("K");
  expect(await tryAcquire(kv, "W", now + 1_800_000, now)).toBe(false);
  fail = false;
  now = start + SAVE_HEARTBEAT_MS * 2 + 10;
  await pending;
  expect(await kv.get(HOT_KEY)).toBeTruthy();

  const stolen = memoryKv(() => now);
  expect(await tryAcquire(stolen, "K", now + 1_800_000, now)).toBe(true);
  const loser = startPaperHost(["ZZ-LEASE"], {});
  loser.leaseToken = decodeLease(await stolen.get(LEASE_KEY))?.token ?? null;
  loser.clock = () => now;
  expect(await tryAcquire(stolen, "W", now + 1_800_000, now)).toBe(false);
  await stolen.del(LEASE_KEY);
  now += 1;
  expect(await tryAcquire(stolen, "W", now + 1_800_000, now)).toBe(true);
  const winner = startPaperHost(["ZZ-LEASE"], {});
  winner.book.realizedUsd = 4;
  winner.leaseToken = decodeLease(await stolen.get(LEASE_KEY))?.token ?? null;
  winner.clock = () => now;
  await persistRun(stolen, winner);
  await expect(persistRun(stolen, loser)).rejects.toThrow(/lease lost/);
  loser.stopped = true;
  const kept = JSON.parse((await stolen.get(HOT_KEY)) ?? "{}") as { realizedUsd?: number };
  expect(kept.realizedUsd).toBe(4);
  expect(await renewLease(stolen, now)).toBe(true);
  expect(decodeLease(await stolen.get(LEASE_KEY))?.holder).toBe("W");
});

test("a failed final save still releases the lease", async () => {
  const kv = memoryKv();
  const result = await runInvocation({
    kv,
    self: "K",
    nowMs: 0,
    deadlineMs: 1_800_000,
    lastCronMs: null,
    holder: {
      async warm() {},
      async applyDueBars() {
        return [];
      },
      releaseDeadline() {},
      async sampleUntil() {},
      async persist() {
        throw new Error("kv set p6:hot failed");
      },
    },
  });
  expect(result.action).toBe("handover");
  expect(await kv.get(LEASE_KEY)).toBeNull();
  expect(decodeLease(await kv.get(LEASE_META_KEY))?.release).toBe("deadline");
  expect(await tryAcquire(kv, "W", 2_000_000, 1_800_000)).toBe(true);
});

test("the overlap buffer is capped and a takeover rebuilds the book from REST", async () => {
  const host = startPaperHost(["ETH-USD"], {});
  host.bufferFeeds = true;
  host.feedCursor = { l2: 1, tradeId: 1 };
  for (let i = 0; i < FEED_BUFFER_MAX + 10; i += 1) {
    ingestSocketMessage(host, 0, { channel: "heartbeats", sequence_num: i + 2, events: [] }, 1_000);
  }
  expect(host.feedBuffer.length).toBe(FEED_BUFFER_MAX);
  expect(host.feedBufferCapped).toBe(true);
  expect(replayHandover(host)).toBe(false);
  expect(host.book.positions).toHaveLength(0);

  const next = startPaperHost(["ETH-USD"], {});
  next.books.set("ETH-USD", { bids: new Map([["1", 1]]), asks: new Map([["2", 1]]) });
  await resyncBooksFromRest(next, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ bids: [["10", "1"], ["9", "2"]], asks: [["11", "4"], ["12", "5"]] }),
  }));
  expect(next.books.get("ETH-USD")?.bids.size).toBe(2);
  expect(next.books.get("ETH-USD")?.asks.size).toBe(2);
  expect(next.l2BookSrc.get("ETH-USD")).toBe("rest_snapshot");
  expect(next.book.quotes["ETH-USD"]?.quoteSrc).toBe("rest_fallback");
  expect(next.book.incidents.some((row) => row.includes("l2 rest snapshot ETH-USD"))).toBe(true);
  ingestSocketMessage(
    next,
    0,
    { channel: "l2_data", sequence_num: 3, events: [{ type: "update", product_id: "ETH-USD", updates: [{ side: "bid", price_level: "10.5", new_quantity: "3" }] }] },
    2_000,
  );
  expect(next.book.incidents.some((row) => row.includes("l2 resync ETH-USD"))).toBe(true);
  expect(next.l2BookSrc.get("ETH-USD")).toBe("rest_snapshot");
});

test("rolled 4h, 1h, and daily bars match the replay aggregation", () => {
  const start = Math.floor(Date.parse("2026-10-10T00:00:00.000Z") / 1000);
  const bars = Array.from({ length: 96 * 2 }, (_, index) => ({
    productId: "ETH-USD",
    startSec: start + index * 900,
    open: 10 + index,
    high: 11 + index,
    low: 9,
    close: 10.5 + index,
    volume: 2,
  }));
  const nowSec = start + 96 * 2 * 900;
  const host = startPaperHost(["ETH-USD"], {});
  host.clock = () => nowSec * 1000;
  host.hourWarm.set("ETH-USD", []);
  host.context = null;
  for (const bar of bars) acceptRestBar(host, { ...bar });
  const derived = deriveForwardBook(bars, nowSec);
  expect(derived).not.toBeNull();
  expect(host.hourWarm.get("ETH-USD")).toEqual(derived!.hour.slice(-HOUR_KEEP));
  expect(host.fourBars.get("ETH-USD")).toEqual(derived!.four.slice(-FOUR_KEEP));
  const daily = derived!.days.filter((row) => !row.empty).map((row) => ({ date: row.date, close: row.close }));
  expect(host.dailyCloses.get("ETH-USD")?.slice(-daily.length)).toEqual(daily);
  expect(FIFTEEN_RETAIN_DAYS).toBe(8);
  expect(HOUR_KEEP).toBeGreaterThanOrEqual(48);
  expect(FOUR_KEEP).toBeGreaterThanOrEqual(220);
});

test("a seeded 4h series stays warm when the 15m book is only a day", () => {
  const host = startPaperHost(["ETH-USD"], {});
  const seeded = Array.from({ length: 220 }, (_, index) => ({
    ts: index * 14_400,
    open: 1,
    high: 1,
    low: 1,
    close: 1 + index / 100,
    volume: 1,
  }));
  host.fourBars.set("ETH-USD", seeded);
  host.hourWarm.set("ETH-USD", []);
  const start = Math.floor(Date.parse("2026-10-12T00:00:00.000Z") / 1000);
  host.clock = () => (start + 900) * 1000;
  acceptRestBar(host, { productId: "ETH-USD", startSec: start, open: 2, high: 2, low: 2, close: 2, volume: 1 });
  expect(host.fourBars.get("ETH-USD")).toHaveLength(220);
  const hours = Array.from({ length: 8 }, (_, index) => ({
    ts: index * 3_600,
    open: index + 1,
    high: index + 2,
    low: index,
    close: index + 1.5,
    volume: 1,
  }));
  expect(foldBars(hours, 14_400, 3_600)).toHaveLength(2);
});

test("history bars do not increment the Jev skip count", () => {
  const start = Math.floor(Date.parse("2026-10-01T00:00:00.000Z") / 1000);
  const host = startPaperHost(["ETH-USD"], {});
  host.clock = () => Date.parse("2026-10-12T00:00:00.000Z");
  host.hourWarm.set("ETH-USD", []);
  acceptRestBar(host, { productId: "ETH-USD", startSec: start, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  expect(host.book.jevSkipped).toBe(0);
  expect(host.book.jevPackets).toBe(0);
  const liveStart = Math.floor(host.clock() / 1000) - 900;
  acceptRestBar(host, { productId: "ETH-USD", startSec: liveStart, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  expect(host.book.jevSkipped).toBeGreaterThan(0);
});

test("a restart from the split keys matches the monolith", async () => {
  const kv = memoryKv();
  const host = startPaperHost(["ETH-USD"], {});
  const start = Math.floor(Date.parse("2026-10-12T00:00:00.000Z") / 1000);
  host.clock = () => (start + 86_400) * 1000;
  host.book.realizedUsd = 12.5;
  host.book.submittedByClass.D = 3;
  host.feedCursor = { l2: 40, tradeId: 7 };
  host.hourWarm.set("ETH-USD", [{ ts: start, open: 1, high: 2, low: 1, close: 1.5, volume: 1 }]);
  host.fourBars.set("ETH-USD", [{ ts: start, open: 1, high: 3, low: 1, close: 2, volume: 4 }]);
  host.dailyBars.set("ETH-USD", [{ ts: start, open: 1, high: 4, low: 1, close: 3, volume: 5 }]);
  host.fifteen.push({ productId: "ETH-USD", startSec: start, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  host.book.mids.completed.push({ productId: "ETH-USD", ts: start * 1000, open: 1, high: 1, low: 1, close: 1, volumeBase: 0 });
  host.trades.push({ productId: "ETH-USD", tsSec: start + 86_400 - 30, price: 1, size: 1 });
  const monolith = {
    realized: host.book.realizedUsd,
    d: host.book.submittedByClass.D,
    cursor: { ...host.feedCursor },
    fifteen: host.fifteen.map((bar) => bar.startSec),
    four: host.fourBars.get("ETH-USD")?.map((bar) => bar.ts),
    hour: host.hourWarm.get("ETH-USD")?.map((bar) => bar.ts),
    daily: host.dailyBars.get("ETH-USD")?.map((bar) => bar.close),
  };
  await persistRun(kv, host);
  expect(Buffer.byteLength((await kv.get(HOT_KEY)) ?? "")).toBeLessThan(HOT_MAX_BYTES);
  const again = startPaperHost(["ETH-USD"], {});
  again.clock = host.clock;
  const loaded = await loadSplit(kv, again);
  expect(loaded).not.toBeNull();
  const { installPaperState } = await import("./paper-host");
  installPaperState(again, loaded!);
  expect(again.book.realizedUsd).toBe(monolith.realized);
  expect(again.book.submittedByClass.D).toBe(monolith.d);
  expect(again.feedCursor).toEqual(monolith.cursor);
  expect(again.fifteen.map((bar) => bar.startSec)).toEqual(monolith.fifteen);
  expect(again.fourBars.get("ETH-USD")?.map((bar) => bar.ts)).toEqual(monolith.four);
  expect(again.hourWarm.get("ETH-USD")?.map((bar) => bar.ts)).toEqual(monolith.hour);
  expect(again.dailyBars.get("ETH-USD")?.map((bar) => bar.close)).toEqual(monolith.daily);
  expect(again.book.mids.completed).toHaveLength(1);
  expect(again.trades).toHaveLength(1);
  await persistRun(kv, again);
  expect(JSON.parse((await kv.get(bar15Key("ETH-USD", "2026-10-12"))) ?? "[]")).toHaveLength(1);
  expect(JSON.parse((await kv.get(bar4hKey("ETH-USD"))) ?? "[]")).toHaveLength(1);
  expect(JSON.parse((await kv.get(bar1hKey("ETH-USD"))) ?? "[]")).toHaveLength(1);
  expect(JSON.parse((await kv.get(d1Key("ETH-USD"))) ?? "[]")).toHaveLength(1);
});

test("a duplicate append is a no-op", async () => {
  const kv = memoryKv();
  const host = startPaperHost(["ETH-USD"], {});
  const start = Math.floor(Date.parse("2026-10-12T00:00:00.000Z") / 1000);
  host.clock = () => (start + 900) * 1000;
  host.fifteen.push({ productId: "ETH-USD", startSec: start, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  await persistSplit(kv, host);
  host.persistedBars.delete(`15:ETH-USD:${start}`);
  await persistSplit(kv, host);
  const stored = JSON.parse((await kv.get(bar15Key("ETH-USD", "2026-10-12"))) ?? "[]") as { startSec: number }[];
  expect(stored).toHaveLength(1);
  expect(stored[0]?.startSec).toBe(start);
});

test("a heartbeat write over 256 KB is an incident and is not stored", async () => {
  const kv = memoryKv();
  const host = startPaperHost(["ETH-USD"], {});
  host.book.incidents.push("x".repeat(HOT_MAX_BYTES));
  await expect(persistRun(kv, host)).rejects.toThrow(/256 KB/);
  expect(host.book.incidents.some((row) => row.includes("exceeds 256 KB"))).toBe(true);
  expect(await kv.get(HOT_KEY)).toBeNull();
});

test("50 products stay inside the hot cap and Upstash's published request cap", () => {
  const ids = Array.from({ length: 50 }, (_, index) => `P${index}-USD`);
  const host = startPaperHost(["BTC-USD"], {});
  host.products = ids;
  host.book.positions = [];
  const bytes = hotBytes(host);
  expect(bytes).toBeLessThan(HOT_MAX_BYTES);
  expect(bytes).toBeLessThan(UPSTASH_LIMITS.maxRequestBytes);
  const day = Array.from({ length: 96 }, (_, index) => ({
    productId: "P0-USD",
    startSec: index * 900,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
  }));
  const dayBytes = Buffer.byteLength(JSON.stringify(day));
  const four = Array.from({ length: FOUR_KEEP }, (_, index) => ({ ts: index * 14_400, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  const hour = Array.from({ length: HOUR_KEEP }, (_, index) => ({ ts: index * 3_600, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  const daily = Array.from({ length: 260 }, (_, index) => ({ ts: index * 86_400, open: 1, high: 1, low: 1, close: 1, volume: 1 }));
  expect(dayBytes).toBeLessThan(1_048_576);
  expect(Buffer.byteLength(JSON.stringify(four))).toBeLessThan(1_048_576);
  expect(Buffer.byteLength(JSON.stringify(hour))).toBeLessThan(1_048_576);
  expect(Buffer.byteLength(JSON.stringify(daily))).toBeLessThan(1_048_576);
  expect(dayBytes).toBeLessThan(UPSTASH_LIMITS.maxRequestBytes);
  const hot = captureHot(host);
  expect(JSON.stringify(hot)).not.toContain("memberCloses");
  expect(rollSettled.length).toBeGreaterThan(0);
});

test("a recorded Coinbase handover is uncovered because each socket restarts its sequence", () => {
  expect(recorded.a.sequenceStart).toBe(0);
  expect(recorded.b.sequenceStart).toBe(0);
  expect(recorded.b.sequenceStart).not.toBe(recorded.a.sequenceEnd);
  expect(recorded.b.sequenceStart).not.toBe(recorded.a.sequenceEnd + 1);
  const cursor = { l2: recorded.a.sequenceEnd, tradeId: Number(recorded.trades[0]!.trade_id) };
  const frames = recorded.trades.map((trade, index) => ({
    sequence: recorded.b.sequenceStart + index,
    events: [
      {
        kind: "trade" as const,
        productId: recorded.product,
        price: Number(trade.price),
        size: 0.001,
        time: trade.time,
        side: "SELL",
        tradeId: trade.trade_id,
      },
    ],
  }));
  expect(feedFramesContiguous(cursor, frames)).toBe(false);
  const host = startPaperHost(["BTC-USD"], {});
  host.feedCursor = cursor;
  host.feedBuffer = frames;
  expect(replayHandover(host)).toBe(false);
});

test("the new wording approval cites bb0c02bd and does not edit f20ca24a", () => {
  const body = amendmentV61CiteBody();
  expect(body.amendmentV61Sha256.startsWith("bb0c02bd")).toBe(true);
  expect(body.amendmentV61Sha256).toBe(AMENDMENT_V61_SHA256);
  expect(body.priorApprovalSha256.startsWith("f20ca24a")).toBe(true);
  expect(body.priorApprovalEdited).toBe(false);
  expect(body.approvalOf).toBe("wording");
  expect(body.bindsToFileHash).toBe(false);
  expect(body.approvedBy).toBe("Brian");
});
