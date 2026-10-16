import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import type { MarketState } from "../../../cb/state";
import {
  boundJevDone,
  catchUpCovers,
  drainJevShadow,
  freshJevSkip,
  noteLatency,
  packetExpired,
  refuseLateCall,
  scheduleLiveJev,
  skipShareReport,
  type JevCatchUpRun,
} from "./jev-call";
import { HOT_MAX_BYTES, hotSnapshot, persistSplit } from "./hot-store";
import { handoverMinuteOk, JEV_MINUTE_MS, JEV_SCHEMA, type StoredJevMinute } from "./jev-minute";
import { installPaperState, startPaperHost, type PaperHost } from "./paper-host";
import { LEASE_KEY, memoryKv } from "./relay";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const ANSWER = { market_regime: "balance", direction_bias: "flat", toxic_flow_risk: "low", liquidity_stress: "normal" } as const;
const WEEK = 7 * 24 * 60 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;

function state(pair = "BTC-USD", mid = 100): MarketState {
  return {
    pair,
    ts: NOW,
    horizonSec: 900,
    mid,
    spreadBps: 1,
    spreadEmaBps: 1,
    imbalance5: 0,
    imbalance20: 0,
    volBps: 1,
    parkinsonBps: 1,
    emaGapBps: 0,
    emaCross: 0,
    rsi: 50,
    volumeDelta: 0,
    volumeGross: 1,
    returnsBps: { m5: 0, m30: 0, h1: 0, h4: 0 },
    position: "flat",
    feeBps: { maker: 0, taker: 0 },
  } as unknown as MarketState;
}

function closed(productId: string, exitTs: number): PaperHost["book"]["closed"][number] {
  return { productId, exitTs } as PaperHost["book"]["closed"][number];
}

test("an empty drain does not read the lease", async () => {
  let gets = 0;
  const base = memoryKv(() => NOW);
  const kv = {
    ...base,
    get: async (key: string) => {
      gets += 1;
      return base.get(key);
    },
  };
  await kv.set(LEASE_KEY, JSON.stringify({ holder: "A", token: "tA", untilMs: NOW + 600_000, release: "none" }));
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => NOW;
  host.kv = kv;
  host.leaseToken = "tA";
  host.holderId = "A";
  host.jevCaller = async () => {
    throw new Error("idle drain must not call");
  };
  for (let i = 0; i < 100; i += 1) await drainJevShadow(host, NOW + i * 200, NOW + 600_000);
  expect(gets).toBe(0);
  expect(host.jevAnswers).toHaveLength(0);
});

test("a historical flat close stays in the score and a close before the answer does not", async () => {
  const bar = Math.floor(NOW / 1000) - 901;
  const cases: { name: string; pair: string; closedAt: number | null; open: boolean; included: boolean }[] = [
    { name: "BTC never traded", pair: "BTC-USD", closedAt: null, open: false, included: true },
    { name: "BTC closed 3 days ago", pair: "BTC-USD", closedAt: NOW - 3 * DAY, open: false, included: true },
    { name: "ETH closed before the answer", pair: "ETH-USD", closedAt: NOW - 1, open: false, included: false },
    { name: "ETH still open", pair: "ETH-USD", closedAt: NOW - 3 * DAY, open: true, included: true },
  ];
  for (const item of cases) {
    const host = startPaperHost([item.pair], {});
    host.clock = () => NOW;
    host.leaseToken = "held";
    if (item.open) host.book.positions = [{ productId: item.pair } as PaperHost["book"]["positions"][number]];
    if (item.closedAt != null) host.book.closed.push(closed(item.pair, item.closedAt));
    host.jevCaller = async () => ({ ok: true, answer: ANSWER, costUsd: 0.01, tokens: 4 });
    host.jevQueue.push({ pair: item.pair, barStartSec: bar, state: state(item.pair, 100), minutes: [] });
    host.jevTape.onBook(item.pair, NOW, { bids: new Map([["109", 1]]), asks: new Map([["111", 1]]) });
    await drainJevShadow(host, NOW, NOW + 120_000);
    const answer = host.jevAnswers[0];
    expect(answer?.guardIncluded).toBe(item.included);
    if (item.included) expect(answer?.scoreMid).toBe(110);
    else expect(answer?.scoreMid).toBeNull();
    expect(host.jevSkip.latency.le60).toBe(1);
  }
});

test("96 bars already past expiry are one catch-up run and not skipShare", () => {
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => NOW;
  host.holderId = "holder-a";
  host.leaseFromMs = NOW - 60_000;
  const end = Math.floor(NOW / 1000) - 1_500 - 900;
  const start = end - 95 * 900;
  for (let bar = start; bar <= end; bar += 900) scheduleLiveJev(host, bar);
  expect(host.jevCatchUps).toHaveLength(1);
  expect(host.jevCatchUps[0]).toMatchObject({ count: 96, firstBar: start, lastBar: end, cause: "engine_gap" });
  expect(host.book.jevPackets).toBe(0);
  expect(host.book.jevSkipped).toBe(0);
  expect(host.jevAnswers).toHaveLength(0);
  expect(host.jevPacketWrites).toHaveLength(0);
  expect(host.jevQueue).toHaveLength(0);
  host.book.jevBarSec = undefined;
  scheduleLiveJev(host, start);
  expect(host.jevCatchUps[0]?.count).toBe(96);
  expect(host.book.jevBarSec).toBeUndefined();
  const report = skipShareReport(host.jevSkip);
  expect(report.catchUp).toBe(96);
  expect(report.onTime).toBe(0);
  expect(report.catchUpShare).toBe(1);
  expect(report.catchUpFlag).toBe(true);
});

