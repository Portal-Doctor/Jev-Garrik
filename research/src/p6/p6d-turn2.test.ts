import { expect, test } from "bun:test";
import recorded from "./fixtures/coinbase-two-sockets.json";
import { amendmentV61CiteBody, AMENDMENT_V61_SHA256 } from "./amendment-v61";
import { amendmentV62ApprovalBody, amendmentV62Body } from "./amendment-v62";
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
  warmupKey,
} from "./hot-store";
import {
  FEED_BUFFER_MAX,
  FIFTEEN_RETAIN_DAYS,
  FOUR_KEEP,
  HOUR_KEEP,
  contiguousTail,
  FOUR_HOUR_EMA_BARS,
  ingestSocketMessage,
  feedFramesContiguous,
  logFoldMismatches,
  markOrdersBeforeTape,
  replayHandover,
  resyncBooksFromRest,
  rollSettled,
  SAVE_HEARTBEAT_MS,
  seedFourHours,
  startPaperHost,
  acceptRestBar,
} from "./paper-host";
import { readFileSync } from "node:fs";
import type { MinuteRow } from "../data/candles";
import { deriveBars, foldHours } from "../data/derive";
import type { Book } from "./engine";
import { decodeLease, HOT_KEY, HANDOVER_MARGIN_MS, LEASE_KEY, LEASE_META_KEY, memoryKv, releaseLease, renewLease, runInvocation, tryAcquire } from "./relay";
import { stampP6Record } from "./stamp-records";
import { hostHolder, LEASE_POLL_FAST_MS, LEASE_POLL_SLOW_MS, leasePollWaitMs, persistRun } from "./vercel-live";

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
  const pending = hostHolder(host, kv, [], "K").sampleUntil(start + SAVE_HEARTBEAT_MS * 2 + 10);
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
  const before = decodeLease(await stolen.get(LEASE_KEY))?.savedAtMs;
  expect(await renewLease(stolen, now, loser.leaseToken ?? undefined)).toBe(false);
  expect(decodeLease(await stolen.get(LEASE_KEY))?.savedAtMs).toBe(before);
  expect(await renewLease(stolen, now + 1, winner.leaseToken ?? undefined)).toBe(true);
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
  expect(result.cause).toBe("uncovered");
  expect(await kv.get(LEASE_KEY)).toBeNull();
  const meta = decodeLease(await kv.get(LEASE_META_KEY));
  expect(meta?.release).toBe("deadline");
  expect(meta?.saveFailed).toBe(true);
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
  expect(host.gaps.some((gap) => gap.cause === "uncovered ETH-USD")).toBe(true);
  expect([...host.overflowByDay.values()]).toEqual([1]);
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
  expect(foldHours(hours, 14_400, 3_600)).toHaveLength(2);
});

test("a missing hour still folds one 4h bar, matching the offline aggregate", () => {
  const minutes: MinuteRow[] = [];
  for (let ts = 0; ts < 14_400; ts += 900) {
    const empty = ts >= 7_200 && ts < 10_800;
    minutes.push({
      minuteSec: ts,
      empty,
      open: empty ? null : "10",
      high: empty ? null : "12",
      low: empty ? null : "9",
      close: empty ? null : "11",
      volume: empty ? null : "2",
    });
  }
  const hours = [0, 3_600, 10_800].map((start) => {
    const rows = minutes.filter((row) => !row.empty && row.minuteSec >= start && row.minuteSec < start + 3_600);
    return {
      ts: start,
      open: Number(rows[0]!.open),
      high: Math.max(...rows.map((row) => Number(row.high))),
      low: Math.min(...rows.map((row) => Number(row.low))),
      close: Number(rows[rows.length - 1]!.close),
      volume: rows.reduce((sum, row) => sum + Number(row.volume), 0),
    };
  });
  const folded = foldHours(hours, 14_400, 3_600);
  const derived = deriveBars(minutes, "4h", 0, 14_400).filter((bar) => !bar.empty);
  expect(folded).toHaveLength(1);
  expect(derived).toHaveLength(1);
  expect(folded[0]!.open).toBe(Number(derived[0]!.open));
  expect(folded[0]!.high).toBe(Number(derived[0]!.high));
  expect(folded[0]!.low).toBe(Number(derived[0]!.low));
  expect(folded[0]!.close).toBe(Number(derived[0]!.close));
  expect(folded[0]!.volume).toBe(Number(derived[0]!.volume));
});

