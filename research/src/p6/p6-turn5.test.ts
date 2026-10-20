import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import type { SourceDay } from "../p3/bar-access";
import type { BarOHLC } from "../p3/signals";
import { monthlyClusters } from "../p5/book";
import { addDays } from "../p5/stats";
import { forwardClusterBeta } from "./clusters";
import { applyForward, freshBook, noteMemberDay } from "./engine";
import { parsePublicMessage } from "./feed";
import {
  generateForward,
  hourAtrAt,
  lastCompletedDailyAtr,
  vetoFromBtc,
  withExplicitGaps,
  type GeneratedEntry,
} from "./generate";
import { barsFromExchangeCandles, planHistorySpans } from "./rest-bars";
import {
  acceptRestBar,
  applyPublic,
  catchUpHistory,
  considerHeartbeatGap,
  dueRest,
  flushEntries,
  historyOriginSec,
  noteRestMiss,
  noteSocketClose,
  restAction,
  savePaperState,
  loadPaperState,
  startPaperHost,
  universeEntries,
} from "./paper-host";

const flags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };

function day(date: string, close: number, empty = false): SourceDay {
  return {
    date,
    ts: Date.parse(`${date}T00:00:00.000Z`) / 1000,
    open: empty ? 0 : close,
    high: empty ? 0 : close,
    low: empty ? 0 : close,
    close: empty ? 0 : close,
    volume: empty ? 0 : 1,
    empty,
  };
}

test("missing calendar days stay in the series and history starts the day after the store", () => {
  const series = withExplicitGaps([day("2026-10-12", 3), day("2026-10-10", 1)]);
  expect(series.map((row) => [row.date, row.empty])).toEqual([
    ["2026-10-10", false],
    ["2026-10-11", true],
    ["2026-10-12", false],
  ]);
  expect(series[1]?.open).toBe(0);
  expect(historyOriginSec([day("2026-10-09", 1, true), day("2026-10-10", 2)])).toBe(Date.parse("2026-10-11T00:00:00.000Z") / 1000);
  expect(historyOriginSec([])).toBeNull();
  const origin = Date.parse("2026-10-11T00:00:00.000Z") / 1000;
  const one = planHistorySpans(origin, origin + 300 * 900 - 900);
  expect(one).toEqual([{ startSec: origin, endSec: origin + 300 * 900 - 900 }]);
  expect(planHistorySpans(origin, origin + 300 * 900)).toHaveLength(2);
  expect(planHistorySpans(origin, origin - 900)).toEqual([]);
  const rows = barsFromExchangeCandles("ETH-USD", [
    [origin + 900, 1, 4, 2, 3, 5],
    [origin, 1, 3, 2, 2.5, 4],
  ]);
  expect(rows.map((bar) => bar.startSec)).toEqual([origin, origin + 900]);
  expect(rows[0]?.open).toBe(2);
});

test("an intraday bar uses the previous day's ATR and the day-close bar uses its own", () => {
  const atr = new Map([
    ["2026-10-10", 4],
    ["2026-10-11", 9],
  ]);
  expect(lastCompletedDailyAtr(atr, "2026-10-11", false)).toBe(4);
  expect(lastCompletedDailyAtr(atr, "2026-10-11", true)).toBe(9);
  expect(lastCompletedDailyAtr(atr, "2026-10-10", false)).toBe(0);
});

test("catch-up reads REST from the store end, marks holes, and does not roll bars off", async () => {
  const host = startPaperHost(["GAP-USD"], {});
  host.warmup.clear();
  const start = 1_728_000_000;
  host.historyFrom.set("GAP-USD", start);
  host.restCursor.clear();
  host.clock = () => (start + 1_800) * 1000;
  const urls: string[] = [];
  await catchUpHistory(host, async (url) => {
    urls.push(String(url));
    return new Response(JSON.stringify([[start, 1, 3, 2, 2.5, 4]]), { status: 200 });
  });
  expect(urls.length).toBe(1);
  expect(host.fifteen).toHaveLength(1);
  expect(host.fifteen[0]?.startSec).toBe(start);
  expect(host.book.incidents.some((row) => row.includes(`history missing GAP-USD ${start} bars 1`))).toBe(true);
  expect(host.restFallback).toBe(0);
  expect(host.restCursor.get("GAP-USD")).toBe(start + 1_800);
  const again = host.fifteen.length;
  await catchUpHistory(host, async () => new Response("[]", { status: 200 }));
  expect(host.fifteen.length).toBe(again);

  host.restCursor.set("GAP-USD", start);
  await catchUpHistory(host, async () => new Response(JSON.stringify([[start, 1, 3, 2, 2.5, 4]]), { status: 200 }));
  expect(host.fifteen.filter((bar) => bar.startSec === start)).toHaveLength(1);

  host.restCursor.set("GAP-USD", start + 1_800);
  host.clock = () => (start + 2_700) * 1000;
  await catchUpHistory(host, async () => new Response("", { status: 429 }));
  expect(host.book.incidents.some((row) => row.includes("429"))).toBe(true);
  expect(host.restFallback).toBe(0);

  host.fifteen = [];
  host.applied.clear();
  const kept = start + 86_400;
  for (let index = 0; index < 501; index += 1) {
    acceptRestBar(host, { productId: "GAP-USD", startSec: kept + index * 900, open: 2, high: 3, low: 1, close: 2.5, volume: 1 });
  }
  expect(host.fifteen.length).toBe(501);
  expect(host.fifteen[0]?.startSec).toBe(kept);
  expect(host.fifteen[500]?.startSec).toBe(kept + 500 * 900);
});