test("a bar first seen on time is not reclassed after expiry, and a queued expiry still counts", async () => {
  const host = startPaperHost(["BTC-USD"], {});
  let now = NOW;
  host.clock = () => now;
  host.holderId = "holder-a";
  host.leaseFromMs = NOW - 60_000;
  const bar = Math.floor(NOW / 1000) - 1_000;
  scheduleLiveJev(host, bar);
  expect(host.jevCatchUps).toHaveLength(0);
  expect(host.jevFirst.some((row) => row.bar === bar && row.atMs === NOW)).toBe(true);
  expect(host.book.jevPackets).toBeGreaterThan(0);
  const packets = host.book.jevPackets;
  host.book.jevBarSec = undefined;
  now = NOW + 3_600_000;
  scheduleLiveJev(host, bar);
  expect(host.jevCatchUps).toHaveLength(0);
  expect(host.book.jevPackets).toBe(packets);
  expect(host.jevSkip.weekCatchUp).toBe(0);

  const saved = { jevFirst: host.jevFirst.map((row) => ({ ...row })), jevCatchUps: [] as JevCatchUpRun[] };
  const next = startPaperHost(["BTC-USD"], {});
  next.clock = () => now;
  next.holderId = "holder-b";
  next.leaseFromMs = now;
  installPaperState(next, saved);
  scheduleLiveJev(next, bar);
  expect(next.jevCatchUps).toHaveLength(0);

  const queued = startPaperHost(["BTC-USD"], {});
  queued.clock = () => now;
  queued.leaseToken = "held";
  const expired = Math.floor(now / 1000) - 1_500;
  queued.jevCaller = async () => {
    throw new Error("expired queue must not call");
  };
  queued.jevQueue.push({ pair: "BTC-USD", barStartSec: expired, state: state(), minutes: [] });
  queued.jevSkip = freshJevSkip();
  queued.jevSkip.byTier.btc = { packets: 1, skipped: 0 };
  await drainJevShadow(queued, now, now + 120_000);
  expect(queued.jevAnswers[0]?.reason).toBe("timeout");
  expect(queued.jevSkip.byReason.timeout).toBe(1);
  expect(queued.jevCatchUps).toHaveLength(0);
});

test("catch-up cause is takeover only when the holder and the lease epoch both change", () => {
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => NOW;
  host.holderId = "holder-a";
  host.leaseFromMs = 100;
  const end = Math.floor(NOW / 1000) - 1_500 - 1_800;
  scheduleLiveJev(host, end - 900);
  scheduleLiveJev(host, end);
  expect(host.jevCatchUps).toHaveLength(1);
  expect(host.jevCatchUps[0]?.cause).toBe("engine_gap");
  expect(host.jevCatchUps[0]?.count).toBe(2);

  host.holderId = "holder-b";
  host.leaseFromMs = 200;
  scheduleLiveJev(host, end + 900);
  expect(host.jevCatchUps).toHaveLength(2);
  expect(host.jevCatchUps[1]?.cause).toBe("takeover");
  expect(host.jevCatchUps[1]?.count).toBe(1);

  scheduleLiveJev(host, end + 1_800);
  expect(host.jevCatchUps[1]?.count).toBe(2);
  expect(host.jevCatchUps[1]?.cause).toBe("takeover");
});

test("weekly catch-up share flags above 2 percent", () => {
  const quiet = freshJevSkip();
  quiet.weekOnTime = 100;
  quiet.weekCatchUp = 2;
  const low = skipShareReport(quiet);
  expect(low.catchUpShare).toBeCloseTo(2 / 102);
  expect(low.catchUpFlag).toBe(false);
  quiet.weekCatchUp = 3;
  quiet.weekOnTime = 97;
  const high = skipShareReport(quiet);
  expect(high.catchUpShare).toBeCloseTo(0.03);
  expect(high.catchUpFlag).toBe(true);
  expect(high.catchUp + high.onTime).toBe(100);
});

test("latency buckets sum to the answer count", () => {
  const ledger = freshJevSkip();
  noteLatency(ledger, 0);
  noteLatency(ledger, 60_000);
  noteLatency(ledger, 60_001);
  noteLatency(ledger, 300_000);
  noteLatency(ledger, 300_001);
  noteLatency(ledger, 600_000);
  noteLatency(ledger, 600_001);
  noteLatency(ledger, WEEK);
  const row = ledger.latency;
  expect(row.le60 + row.le300 + row.le600 + row.late).toBe(8);
  expect(row).toEqual({ le60: 2, le300: 2, le600: 2, late: 2 });
});

