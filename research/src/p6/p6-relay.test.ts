import { expect, test } from "bun:test";
import { gapWeekReport, jevSkipShare, missingMidKill, soakElapsed, staleFeedKill } from "./amendment-v6";
import { applyForward, freshBook } from "./engine";
import {
  barKey,
  commitBar,
  cronAuthorized,
  dashboard,
  encodeCommand,
  memoryKv,
  planRelay,
  releaseLease,
  runInvocation,
  takeReply,
  tryAcquire,
} from "./relay";
import { capturePaperState, flushEntries, noteSocketClose, releaseForDeadline, startPaperHost } from "./paper-host";
import { handleEngineRequest, hostHolder } from "./vercel-live";
import type { GeneratedEntry } from "./generate";

const secret = "cron-test";

function holder(applied: string[] = []) {
  return {
    warmed: 0,
    released: 0,
    async warm() {
      this.warmed += 1;
    },
    async applyDueBars() {
      applied.push("bar");
      return ["ETH-USD:1"];
    },
    releaseDeadline() {
      this.released += 1;
    },
  };
}

test("the lease holder applies a bar once, and a duplicate or overlap does not", async () => {
  const kv = memoryKv();
  const applied: string[] = [];
  const first = holder(applied);
  const opened = await runInvocation({
    kv,
    self: "a",
    nowMs: 0,
    deadlineMs: 1_800_000,
    lastCronMs: null,
    holder: first,
  });
  expect(opened.action).toBe("hold");
  expect(opened.socketGap).toBe(false);
  expect(applied).toEqual(["bar"]);
  const second = holder(applied);
  const duplicate = await runInvocation({
    kv,
    self: "b",
    nowMs: 10_000,
    deadlineMs: 1_810_000,
    lastCronMs: 0,
    holder: second,
  });
  expect(duplicate.action).toBe("duplicate");
  expect(duplicate.applied).toEqual([]);
  expect(applied).toEqual(["bar"]);
  expect(second.warmed).toBe(0);

  const covered = planRelay({
    nowMs: 30 * 60 * 1000,
    deadlineMs: 30 * 60 * 1000 + 1_800_000,
    self: "c",
    lease: { holder: "a", untilMs: 30 * 60 * 1000 + 1_800_000, release: "none" },
    lastCronMs: 0,
  });
  expect(covered.action).toBe("overlap");
  expect(covered.feedGapMs).toBe(0);
  expect(covered.socketGap).toBe(false);
});

test("a deadline kill is not a socket gap, a crash is, and a missed cron is uncovered time", async () => {
  const handover = planRelay({
    nowMs: 1_800_000 - 60_000,
    deadlineMs: 1_800_000,
    self: "a",
    lease: { holder: "a", untilMs: 1_800_000, release: "none" },
    lastCronMs: 0,
  });
  expect(handover.action).toBe("handover");
  expect(handover.socketGap).toBe(false);

  const kv = memoryKv();
  expect(await tryAcquire(kv, "a", 1_800_000, 0)).toBe(true);
  const leaving = holder();
  const left = await runInvocation({
    kv,
    self: "a",
    nowMs: 1_740_000,
    deadlineMs: 1_800_000,
    lastCronMs: 0,
    holder: leaving,
  });
  expect(left.action).toBe("handover");
  expect(leaving.released).toBe(1);
  expect(left.socketGap).toBe(false);

  const next = planRelay({
    nowMs: 1_740_000,
    deadlineMs: 1_740_000 + 1_800_000,
    self: "b",
    lease: { holder: "a", untilMs: 1_740_000, release: "deadline" },
    lastCronMs: 0,
  });
  expect(next.action).toBe("acquire");
  expect(next.socketGap).toBe(false);
  expect(next.feedGapMs).toBe(0);

  const missed = planRelay({
    nowMs: 1_800_000 + 15 * 60 * 1000,
    deadlineMs: 1_800_000 + 15 * 60 * 1000 + 1_800_000,
    self: "b",
    lease: { holder: "a", untilMs: 1_800_000, release: "deadline" },
    lastCronMs: 0,
  });
  expect(missed.socketGap).toBe(false);
  expect(missed.feedGapMs).toBe(15 * 60 * 1000);
  expect(missed.cause).toBe("missed-cron");

  const killed = planRelay({
    nowMs: 500_000,
    deadlineMs: 2_000_000,
    self: "b",
    lease: { holder: "a", untilMs: 400_000, release: "crash" },
    lastCronMs: 0,
  });
  expect(killed.socketGap).toBe(true);
  expect(killed.cause).toBe("kill");
  expect(killed.feedGapMs).toBe(100_000);

  expect(await tryAcquire(kv, "b", 2_000_000, 1_740_000)).toBe(true);
  await releaseLease(kv, "a", "crash", 400_000);
  expect(await tryAcquire(kv, "b", 2_000_000, 500_000)).toBe(true);
});

