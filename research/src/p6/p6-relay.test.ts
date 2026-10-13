import { expect, test } from "bun:test";
import { gapWeekReport, jevSkipShare, missingMidKill, soakElapsed, staleFeedKill } from "./amendment-v6";
import { applyForward, freshBook } from "./engine";
import {
  barKey,
  barMarker,
  commitBar,
  cronAuthorized,
  dashboard,
  encodeCommand,
  HOT_KEY,
  LEASE_KEY,
  LEASE_META_KEY,
  markerBytesPerDay,
  memoryKv,
  planRelay,
  redisEndpoint,
  releaseLease,
  runInvocation,
  saveState,
  STATE_KEY,
  takeReply,
  tryAcquire,
  WARMUP_KEY,
} from "./relay";
import { capturePaperState, driveHost, ensureSendQuote, flushEntries, noteSocketClose, prepareExitQuotes, releaseForDeadline, SAVE_HEARTBEAT_MS, sendDueEntries, startPaperHost, volHoursFromFifteens, warmSeriesFromRest } from "./paper-host";
import { handleEngineRequest, hostHolder, loadDashboard, persistRun } from "./vercel-live";
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
  host.warmup.set("ZZ-RELAY", [{ date: "2026-10-01", ts: 0, open: 1, high: 1, low: 1, close: 1, volume: 1, empty: false }]);
  const withWarmup = capturePaperState(host);
  await saveState(kv, withWarmup, { writeWarmup: false });
  expect(await commitBar(kv, "ZZ-RELAY", 900)).toBe("applied");
  expect(await commitBar(kv, "ZZ-RELAY", 900)).toBe("duplicate");
  const marker = await kv.get(barKey("ZZ-RELAY", 900));
  expect(marker).toBe(barMarker("ZZ-RELAY", 900));
  expect(marker).not.toContain("warmup");
  expect(await kv.get(WARMUP_KEY)).toBeNull();
  const parsed = JSON.parse((await kv.get(HOT_KEY))!) as typeof body;
  expect(parsed.fifteen).toBeUndefined();
  expect(parsed.queued).toEqual([]);
  expect(parsed.weeks[0]?.[1][0]?.date).toBe("2026-10-12");
  expect(parsed.restCursor).toEqual([]);
  expect(parsed.jevPackets).toBe(4);
  expect(parsed.jevSkipped).toBe(1);
  expect(parsed.warmup).toBeUndefined();
  expect(parsed.memberCloses).toBeUndefined();
  expect(await kv.get(STATE_KEY)).toBeNull();
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
  expect(host.book.legs.find((leg) => leg.id === `A-ETH-USD-${now}`)?.quoteSrc).toBe("rest_fallback");
});

test("the book, member closes, gaps, and D counts survive a run that has no injected bars", async () => {
  const kv = memoryKv();
  let stateWrites = 0;
  const set = kv.set.bind(kv);
  kv.set = async (key, value, opts) => {
    if (key === "p6:hot") stateWrites += 1;
    return set(key, value, opts);
  };
  const flags = { priceGroupPasses: true, volumeGroupPasses: false, boundarySaved: false };
  const host = startPaperHost(["ZZ-LIVE"], {});
  host.book.realizedUsd = 7;
  host.warmup.set("ZZ-LIVE", [{ date: "2026-10-10", ts: 0, open: 1, high: 1, low: 1, close: 2, volume: 1, empty: false }]);
  host.context = { flags, byProduct: new Map([["ZZ-LIVE", flags]]), memberOn: () => true };
  host.fifteen.push({ productId: "ZZ-LIVE", startSec: 1_700_000_100, open: 1, high: 1.2, low: 0.9, close: 1.1, volume: 1 });
  host.book.submittedByClass.D = 4;
  host.book.indeterminateByClass.D = 1;
  host.gaps.push({ startMs: 0, endMs: 16 * 60 * 1000, cause: "missed-cron" });
  await driveHost(host, 0, { persist: () => persistRun(kv, host) });
  const saved = await kv.get("p6:hot");
  expect(saved).toBeTruthy();
  expect(saved).not.toContain("memberCloses");
  expect(stateWrites).toBe(1);
  expect(await kv.get("p6:bar:ZZ-LIVE:1700000100")).toBeTruthy();
  const next = startPaperHost(["ZZ-LIVE"], {});
  next.context = host.context;
  await hostHolder(next, kv, []).warm();
  expect(next.book.realizedUsd).toBe(7);
  expect(next.book.config.memberCloses?.find((row) => row.productId === "ZZ-LIVE")?.days.some((row) => row.date === "2026-10-10")).toBe(true);
  expect(next.book.submittedByClass.D).toBe(4);
  expect(next.book.indeterminateByClass.D).toBe(1);
  expect(next.gaps[0]?.cause).toBe("missed-cron");
  const view = await loadDashboard(kv);
  expect(view.g0).toBe(true);
  expect(view.gaps.flags).toContain("gap-length");
  expect(view.gaps.dIndeterminateShare).toBe(0.25);
  expect(view.readOnly).toBe(true);
});