test("the live universe is the offline generator, including the BTC veto", () => {
  const host = startPaperHost(["ETH-USD", "SOL-USD"], {});
  const dates: string[] = [];
  for (let i = 0; i < 60; i += 1) dates.push(addDays("2026-01-01", i));
  const warmup = new Map<string, SourceDay[]>();
  for (const id of ["BTC-USD", "ETH-USD", "SOL-USD"]) {
    warmup.set(id, dates.map((date, index) => day(date, id === "BTC-USD" && index === 59 ? 90 : 100 + index * 0.1)));
  }
  host.warmup = warmup;
  host.fifteen = [
    { productId: "ETH-USD", startSec: 1_767_225_600, open: 100, high: 101, low: 99, close: 100.4, volume: 1 },
    { productId: "SOL-USD", startSec: 1_767_225_600, open: 100, high: 102, low: 98, close: 100.2, volume: 1 },
  ];
  if (!host.context) {
    host.context = { flags, byProduct: new Map([["ETH-USD", flags], ["SOL-USD", flags], ["BTC-USD", flags]]), memberOn: () => true };
  }
  const nowSec = 1_767_226_500;
  const live = universeEntries(host, nowSec);
  const btc = warmup.get("BTC-USD") ?? [];
  const offline = generateForward({
    bars: host.fifteen,
    nowSec,
    flags: host.context!.flags,
    flagsByProduct: host.context!.byProduct,
    memberOn: host.context!.memberOn,
    warmupDays: host.warmup,
    veto: vetoFromBtc(btc, []),
    pick: { lookback: host.book.aPick!.lookback, k: host.book.aPick!.k },
  });
  expect(live).not.toBeNull();
  expect(live!.entries).toEqual(offline.entries);
  expect(live!.weeks).toEqual(offline.weeks);
  expect(host.weeks.get("*")).toEqual(offline.weeks);
  const crash = dates[59]!;
  expect(vetoFromBtc(btc, [])(crash)).toBe(true);
  expect(vetoFromBtc(btc, [])(dates[58]!)).toBe(false);
  const open = generateForward({ bars: [], nowSec: 0, flags, warmupDays: warmup, veto: () => false, pick: { lookback: 55, k: 3 } });
  const shut = generateForward({ bars: [], nowSec: 0, flags, warmupDays: warmup, veto: () => true, pick: { lookback: 55, k: 3 } });
  expect(shut.entries.filter((entry) => entry.classId === "B")).toEqual([]);
  expect(shut.entries.filter((entry) => entry.classId !== "B")).toEqual(open.entries.filter((entry) => entry.classId !== "B"));
});