test("a bar key is idempotent and holds the book, orders, bars, weeks, rings, tape, cursors, and Jev history", async () => {
  const kv = memoryKv();
  const host = startPaperHost(["ZZ-RELAY"], {});
  host.fifteen.push({ productId: "ZZ-RELAY", startSec: 900, open: 1, high: 2, low: 1, close: 1.5, volume: 1 });
  host.weeks.set("*", [{ date: "2026-10-12", rows: [{ id: "ZZ-RELAY", score: 1, member: true }] }]);
  host.trades.push({ productId: "ZZ-RELAY", tsSec: 1, price: 1, size: 1 });
  host.book.mids.completed.push({ productId: "ZZ-RELAY", ts: 0, open: 1, high: 1, low: 1, close: 1, volumeBase: 0 });
  host.book.jevPackets = 4;
  host.book.jevSkipped = 1;
  const body = capturePaperState(host);
  expect(await commitBar(kv, "ZZ-RELAY", 900, body)).toBe("applied");
  expect(await commitBar(kv, "ZZ-RELAY", 900, body)).toBe("duplicate");
  const saved = await kv.get(barKey("ZZ-RELAY", 900));
  const parsed = JSON.parse(saved!) as typeof body;
  expect(parsed.fifteen).toHaveLength(1);
  expect(parsed.queued).toEqual([]);
  expect(parsed.weeks[0]?.[1][0]?.date).toBe("2026-10-12");
  expect(parsed.rings).toHaveLength(1);
  expect(parsed.tape).toHaveLength(1);
  expect(parsed.restCursor).toEqual([]);
  expect(parsed.jevPackets).toBe(4);
  expect(parsed.jevSkipped).toBe(1);
  const next = startPaperHost(["ZZ-RELAY"], {});
  await hostHolder(next, kv, []).warm();
  expect(next.fifteen).toHaveLength(1);
  expect(next.book.jevSkipped).toBe(1);
});

test("the cron route rejects a missing secret and a second runner does not apply", async () => {
  const kv = memoryKv();
  const request = (method: string, read = false) =>
    new Request(`https://paper.example/api/engine${read ? "?read=1" : ""}`, { method, headers: { authorization: `Bearer ${secret}` } });
  expect(cronAuthorized(null, undefined)).toBe(false);
  const denied = await handleEngineRequest(request("GET"), {}, { kv });
  expect(denied.status).toBe(401);
  const counts: string[] = [];
  const step = holder(counts);
  const ok = await handleEngineRequest(request("POST"), { CRON_SECRET: secret }, {
    kv,
    nowMs: 0,
    deadlineMs: 1_800_000,
    self: "a",
    holder: step,
  });
  expect(ok.status).toBe(200);
  const body = (await ok.json()) as { action: string };
  expect(body.action).toBe("hold");
  const again = await handleEngineRequest(request("GET"), { CRON_SECRET: secret }, {
    kv,
    nowMs: 1_000,
    deadlineMs: 1_801_000,
    self: "b",
    holder: holder(counts),
  });
  const duplicate = (await again.json()) as { action: string; applied: string[] };
  expect(duplicate.action).toBe("duplicate");
  expect(duplicate.applied).toEqual([]);
  expect(counts).toEqual(["bar"]);
  const read = await handleEngineRequest(request("GET", true), { CRON_SECRET: secret }, { kv });
  const view = (await read.json()) as { readOnly: boolean; g0: boolean };
  expect(view.readOnly).toBe(true);
  expect(view.g0).toBe(false);
  const posted = await handleEngineRequest(new Request("https://paper.example/api/engine", { method: "PUT", headers: { authorization: `Bearer ${secret}` } }), { CRON_SECRET: secret }, { kv });
  expect(posted.status).toBe(405);
});

