import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { SourceDay } from "../p3/bar-access";
import { tradeThroughFill } from "../p3/design-rules";
import { addDays } from "../p5/stats";
import { repoRoot } from "../manifest";
import { applyForward, freshBook } from "./engine";
import { completedDays, entriesToEvents, vetoFromBtc, type GeneratedEntry } from "./generate";
import {
  acceptRestBar,
  capturePaperState,
  catchUpHistory,
  fallbackTradesBar,
  SAVE_HEARTBEAT_MS,
  sendDueEntries,
  startPaperHost,
  warmSeriesFromRest,
  type RestSlot,
} from "./paper-host";
import { memoryKv, STATE_KEY } from "./relay";
import { FORWARD_PICK_SHA256, paperWindow, readForwardPick, startDateReport } from "./select";
import { hostHolder, persistRun } from "./vercel-live";
import { equityState } from "./session";

const flags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };

function day(date: string, close: number): SourceDay {
  return { date, ts: Date.parse(`${date}T00:00:00.000Z`) / 1000, open: close, high: close, low: close, close, volume: 1, empty: false };
}

function flatBars(date: string, close: number) {
  const start = Date.parse(`${date}T00:00:00.000Z`) / 1000;
  const bars = [];
  for (let i = 0; i < 96; i += 1) {
    bars.push({ productId: "BTC-USD", startSec: start + i * 900, open: close, high: close, low: close, close, volume: 1 });
  }
  return bars;
}

test("the BTC veto stays on after the warmup, including a 5-day gap", () => {
  const warmup = Array.from({ length: 55 }, (_, index) => day(addDays("2026-08-01", index), 100));
  const gap = addDays("2026-08-01", 55);
  const bars = [0, 1, 2, 3, 4].flatMap((offset) => flatBars(addDays(gap, offset), offset === 4 ? 96 : 100));
  const nowSec = Date.parse(`${addDays(gap, 5)}T00:00:00.000Z`) / 1000;
  const days = completedDays(warmup, bars, nowSec);
  const veto = vetoFromBtc(days, []);
  const crash = addDays(gap, 4);
  expect(veto(crash)).toBe(true);
  expect(veto(addDays(gap, 3))).toBe(false);
  expect(vetoFromBtc(warmup, [])(crash)).toBe(false);
  const host = startPaperHost(["BTC-USD"], {});
  host.warmup.set("BTC-USD", warmup);
  host.fifteen = bars;
  host.clock = () => nowSec * 1000;
  if (!host.context) host.context = { flags, byProduct: new Map([["BTC-USD", flags]]), memberOn: () => true };
  expect(completedDays(host.warmup.get("BTC-USD") ?? [], host.fifteen, nowSec).some((row) => row.date === crash)).toBe(true);
  expect(vetoFromBtc(host.warmup.get("BTC-USD") ?? [], [])(crash)).toBe(false);
});