test("the next instance warms before the lease, and a sampled run releases at the deadline", async () => {
  const kv = memoryKv();
  const opened = await runInvocation({
    kv,
    self: "a",
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
    },
  });
  expect(opened.action).toBe("handover");
  expect(await kv.get(LEASE_KEY)).toBeNull();
  const order: string[] = [];
  const overlap = await runInvocation({
    kv,
    self: "b",
    nowMs: 15 * 60 * 1000,
    deadlineMs: 15 * 60 * 1000 + 1_800_000,
    lastCronMs: 0,
    holder: {
      async warm() {
        order.push("warm");
      },
      async watchUntil() {
        order.push("watch");
      },
      async applyDueBars() {
        order.push("apply");
        return ["ETH-USD:1"];
      },
      releaseDeadline() {
        order.push("release");
      },
      recordGap(gap) {
        order.push(`${gap.cause}:${gap.endMs - gap.startMs}`);
      },
    },
  });
  expect(order[0]).toBe("warm");
  expect(order).toContain("apply");
  expect(order).toContain("handover:0");
  expect(order).not.toContain("watch");
  expect(overlap.applied).toEqual(["ETH-USD:1"]);
  expect(overlap.action).not.toBe("duplicate");
  expect(overlap.socketGap).toBe(false);
  expect(overlap.feedGapMs).toBe(0);
  const stillHeld = memoryKv();
  expect(await tryAcquire(stillHeld, "a", 1_800_000, 0)).toBe(true);
  const watched: string[] = [];
  const during = await runInvocation({
    kv: stillHeld,
    self: "b",
    nowMs: 15 * 60 * 1000,
    deadlineMs: 15 * 60 * 1000 + 1_800_000,
    lastCronMs: 0,
    holder: {
      async warm() {
        watched.push("warm");
      },
      async watchUntil() {
        watched.push("watch");
        await releaseLease(stillHeld, "a", "deadline", 1_800_000 - 60_000);
      },
      async applyDueBars() {
        watched.push("apply");
        return ["ETH-USD:2"];
      },
      releaseDeadline() {},
      recordGap(gap) {
        watched.push(`${gap.cause}:${gap.endMs - gap.startMs}`);
      },
    },
  });
  expect(watched[0]).toBe("warm");
  expect(watched[1]).toBe("watch");
  expect(during.applied).toEqual(["ETH-USD:2"]);
  expect(during.action).not.toBe("duplicate");
  expect(watched).toContain("handover:0");

  const sampledKv = memoryKv();
  const sampled = await runInvocation({
    kv: sampledKv,
    self: "c",
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
      recordGap(gap) {
        expect(gap.cause).toBe("handover");
      },
    },
  });
  expect(sampled.action).toBe("handover");
  expect(await sampledKv.get(LEASE_KEY)).toBeNull();
  const released = JSON.parse((await sampledKv.get(LEASE_META_KEY)) ?? "{}") as { release?: string };
  expect(released.release).toBe("deadline");

  const crashKv = memoryKv();
  expect(await tryAcquire(crashKv, "d", 50_000, 0)).toBe(true);
  await expect(runInvocation({
    kv: crashKv,
    self: "d",
    nowMs: 1_000,
    deadlineMs: 1_800_000,
    lastCronMs: 0,
    holder: {
      async warm() {},
      async applyDueBars() {
        return [];
      },
      releaseDeadline() {},
      sampleUntil() {
        throw new Error("killed");
      },
    },
  })).rejects.toThrow("killed");
  const crashed = JSON.parse((await crashKv.get("p6:lease-meta")) ?? "{}") as { release?: string };
  expect(crashed.release).toBe("crash");
});