test("redis replies round-trip and the deadline close does not reconnect", () => {
  expect(encodeCommand(["GET", "p6:state"])).toBe("*2\r\n$3\r\nGET\r\n$8\r\np6:state\r\n");
  expect(takeReply("+OK\r\n$3\r\nbar")).toEqual({ reply: "OK", rest: "$3\r\nbar" });
  expect(takeReply("$-1\r\n+OK\r\n")).toEqual({ reply: null, rest: "+OK\r\n" });
  expect(takeReply("$3\r\nbar\r\n")).toEqual({ reply: "bar", rest: "" });
  const host = startPaperHost(["ETH-USD"], {});
  host.socketGen[0] = 1;
  releaseForDeadline(host);
  noteSocketClose(host, 0, 1);
  expect(host.needsReconnect[0]).toBe(false);
  expect(host.reconnects).toBe(0);
  expect(host.deadlineRelease).toBe(true);
});

test("V6 is live: gap windows, REST books, skipped Jev, gap fills, and the caps", () => {
  const book = freshBook({ parity: { riskUsd: 20, sBtBps: 5 }, members: ["ETH-USD", "BTC-USD"] });
  const placed = 1_700_000_000_000;
  applyForward(book, {
    kind: "d-order",
    id: "d1",
    productId: "ETH-USD",
    limit: 100,
    units: 1,
    placedTs: placed,
    stop: 90,
    bid: 100,
    ask: 100.1,
    bookTsMs: placed,
    sendTsMs: placed,
    decisionMid: 100,
    tick: 0.01,
  });
  expect(book.working).toHaveLength(1);
  applyForward(book, { kind: "gap", productId: "ETH-USD", startMs: placed + 200_000, endMs: placed + 200_000 });
  expect(book.working).toHaveLength(1);
  expect(book.indeterminateByClass.D).toBe(0);
  applyForward(book, { kind: "gap", productId: "ETH-USD", startMs: placed + 100_000, endMs: placed + 130_000 });
  expect(book.working).toHaveLength(0);
  expect(book.indeterminateByClass.D).toBe(1);

  const entryBook = freshBook({ parity: { riskUsd: 60, sBtBps: 5 }, members: ["ETH-USD"] });
  const start = 1_699_999_200;
  const ts = start * 1000;
  applyForward(entryBook, { kind: "clock", tsMs: ts });
  applyForward(entryBook, {
    kind: "x1",
    id: "a",
    classId: "A",
    productId: "ETH-USD",
    tsMs: ts,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.2,
    bookTsMs: ts,
    sendTsMs: ts,
    decisionMid: 100,
    aConfig: "A55-k3",
    quoteFallback: true,
  });
  expect(entryBook.legs.find((leg) => leg.id === "a")?.source).toBe("rest");
  expect(entryBook.legs.find((leg) => leg.id === "a")?.stale).toBe(true);
  expect(entryBook.positions).toHaveLength(1);
  applyForward(entryBook, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec: start,
    nowSec: start + 900,
    open: 100,
    high: 101,
    low: 80,
    close: 95,
    feedGap: true,
  });
  expect(entryBook.closed[0]?.exitKind).toBe("stop");
  expect(entryBook.gapFills).toBe(1);
  expect(entryBook.incidents.some((row) => row.includes("gap fill a"))).toBe(true);
  const exit = entryBook.legs.find((leg) => leg.id === "a:exit");
  expect(exit?.fillPrice).toBeLessThan(100);
  expect(exit?.fillPrice).toBeGreaterThan(0);

  const skip = freshBook({ members: ["ETH-USD", "BTC-USD"] });
  applyForward(skip, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec: 1_700_000_100,
    nowSec: 1_700_001_000,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    missing1m: true,
  });
  expect(skip.packets).toHaveLength(0);
  expect(skip.jevSkipped).toBeGreaterThan(0);
  expect(skip.incidents.some((row) => row.includes("jev skip"))).toBe(true);
  expect(jevSkipShare(6, 100).flagWeek).toBe(true);
  expect(jevSkipShare(5, 100).flagWeek).toBe(false);
  expect(missingMidKill(100, 95)).toBe(true);
  expect(missingMidKill(100, 96)).toBe(false);
  expect(staleFeedKill(120_000)).toBe(false);
  expect(staleFeedKill(120_001)).toBe(true);
  expect(soakElapsed(0, 7 * 24 * 60 * 60 * 1000).complete).toBe(true);
  expect(soakElapsed(0, 6 * 24 * 60 * 60 * 1000).complete).toBe(false);

  const hours = Array.from({ length: 10 }, (_, index) => ({ rv: index, gappedMs: index === 9 ? 2_000 : 0, hourMs: 3_600_000 }));
  const report = gapWeekReport({
    weekMs: 100_000,
    gaps: [{ startMs: 0, endMs: 2_000 }, { startMs: 10_000, endMs: 10_000 + 16 * 60 * 1000 }],
    hours,
    jevSkipped: 6,
    jevPackets: 100,
    dIndeterminate: 1,
    dSubmitted: 4,
  });
  expect(report.flags).toContain("gap-share");
  expect(report.flags).toContain("gap-length");
  expect(report.flags).toContain("jev-skip");
  expect(report.flagWeek).toBe(true);
  expect(report.dIndeterminateShare).toBe(0.25);
  const view = dashboard({
    positions: [],
    gates: ["halt"],
    leaseHolder: "a",
    incidents: ["gap fill a"],
    weekMs: 100_000,
    gaps: [{ startMs: 0, endMs: 2_000 }],
    hours: [],
    jevSkipped: 0,
    jevPackets: 1,
    dIndeterminate: 0,
    dSubmitted: 0,
  });
  expect(view.readOnly).toBe(true);
  expect(view.g0).toBe(true);
  expect(view.leaseHolder).toBe("a");
});

test("a stale live book falls back to the REST product book and is flagged", () => {
  const host = startPaperHost(["ETH-USD"], {});
  host.book = freshBook({ parity: { riskUsd: 60, sBtBps: 5 }, members: ["ETH-USD"] });
  const now = Date.parse("2026-10-15T01:00:00.000Z");
  host.book.quotes["ETH-USD"] = { bid: 50, ask: 50.1, tsMs: now - 60_000 };
  host.restQuotes.set("ETH-USD", { bid: 100, ask: 100.2, tsMs: now });
  const entry: GeneratedEntry = {
    kind: "x1",
    classId: "A",
    productId: "ETH-USD",
    tsMs: now,
    nextOpen: 100,
    stop: 90,
    target: null,
    dailyAtr: 2,
    priorDailyCloses: [],
    signalDate: "2026-10-14",
    aConfig: "A55-k3",
    fillAtOpen: true,
  };
  host.queued.set(`A-ETH-USD-${now}`, entry);
  flushEntries(host, now);
  expect(host.book.rejected.find((row) => row.id === `A-ETH-USD-${now}`)?.reason).not.toBe("stale-book");
  expect(host.book.legs.find((leg) => leg.id === `A-ETH-USD-${now}`)?.source).toBe("rest");
});
