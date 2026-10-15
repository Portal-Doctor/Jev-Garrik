import { expect, test } from "bun:test";
import { handoverCause, HANDOVER_MICRO_MS } from "./amendment-v6";
import { amendmentV61ApprovalBody, amendmentV61Body, AMENDMENT_V6_SHA256 } from "./amendment-v61";
import { gapWeekReport } from "./amendment-v6";
import { applyForward } from "./engine";
import { buildJevPackets, freshJevMeter, noteJevSpend } from "./jev-shadow";
import {
  acceptRestBar,
  attachMemberCloses,
  capturePaperState,
  feedFramesContiguous,
  FIFTEEN_RETAIN_DAYS,
  FOUR_KEEP,
  replayHandover,
  SAVE_HEARTBEAT_MS,
  startPaperHost,
} from "./paper-host";
import {
  assertRedisTransport,
  LEASE_TTL_MS,
  leasePx,
  memoryKv,
  noteLeaseSave,
  renewLease,
  runInvocation,
  saveState,
  tryAcquire,
} from "./relay";
import { stampP6Record } from "./stamp-records";
import { hostHolder, persistRun } from "./vercel-live";

test("the live lease expires inside 3 minutes and a crash gap stays under 15 minutes", async () => {
  expect(LEASE_TTL_MS).toBeGreaterThanOrEqual(120_000);
  expect(LEASE_TTL_MS).toBeLessThanOrEqual(180_000);
  expect(leasePx(10_000_000, 0)).toBe(LEASE_TTL_MS);
  let now = 50_000_000;
  const kv = memoryKv(() => now);
  expect(await tryAcquire(kv, "A", now + 1_800_000, now)).toBe(true);
  const token = JSON.parse((await kv.get("p6:lease")) ?? "{}") as { token?: string };
  await noteLeaseSave(kv, now);
  now += 60_000;
  expect(await renewLease(kv, now, token.token)).toBe(true);
  now += LEASE_TTL_MS - 1_000;
  expect(await kv.get("p6:lease")).not.toBeNull();
  now += 2_000;
  expect(await kv.get("p6:lease")).toBeNull();

  let crashed = 80_000_000;
  const crashKv = memoryKv(() => crashed);
  expect(await tryAcquire(crashKv, "A", crashed + 1_800_000, crashed)).toBe(true);
  await noteLeaseSave(crashKv, crashed);
  crashed += LEASE_TTL_MS;
  expect(await crashKv.get("p6:lease")).toBeNull();
  const gaps: { cause: string; endMs: number; startMs: number }[] = [];
  const result = await runInvocation({
    kv: crashKv,
    self: "B",
    nowMs: crashed,
    deadlineMs: crashed + 1_800_000,
    clock: () => crashed,
    holder: {
      async warm() {},
      async applyDueBars() {
        return [];
      },
      releaseDeadline() {},
      recordGap(gap) {
        gaps.push(gap);
      },
    },
  });
  expect(gaps[0]?.cause).toBe("crash");
  expect(result.feedGapMs).toBe(LEASE_TTL_MS);
  expect(result.feedGapMs).toBeLessThan(15 * 60 * 1000);
});

test("the heartbeat saves state and renews the lease", async () => {
  let now = 5_000_000;
  const kv = memoryKv(() => now);
  const host = startPaperHost(["ZZ-BEAT"], {});
  host.products = [];
  host.shards = [];
  host.openSockets = [];
  host.rest.clear();
  host.clock = () => now;
  expect(await tryAcquire(kv, "h", now + 1_800_000, now)).toBe(true);
  const pending = hostHolder(host, kv).sampleUntil(now + SAVE_HEARTBEAT_MS + 1);
  await new Promise((resolve) => setTimeout(resolve, 300));
  now += SAVE_HEARTBEAT_MS + 1;
  await pending;
  expect(await kv.get("p6:hot")).toBeTruthy();
  const saved = JSON.parse((await kv.get("p6:lease")) ?? "{}") as { savedAtMs?: number };
  expect(saved.savedAtMs).toBe(now);
});