test("REST warmup fills daily and 1h history without a local store", async () => {
  const host = startPaperHost(["ZZ-REST"], {});
  host.warmup.clear();
  host.hourWarm.clear();
  host.historyFrom.clear();
  const urls: string[] = [];
  await warmSeriesFromRest(host, async (url) => {
    urls.push(url);
    const daily = url.includes("granularity=86400");
    const row = daily ? [1_700_000_000, 1, 2, 1.1, 1.5, 3] : [1_700_000_000, 1, 2, 1.1, 1.4, 3];
    return { ok: true, status: 200, json: async () => [row] };
  });
  expect(urls.some((url) => url.includes("granularity=86400"))).toBe(true);
  expect(urls.some((url) => url.includes("granularity=3600"))).toBe(true);
  expect(host.warmup.get("ZZ-REST")?.length).toBeGreaterThan(0);
  expect((host.hourWarm.get("ZZ-REST")?.length ?? 0) > 0).toBe(true);
  expect(host.historyFrom.get("ZZ-REST")).toBeTruthy();
});

test("a frozen book takes one REST snapshot and rejects the leg when that snapshot is stale", async () => {
  const host = startPaperHost(["ETH-USD"], {});
  const now = Date.parse("2026-10-15T01:00:00.000Z");
  host.l2Ts.set("ETH-USD", now - 16_000);
  host.books.set("ETH-USD", { bids: new Map([["100", 1]]), asks: new Map([["100.2", 1]]) });
  let calls = 0;
  const stale = await ensureSendQuote(host, "ETH-USD", now, async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ bids: [["100", "1"]], asks: [["100.2", "1"]], time: new Date(now - 20_000).toISOString() }) };
  });
  expect(calls).toBe(1);
  expect(stale).toBe("stale");
  const fresh = await ensureSendQuote(host, "ETH-USD", now, async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ bids: [["101", "1"]], asks: [["101.2", "1"]], time: new Date(now - 500).toISOString() }) };
  });
  expect(calls).toBe(2);
  expect(fresh).toBe("rest_fallback");
  expect(host.book.quotes["ETH-USD"]?.quoteSrc).toBe("rest_fallback");
});

test("an exit uses the book at send and a day-old quote is not a trade", () => {
  const host = startPaperHost(["ETH-USD"], {});
  const ts = Date.parse("2026-10-15T01:00:00.000Z");
  applyForward(host.book, { kind: "clock", tsMs: ts });
  applyForward(host.book, {
    kind: "x1",
    id: "held",
    classId: "B",
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
  host.book.quotes["ETH-USD"] = { bid: 100, ask: 100.1, tsMs: ts, quoteSrc: "l2" };
  const start = Math.floor(ts / 1000) + 86_400;
  applyForward(host.book, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec: start,
    nowSec: start + 900,
    open: 80,
    high: 81,
    low: 70,
    close: 80,
  });
  expect(host.book.closed).toHaveLength(0);
  expect(host.book.rejected.some((row) => row.reason === "missed_send_stale_quote")).toBe(true);
  const next = start + 900;
  host.book.quotes["ETH-USD"] = { bid: 79, ask: 79.2, tsMs: next * 1000, quoteSrc: "l2" };
  applyForward(host.book, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec: next,
    nowSec: next + 900,
    open: 78,
    high: 79,
    low: 70,
    close: 78,
  });
  expect(host.book.closed[0]?.exitKind).toBe("stop");
  expect(host.book.legs.find((leg) => leg.id === "held:exit")?.arrivalSnapshotTs).toBe(next * 1000);
});

test("redis urls carry tls, username, and timeout, and auth is checked before Redis", async () => {
  const endpoint = redisEndpoint("rediss://alice:s3cret@redis.example:6380", 1500);
  expect(endpoint.tls).toBe(true);
  expect(endpoint.username).toBe("alice");
  expect(endpoint.password).toBe("s3cret");
  expect(endpoint.port).toBe(6380);
  expect(endpoint.timeoutMs).toBe(1500);
  const plain = redisEndpoint("redis://:onlypass@127.0.0.1:6379");
  expect(plain.tls).toBe(false);
  expect(plain.username).toBe("");
  expect(plain.password).toBe("onlypass");
  const request = new Request("https://paper.example/api/engine", { headers: { authorization: "Bearer no" } });
  const denied = await handleEngineRequest(request, {});
  expect(denied.status).toBe(401);
  const missing = await handleEngineRequest(request, { CRON_SECRET: "no" });
  expect(missing.status).toBe(503);
});

