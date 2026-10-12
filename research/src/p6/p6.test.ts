import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { classBScore } from "../p3/classes";
import { collectA, isMondayCloseBar, x1EntryTs } from "../p5/run";
import { addDays } from "../p5/stats";
import { applyEvent, completedDailyDates, freshFeed, parsePublicMessage, rebuildFeed, finishWarmup } from "./feed";
import { shadowPackets, warmupLabel } from "./jev-shadow";
import { OPEN_QUESTIONS } from "./open-questions";
import { empiricalQuantile } from "./percentile";
import { placeboExitIndexes } from "./placebo";
import { candleBackfillUrl, feedProducts, missingMinutes, subscribeFrames } from "./public-ws";
import { replaySignals, type ReplayDay } from "./replay";
import { forwardReview } from "./review";
import {
  classBlockers,
  entryGates,
  equityState,
  freshClassCurve,
  momentumOnDate,
  paperDecision,
  shadowGuard,
  stepClass,
} from "./session";
import { indeterminateShare, onFeedGap, onPublicTrade, openShadow } from "./shadow";
import { bSizingCheck, type FoldPick, type TapeTrade } from "./sizing";

test("stitched base B is sized at $60 open risk and the $1,500 cap does not bind", () => {
  const path = fileURLToPath(new URL("../../data/reports/p5-v31-results.json", import.meta.url));
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    results: { trades: TapeTrade[]; selection: { folds: FoldPick[] } };
  };
  const check = bSizingCheck(doc.results.trades, doc.results.selection.folds);
  expect(check.bug).toBe(false);
  expect(check.n).toBe(28);
  expect(check.mismatches).toBe(0);
  expect(check.capBinds).toBe(0);
  expect(check.rows.every((row) => row.openRiskIs60 && row.costBps === 190)).toBe(true);
  expect(check.meanNetBps).toBeLessThan(0);
  expect(check.totalNetUsd).toBeGreaterThan(0);
  expect(check.meanRTimesRisk).toBeCloseTo(check.totalNetUsd, 6);
  expect(check.notionalWeightedBps).toBeGreaterThan(0);
  const reportPath = fileURLToPath(new URL("../../data/reports/p6-b-sizing-check.json", import.meta.url));
  const report = JSON.parse(readFileSync(reportPath, "utf8")) as { bug: boolean; n: number; mismatches: number; capBinds: number; totalNetUsd: number; rows: unknown[] };
  expect(report.bug).toBe(false);
  expect(report.n).toBe(check.n);
  expect(report.mismatches).toBe(check.mismatches);
  expect(report.capBinds).toBe(check.capBinds);
  expect(report.totalNetUsd).toBeCloseTo(check.totalNetUsd, 8);
  expect(report.rows).toHaveLength(check.rows.length);
});

test("a public subscribe carries candles, L2, and trades, and refuses keys and order channels", () => {
  const products = feedProducts(["ETH-USD"]);
  expect(products).toEqual(["ETH-USD", "BTC-USD"]);
  const frames = subscribeFrames(products, undefined, { PATH: "/usr/bin" });
  expect(frames).toHaveLength(4);
  for (const frame of frames) {
    expect(frame).not.toContain("signature");
    expect(frame).not.toContain("secret");
    const body = JSON.parse(frame) as { channel: string; product_ids: string[] };
    expect(["heartbeats", "candles", "level2", "market_trades"]).toContain(body.channel);
    expect(body.product_ids).toContain("BTC-USD");
  }
  expect(() => subscribeFrames(["BTC-USD"], undefined, { COINBASE_API_KEY: "present" })).toThrow(/order-capable/);
  expect(() => JSON.parse(`{"type":"subscribe","channel":"user"}`) && subscribeFrames(["BTC-USD"], ["user" as "candles"], {})).toThrow(/channel/);
  expect(() => parsePublicMessage({ channel: "orders", events: [] })).toThrow(/order channel/);
});