test("entries send at the next open and staleness is the wall clock, not the signal time", () => {
  const book = freshBook({ members: ["ETH-USD"] });
  const ts = Date.parse("2026-10-15T01:00:00.000Z");
  applyForward(book, { kind: "clock", tsMs: ts });
  const order = {
    kind: "x1" as const,
    classId: "A" as const,
    productId: "ETH-USD",
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    decisionMid: 100,
    aConfig: "A55-k3",
  };
  applyForward(book, { ...order, id: "late-send", tsMs: ts, bookTsMs: ts, sendTsMs: ts + 20_000 });
  expect(book.rejected.find((row) => row.id === "late-send")?.reason).toBe("missed_send_stale_quote");
  applyForward(book, { ...order, id: "fresh-send", tsMs: ts - 60_000, bookTsMs: ts, sendTsMs: ts });
  expect(book.rejected.find((row) => row.id === "fresh-send")?.reason).not.toBe("stale-book");

  const host = startPaperHost(["ETH-USD"], {});
  const now = ts;
  applyPublic(host, 0, [{ kind: "l2-snapshot", productId: "ETH-USD", bids: [["100", "1"]], asks: [["100.2", "1"]] }], now - 16_000);
  const closeTs = now - 90_000;
  const entry: GeneratedEntry = {
    kind: "x1",
    classId: "C",
    productId: "ETH-USD",
    tsMs: closeTs,
    nextOpen: 0,
    stop: 90,
    target: null,
    dailyAtr: 2,
    priorDailyCloses: [],
    signalDate: "2026-10-14",
    fillAtOpen: true,
    decisionTs: closeTs,
    barCloseTs: closeTs,
  };
  host.queued.set(`C-ETH-USD-${closeTs}`, entry);
  flushEntries(host, now);
  const missed = host.book.legs.find((leg) => leg.id === `C-ETH-USD-${closeTs}`);
  expect(missed?.fillSrc).toBe("stale_quote_modelled");
  expect(host.book.positions.some((row) => row.id === `C-ETH-USD-${closeTs}`)).toBe(true);
  expect(host.book.staleQuoteMisses).toBeGreaterThan(0);
  host.book.positions = [];

  host.restQuotes.set("ETH-USD", { bid: 100, ask: 100.2, tsMs: now - 1_000 });
  const fallbackId = `C-ETH-USD-${closeTs + 1}`;
  host.queued.set(fallbackId, { ...entry, tsMs: closeTs + 1 });
  flushEntries(host, now);
  const fallback = host.book.legs.find((leg) => leg.id === fallbackId);
  expect(fallback?.quoteSrc).toBe("rest_fallback");
  expect(fallback?.decisionTs).toBe(closeTs);
  expect(fallback?.barCloseTs).toBe(closeTs);
  expect(fallback?.orderSendTs).toBe(now);

  const live = startPaperHost(["ETH-USD"], {});
  applyPublic(live, 0, [{ kind: "l2-snapshot", productId: "ETH-USD", bids: [["200", "1"]], asks: [["200.2", "1"]] }], now - 500);
  const freshId = `A-ETH-USD-${now - 45_000}`;
  live.queued.set(freshId, {
    kind: "x1",
    classId: "A",
    productId: "ETH-USD",
    tsMs: now - 45_000,
    nextOpen: 0,
    stop: 0,
    target: null,
    dailyAtr: 2,
    priorDailyCloses: [],
    signalDate: "2026-10-14",
    aConfig: "A55-k3",
    fillAtOpen: true,
    decisionTs: now - 45_000,
    barCloseTs: now - 45_000,
  });
  live.hourWarm.set("ETH-USD", Array.from({ length: 20 }, (_, index) => {
    const px = 100 + index;
    return { ts: index * 3_600, open: px, high: px + 2, low: px - 2, close: px + 0.5, volume: 1 };
  }));
  flushEntries(live, now);
  expect(live.book.rejected.find((row) => row.id === freshId)?.reason).not.toBe("missed_send_stale_quote");
  const fresh = live.book.legs.find((leg) => leg.id === freshId);
  expect(fresh?.quoteSrc).toBe("l2");
  expect(now - (fresh?.arrivalSnapshotTs ?? 0)).toBeLessThan(1_000);
  expect(fresh?.decisionTs).toBe(now - 45_000);
  expect(fresh?.barCloseTs).toBe(now - 45_000);
  expect(fresh?.orderSendTs).toBe(now);
});

test("startup past the deadline still fetches, and a spent attempt falls back", () => {
  const host = startPaperHost(["ZZZ-USD"], {});
  host.historyFrom.delete("ZZZ-USD");
  const due = dueRest(host, 2_000_000);
  expect(due.length).toBeGreaterThan(0);
  expect(due.every((row) => row.action === "fetch")).toBe(true);
  const slot = due[0]!.slot;
  expect(slot.attempts).toBe(0);
  expect(restAction(slot, 2_000_000)).toBe("fetch");
  noteRestMiss(host, slot);
  expect(restAction(slot, 2_000_000)).toBe("fallback");
});