test("a handover at 15m and at 30m is a zero gap, and a missed cron is the uncovered remainder", async () => {
  const kv = memoryKv();
  const T = Date.parse("2026-10-12T17:01:00Z");
  const run = async (self: string, nowMs: number) => {
    const rows: { cause: string; width: number }[] = [];
    const result = await runInvocation({
      kv,
      self,
      nowMs,
      deadlineMs: nowMs + 30 * 60_000,
      holder: {
        async warm() {},
        async applyDueBars() {
          return [`${self}-bar`];
        },
        releaseDeadline() {},
        async sampleUntil() {},
        async watchUntil() {},
        recordGap(gap) {
          rows.push({ cause: gap.cause, width: gap.endMs - gap.startMs });
        },
      },
    });
    return { result, rows };
  };
  await run("A", T);
  const at15 = await run("B", T + 15 * 60_000);
  const at30 = await run("C", T + 30 * 60_000);
  expect(at15.result.action).not.toBe("duplicate");
  expect(at30.result.action).not.toBe("duplicate");
  expect(at15.rows.some((row) => row.cause === "handover" && row.width === 0)).toBe(true);
  expect(at30.rows.some((row) => row.cause === "handover" && row.width === 0)).toBe(true);
  expect([...at15.rows, ...at30.rows].every((row) => row.width >= 0 && row.width < 1_000)).toBe(true);
  const missedKv = memoryKv();
  await runInvocation({
    kv: missedKv,
    self: "A",
    nowMs: T,
    deadlineMs: T + 30 * 60_000,
    holder: { async warm() {}, async applyDueBars() { return []; }, releaseDeadline() {}, async sampleUntil() {} },
  });
  const missedRows: { cause: string; width: number }[] = [];
  const missed = await runInvocation({
    kv: missedKv,
    self: "E",
    nowMs: T + 45 * 60_000,
    deadlineMs: T + 75 * 60_000,
    holder: {
      async warm() {},
      async applyDueBars() { return []; },
      releaseDeadline() {},
      async sampleUntil() {},
      recordGap(gap) {
        missedRows.push({ cause: gap.cause, width: gap.endMs - gap.startMs });
      },
    },
  });
  expect(missed.feedGapMs).toBe(16 * 60_000);
  expect(missedRows.some((row) => row.cause === "missed-cron" && row.width === 16 * 60_000)).toBe(true);
});

test("a kill during overlap records the crash from the last save, not the lease expiry", async () => {
  const kv = memoryKv();
  const start = 1_000_000;
  expect(await tryAcquire(kv, "K", start + 30 * 60_000, start)).toBe(true);
  const rows: { cause: string; startMs: number; endMs: number }[] = [];
  const next = await runInvocation({
    kv,
    self: "N",
    nowMs: start + 60_000,
    deadlineMs: start + 60_000 + 30 * 60_000,
    lastCronMs: start,
    holder: {
      async warm() {},
      async applyDueBars() { return ["kept"]; },
      releaseDeadline() {},
      async watchUntil() {
        await kv.del(LEASE_KEY);
      },
      recordGap(gap) {
        rows.push(gap);
      },
    },
  });
  expect(next.applied).toEqual(["kept"]);
  expect(next.action).not.toBe("duplicate");
  const crash = rows[0];
  expect(crash?.cause).toBe("crash");
  expect(crash?.startMs).toBe(start);
  expect((crash?.endMs ?? 0) - (crash?.startMs ?? 0)).toBe(60_000);
  expect(rows.some((row) => row.cause === "handover")).toBe(false);
});

test("a crash takeover reports crash and releases the lease as a deadline", async () => {
  const kv = memoryKv();
  const start = 1_000_000;
  expect(await tryAcquire(kv, "K", start + 30 * 60_000, start)).toBe(true);
  await kv.del(LEASE_KEY);
  const outcomes: string[] = [];
  const gaps: string[] = [];
  const next = await runInvocation({
    kv,
    self: "N",
    nowMs: start + 60_000,
    deadlineMs: start + 60_000 + 30 * 60_000,
    holder: {
      async warm() {},
      async applyDueBars() {
        return [];
      },
      releaseDeadline(cause?: string) {
        if (cause) outcomes.push(cause);
      },
      async sampleUntil() {},
      recordGap(gap) {
        gaps.push(gap.cause);
      },
    },
  });
  expect(next.action).toBe("crash");
  expect(next.cause).toBe("crash");
  expect(outcomes).toEqual(["crash"]);
  expect(gaps).toContain("crash");
  expect(gaps.filter((cause) => cause === "handover")).toHaveLength(1);
  const meta = JSON.parse((await kv.get(LEASE_META_KEY)) ?? "{}") as { release?: string };
  expect(meta.release).toBe("deadline");
});