test("pins that kill a widened expiry, deadline, shed, ttl, and done cap", async () => {
  expect(packetExpired(0, 1_500_000)).toBe(true);
  expect(packetExpired(0, 1_499_000)).toBe(false);
  expect(refuseLateCall(0, 100, 200)).toBe(true);
  expect(refuseLateCall(0, 10_000, 1_000)).toBe(false);
  expect(boundJevDone(Array.from({ length: 10 }, (_, i) => `P:${10_000_000 - i * 2_000}`), 10_000_000)).toHaveLength(8);

  const host = startPaperHost(["NEAR-USD"], {});
  host.clock = () => NOW;
  host.leaseToken = "held";
  host.book.positions = [{ productId: "NEAR-USD" } as PaperHost["book"]["positions"][number]];
  host.book.realizedUsd = 7;
  const nowSec = Math.floor(NOW / 1000);
  host.jevDone = new Set(Array.from({ length: 8 }, (_, i) => `NEAR-USD:${"x".repeat(40_000)}:${nowSec - i}`));
  const body = JSON.parse(hotSnapshot(host)) as { jevDone: string[]; positions: { productId: string }[]; realizedUsd: number };
  expect(Buffer.byteLength(JSON.stringify(captureBefore(host)))).toBeGreaterThan(HOT_MAX_BYTES);
  expect(body.jevDone).toEqual([]);
  expect(body.positions.map((item) => item.productId)).toEqual(["NEAR-USD"]);
  expect(body.realizedUsd).toBe(7);

  let now = NOW;
  const kv = memoryKv(() => now);
  await kv.set(LEASE_KEY, JSON.stringify({ holder: "holder-a", token: "token-a", untilMs: NOW + WEEK, release: "none", acquiredAtMs: NOW }));
  const writer = startPaperHost(["BTC-USD"], {});
  writer.clock = () => now;
  writer.kv = kv;
  writer.leaseToken = "token-a";
  writer.holderId = "holder-a";
  writer.jevCaller = async () => ({ ok: true, answer: ANSWER, costUsd: 0.01, tokens: 3 });
  const live = Math.floor(NOW / 1000) - 1_000;
  writer.jevQueue.push({ pair: "BTC-USD", barStartSec: live, state: state(), minutes: [] });
  await drainJevShadow(writer, NOW, NOW + 120_000);
  await persistSplit(kv, writer);
  const key = `p6:jev:ans:BTC-USD:${live}`;
  expect(await kv.get(key)).not.toBeNull();
  now = NOW + 13 * DAY;
  expect(await kv.get(key)).not.toBeNull();
  now = NOW + 14 * DAY + 1;
  expect(await kv.get(key)).toBeNull();

  const bare = startPaperHost(["BTC-USD"], {});
  bare.clock = () => NOW;
  bare.kv = kv;
  bare.leaseToken = null;
  bare.jevPacketWrites.push({ key: "p6:jev:ans:ZZZ-USD:1", value: "{}" });
  await persistSplit(kv, bare);
  expect(await kv.get("p6:jev:ans:ZZZ-USD:1")).toBeNull();
});

function captureBefore(host: PaperHost): string {
  return JSON.stringify({
    positions: host.book.positions,
    realizedUsd: host.book.realizedUsd,
    jevDone: [...host.jevDone],
  });
}

test("an empty holder and a lease that ends before T+60s stay absent", () => {
  const minute: StoredJevMinute = {
    productId: "NEAR-USD",
    ts: NOW,
    takerBuyUsd: 1,
    takerSellUsd: 0,
    trades: 1,
    midClose: 1,
    midHigh: 1,
    midLow: 1,
    spreadBps: 1,
    imbalance5: 0,
    imbalance20: 0,
    carried: false,
    live: true,
    schema: JEV_SCHEMA,
    src: "live",
    holder: "",
    sealedAtMs: NOW + JEV_MINUTE_MS,
    leaseFromMs: NOW - 1_000,
    leaseUntilMs: NOW + JEV_MINUTE_MS,
  };
  expect(handoverMinuteOk(minute)).toBe(false);
  const shortLease = { ...minute, holder: "holder-a", leaseUntilMs: NOW + JEV_MINUTE_MS - 1, sealedAtMs: NOW + JEV_MINUTE_MS - 1 };
  expect(handoverMinuteOk(shortLease)).toBe(false);
  const src = readFileSync(new URL("./jev-minute.ts", import.meta.url), "utf8");
  expect(src).toContain("if (row.leaseUntilMs < row.ts + JEV_MINUTE_MS) return false;");
  expect(src).toContain('if (typeof row.holder !== "string" || row.holder === "") return false;');
  expect(catchUpCovers([{ count: 2, firstBar: 900, lastBar: 1_800, cause: "engine_gap", atMs: 0, holder: "a" }], 900)).toBe(true);
  expect(catchUpCovers([{ count: 1, firstBar: 900, lastBar: 1_800, cause: "engine_gap", atMs: 0, holder: "a" }], 1_800)).toBe(false);
});