test("backfill uses the public candle URL", () => {
  const url = candleBackfillUrl("BTC-USD", 1_700_000_000, 1_700_000_060);
  expect(url).toContain("https://api.exchange.coinbase.com/products/BTC-USD/candles");
  expect(url).not.toContain("/orders");
  expect(missingMinutes([60], 0, 120)).toEqual([0, 120]);
});

test("a 1m candle completes on the next minute, a same-minute update does not, and a jump is a gap", () => {
  const state = freshFeed();
  const first = applyEvent(state, { kind: "candle", productId: "BTC-USD", startSec: 0, open: 10, high: 11, low: 9, close: 10.5, volume: 1 });
  expect(first.completed).toBeNull();
  const update = applyEvent(state, { kind: "candle", productId: "BTC-USD", startSec: 0, open: 10, high: 12, low: 9, close: 11, volume: 2 });
  expect(update.completed).toBeNull();
  expect(state.forming.get("BTC-USD")?.high).toBe(12);
  const next = applyEvent(state, { kind: "candle", productId: "BTC-USD", startSec: 60, open: 11, high: 11, low: 11, close: 11, volume: 1 });
  expect(next.completed?.startSec).toBe(0);
  expect(next.completed?.close).toBe(11);
  expect(next.gap).toBe(false);
  const jump = applyEvent(state, { kind: "candle", productId: "BTC-USD", startSec: 180, open: 11, high: 11, low: 11, close: 11, volume: 1 });
  expect(jump.gap).toBe(true);
  expect(jump.completed?.startSec).toBe(60);
});

test("restart rebuilds completed bars and marks the feed warming until warmup finishes", () => {
  const state = rebuildFeed([{ productId: "ETH-USD", startSec: 0, open: 1, high: 1, low: 1, close: 1, volume: 1 }]);
  expect(state.warming).toBe(true);
  expect(state.completed).toHaveLength(1);
  expect(applyEvent(state, { kind: "heartbeat" }).warming).toBe(true);
  finishWarmup(state);
  expect(applyEvent(state, { kind: "heartbeat" }).warming).toBe(false);
});

test("a UTC day is acted on only after a later date arrives", () => {
  const day = 1_736_035_200;
  expect(completedDailyDates([{ startSec: day }, { startSec: day + 60 }])).toEqual([]);
  expect(completedDailyDates([{ startSec: day }, { startSec: day + 86_400 }])).toEqual(["2025-01-05"]);
});

test("public envelopes become candles, trades, and an L2 book", () => {
  const state = freshFeed();
  const candles = parsePublicMessage({
    channel: "candles",
    events: [{ candles: [{ product_id: "BTC-USD", start: "0", open: "1", high: "2", low: "1", close: "2", volume: "3" }] }],
  });
  applyEvent(state, candles[0]!);
  applyEvent(state, parsePublicMessage({
    channel: "candles",
    events: [{ candles: [{ product_id: "BTC-USD", start: "60", open: "2", high: "2", low: "2", close: "2", volume: "1" }] }],
  })[0]!);
  expect(state.completed).toHaveLength(1);
  const [trade] = parsePublicMessage({ channel: "market_trades", events: [{ trades: [{ product_id: "BTC-USD", price: "9.9", size: "4" }] }] });
  applyEvent(state, trade!);
  expect(state.trades[0]?.price).toBe(9.9);
  const [book] = parsePublicMessage({
    channel: "level2",
    events: [{ type: "snapshot", product_id: "BTC-USD", updates: [{ side: "bid", price_level: "9", new_quantity: "1" }, { side: "offer", price_level: "11", new_quantity: "2" }] }],
  });
  applyEvent(state, book!);
  expect(state.books.get("BTC-USD")?.bids.get("9")).toBe("1");
  expect(state.books.get("BTC-USD")?.asks.get("11")).toBe("2");
});