test("vol hours stay per product and gap share uses each week", () => {
  const t = 1_791_820_800;
  const bars = [];
  for (let i = 0; i < 8; i += 1) {
    bars.push({ productId: "BTC-USD", startSec: t + i * 900, close: 60_000 + i });
    bars.push({ productId: "ETH-USD", startSec: t + i * 900, close: 2_400 + i });
  }
  const mixed = volHoursFromFifteens(bars, []);
  const btc = volHoursFromFifteens(bars.filter((bar) => bar.productId === "BTC-USD"), []);
  expect(mixed.filter((hour) => hour.productId === "BTC-USD").map((hour) => hour.rv)).toEqual(btc.map((hour) => hour.rv));
  expect(mixed.some((hour) => hour.productId === "ETH-USD")).toBe(true);
  const weekMs = 100_000;
  const quiet = gapWeekReport({
    weekMs,
    gaps: [0, 1, 2, 3].map((week) => ({ startMs: week * weekMs, endMs: week * weekMs + 500 })),
    hours: [],
    jevSkipped: 0,
    jevPackets: 1,
    dIndeterminate: 0,
    dSubmitted: 0,
  });
  expect(quiet.gappedShare).toBeCloseTo(0.005);
  expect(quiet.flags).not.toContain("gap-share");
  expect(markerBytesPerDay(50)).toBe(50 * 96 * Buffer.byteLength(barMarker("BTC-USD", 1_700_000_000)));
});

test("REST daily warmup drops today's partial candle so catch-up is not skipped", async () => {
  const host = startPaperHost(["ZZ-REST"], {});
  const now = Date.parse("2026-10-12T17:01:00Z");
  host.clock = () => now;
  host.warmup.clear();
  host.hourWarm.clear();
  host.historyFrom.clear();
  const today = Math.floor(now / 1000 / 86_400) * 86_400;
  await warmSeriesFromRest(host, async (url) => {
    const daily = url.includes("granularity=86400");
    const rows = daily ? [[today - 86_400, 1, 2, 1, 1.5, 3], [today, 1, 2, 1, 1.4, 3]] : [[today - 3_600, 1, 2, 1, 1.4, 3]];
    return { ok: true, status: 200, json: async () => rows };
  });
  const days = host.warmup.get("ZZ-REST") ?? [];
  expect(days.some((day) => day.date === "2026-10-12")).toBe(false);
  expect(host.historyFrom.get("ZZ-REST")).toBe(today);
  const newest = Math.floor(now / 1000 / 900) * 900 - 900;
  expect((host.historyFrom.get("ZZ-REST") ?? Number.POSITIVE_INFINITY) <= newest).toBe(true);
});

test("a stale book is priced by one awaited REST snapshot, and a 429 is not retried until it clears", async () => {
  const host = startPaperHost(["BTC-USD"], {});
  const now = Date.parse("2026-10-12T17:01:00Z");
  host.books.set("BTC-USD", { bids: new Map([["60000", 1]]), asks: new Map([["60001", 1]]) });
  host.l2Ts.set("BTC-USD", now - 16_000);
  host.ticks.set("BTC-USD", 0.01);
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, status: 200, json: async () => ({ bids: [["59999", "1"]], asks: [["60002", "1"]], time: new Date(now).toISOString() }) };
  };
  host.queued.set("x", {
    kind: "x1",
    classId: "C",
    productId: "BTC-USD",
    tsMs: now - 30_000,
    nextOpen: 60_000,
    stop: 59_000,
    target: null,
    dailyAtr: 1_000,
    priorDailyCloses: [],
    signalDate: "2026-10-12",
  });
  await sendDueEntries(host, now, fetchImpl);
  expect(calls).toBe(1);
  expect(host.book.rejected).toEqual([]);
  expect(host.book.positions.length + host.book.legs.length).toBeGreaterThan(0);
  await sendDueEntries(host, now, fetchImpl);
  expect(calls).toBe(1);

  const limited = startPaperHost(["BTC-USD"], {});
  limited.books.set("BTC-USD", { bids: new Map([["60000", 1]]), asks: new Map([["60001", 1]]) });
  limited.l2Ts.set("BTC-USD", now - 16_000);
  limited.queued.set("y", {
    kind: "x1",
    classId: "C",
    productId: "BTC-USD",
    tsMs: now - 30_000,
    nextOpen: 60_000,
    stop: 59_000,
    target: null,
    dailyAtr: 1_000,
    priorDailyCloses: [],
    signalDate: "2026-10-12",
  });
  let limitedCalls = 0;
  const throttle = async () => {
    limitedCalls += 1;
    return { ok: false, status: 429, headers: { get: () => "30" }, json: async () => ({}) };
  };
  await sendDueEntries(limited, now, throttle);
  await sendDueEntries(limited, now + 1_000, throttle);
  expect(limitedCalls).toBe(1);
  expect(limited.book.rejected).toEqual([]);
  expect(limited.queued.has("y")).toBe(true);
  await prepareExitQuotes(limited, "BTC-USD", 1, now + 1_000, throttle);
  expect(limitedCalls).toBe(1);
});