test("15m bars stay for 8 days and daily closes keep the full history", () => {
  expect(FIFTEEN_RETAIN_DAYS).toBe(8);
  expect(FOUR_KEEP).toBeGreaterThanOrEqual(220);
  const nowSec = Math.floor(Date.parse("2026-10-12T12:00:00.000Z") / 1000);
  const host = startPaperHost(["ETH-USD"], {});
  host.clock = () => nowSec * 1000;
  const flags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };
  host.context = { flags, byProduct: new Map([["ETH-USD", flags]]), memberOn: () => true };
  const day = (offset: number) => new Date(Date.parse("2024-01-01T00:00:00.000Z") + offset * 86_400_000).toISOString().slice(0, 10);
  host.warmup.set(
    "ETH-USD",
    Array.from({ length: 300 }, (_, index) => ({
      date: day(index),
      ts: Date.parse(`${day(index)}T00:00:00.000Z`) / 1000,
      open: 1,
      high: 1,
      low: 1,
      close: 1 + index,
      volume: 1,
      empty: false,
    })),
  );
  attachMemberCloses(host);
  expect(host.dailyCloses.get("ETH-USD")).toHaveLength(300);
  expect(host.book.config.memberCloses?.[0]?.days).toHaveLength(300);
  expect(host.book.config.memberCloses?.[0]?.days[0]?.date).toBe(day(0));
  const old = nowSec - 9 * 86_400;
  const kept = nowSec - 2 * 86_400;
  acceptRestBar(host, { productId: "ETH-USD", startSec: old, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  acceptRestBar(host, { productId: "ETH-USD", startSec: kept, open: 1, high: 1, low: 1, close: 2, volume: 1 });
  expect(host.fifteen.some((bar) => bar.startSec === old)).toBe(false);
  expect(host.fifteen.some((bar) => bar.startSec === kept)).toBe(true);
  const before = host.dailyCloses.get("ETH-USD")?.length ?? 0;
  expect(host.book.config.memberCloses?.[0]?.days.some((row) => row.date === "2026-10-12")).toBe(false);
  const closeStart = Math.floor(Date.parse("2026-10-12T00:00:00.000Z") / 1000) + 95 * 900;
  acceptRestBar(host, { productId: "ETH-USD", startSec: closeStart, open: 3, high: 4, low: 2, close: 3.5, volume: 1 });
  expect(host.dailyCloses.get("ETH-USD")?.some((row) => row.date === "2026-10-12" && row.close === 3.5)).toBe(true);
  expect(host.dailyCloses.get("ETH-USD")).toHaveLength(before + 1);
  expect(host.book.config.memberCloses?.[0]?.days.some((row) => row.date === "2026-10-12")).toBe(true);
});

test("a failed state write is an incident", async () => {
  const kv = memoryKv();
  const host = startPaperHost(["ZZ-SET"], {});
  const set = kv.set.bind(kv);
  kv.set = async (key, value, opts) => (key === "p6:hot" ? false : set(key, value, opts));
  await expect(saveState(kv, capturePaperState(host))).rejects.toThrow(/kv set p6:hot failed/);
  host.products = [];
  host.shards = [];
  host.openSockets = [];
  host.rest.clear();
  let now = 0;
  host.clock = () => now;
  const pending = hostHolder(host, kv).sampleUntil(SAVE_HEARTBEAT_MS + 1);
  await new Promise((resolve) => setTimeout(resolve, 250));
  now += SAVE_HEARTBEAT_MS + 1;
  await pending;
  expect(host.book.incidents.some((row) => row.includes("kv set"))).toBe(true);
});

test("redis:// with a password is allowed off localhost", () => {
  const remote = assertRedisTransport("redis://:secret@x.upstash.io:6379");
  expect(remote.tls).toBe(false);
  expect(remote.host).toBe("x.upstash.io");
  expect(remote.password).toBe("secret");
  expect(assertRedisTransport("redis://127.0.0.1:6379").tls).toBe(false);
  expect(assertRedisTransport("rediss://redis.example:6380").tls).toBe(true);
  expect(assertRedisTransport("redis://localhost:6379").host).toBe("localhost");
});

test("Jev packets come from the 1m bars and the spend meter stops at $5", () => {
  const start = Math.floor(Date.parse("2026-10-12T00:00:00.000Z") / 1000);
  const mids = ["ETH-USD", "BTC-USD"].flatMap((productId) =>
    Array.from({ length: 15 }, (_, index) => ({ productId, ts: (start + index * 60) * 1000, close: 10 + index })),
  );
  const full = buildJevPackets({ members: ["ETH-USD"], barStartSec: start, nowSec: start + 900, mids });
  expect(full.missing).toBe(false);
  expect(full.packets).toHaveLength(2);
  expect(full.packets.every((packet) => packet.called === false && packet.minutes.length === 15)).toBe(true);
  mids.pop();
  const missing = buildJevPackets({ members: ["ETH-USD"], barStartSec: start, nowSec: start + 900, mids });
  expect(missing.missing).toBe(true);
  const host = startPaperHost(["ETH-USD"], {});
  host.clock = () => (start + 900) * 1000;
  host.book.mids.completed = mids.map((row) => ({ ...row, open: row.close, high: row.close, low: row.close, volumeBase: 0 }));
  acceptRestBar(host, { productId: "ETH-USD", startSec: start, open: 10, high: 11, low: 9, close: 10, volume: 1 });
  expect(host.book.jevSkipped).toBeGreaterThan(0);
  expect(host.book.incidents.some((row) => row.includes("jev no_1m_input"))).toBe(true);
  expect(host.jevMeter.capUsd).toBe(5);
  expect(host.jevMeter.monthCapUsd).toBe(100);
  expect(host.jevMeter.cumulativeUsd).toBeLessThanOrEqual(5);
  expect(() => noteJevSpend(freshJevMeter(5), 0.01, "2026-10")).toThrow(/jev spend cap/);
  expect(noteJevSpend(freshJevMeter(0), 1, "2026-10").monthUsd).toBe(1);
  const monthFull = { ...freshJevMeter(0), month: "2026-10", monthUsd: 100 };
  expect(() => noteJevSpend(monthFull, 0.01, "2026-10")).toThrow(/monthly/);
});

test("a contiguous handover replays in order and a hole stays uncovered", () => {
  expect(HANDOVER_MICRO_MS).toBe(1_000);
  expect(handoverCause(230, true)).toBe("handover_micro");
  expect(handoverCause(230, false)).toBe("uncovered");
  expect(handoverCause(1_000, true)).toBe("uncovered");
  const ts = Date.parse("2026-10-13T12:00:00.000Z");
  const host = startPaperHost(["ETH-USD"], {});
  host.clock = () => ts;
  applyForward(host.book, { kind: "clock", tsMs: ts });
  applyForward(host.book, {
    kind: "x1",
    id: "p",
    classId: "C",
    productId: "ETH-USD",
    tsMs: ts,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: ts,
    sendTsMs: ts,
    decisionMid: 100,
  });
  expect(host.book.positions).toHaveLength(1);
  host.feedCursor = { l2: 10, tradeId: 4 };
  const trade = (sequence: number, price: number, id: number, at: number) => ({
    sequence,
    events: [
      {
        kind: "trade" as const,
        productId: "ETH-USD",
        price,
        size: 1,
        time: new Date(at).toISOString(),
        side: "SELL",
        tradeId: String(id),
      },
    ],
  });
  host.socketOpenedMs = ts - 60_000;
  host.socketHole = false;
  host.feedBufferCapped = false;
  host.feedCut = {
    atMs: ts,
    wallMs: ts,
    trade: { productId: "ETH-USD", tradeId: "4", time: new Date(ts).toISOString(), price: 100, size: 1 },
  };
  host.feedBuffer = [trade(10, 100, 4, ts), trade(12, 89, 6, ts + 2), trade(11, 95, 5, ts + 1)];
  expect(replayHandover(host)).toBe(true);
  expect(host.book.positions).toHaveLength(0);
  expect(host.book.incidents.some((row) => row.includes("handover_micro"))).toBe(true);
  const fill = host.book.legs.find((leg) => leg.id === "p:exit");
  expect(fill?.fillPrice).toBe(89);

  const holed = startPaperHost(["ETH-USD"], {});
  holed.clock = () => ts;
  applyForward(holed.book, { kind: "clock", tsMs: ts });
  applyForward(holed.book, {
    kind: "x1",
    id: "q",
    classId: "C",
    productId: "ETH-USD",
    tsMs: ts,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: ts,
    sendTsMs: ts,
    decisionMid: 100,
  });
  holed.feedCursor = { l2: 10, tradeId: 4 };
  holed.feedBuffer = [trade(13, 80, 5, ts + 1)];
  const quiet = startPaperHost(["ETH-USD"], {});
  quiet.feedCursor = { l2: 10, tradeId: 4 };
  quiet.socketOpenedMs = ts - 60_000;
  quiet.feedCut = {
    atMs: ts,
    wallMs: ts,
    trade: { productId: "ETH-USD", tradeId: "4", time: new Date(ts).toISOString(), price: 100, size: 1 },
  };
  expect(feedFramesContiguous(quiet.feedCursor, [])).toBe(true);
  expect(replayHandover(quiet)).toBe(false);
  expect(feedFramesContiguous({ l2: null, tradeId: null }, [])).toBe(false);
  expect(feedFramesContiguous(holed.feedCursor, holed.feedBuffer)).toBe(false);
  expect(replayHandover(holed)).toBe(false);
  expect(holed.book.positions).toHaveLength(1);

  const week = gapWeekReport({
    weekMs: 7 * 86_400_000,
    gaps: [
      { startMs: 0, endMs: 230, cause: "handover_micro" },
      { startMs: 1_000, endMs: 1_200, cause: "handover_micro" },
      { startMs: 5_000, endMs: 15_000, cause: "uncovered" },
    ],
    hours: [],
    jevSkipped: 0,
    jevPackets: 1,
    dIndeterminate: 0,
    dSubmitted: 0,
  });
  expect(week.gappedMs).toBe(10_000);
  expect(week.longestMs).toBe(10_000);
  expect(week.handoverMicroByWeek).toEqual([{ weekStartMs: 0, count: 2 }]);
  expect(week.flags).not.toContain("gap-share");
});

test("the relay labels a sub-second contiguous handover as covered", async () => {
  let now = 90_000_000;
  const kv = memoryKv(() => now);
  expect(await tryAcquire(kv, "A", now + 1_800_000, now)).toBe(true);
  await noteLeaseSave(kv, now);
  const { releaseLease } = await import("./relay");
  await releaseLease(kv, "A", "deadline", now);
  now += 230;
  const gaps: { cause: string }[] = [];
  await runInvocation({
    kv,
    self: "B",
    nowMs: now,
    deadlineMs: now + 1_800_000,
    clock: () => now,
    holder: {
      async warm() {},
      async applyDueBars() {
        return [];
      },
      releaseDeadline() {},
      recordGap(gap) {
        gaps.push(gap);
      },
      async confirmHandover() {
        return true;
      },
    },
  });
  expect(gaps.map((gap) => gap.cause)).toContain("handover_micro");
});

test("V6.1 is a new wording record and does not edit V6", () => {
  const body = amendmentV61Body();
  expect(body.amendmentV6Sha256).toBe(AMENDMENT_V6_SHA256);
  expect(body.amendmentV6Edited).toBe(false);
  expect(body.registrationEdited).toBe(false);
  expect(body.live).toBe(true);
  expect(body.featureFlag).toBe(false);
  expect(body.rule).toContain("handover_micro");
  expect(body.rule).toContain("trade ids");
  const approval = amendmentV61ApprovalBody();
  expect(approval.approvedBy).toBe("Brian");
  expect(approval.approvedAt).toBe("2026-10-12T18:35:00Z");
  expect(approval.approvalOf).toBe("wording");
  expect(approval.bindsToFileHash).toBe(false);
  expect(approval.amendmentV6Edited).toBe(false);
  expect(approval.confirmedBy).toEqual(["Quant", "Trader"]);
  expect(() => stampP6Record("p6-stamp-amendment-v61")).toThrow(/refusing to overwrite/);
  expect(() => stampP6Record("p6-stamp-amendment-v61-approval")).toThrow(/refusing to overwrite/);
  expect(() => stampP6Record("p6-stamp-amendment-v61-cite")).toThrow(/refusing to overwrite/);
  expect(() => stampP6Record("p6-stamp-amendment-v6")).toThrow(/refusing to overwrite/);
});

test("persist writes the warmup key once and does not read it again", async () => {
  const kv = memoryKv();
  const host = startPaperHost(["ZZ-WARM"], {});
  host.warmup.set("ZZ-WARM", [{ date: "2026-10-01", ts: 0, open: 1, high: 1, low: 1, close: 1, volume: 1, empty: false }]);
  let gets = 0;
  const get = kv.get.bind(kv);
  kv.get = async (key) => {
    if (key === "p6:warmup:ZZ-WARM") gets += 1;
    return get(key);
  };
  await persistRun(kv, host);
  await persistRun(kv, host);
  expect(gets).toBe(0);
  expect(await kv.get("p6:warmup:ZZ-WARM")).toContain("2026-10-01");
  expect(await kv.get("p6:warmup")).toBeNull();
  expect(gets).toBe(1);
});
