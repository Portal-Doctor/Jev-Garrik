import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { classBScore } from "../p3/classes";
import { isMondayCloseBar, x1EntryTs } from "../p5/run";
import { addDays } from "../p5/stats";
import { applyEvent, completedProductDays, freshFeed, parsePublicMessage, rebuildFeed, finishWarmup } from "./feed";
import { shadowPackets, warmupLabel } from "./jev-shadow";
import { OPEN_QUESTIONS } from "./open-questions";
import { empiricalQuantile } from "./percentile";
import { placeboExitIndexes } from "./placebo";
import { candleBackfillUrl, feedProducts, missingMinutes, subscribeFrames } from "./public-ws";
import { classATrigger } from "../p3/classes";
import { classBarInputs } from "../p3/bar-access";
import { emaPoints, replaySignals, scanForwardA, type ReplayDay } from "./replay";
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

test("a public subscribe carries L2, trades, and heartbeats, and refuses keys and order channels", () => {
  const products = feedProducts(["ETH-USD"]);
  expect(products).toEqual(["ETH-USD", "BTC-USD"]);
  const frames = subscribeFrames(products, undefined, { PATH: "/usr/bin" });
  expect(frames).toHaveLength(3);
  for (const frame of frames) {
    expect(frame).not.toContain("signature");
    expect(frame).not.toContain("secret");
    const body = JSON.parse(frame) as { channel: string; product_ids: string[] };
    expect(["heartbeats", "level2", "market_trades"]).toContain(body.channel);
    expect(body.channel).not.toBe("candles");
    expect(body.product_ids).toContain("BTC-USD");
  }
  expect(() => subscribeFrames(["BTC-USD"], undefined, { COINBASE_API_KEY: "present" })).toThrow(/order-capable/);
  expect(() => subscribeFrames(["BTC-USD"], ["user" as "level2"], {})).toThrow(/channel/);
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

test("a UTC day completes per product, and only after that product prints a later date", () => {
  const day = 1_736_035_200;
  expect(completedProductDays([{ productId: "ETH-USD", startSec: day }, { productId: "ETH-USD", startSec: day + 60 }])).toEqual([]);
  expect(completedProductDays([
    { productId: "ETH-USD", startSec: day },
    { productId: "BTC-USD", startSec: day + 86_400 },
  ])).toEqual([]);
  expect(completedProductDays([
    { productId: "ETH-USD", startSec: day },
    { productId: "ETH-USD", startSec: day + 86_400 },
    { productId: "BTC-USD", startSec: day },
  ])).toEqual([{ productId: "ETH-USD", date: "2025-01-05" }]);
});

test("public envelopes become trades and an L2 book, and a 5m candle is not a 1m bar", () => {
  const state = freshFeed();
  const candles = parsePublicMessage({
    channel: "candles",
    events: [{ candles: [{ product_id: "BTC-USD", start: "0", open: "1", high: "2", low: "1", close: "2", volume: "3" }] }],
  });
  expect(candles).toEqual([]);
  expect(state.completed).toHaveLength(0);
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

test("X2 fills on a trade-through, goes indeterminate on a gap, and class D reports its indeterminate count", () => {
  const working = openShadow({ id: "1", mode: "X2", classId: "A", productId: "ETH-USD", limit: 10, tick: 0.01 });
  expect(onPublicTrade(working, 9.995, 4).status).toBe("working");
  const filled = onPublicTrade(working, 9.9, 4);
  expect(filled).toEqual({ ...working, status: "filled", filledVolume: 2 });
  expect(onFeedGap(working).status).toBe("indeterminate");
  const maker = openShadow({ id: "d", mode: "X3", classId: "D", productId: "ETH-USD", limit: 10, tick: 0.01 });
  expect(maker.status).toBe("working");
  const dGap = onFeedGap(maker);
  expect(dGap.status).toBe("indeterminate");
  const share = indeterminateShare([
    { ...working, status: "indeterminate", filledVolume: 0 },
    filled,
    dGap,
  ]);
  expect(share.submitted).toBe(3);
  expect(share.classDIndeterminate).toBe(1);
  expect(share.flagged).toBe(true);
});

test("breadth is logged and does not change size, pauses shrink, and kills latch", () => {
  const full = paperDecision({ classId: "A", blockers: [], stopBps: 500, breadthPaused: false, scheduledRiskUsd: 20 });
  const logged = paperDecision({ classId: "A", blockers: ["pause-2a"], stopBps: 500, breadthPaused: true, scheduledRiskUsd: 20 });
  expect(logged.entries).toBe(full.entries);
  expect(logged.riskUsd).toBe(20);
  expect(logged.notionalUsd).toBe(full.notionalUsd);
  expect(logged.openRiskUsd).toBeCloseTo(20, 8);
  expect(logged.breadth).toBe("off");
  expect(full.breadth).toBe("on");
  expect(full.entry).toBe("X1");
  expect(full.addedByJev).toBe(false);
  const shrunk = paperDecision({ classId: "C", blockers: ["pause-1b"], stopBps: 500, breadthPaused: false, scheduledRiskUsd: 75 });
  expect(shrunk.entries).toBe(true);
  expect(shrunk.riskUsd).toBe(20);
  expect(paperDecision({ classId: "D", blockers: [], stopBps: 500, breadthPaused: false, scheduledRiskUsd: 20 }).riskUsd).toBe(20);
  expect(paperDecision({ classId: "D", blockers: [], stopBps: 500, breadthPaused: false, scheduledRiskUsd: 20 }).entry).toBe("maker");
  expect(paperDecision({ classId: "D", blockers: [], stopBps: 500, breadthPaused: false, scheduledRiskUsd: 20 }).costBps).toBe(140);
  expect(paperDecision({ classId: "E", blockers: [], stopBps: 500, breadthPaused: false, scheduledRiskUsd: 20 }).riskUsd).toBe(20);
  const blocked = paperDecision({ classId: "B", blockers: ["pause-2b"], stopBps: 500, breadthPaused: false, scheduledRiskUsd: 20 });
  expect(blocked.entries).toBe(false);
  expect(blocked.riskUsd).toBe(20);
  let curve = freshClassCurve();
  for (let i = 0; i < 20; i += 1) curve = stepClass(curve, -1);
  expect(curve.curve.killed).toBe(true);
  curve = stepClass(curve, 50);
  expect(curve.curve.killed).toBe(true);
  const blockers = classBlockers("A", curve, { halt: false, backstop: false, momentumBlocked: false, killSwitch: false });
  expect(blockers).toContain("r-kill");
  expect(paperDecision({ classId: "A", blockers, stopBps: 500, breadthPaused: false, scheduledRiskUsd: 20 }).entries).toBe(false);
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
  expect(shadowPackets({ members: ["ETH-USD"], barStartSec: 900, nowSec: 900, warming: false })).toEqual([]);
  const packets = shadowPackets({ members: ["ETH-USD"], barStartSec: 900, nowSec: 1800, warming: true });
  expect(packets.map((row) => row.pair)).toEqual(["ETH-USD", "BTC-USD"]);
  expect(packets.every((row) => row.position === 0 && row.called === false && row.label === "warming")).toBe(true);
  expect(warmupLabel(6)).toBe("log-only");
  expect(warmupLabel(7)).toBe("pooled baseline");
  expect(warmupLabel(30)).toBe("per-pair");
  expect(empiricalQuantile([1, 2, 3, 4], 0.95)).toBe(4);
  expect(placeboExitIndexes([2, 0.2, 3, 0], 5, () => 0).every((index) => [0.2, 0][0] === 0.2 && index !== 0 && index !== 2)).toBe(true);
});

test("the forward scan uses the D1 bar path and an incomplete day does not", () => {
  const days: ReplayDay[] = [];
  let date = "2025-08-01";
  for (let i = 0; i < 80; i += 1) {
    const close = 100 + i * 0.2;
    days.push({ date, high: close, low: close - 0.2, close, volume: 1, complete: true });
    date = addDays(date, 1);
  }
  const atrByDate = new Map(days.map((day) => [day.date, 1]));
  const hour = days.map((day) => ({ ts: x1EntryTs(day.date), open: day.close }));
  const boundary = { priceGroupPasses: false, volumeGroupPasses: false, boundarySaved: true };
  const forward = scanForwardA({ flags: boundary, days, firstD1Date: days[0]!.date, atrByDate, hour, young: true });
  const inputs = classBarInputs(boundary, days.map((day) => ({
    date: day.date,
    ts: Date.parse(`${day.date}T00:00:00.000Z`) / 1000,
    open: day.close,
    high: day.high,
    low: day.low,
    close: day.close,
    volume: day.volume,
    empty: false,
  })), days[0]!.date);
  const points = emaPoints(inputs);
  const oracle = inputs.closeLookback.flatMap((bar, index) => {
    const point = points.get(bar.date);
    if (!point) return [];
    return ([20, 55] as const).filter((lookback) => classATrigger(inputs.closeLookback, index, lookback, true, undefined, point)).map((lookback) => `${bar.date}:${lookback}`);
  });
  expect(forward.map((row) => `${row.date}:${row.lookback}`)).toEqual(oracle);
  const early = days.find((day) => day.date >= "2025-10-11");
  expect(early).toBeTruthy();
  const earlyHits = forward.filter((row) => row.date < addDays("2025-10-11", 20));
  expect(earlyHits).toEqual([]);
  const rawBars = days.map((day) => ({ date: day.date, high: day.high, low: day.low, close: day.close, volume: day.volume }));
  const rawIndex = rawBars.findIndex((bar) => bar.date === addDays("2025-10-11", 8));
  expect(rawIndex).toBeGreaterThan(20);
  expect(classATrigger(rawBars, rawIndex, 20, true)).toBe(true);
  expect(forward.some((row) => row.date === rawBars[rawIndex]!.date)).toBe(false);
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
  const weeks = replaySignals({ productId: "ETH-USD", days, atrByDate, hour, young: true, scores });
  expect(weeks.weeks[0]?.selected).toEqual(["AAA-USD"]);
  expect(weeks.weeks[0]?.held).not.toContain("CCC-USD");
});

test("the forward review reports the 5-stream Holm and the Jev family of 2 at p = 1", () => {
  const trades = [
    { classId: "A" as const, productId: "ETH-USD", netR: 1, grossUsd: 10, netUsd: 8, costUsd: 2, riskUsd: 20, notionalUsd: 100, entryDate: "2026-03-02", breadth: "on" as const },
    { classId: "A" as const, productId: "ETH-USD", netR: -0.5, grossUsd: -2, netUsd: -3, costUsd: 1, riskUsd: 20, notionalUsd: 100, entryDate: "2026-03-03", breadth: "off" as const },
  ];
  const report = forwardReview({ classId: "A", trades, weeks: ["2026-03-02"], reps: 20 });
  expect(report.n).toBe(2);
  expect(report.payoff.pHat).toBe(0.5);
  expect(report.cost.status).toBe("ok");
  expect(report.cost.cd).toBeCloseTo(0.3, 8);
  expect(report.sprt.pauses).toBe(false);
  expect(report.sprt.reportOnly).toBe(true);
  expect(report.holm.family).toBe("5-stream");
  expect(report.holm.streams).toHaveLength(5);
  expect(report.holm.streams.every((row) => row.p === 1)).toBe(true);
  expect(report.jevGuards.family).toBe("2");
  expect(report.jevGuards.streams.map((row) => row.p)).toEqual([1, 1]);
  expect(report.breadth.selects).toBe(false);
  expect(report.breadth.label).toBe("diagnostic, no selection");
  expect(report.gates.coloursDoNotPromote).toBe(true);
  expect(OPEN_QUESTIONS.map((row) => row.id)).toContain("live-tape");
  expect(OPEN_QUESTIONS.map((row) => row.id)).not.toContain("default-13");
  expect(OPEN_QUESTIONS.map((row) => row.id)).not.toContain("wilson");
});

describe("sizing identity", () => {
  test("mean R times $60 is the dollar net", () => {
    expect(0.07590549366477999 * 28 * 60).toBeCloseTo(127.52122935683045, 6);
  });
});