test("a successor reloads the outgoing book after the lease, so an A to D chain keeps every gap", async () => {
  const kv = memoryKv();
  const T = Date.parse("2026-10-12T17:01:00Z");
  const fill = {
    id: "fill-a",
    classId: "C" as const,
    productId: "ZZ-HAND",
    netR: 1,
    netUsd: 4,
    grossUsd: 4,
    costUsd: 0,
    riskUsd: 20,
    notionalUsd: 100,
    entryDate: "2026-10-12",
    exitTs: T,
    exitKind: "target",
  };
  expect(await tryAcquire(kv, "A", T + 29 * 60_000, T)).toBe(true);
  const seed = startPaperHost(["ZZ-HAND"], {});
  seed.book.realizedUsd = 3;
  seed.book.submittedByClass.D = 2;
  seed.book.indeterminateByClass.D = 1;
  seed.book.closed.push(fill);
  seed.gaps.push({ startMs: 1, endMs: 2, cause: "seed" });
  await persistRun(kv, seed);

  const step = async (prev: string, next: string, now: number, cause: string, usd: number, dCount: number) => {
    const incoming = startPaperHost(["ZZ-HAND"], {});
    const holder = hostHolder(incoming, kv);
    await holder.warm();
    const outgoing = startPaperHost(["ZZ-HAND"], {});
    await hostHolder(outgoing, kv).warm();
    outgoing.book.realizedUsd = usd;
    outgoing.book.submittedByClass.D = dCount;
    outgoing.gaps.push({ startMs: now, endMs: now + 589, cause });
    await persistRun(kv, outgoing);
    await runInvocation({
      kv,
      self: next,
      nowMs: now + 15 * 60_000,
      deadlineMs: now + 45 * 60_000,
      lastCronMs: now,
      holder: {
        async warm() {},
        async watchUntil() {
          await releaseLease(kv, prev, "deadline", now + 29 * 60_000 - 60_000);
        },
        reload: () => holder.reload(),
        async applyDueBars() {
          return [];
        },
        releaseDeadline() {},
        recordGap(gap) {
          incoming.gaps.push(gap);
        },
        persist: () => holder.persist(),
      },
    });
  };

  await step("A", "B", T, "from-A", 11, 4);
  await step("B", "C", T + 15 * 60_000, "from-B", 21, 6);
  await step("C", "D", T + 30 * 60_000, "from-C", 31, 8);
  const saved = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as {
    realizedUsd: number;
    dSubmitted: number;
    dIndeterminate: number;
    gaps: { cause: string }[];
    closed: { id: string }[];
    memberCloses?: unknown;
  };
  expect(saved.realizedUsd).toBe(31);
  expect(saved.dSubmitted).toBe(8);
  expect(saved.dIndeterminate).toBe(1);
  expect(saved.closed.map((row) => row.id)).toEqual(["fill-a"]);
  expect(saved.memberCloses).toBeUndefined();
  for (const cause of ["seed", "from-A", "from-B", "from-C"]) {
    expect(saved.gaps.some((gap) => gap.cause === cause)).toBe(true);
  }
});

test("the save heartbeat moves the crash clock without a bar", async () => {
  const host = startPaperHost(["ZZ-BEAT"], {});
  host.shards = [];
  host.openSockets = [];
  let now = 1_000;
  host.clock = () => now;
  let beats = 0;
  const pending = driveHost(host, now + 10_000_000, {
    applyBars: false,
    heartbeat: () => {
      beats += 1;
    },
    stopWhen: () => beats >= 1,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  now += SAVE_HEARTBEAT_MS;
  await pending;
  expect(beats).toBeGreaterThanOrEqual(1);
  expect(SAVE_HEARTBEAT_MS).toBeGreaterThanOrEqual(60_000);
  expect(SAVE_HEARTBEAT_MS).toBeLessThanOrEqual(120_000);
});