test("a completed bar past expiry is catch-up and is not a skip", () => {
  const start = Math.floor(Date.parse("2026-10-01T00:00:00.000Z") / 1000);
  const host = startPaperHost(["ETH-USD"], {});
  host.clock = () => Date.parse("2026-10-12T00:00:00.000Z");
  host.hourWarm.set("ETH-USD", []);
  acceptRestBar(host, { productId: "ETH-USD", startSec: start, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  expect(host.book.jevSkipped).toBe(0);
  expect(host.book.jevPackets).toBe(0);
  expect(host.jevAnswers.some((row) => row.reason === "timeout")).toBe(false);
  expect(host.jevPacketWrites).toHaveLength(0);
  expect(host.jevCatchUps).toHaveLength(1);
  expect(host.jevCatchUps[0]?.count).toBe(1);
  expect(host.jevCatchUps[0]?.cause).toBe("engine_gap");
  const liveStart = Math.floor(host.clock() / 1000) - 900;
  acceptRestBar(host, { productId: "ETH-USD", startSec: liveStart, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  expect(host.book.jevPackets).toBeGreaterThan(0);
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

test("a heartbeat write over 256 KB is an incident and the book is still stored", async () => {
  const kv = memoryKv();
  const host = startPaperHost(["ETH-USD"], {});
  const start = Math.floor(Date.now() / 1000) - 900;
  host.clock = () => Date.now();
  host.fifteen.push({ productId: "ETH-USD", startSec: start, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  host.book.incidents.push("x".repeat(HOT_MAX_BYTES));
  await persistRun(kv, host);
  expect(host.book.incidents.some((row) => row.includes("exceeds 256 KB"))).toBe(true);
  const storedHot = JSON.parse((await kv.get(HOT_KEY)) ?? "null") as { positions?: unknown } | null;
  expect(storedHot?.positions).toEqual([]);
  const stored = JSON.parse((await kv.get(bar15Key("ETH-USD", new Date(start * 1000).toISOString().slice(0, 10)))) ?? "[]") as { startSec: number }[];
  expect(stored.some((bar) => bar.startSec === start)).toBe(true);
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

test("the live host does not walk up to .git", () => {
  const source = readFileSync(new URL("./paper-host.ts", import.meta.url), "utf8");
  expect(source.includes("repoRoot")).toBe(false);
  const pick = readFileSync(new URL("./select.ts", import.meta.url), "utf8");
  expect(pick.includes("readForwardPick(root = repoRoot())")).toBe(false);
  expect(LEASE_POLL_SLOW_MS).toBe(15_000);
  expect(LEASE_POLL_FAST_MS).toBe(200);
  expect(leasePollWaitMs(0, 60_000)).toBe(LEASE_POLL_SLOW_MS);
  expect(leasePollWaitMs(55_000, 60_000)).toBe(LEASE_POLL_FAST_MS);
});

test("REST 1h candles seed 200 contiguous 4h bars and a short product is flagged", async () => {
  const host = startPaperHost(["AAA-USD"], {});
  host.products = ["AAA-USD", "BBB-USD"];
  const end = Math.floor(Date.parse("2026-10-12T11:35:00.000Z") / 1000);
  host.clock = () => end * 1000;
  await seedFourHours(host, async (url) => {
    const parsed = new URL(url);
    const product = decodeURIComponent(parsed.pathname.split("/")[2] ?? "");
    const start = Number(parsed.searchParams.get("start"));
    const stop = Number(parsed.searchParams.get("end"));
    const rows: number[][] = [];
    const limit = product === "BBB-USD" ? start + 10 * 3_600 : stop;
    for (let ts = start; ts <= Math.min(stop, limit); ts += 3_600) {
      if (ts % 3_600 !== 0 || rows.length >= 300) break;
      rows.push([ts, 1, 2, 1.1, 1.5, 3]);
    }
    return { ok: true, status: 200, json: async () => rows };
  });
  const seeded = host.fourBars.get("AAA-USD") ?? [];
  expect(seeded.length).toBeGreaterThanOrEqual(FOUR_HOUR_EMA_BARS);
  expect(contiguousTail(seeded, 14_400).length).toBeGreaterThanOrEqual(FOUR_HOUR_EMA_BARS);
  expect(host.fourSeedSrc.get("AAA-USD")).toBe("rest_1h");
  expect(host.ema200.get("AAA-USD")).toBe("seeded");
  expect(host.book.incidents.some((row) => row.startsWith("4h seed short BBB-USD"))).toBe(true);
  expect(host.fourSeedSrc.get("BBB-USD")).toBe("rest_1h");
});

test("a 1h fold that differs from the 15m fold is logged and EMA200 stays seeded", () => {
  const host = startPaperHost(["ETH-USD"], {});
  logFoldMismatches(
    host,
    "ETH-USD",
    [{ ts: 14_400, open: 1, high: 2, low: 1, close: 2, volume: 4 }],
    [{ ts: 14_400, open: 1, high: 2, low: 1, close: 9, volume: 4 }],
  );
  expect(host.book.incidents.some((row) => row === "4h fold mismatch ETH-USD 14400")).toBe(true);
  host.fourBars.set(
    "ETH-USD",
    Array.from({ length: 200 }, (_, index) => ({ ts: (index + 1) * 14_400, open: 1, high: 1, low: 1, close: 1, volume: 1 })),
  );
  host.fourSeedThrough.set("ETH-USD", 0);
  host.ema200.set("ETH-USD", "seeded");
  host.fifteen.push({ productId: "ETH-USD", startSec: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  rollSettled(host, "ETH-USD", 86_400);
  expect(host.ema200.get("ETH-USD")).toBe("live");
});

test("an order placed before the warm tape is indeterminate", () => {
  const host = startPaperHost(["ETH-USD"], {});
  const now = Date.parse("2026-10-12T12:00:00.000Z");
  host.clock = () => now;
  host.trades.push({ productId: "ETH-USD", tsSec: Math.floor(now / 1000) - 120, price: 1, size: 1 });
  const working = (placedTs: number) =>
    ({
      order: { placedTs, pair: "ETH-USD", expireTs: now + 60_000 },
      classId: "D",
      status: "working",
    }) as Book["working"][number];
  host.book.working.push(working(now - 20 * 60_000), working(now - 60_000));
  markOrdersBeforeTape(host);
  expect(host.book.working[0]?.status).toBe("indeterminate");
  expect(host.book.working[1]?.status).toBe("working");
  expect(host.book.incidents).toContain("tape window indeterminate");
});

test("an ambiguous cut stays uncovered and a unique trade id is applied after the cut", () => {
  const ts = Date.parse("2026-10-13T12:00:00.000Z");
  const host = startPaperHost(["ETH-USD"], {});
  host.clock = () => ts;
  host.socketOpenedMs = ts - 60_000;
  host.feedCut = {
    atMs: ts,
    wallMs: ts,
    trade: { productId: "ETH-USD", tradeId: "4", time: new Date(ts).toISOString(), price: 1, size: 1 },
  };
  const trade = (id: string, at: number) => ({
    sequence: 1,
    events: [{ kind: "trade" as const, productId: "ETH-USD", price: 1, size: 1, time: new Date(at).toISOString(), side: "BUY", tradeId: id }],
  });
  host.feedBuffer = [trade("4", ts), trade("4", ts + 1)];
  expect(replayHandover(host)).toBe(false);

  const covered = startPaperHost(["ETH-USD"], {});
  covered.clock = () => ts;
  covered.socketOpenedMs = ts - 60_000;
  covered.feedCut = {
    atMs: ts,
    wallMs: ts,
    trade: { productId: "ETH-USD", tradeId: "4", time: new Date(ts).toISOString(), price: 1, size: 1 },
  };
  covered.feedBuffer = [trade("4", ts - 1_000), trade("9", ts + 1_000)];
  expect(replayHandover(covered)).toBe(true);
  expect(covered.overlapSeen).toBe(true);
  expect(covered.trades.some((row) => row.tsSec === Math.floor((ts + 1_000) / 1000))).toBe(true);
  expect(covered.trades.some((row) => row.tsSec === Math.floor((ts - 1_000) / 1000))).toBe(false);
});

test("50 products keep each warmup under 1 MB and a failed warmup still appends", async () => {
  const ids = Array.from({ length: 50 }, (_, index) => `P${index}-USD`);
  const host = startPaperHost(["BTC-USD"], {});
  host.products = ids;
  host.clock = () => Date.parse("2026-10-12T00:00:00.000Z");
  for (const id of ids) {
    host.warmup.set(
      id,
      Array.from({ length: 300 }, (_, index) => {
        const ts = Date.parse("2025-01-01T00:00:00.000Z") / 1000 + index * 86_400;
        return {
          date: new Date(ts * 1000).toISOString().slice(0, 10),
          ts,
          open: 100 + index / 100,
          high: 101.25,
          low: 99.5,
          close: 100.75,
          volume: 12_345.67,
          empty: false,
        };
      }),
    );
  }
  const kv = memoryKv();
  const start = Math.floor(host.clock() / 1000) - 900;
  host.fifteen.push({ productId: ids[0]!, startSec: start, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  const set = kv.set.bind(kv);
  kv.set = async (key, value, opts) => (key === warmupKey(ids[0]!) ? false : set(key, value, opts));
  await persistSplit(kv, host);
  expect(await kv.get(warmupKey(ids[0]!))).toBeNull();
  expect(host.warmupStored).toBe(false);
  for (const id of ids.slice(1)) {
    const raw = await kv.get(warmupKey(id));
    expect(raw).toBeTruthy();
    expect(Buffer.byteLength(raw ?? "")).toBeLessThan(1_048_576);
  }
  const day = new Date(start * 1000).toISOString().slice(0, 10);
  expect(JSON.parse((await kv.get(bar15Key(ids[0]!, day))) ?? "[]")).toHaveLength(1);
  expect(hotBytes(host)).toBeLessThan(HOT_MAX_BYTES);
});

test("the reworded handover is a new wording record", () => {
  const body = amendmentV62Body();
  expect(body.amendmentV61Edited).toBe(false);
  expect(body.amendmentV6Edited).toBe(false);
  expect(body.amendmentV61Sha256.startsWith("bb0c02bd")).toBe(true);
  expect(body.rule).toContain("trade_id");
  expect(body.rule).toContain("never by socket sequence_num");
  expect(body.rule).toContain("does not by itself change the covered result");
  expect(body.live).toBe(true);
  expect(body.featureFlag).toBe(false);
  const approval = amendmentV62ApprovalBody();
  expect(approval.approvedBy).toBe("Brian");
  expect(approval.approvedAt).toBe("2026-10-12T22:23:00Z");
  expect(approval.approvalOf).toBe("wording");
  expect(approval.bindsToFileHash).toBe(false);
  expect(approval.confirmedBy).toEqual(["Quant", "Trader"]);
  expect(approval.amendmentV61Edited).toBe(false);
  expect(() => stampP6Record("p6-stamp-amendment-v62")).toThrow(/refusing to overwrite/);
  expect(() => stampP6Record("p6-stamp-amendment-v62-approval")).toThrow(/refusing to overwrite/);
});

test("the next holder records a failed final save as an uncovered gap", async () => {
  const kv = memoryKv(() => 1_800_000);
  await runInvocation({
    kv,
    self: "K",
    nowMs: 0,
    deadlineMs: 1_800_000,
    clock: () => 0,
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
  const host = startPaperHost(["ZZ-SAVE"], {});
  host.products = [];
  host.shards = [];
  host.openSockets = [];
  host.clock = () => 1_800_000;
  host.book.working.push({
    order: { placedTs: 1_800_000, pair: "ZZ-SAVE", expireTs: 9_000_000 },
    classId: "D",
    status: "working",
  } as Book["working"][number]);
  const holder = hostHolder(host, kv);
  await runInvocation({
    kv,
    self: "W",
    nowMs: 1_800_000,
    deadlineMs: 3_600_000,
    clock: () => 1_800_000,
    holder: {
      warm: () => holder.warm(),
      applyDueBars: () => holder.applyDueBars(),
      releaseDeadline: () => holder.releaseDeadline(),
      recordGap: (gap) => holder.recordGap(gap),
      reload: () => holder.reload(),
      persist: async () => {},
    },
  });
  expect(host.book.incidents).toContain("save failed");
  expect(host.gaps.some((gap) => gap.cause === "uncovered")).toBe(true);
  expect(host.book.working[0]?.status).toBe("indeterminate");
});

test("overlapping saves append a row once", async () => {
  const kv = memoryKv();
  const host = startPaperHost(["ETH-USD"], {});
  const start = Math.floor(Date.parse("2026-10-12T00:00:00.000Z") / 1000);
  host.clock = () => (start + 900) * 1000;
  host.fifteen.push({ productId: "ETH-USD", startSec: start, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  await Promise.all([persistSplit(kv, host), persistSplit(kv, host)]);
  const stored = JSON.parse((await kv.get(bar15Key("ETH-USD", "2026-10-12"))) ?? "[]") as { startSec: number }[];
  expect(stored).toHaveLength(1);
  expect(host.duplicateAppends).toBe(0);
  const commands = host.saveCommands;
  await persistSplit(kv, host);
  expect(host.duplicateAppends).toBe(0);
  expect(host.saveCommands).toBe(commands + 1);
});

test("a lost lease is not retried and a redis timeout is a write failure", async () => {
  let lostCalls = 0;
  const lost = await runInvocation({
    kv: memoryKv(),
    self: "K",
    nowMs: 0,
    deadlineMs: 1_800_000,
    clock: () => 0,
    holder: {
      async warm() {},
      async applyDueBars() {
        return [];
      },
      releaseDeadline() {},
      async sampleUntil() {},
      async persist() {
        lostCalls += 1;
        throw new Error("lease lost");
      },
    },
  });
  expect(lostCalls).toBe(1);
  expect(lost.cause).toBe("uncovered");

  let reads = 0;
  let timeoutCalls = 0;
  const timed = await runInvocation({
    kv: memoryKv(),
    self: "K",
    nowMs: 0,
    deadlineMs: 1_800_000,
    clock: () => {
      reads += 1;
      return reads * 900_000;
    },
    holder: {
      async warm() {},
      async applyDueBars() {
        return [];
      },
      releaseDeadline() {},
      async sampleUntil() {},
      async persist() {
        timeoutCalls += 1;
        throw new Error("redis timeout");
      },
    },
  });
  expect(timeoutCalls).toBeGreaterThan(1);
  expect(timed.cause).toBe("uncovered");
});

test("releaseLease does not write lease meta unless it holds the token", async () => {
  const kv = memoryKv();
  expect(await tryAcquire(kv, "W", 2_000_000, 1_000)).toBe(true);
  expect(decodeLease(await kv.get(LEASE_KEY))?.releaseAtMs).toBe(2_000_000 - HANDOVER_MARGIN_MS);
  const acquired = await kv.get(LEASE_META_KEY);
  await kv.del(LEASE_KEY);
  await releaseLease(kv, "K", "deadline", 50_000, { saveFailed: true });
  expect(await kv.get(LEASE_META_KEY)).toBe(acquired);
  expect(await tryAcquire(kv, "W", 3_000_000, 2_000)).toBe(true);
  const held = await kv.get(LEASE_META_KEY);
  await releaseLease(kv, "K", "deadline", 60_000, { saveFailed: true });
  expect(await kv.get(LEASE_META_KEY)).toBe(held);
  expect(decodeLease(await kv.get(LEASE_KEY))?.holder).toBe("W");
});