test("1h ATR is the warmed hour series and the tick is the product increment", () => {
  const host = startPaperHost(["ZZ-ATR-USD"], {});
  host.warmup.clear();
  const hours: BarOHLC[] = Array.from({ length: 20 }, (_, index) => {
    const px = 100 + index;
    return { ts: index * 3_600, open: px, high: px + 3, low: px - 3, close: px + 1, volume: 1 };
  });
  host.hourWarm.set("ZZ-ATR-USD", hours);
  const start = 19 * 3_600;
  acceptRestBar(host, { productId: "ZZ-ATR-USD", startSec: start, open: 120, high: 121, low: 119, close: 120.5, volume: 1 });
  const atr = hourAtrAt(hours, start);
  expect(atr).toBeGreaterThan(0);
  expect(host.lastBar?.atr1h).toBe(atr);
  expect(host.lastBar?.dailyAtr ?? 0).toBe(0);

  const spot = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/products/usd-spot.json", import.meta.url)), "utf8")) as {
    products: { productId: string; tickSize: string | null }[];
  };
  const row = spot.products.find((product) => product.productId === "ETH-USD" && Number(product.tickSize) > 0);
  expect(row).toBeTruthy();
  const quoted = startPaperHost(["ETH-USD"], {});
  expect(quoted.ticks.get("ETH-USD")).toBe(Number(row!.tickSize));
  const odd = spot.products.find((product) => Number(product.tickSize) > 0 && Number(product.tickSize) !== 0.01);
  expect(odd).toBeTruthy();
  expect(quoted.ticks.get(odd!.productId)).toBe(Number(odd!.tickSize));

  const now = Date.parse("2026-10-15T01:00:00.000Z");
  applyPublic(quoted, 0, [{ kind: "l2-snapshot", productId: "ETH-USD", bids: [["100", "1"]], asks: [["100.1", "1"]] }], now);
  quoted.ticks.delete("ETH-USD");
  quoted.queued.set(`D-ETH-USD-${now}`, {
    kind: "d-order",
    classId: "D",
    productId: "ETH-USD",
    tsMs: now,
    nextOpen: 100,
    stop: 90,
    target: 110,
    dailyAtr: 0,
    priorDailyCloses: [],
    signalDate: "2026-10-14",
  });
  flushEntries(quoted, now);
  expect(quoted.book.rejected.some((item) => item.reason === "tick")).toBe(true);
  expect(quoted.book.incidents.some((item) => item.includes("tick missing ETH-USD"))).toBe(true);
});

test("a replaced socket does not stick, every reconnect is an incident, and trade snapshots dedupe", () => {
  const host = startPaperHost(["ETH-USD"], {});
  host.socketGen[0] = 2;
  host.replacing[0] = true;
  noteSocketClose(host, 0, 1);
  expect(host.replacing[0]).toBe(false);
  expect(host.needsReconnect[0]).toBe(false);
  expect(host.book.incidents.some((row) => row.includes("reconnect"))).toBe(false);
  noteSocketClose(host, 0, 2);
  expect(host.needsReconnect[0]).toBe(true);
  expect(host.book.incidents.some((row) => row.includes("socket 0 closed"))).toBe(true);
  expect(considerHeartbeatGap(host, 0, 10_000)).toBe(true);
  expect(host.book.incidents.some((row) => row.startsWith("socket reconnect 1 closed:"))).toBe(true);

  const raw = {
    channel: "market_trades",
    events: [{ type: "snapshot", trades: [{ product_id: "ETH-USD", price: "100", size: "1.5", side: "SELL", time: "2026-10-12T12:00:01.000Z", trade_id: "abc" }] }],
  };
  const parsed = parsePublicMessage(raw);
  expect(parsed[0]).toMatchObject({ kind: "trade", side: "SELL", tradeId: "abc" });
  applyPublic(host, 0, parsed, 1_000);
  applyPublic(host, 0, parsed, 2_000);
  expect(host.trades).toHaveLength(1);
  const feed = readFileSync(fileURLToPath(new URL("./feed.ts", import.meta.url)), "utf8");
  expect(feed).toContain("https://docs.cdp.coinbase.com/api-reference/advanced-trade-api/websocket/market-trades");
  expect(feed).toContain("maker");
});