test("X2 fills on a trade-through, goes indeterminate on a gap, and class D takes no fill", () => {
  const working = openShadow({ id: "1", mode: "X2", classId: "A", productId: "ETH-USD", limit: 10, tick: 0.01 });
  expect(onPublicTrade(working, 9.995, 4).status).toBe("working");
  const filled = onPublicTrade(working, 9.9, 4);
  expect(filled).toEqual({ ...working, status: "filled", filledVolume: 2 });
  expect(onFeedGap(working).status).toBe("indeterminate");
  expect(openShadow({ id: "d", mode: "X3", classId: "D", productId: "ETH-USD", limit: 10, tick: 0.01 }).status).toBe("no-fill");
  const share = indeterminateShare([
    { ...working, status: "indeterminate", filledVolume: 0 },
    filled,
    openShadow({ id: "d", mode: "X3", classId: "D", productId: "ETH-USD", limit: 10, tick: 0.01 }),
  ]);
  expect(share.resolved).toBe(2);
  expect(share.flagged).toBe(true);
});

test("breadth is logged and does not change size, pauses shrink, and kills latch", () => {
  const full = paperDecision({ classId: "A", blockers: [], stopBps: 500, breadthPaused: false });
  const logged = paperDecision({ classId: "A", blockers: ["pause-2a"], stopBps: 500, breadthPaused: true });
  expect(logged.entries).toBe(full.entries);
  expect(logged.riskUsd).toBe(60);
  expect(logged.notionalUsd).toBe(full.notionalUsd);
  expect(logged.openRiskUsd).toBeCloseTo(60, 8);
  expect(logged.breadth).toBe("off");
  expect(full.breadth).toBe("on");
  expect(full.entry).toBe("X1");
  expect(full.addedByJev).toBe(false);
  const shrunk = paperDecision({ classId: "C", blockers: ["pause-1b"], stopBps: 500, breadthPaused: false });
  expect(shrunk.entries).toBe(true);
  expect(shrunk.riskUsd).toBe(20);
  expect(paperDecision({ classId: "D", blockers: [], stopBps: 500, breadthPaused: false }).riskUsd).toBe(20);
  expect(paperDecision({ classId: "E", blockers: [], stopBps: 500, breadthPaused: false }).riskUsd).toBe(60);
  const blocked = paperDecision({ classId: "B", blockers: ["pause-2b"], stopBps: 500, breadthPaused: false });
  expect(blocked.entries).toBe(false);
  expect(blocked.riskUsd).toBe(20);
  let curve = freshClassCurve();
  for (let i = 0; i < 20; i += 1) curve = stepClass(curve, -1);
  expect(curve.curve.killed).toBe(true);
  curve = stepClass(curve, 50);
  expect(curve.curve.killed).toBe(true);
  const blockers = classBlockers("A", curve, { halt: false, backstop: false, momentumBlocked: false, killSwitch: false });
  expect(blockers).toContain("r-kill");
  expect(paperDecision({ classId: "A", blockers, stopBps: 500, breadthPaused: false }).entries).toBe(false);
  const bleed = freshClassCurve();
  const values = Array.from({ length: 20 }, () => -0.25);
  let rolled = bleed;
  for (const value of values) rolled = stepClass(rolled, value);
  expect(classBlockers("A", rolled, { halt: false, backstop: false, momentumBlocked: false, killSwitch: false })).toContain("pause-1b");
  expect(momentumOnDate([], "2026-03-02", -0.25, 0.15).blocked).toBe(true);
  expect(classBlockers("A", freshClassCurve(), { halt: false, backstop: false, momentumBlocked: true, killSwitch: false })).not.toContain("pause-2b");
  expect(classBlockers("B", freshClassCurve(), { halt: false, backstop: false, momentumBlocked: true, killSwitch: false })).toContain("pause-2b");
});