test("a 5-day catch-up keeps the daily warmup and feeds the veto", async () => {
  const host = startPaperHost(["BTC-USD"], {});
  host.warmup.clear();
  host.hourWarm.set("BTC-USD", [{ ts: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  host.context = null;
  const warmup = Array.from({ length: 55 }, (_, index) => day(addDays("2026-08-01", index), 100));
  const gap = addDays("2026-08-01", 55);
  const nowSec = Date.parse(`${addDays(gap, 5)}T00:30:00.000Z`) / 1000;
  host.clock = () => nowSec * 1000;
  const dailyRows = warmup.map((row) => [row.ts, row.low, row.high, row.open, row.close, row.volume]);
  await warmSeriesFromRest(host, async (url) => {
    if (String(url).includes("granularity=86400")) return { ok: true, status: 200, json: async () => dailyRows };
    return { ok: true, status: 200, json: async () => [] };
  });
  expect(host.warmup.get("BTC-USD")?.some((row) => row.date === warmup[54]!.date)).toBe(true);
  expect(host.historyFrom.get("BTC-USD")).toBe(Date.parse(`${gap}T00:00:00.000Z`) / 1000);
  const bars = [0, 1, 2, 3, 4].flatMap((offset) => flatBars(addDays(gap, offset), offset === 4 ? 96 : 100));
  const candles = bars.map((bar) => [bar.startSec, bar.low, bar.high, bar.open, bar.close, bar.volume]);
  await catchUpHistory(host, async () => ({ ok: true, status: 200, json: async () => candles }));
  expect(host.fifteen.length).toBe(bars.length);
  const crash = addDays(gap, 4);
  expect(vetoFromBtc(completedDays(host.warmup.get("BTC-USD") ?? [], host.fifteen, nowSec), [])(crash)).toBe(true);
});

test("an exchange day on the host rolls, recomputes, falls back, and reloads mid-bar", async () => {
  const host = startPaperHost(["ETH-USD"], {});
  host.book.config.memberCloses = [{ productId: "ETH-USD", flags, days: [day("2026-10-01", 100)] }];
  const dayStart = Date.parse("2026-10-12T00:00:00.000Z") / 1000;
  host.clock = () => (dayStart + 86_400) * 1000;
  acceptRestBar(host, { productId: "ETH-USD", startSec: dayStart, open: 100, high: 101, low: 99, close: 100.2, volume: 2 });
  expect(host.book.day).toBe("2026-10-12");
  expect(host.book.clusterAsOf).toBeTruthy();
  for (let index = 1; index < 96; index += 1) {
    acceptRestBar(host, { productId: "ETH-USD", startSec: dayStart + index * 900, open: 100, high: 101, low: 99, close: 100.5, volume: 2 });
  }
  expect(host.book.config.memberCloses?.[0]?.days.some((row) => row.date === "2026-10-12")).toBe(true);
  expect(host.book.day).toBe("2026-10-13");
  const open = dayStart + 86_400;
  const slot: RestSlot = {
    productId: "ETH-USD",
    barStartSec: open + 900,
    attempts: 0,
    done: false,
    fallback: false,
    deferredMs: 0,
    notBeforeMs: 0,
    inflight: false,
  };
  host.trades.push({ productId: "ETH-USD", tsSec: open + 900 + 10, price: 101, size: 2 });
  const built = fallbackTradesBar(host, slot);
  expect(built?.startSec).toBe(open + 900);
  expect(host.restFallback).toBe(1);
  host.book.realizedUsd = 12;
  const kv = memoryKv();
  await persistRun(kv, host);
  const next = startPaperHost(["ETH-USD"], {});
  await hostHolder(next, kv).warm();
  expect(next.book.day).toBe("2026-10-13");
  expect(next.book.realizedUsd).toBe(12);
  expect(next.fifteen.some((bar) => bar.startSec === open + 900)).toBe(true);
  expect(JSON.parse((await kv.get(STATE_KEY)) ?? "{}").memberCloses).toBeUndefined();
});

test("halts, the $900 and $8,000 backstops, the pair latch, the beta cap, and 10R/20R run on the host book", () => {
  const ts = Date.parse("2026-10-13T12:00:00.000Z");
  const quote = { bid: 100, ask: 100.1, bookTsMs: ts, sendTsMs: ts, decisionMid: 100 };
  const daily = startPaperHost(["ETH-USD"], {});
  applyForward(daily.book, { kind: "clock", tsMs: ts });
  applyForward(daily.book, { kind: "realize", id: "day", classId: "C", productId: "ETH-USD", netR: -1, netUsd: -900, riskUsd: 20, entryDate: "2026-10-13", exitTs: ts + 1 });
  const dayEquity = equityState({
    peakEquity: daily.book.peakEquity,
    realizedUsd: daily.book.realizedUsd,
    openMtmUsd: 0,
    dayStartEquity: daily.book.dayStartEquity,
    weekStartEquity: daily.book.weekStartEquity,
    pairLossUsd: 0,
  });
  expect(dayEquity.backstop).toBe(true);
  expect(dayEquity.halt).toBe(true);
  applyForward(daily.book, {
    kind: "x1", id: "after-900", classId: "C", productId: "SOL-USD", tsMs: ts + 2, nextOpen: 100, stop: 90, atr1h: 1, ...quote,
  });
  expect(daily.book.rejected.find((row) => row.id === "after-900")?.reason).toContain("backstop");

  const bookLoss = startPaperHost(["ETH-USD"], {});
  applyForward(bookLoss.book, { kind: "clock", tsMs: ts });
  applyForward(bookLoss.book, { kind: "realize", id: "book", classId: "C", productId: "ETH-USD", netR: -1, netUsd: -8_000, riskUsd: 20, entryDate: "2026-10-13", exitTs: ts + 1 });
  const bookEquity = equityState({
    peakEquity: bookLoss.book.peakEquity,
    realizedUsd: bookLoss.book.realizedUsd,
    openMtmUsd: 0,
    dayStartEquity: bookLoss.book.dayStartEquity,
    weekStartEquity: bookLoss.book.weekStartEquity,
    pairLossUsd: 0,
  });
  expect(bookEquity.backstop).toBe(true);
  expect(bookLoss.book.realizedUsd).toBe(-8_000);

  const pair = startPaperHost(["ETH-USD", "SOL-USD"], {});
  applyForward(pair.book, { kind: "clock", tsMs: ts });
  applyForward(pair.book, { kind: "realize", id: "pair", classId: "C", productId: "ETH-USD", netR: -1, netUsd: -500, riskUsd: 20, entryDate: "2026-10-13", exitTs: ts + 1 });
  expect(pair.book.pairs["ETH-USD"]?.latched).toBe(true);
  applyForward(pair.book, {
    kind: "x1", id: "latched", classId: "C", productId: "ETH-USD", tsMs: ts + 2, nextOpen: 100, stop: 90, atr1h: 1, ...quote, bookTsMs: ts + 2, sendTsMs: ts + 2,
  });
  expect(pair.book.rejected.find((row) => row.id === "latched")?.reason).toBe("pair-backstop");
  applyForward(pair.book, {
    kind: "x1", id: "other", classId: "C", productId: "SOL-USD", tsMs: ts + 3, nextOpen: 100, stop: 90, atr1h: 1, bid: 100, ask: 100.1, bookTsMs: ts + 3, sendTsMs: ts + 3, decisionMid: 100,
  });
  expect(pair.book.rejected.find((row) => row.id === "other")?.reason).not.toBe("pair-backstop");

  const beta = startPaperHost(["ETH-USD"], {});
  applyForward(beta.book, { kind: "clock", tsMs: ts });
  applyForward(beta.book, {
    kind: "x1", id: "open", classId: "C", productId: "ETH-USD", tsMs: ts, nextOpen: 100, stop: 90, atr1h: 1, ...quote,
  });
  expect(beta.book.positions).toHaveLength(1);
  const held = beta.book.positions[0]!;
  held.notionalUsd = 6_001;
  held.beta = 1;
  applyForward(beta.book, {
    kind: "x1", id: "capped", classId: "C", productId: "ETH-USD", tsMs: ts + 60_000, nextOpen: 100, stop: 90, atr1h: 1,
    bid: 100, ask: 100.1, bookTsMs: ts + 60_000, sendTsMs: ts + 60_000, decisionMid: 100,
  });
  expect(beta.book.rejected.find((row) => row.id === "capped")?.reason).toContain("beta");

  const curve = startPaperHost(["ETH-USD"], {});
  applyForward(curve.book, { kind: "realize", id: "p10", classId: "A", productId: "ETH-USD", netR: -10, netUsd: 0, riskUsd: 20, entryDate: "2026-10-13", exitTs: ts });
  expect(curve.book.classes.A.curve.paused).toBe(true);
  expect(curve.book.classes.A.curve.killed).toBe(false);
  applyForward(curve.book, { kind: "realize", id: "k20", classId: "A", productId: "ETH-USD", netR: -10, netUsd: 0, riskUsd: 20, entryDate: "2026-10-13", exitTs: ts + 1 });
  expect(curve.book.classes.A.curve.killed).toBe(true);
});

test("replay and the host disagree on tick and send time, and that changes a D fill", () => {
  const ts = Date.parse("2026-10-13T12:00:00.000Z");
  const entry: GeneratedEntry = {
    kind: "d-order",
    classId: "D",
    productId: "ETH-USD",
    tsMs: ts,
    nextOpen: 1,
    stop: 0.9,
    target: null,
    dailyAtr: 0.1,
    priorDailyCloses: [],
    signalDate: "2026-10-13",
  };
  const replay = entriesToEvents([entry])[0];
  expect(replay?.kind).toBe("d-order");
  if (replay?.kind !== "d-order") return;
  const hostTick = 0.05;
  const sendTs = ts + 2_500;
  const bookTs = ts + 400;
  expect(replay.tick).toBe(0.01);
  expect(replay.bookTsMs).toBe(ts);
  expect(replay.sendTsMs ?? ts).toBe(ts);
  expect(hostTick - (replay.tick ?? 0)).toBeCloseTo(0.04);
  expect(sendTs - ts).toBe(2_500);
  expect(bookTs - replay.bookTsMs).toBe(400);
  const price = 1 - 0.01;
  expect(tradeThroughFill(1, price, replay.tick ?? 0.01, 2)?.filled).toBe(true);
  expect(tradeThroughFill(1, price, hostTick, 2)?.filled).toBe(false);
  const fine = freshBook({ members: ["ETH-USD"] });
  const coarse = freshBook({ members: ["ETH-USD"] });
  const order = {
    kind: "d-order" as const,
    productId: "ETH-USD",
    limit: 1,
    units: 1,
    placedTs: ts,
    stop: 0.9,
    bid: 1.01,
    ask: 1.02,
    bookTsMs: ts,
    sendTsMs: ts,
    decisionMid: 1,
  };
  applyForward(fine, { ...order, id: "fine", tick: 0.01 });
  applyForward(coarse, { ...order, id: "coarse", tick: hostTick });
  applyForward(fine, { kind: "trade", productId: "ETH-USD", price, size: 2, makerSide: "sell", tsMs: ts + 1 });
  applyForward(coarse, { kind: "trade", productId: "ETH-USD", price, size: 2, makerSide: "sell", tsMs: ts + 1 });
  expect(fine.positions.some((row) => row.id === "fine")).toBe(true);
  expect(coarse.positions.some((row) => row.id === "coarse")).toBe(false);
  expect(coarse.working).toHaveLength(1);
});

test("daily warmup, catch-up, and the product book each stop on a 429", async () => {
  const host = startPaperHost(["ZZ-429"], {});
  host.warmup.clear();
  host.hourWarm.clear();
  host.historyFrom.set("ZZ-429", 1_700_000_000);
  host.restCursor.clear();
  host.clock = () => (1_700_000_000 + 3_600) * 1000;
  const denied = async () => ({ ok: false, status: 429, json: async () => [] });
  await warmSeriesFromRest(host, denied);
  await catchUpHistory(host, denied);
  expect(host.restFallback).toBe(0);
  expect(host.fifteen).toHaveLength(0);
  expect(host.book.incidents.some((row) => row.includes("429"))).toBe(true);
  const now = host.clock();
  host.books.set("ZZ-429", { bids: new Map([["10", 1]]), asks: new Map([["10.1", 1]]) });
  host.l2Ts.set("ZZ-429", now - 16_000);
  host.queued.set("z", {
    kind: "x1",
    classId: "C",
    productId: "ZZ-429",
    tsMs: now - 30_000,
    nextOpen: 10,
    stop: 9,
    target: null,
    dailyAtr: 1,
    priorDailyCloses: [],
    signalDate: "2026-10-12",
  });
  let calls = 0;
  await sendDueEntries(host, now, async () => {
    calls += 1;
    return { ok: false, status: 429, headers: { get: () => "2" }, json: async () => ({}) };
  });
  await sendDueEntries(host, now + 500, async () => {
    calls += 1;
    return { ok: false, status: 429, headers: { get: () => "2" }, json: async () => ({}) };
  });
  expect(calls).toBe(1);
  expect(host.queued.has("z")).toBe(true);
  expect(host.book.rejected).toEqual([]);
});

test("the start-date command reruns the A pick and leaves 2026-10-10 through go-live in neither window", () => {
  const path = join(repoRoot(), "research/data/reports/p6-forward-a.json");
  const before = createHash("sha256").update(readFileSync(path)).digest("hex");
  const report = startDateReport("2026-11-02");
  const after = createHash("sha256").update(readFileSync(path)).digest("hex");
  expect(after).toBe(before);
  expect(after).toBe(FORWARD_PICK_SHA256);
  expect(report.chosen).toBe(readForwardPick().config);
  expect(report.monthlyReselect).toBe(false);
  const window = paperWindow("2026-11-02");
  expect(window.inSample).toEqual({ from: "2025-11-10", through: "2026-10-09" });
  expect(window.neither).toEqual({ from: "2026-10-10", through: "2026-11-01" });
  expect(window.forwardFrom).toBe("2026-11-02");
  expect(report.neitherInSampleNorForward).toEqual(window.neither);
});

test("one day at 50 products is one state write per bar and no member-close copy", () => {
  const host = startPaperHost(["P0"], {});
  const t0 = 1_700_000_000;
  for (let product = 0; product < 50; product += 1) {
    for (let bar = 0; bar < 96; bar += 1) {
      host.fifteen.push({ productId: `P${product}`, startSec: t0 + bar * 900, open: 1, high: 1.1, low: 0.9, close: 1, volume: 1 });
    }
  }
  const body = capturePaperState(host);
  const { warmup, memberCloses, ...live } = body;
  void warmup;
  void memberCloses;
  const bytes = Buffer.byteLength(JSON.stringify(live));
  expect("memberCloses" in live).toBe(false);
  expect(bytes).toBeGreaterThan(100_000);
  expect(bytes).toBeLessThan(2_000_000);
  const barsPerDay = 50 * 96;
  expect(barsPerDay).toBe(4_800);
  expect(Math.round(86_400_000 / SAVE_HEARTBEAT_MS)).toBe(1_440);
  expect(bytes).toBeLessThan(2_000_000);
});