test("a live member close waits for the month boundary, then the recompute sees it", () => {
  const dates: string[] = [];
  for (let i = 0; i < 220; i += 1) dates.push(addDays("2025-11-01", i));
  let btc = 100;
  let eth = 100;
  let sol = 100;
  const btcDays: { date: string; close: number }[] = [];
  const ethDays: { date: string; close: number }[] = [];
  const solDays: { date: string; close: number }[] = [];
  dates.forEach((date, i) => {
    const shock = Math.sin(i / 3) * 0.02 + ((i % 5) - 2) * 0.003;
    const ethRet = date < "2026-03-01" ? shock : Math.cos(i / 4) * 0.015;
    const solRet = date < "2026-03-01" ? shock : -shock * 0.8;
    btc *= 1 + shock;
    eth *= 1 + ethRet;
    sol *= 1 + solRet;
    btcDays.push({ date, close: btc });
    ethDays.push({ date, close: eth });
    solDays.push({ date, close: sol });
  });
  const asDays = (rows: { date: string; close: number }[]): SourceDay[] =>
    rows.map((row) => day(row.date, row.close));
  const early = (rows: { date: string; close: number }[]) => asDays(rows.filter((row) => row.date <= "2026-02-28"));
  const book = freshBook({
    members: ["BTC-USD", "ETH-USD", "SOL-USD"],
    aPick: { config: "A55-k3", lookback: 55, k: 3, at: "2026-03-05", stats: [] },
    memberCloses: [
      { productId: "BTC-USD", flags, days: early(btcDays) },
      { productId: "ETH-USD", flags, days: early(ethDays) },
      { productId: "SOL-USD", flags, days: early(solDays) },
    ],
    btcCloses: btcDays.filter((row) => row.date <= "2026-02-28"),
  });
  const ts = Date.parse("2026-03-05T01:00:00.000Z");
  applyForward(book, { kind: "clock", tsMs: ts });
  applyForward(book, {
    kind: "x1",
    id: "eth",
    classId: "A",
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
    aConfig: "A55-k3",
  });
  expect(book.clusterAsOf).toBe("2026-03-01");
  const march = monthlyClusters(
    [
      { productId: "BTC-USD", flags, days: early(btcDays) },
      { productId: "ETH-USD", flags, days: early(ethDays) },
      { productId: "SOL-USD", flags, days: early(solDays) },
    ],
    ["2026-03-01"],
  ).get("2026-03-01");
  expect(book.positions.find((position) => position.id === "eth")?.clusterId).toBe(march?.get("ETH-USD"));
  noteMemberDay(book, "ETH-USD", day("2026-03-20", ethDays.find((row) => row.date === "2026-03-20")!.close));
  expect(book.clusterAsOf).toBe("2026-03-01");
  expect(book.config.memberCloses?.find((member) => member.productId === "ETH-USD")?.days.some((row) => row.date === "2026-03-20")).toBe(true);
  for (const row of btcDays.filter((item) => item.date > "2026-02-28")) noteMemberDay(book, "BTC-USD", day(row.date, row.close));
  for (const row of ethDays.filter((item) => item.date > "2026-02-28" && item.date !== "2026-03-20")) noteMemberDay(book, "ETH-USD", day(row.date, row.close));
  for (const row of solDays.filter((item) => item.date > "2026-02-28")) noteMemberDay(book, "SOL-USD", day(row.date, row.close));
  expect(book.clusterAsOf).toBe("2026-03-01");
  applyForward(book, { kind: "clock", tsMs: Date.parse("2026-05-12T00:00:00.000Z") });
  expect(book.clusterAsOf).toBe("2026-05-10");
  const full = forwardClusterBeta(book.config.memberCloses ?? [], book.config.btcCloses ?? [], "2026-05-10");
  expect(book.betas["ETH-USD"]).toBe(full.betas.get("ETH-USD"));
  expect(book.betas["SOL-USD"]).toBe(full.betas.get("SOL-USD"));
  const frozen = forwardClusterBeta(
    [
      { productId: "BTC-USD", flags, days: early(btcDays) },
      { productId: "ETH-USD", flags, days: early(ethDays) },
      { productId: "SOL-USD", flags, days: early(solDays) },
    ],
    btcDays.filter((row) => row.date <= "2026-02-28"),
    "2026-05-10",
  );
  expect(book.betas["ETH-USD"]).not.toBe(frozen.betas.get("ETH-USD"));
  expect(book.positions.find((position) => position.id === "eth")?.clusterId).toBe(march?.get("ETH-USD"));
});

test("saved state keeps the full 15m history and the B weeks", () => {
  const host = startPaperHost(["ETH-USD"], {});
  host.fifteen.push({ productId: "ETH-USD", startSec: 100, open: 1, high: 2, low: 1, close: 1.5, volume: 1 });
  host.weeks.set("*", [{ date: "2026-10-12", rows: [{ id: "ETH-USD", score: 1, member: true }] }]);
  const dir = join(mkdtempSync(join(tmpdir(), "p6-turn5-")), "data", "runtime", "state");
  savePaperState(dir, host);
  const next = startPaperHost(["ETH-USD"], {});
  expect(loadPaperState(dir, next)).toBe(true);
  expect(next.fifteen).toHaveLength(1);
  expect(next.weeks.get("*")?.[0]?.date).toBe("2026-10-12");
  rmSync(dir, { recursive: true, force: true });
});