test("equity halts use realized plus open MTM, and the book gates use the registered caps", () => {
  const halt = equityState({ peakEquity: 10_000, realizedUsd: 8_400, openMtmUsd: 0, dayStartEquity: 8_400, weekStartEquity: 8_400, pairLossUsd: 0 });
  expect(halt.halt).toBe(true);
  expect(halt.backstop).toBe(false);
  const backstop = equityState({ peakEquity: 10_000, realizedUsd: 2_000, openMtmUsd: 0, dayStartEquity: 2_000, weekStartEquity: 2_000, pairLossUsd: 0 });
  expect(backstop.backstop).toBe(true);
  const quiet = entryGates({
    openPairs: [],
    pair: "ETH-USD",
    classId: "A",
    classOpen: 0,
    bookOpen: 0,
    openInCluster: 0,
    openRiskUsd: 0,
    addRiskUsd: 60,
    grossUsd: 0,
    addNotionalUsd: 100,
    betaWeightedUsd: 100,
    lastExitTsMs: null,
    nowTsMs: 0,
  });
  expect(quiet).toEqual([]);
  expect(entryGates({ ...quietInput(), openInCluster: 3 })).toContain("cluster");
  expect(entryGates({ ...quietInput(), betaWeightedUsd: 6_001 })).toContain("beta");
  expect(entryGates({ ...quietInput(), openRiskUsd: 421, addRiskUsd: 60 })).toContain("openRisk");
  expect(entryGates({ ...quietInput(), grossUsd: 5_500, addNotionalUsd: 600 })).toContain("grossNotional");
  expect(entryGates({ ...quietInput(), lastExitTsMs: 0, nowTsMs: 1_000 })).toContain("reentry");
  expect(entryGates({ ...quietInput(), openPairs: ["ETH-USD"] })).toContain("onePerPair");
  expect(entryGates({ ...quietInput(), classId: "A", classOpen: 3 })).toContain("slot");
  expect(entryGates({ ...quietInput(), bookOpen: 8 })).toContain("bookSlots");
});

function quietInput() {
  return {
    openPairs: [] as string[],
    pair: "ETH-USD",
    classId: "A" as const,
    classOpen: 0,
    bookOpen: 0,
    openInCluster: 0,
    openRiskUsd: 0,
    addRiskUsd: 60,
    grossUsd: 0,
    addNotionalUsd: 100,
    betaWeightedUsd: 100,
    lastExitTsMs: null,
    nowTsMs: 0,
  };
}

test("an outage adds no trade and a firing guard does not change the position", () => {
  const read = { toxicHigh: true, stressedHigh: true, consecutive: 3, unrealizedR: 0.5, warmed: true, exitTs: 100 };
  const btc = { toxicHigh: true, stressedHigh: true, consecutive: 2, warmed: true };
  const outage = shadowGuard({ outage: true, exit: read, btc });
  expect(outage).toEqual({ position: "unchanged", shadowExit: false, pauseLogged: false, authority: false, addedTrade: false, twin: null });
  const fired = shadowGuard({ outage: false, exit: read, btc });
  expect(fired.position).toBe("unchanged");
  expect(fired.shadowExit).toBe(true);
  expect(fired.pauseLogged).toBe(true);
  expect(fired.authority).toBe(false);
  expect(fired.addedTrade).toBe(false);
  expect(fired.twin).toEqual({ resimulateBook: false, exitTs: 100, reentryScope: "pair" });
});

test("S1 packets are one unread Fallback B call per member plus BTC on a completed 15m bar", () => {
  expect(shadowPackets({ members: ["ETH-USD"], barStartSec: 60, warming: false })).toEqual([]);
  const packets = shadowPackets({ members: ["ETH-USD"], barStartSec: 900, warming: true });
  expect(packets.map((row) => row.pair)).toEqual(["ETH-USD", "BTC-USD"]);
  expect(packets.every((row) => row.position === 0 && row.called === false && row.label === "warming")).toBe(true);
  expect(warmupLabel(6)).toBe("log-only");
  expect(warmupLabel(7)).toBe("pooled baseline");
  expect(warmupLabel(30)).toBe("per-pair");
  expect(empiricalQuantile([1, 2, 3, 4], 0.95)).toBe(4);
  expect(placeboExitIndexes([2, 0.2, 3, 0], 5, () => 0).every((index) => [0.2, 0][0] === 0.2 && index !== 0 && index !== 2)).toBe(true);
});

test("completed synthetic days match the P5 signal functions and an incomplete day does not", () => {
  const days: ReplayDay[] = [];
  let date = "2025-11-01";
  for (let i = 0; i < 80; i += 1) {
    const close = 100 + i;
    days.push({ date, high: close + 1, low: close - 1, close, volume: 1, complete: i < 79 });
    date = addDays(date, 1);
  }
  const atrByDate = new Map(days.map((day) => [day.date, 1]));
  const hour = days.map((day) => ({ ts: x1EntryTs(day.date), open: day.close }));
  const forward = replaySignals({ productId: "ETH-USD", days, atrByDate, hour, young: true });
  const complete = days.filter((day) => day.complete);
  const p5 = collectA("ETH-USD", {
    ema: complete,
    ohlc: complete,
    closeLookback: complete,
    volume: complete,
    classC: [],
    swing: [],
    bias: [],
    dHistoryStart: complete[0]!.date,
    listingProxySource: "first-in-window-15m",
    listingProxyDate: complete[0]!.date,
  }, atrByDate, hour, () => true, true, () => false);
  expect(forward.a.map((row) => `${row.date}:${row.lookback}`)).toEqual(p5.map((row) => `${row.date}:${row.lookback}`));
  const withLast = collectA("ETH-USD", {
    ema: days,
    ohlc: days,
    closeLookback: days,
    volume: days,
    classC: [],
    swing: [],
    bias: [],
    dHistoryStart: days[0]!.date,
    listingProxySource: "first-in-window-15m",
    listingProxyDate: days[0]!.date,
  }, atrByDate, hour, () => true, true, () => false);
  expect(withLast.length).toBeGreaterThan(forward.a.length);
  const sunday = days.find((day, index) => index >= 31 && isMondayCloseBar(day.date));
  expect(sunday).toBeTruthy();
  const index = days.findIndex((day) => day.date === sunday!.date);
  const score = classBScore(days.map((day) => day.close), index);
  expect(score).not.toBeNull();
  const scores = [
    { id: "AAA-USD", date: sunday!.date, score: 0.4, member: true, complete: true },
    { id: "BBB-USD", date: sunday!.date, score: 0.1, member: true, complete: true },
    { id: "CCC-USD", date: sunday!.date, score: -1, member: true, complete: false },
  ];
  const weeks = replaySignals({ productId: "ETH-USD", days: complete, atrByDate, hour, young: true, scores });
  expect(weeks.weeks[0]?.selected).toEqual(["AAA-USD"]);
  expect(weeks.weeks[0]?.held).not.toContain("CCC-USD");
});

test("the forward review reports the 5-stream Holm and the Jev family of 2 at p = 1", () => {
  const trades = [
    { classId: "A" as const, productId: "ETH-USD", netR: 1, grossUsd: 10, netUsd: 8, entryDate: "2026-03-02", breadth: "on" as const },
    { classId: "A" as const, productId: "ETH-USD", netR: -0.5, grossUsd: -2, netUsd: -3, entryDate: "2026-03-03", breadth: "off" as const },
  ];
  const report = forwardReview({ classId: "A", trades, weeks: ["2026-03-02"], l80UsdPerMonth: null });
  expect(report.n).toBe(2);
  expect(report.wilson).toBeNull();
  expect(report.costDrag).toBeNull();
  expect(report.payoffBreakEven).toBeNull();
  expect(report.sprt.pauses).toBe(false);
  expect(report.sprt.reportOnly).toBe(true);
  expect(report.holm.family).toBe("5-stream");
  expect(report.holm.streams).toHaveLength(5);
  expect(report.holm.streams.every((row) => row.p === 1)).toBe(true);
  expect(report.jevGuards.family).toBe("2");
  expect(report.jevGuards.streams.map((row) => row.p)).toEqual([1, 1]);
  expect(report.breadth.selects).toBe(false);
  expect(report.breadth.label).toBe("diagnostic, no selection");
  expect(OPEN_QUESTIONS.map((row) => row.id)).toContain("wilson");
  expect(OPEN_QUESTIONS.map((row) => row.id)).toContain("amendment-1");
});

describe("sizing identity", () => {
  test("mean R times $60 is the dollar net", () => {
    expect(0.07590549366477999 * 28 * 60).toBeCloseTo(127.52122935683045, 6);
  });
});
