import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { TAKER_FEE_BPS } from "../../vendor/87b35d0/config.ts";
import { x1FillPrice } from "../p3/design-rules";
import { readP6Page, redactP6View } from "./dashboard-read";
import {
  applyForward,
  bookRoundTrip,
  freshBook,
  markedPnl,
  replayInjected,
  type Book,
  type ForwardEvent,
} from "./engine";
import { BID_BASIS, FALLBACK_BASIS, HOT_REV, MAE15_BASIS, MFE15_BASIS, minuteBucket, noteBidExtreme } from "./extremes";
import { HOT_MAX_BYTES, hotBytes, hotSnapshot } from "./hot-store";
import { clearRestCache, closedNow, MARK_LABEL, positionPnlNow, REST_LABEL } from "./mark-now";
import { installPaperState, startPaperHost, type PaperStateBody } from "./paper-host";
import { memoryKv } from "./relay";
import {
  execCostBps,
  execCostWord,
  inSlippageStats,
  isPreFixB,
  modelledPx,
  modelledShare,
  PRE_FIX_BEFORE_MS,
  PRE_FIX_FILL_SRC,
  PRE_FIX_PRODUCTS,
  sBtMagnitude,
} from "./x1-fill";

const OPEN = Date.parse("2026-03-04T00:00:00.000Z");

function live(members: string[]): Book {
  return freshBook({ members, liveQuotes: true });
}

function x1(over: Partial<Extract<ForwardEvent, { kind: "x1" }>> & { id: string; productId: string }): Extract<ForwardEvent, { kind: "x1" }> {
  const ts = over.tsMs ?? OPEN;
  return {
    kind: "x1",
    classId: "C",
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 101,
    bookTsMs: ts,
    sendTsMs: ts,
    decisionMid: 100,
    tsMs: ts,
    ...over,
  };
}

test("running bid extremes follow the minute bucket and ignore trade candles", () => {
  const book = live(["ETH-USD"]);
  applyForward(book, x1({ id: "e", productId: "ETH-USD", bid: 100, ask: 100 }));
  const position = book.positions[0]!;
  expect(position.highestClose).toBeNull();
  expect(position.mfeBid1m).toBeNull();
  const minute = OPEN + 60_000;
  applyForward(book, { kind: "minute", productId: "ETH-USD", tsMs: minute + 5_000, open: 200, high: 250, low: 10, close: 200, volume: 1 });
  expect(position.mfeBid1m).toBeNull();
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: minute + 1_000, bid: 110, ask: 111 });
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: minute + 20_000, bid: 108, ask: 109 });
  expect(position.mfeBid1m).toBe(110);
  expect(position.maeBid1m).toBe(108);
  expect(position.mfeTs).toBe(minuteBucket(minute));
  expect(position.maeTs).toBe(minuteBucket(minute));
  expect(position.mfeBasis).toBe(BID_BASIS);
  const next = minute + 60_000;
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: next + 1_000, bid: 90, ask: 91 });
  expect(position.mfeBid1m).toBe(110);
  expect(position.maeBid1m).toBe(90);
  expect(position.maeTs).toBe(minuteBucket(next));
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: next + 2_000, bid: 0, ask: 0, fallbackMid: { mid: 80, halfSpread: 1 } });
  expect(position.maeBid1m).toBe(79);
  expect(position.maeBasis).toBe(FALLBACK_BASIS);
  expect(position.mfeBasis).toBe(BID_BASIS);
  const startSec = Math.floor(OPEN / 1000) + 900;
  applyForward(book, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec,
    nowSec: startSec + 900,
    open: 100,
    high: 130,
    low: 95,
    close: 120,
    countJev: false,
  });
  expect(position.mfe15).toBe(130);
  expect(position.mae15).toBe(95);
  expect(position.mfe15Basis).toBe(MFE15_BASIS);
  expect(position.mae15Basis).toBe(MAE15_BASIS);
  expect(position.highestClose).toBeNull();
});

test("extremes survive a JSON hot round trip, a restart keeps them, and 24 positions stay under 256 KB", () => {
  const host = startPaperHost(["ETH-USD"], {});
  applyForward(host.book, x1({ id: "hot", productId: "ETH-USD", bid: 100, ask: 100 }));
  applyForward(host.book, { kind: "mid", productId: "ETH-USD", tsMs: OPEN + 1_000, bid: 112, ask: 113 });
  applyForward(host.book, { kind: "mid", productId: "ETH-USD", tsMs: OPEN + 2_000, bid: 97, ask: 98 });
  const before = host.book.positions[0]!;
  expect(before.mfeReconstructed).toBeUndefined();
  const tripped = bookRoundTrip(host.book);
  expect(tripped.positions[0]?.mfeBid1m).toBe(112);
  expect(tripped.positions[0]?.maeBid1m).toBe(97);
  expect(tripped.positions[0]?.mfeReconstructed).toBeUndefined();
  const hotSrc = readFileSync(fileURLToPath(new URL("./hot-store.ts", import.meta.url)), "utf8");
  expect(hotSrc.includes("gz1")).toBe(false);
  const raw = hotSnapshot(host);
  const body = JSON.parse(raw) as PaperStateBody;
  expect(body.hotRev).toBe(HOT_REV);
  expect(body.positions[0]?.mfeBid1m).toBe(112);
  const next = startPaperHost(["ETH-USD"], {});
  installPaperState(next, body);
  const restored = next.book.positions[0]!;
  expect(restored.mfeBid1m).toBe(112);
  expect(restored.maeBid1m).toBe(97);
  expect(restored.mfeTs).toBe(before.mfeTs);
  expect(restored.mfeReconstructed).toBe(true);
  const blank = startPaperHost(["ETH-USD"], {});
  installPaperState(blank, { ...body, hotRev: HOT_REV, positions: (body.positions ?? []).map((row) => ({ ...row, mfeBid1m: undefined as unknown as number })) });
  expect(blank.book.positions[0]?.mfeReconstructed).toBe(true);
  const wide = startPaperHost(["ETH-USD"], {});
  const seed = host.book.positions[0]!;
  wide.book.positions = Array.from({ length: 24 }, (_, index) => ({
    ...seed,
    id: `p${index}`,
    productId: `P${index}-USD`,
    mfeBid1m: 100 + index,
    maeBid1m: 90 - index / 100,
    mfeTs: OPEN,
    maeTs: OPEN,
    mfe15: 120,
    mae15: 80,
  }));
  wide.book.pendingFills = [
    {
      id: "wait",
      productId: "ETH-USD",
      classId: "C",
      role: "entry",
      side: "buy",
      notBeforeMs: OPEN,
      fillAnchorOpen: 100,
      modelOpen: 100,
      midAtDecision: 100,
      stop: 90,
      atr1h: 1,
      target: null,
      dailyAtr: 0,
      priorDailyCloses: [],
      tick: 0.01,
      aConfig: null,
      tsMs: OPEN,
      triggerBarTs: null,
    },
  ];
  expect(hotBytes(wide)).toBeLessThan(HOT_MAX_BYTES);
  const pendingRaw = hotSnapshot(wide);
  expect(pendingRaw.includes("wait")).toBe(true);
  expect(Buffer.byteLength(pendingRaw)).toBeLessThan(HOT_MAX_BYTES);
});

test("a close writes mfeR and maeR from the bid extremes", () => {
  const book = live(["ETH-USD"]);
  applyForward(book, x1({ id: "c", productId: "ETH-USD", bid: 100, ask: 100, nextOpen: 100 }));
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: OPEN + 1_000, bid: 110, ask: 110 });
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: OPEN + 2_000, bid: 94, ask: 94 });
  const open = book.positions[0]!;
  const startSec = Math.floor(OPEN / 1000) + 900;
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: startSec * 1000, bid: 96, ask: 96 });
  applyForward(book, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec,
    nowSec: startSec + 900,
    open: 80,
    high: 85,
    low: 70,
    close: 82,
    countJev: false,
  });
  expect(book.positions).toHaveLength(0);
  const trade = book.closed[0]!;
  expect(trade.mfeR).toBeCloseTo(((110 - open.fillPrice) * open.units) / open.riskUsd, 8);
  expect(trade.maeR).toBeCloseTo(((94 - open.fillPrice) * open.units) / open.riskUsd, 8);
  expect(trade.mfeBasis).toBe(BID_BASIS);
});

test("an ask of 101 at an open of 100 fills the buy at 101, and a thin top walks", () => {
  const touch = live(["ETH-USD"]);
  applyForward(touch, x1({ id: "ask", productId: "ETH-USD", bid: 100, ask: 101, nextOpen: 100 }));
  expect(touch.positions[0]?.fillPrice).toBe(101);
  expect(touch.legs[0]?.fillSrc).toBe("l2");
  const thin = live(["ETH-USD"]);
  applyForward(thin, x1({ id: "walk", productId: "ETH-USD", bid: 100, ask: 101, nextOpen: 100, asks: [[101, 0.0001], [103, 1_000]] }));
  const walked = thin.positions[0]!.fillPrice;
  expect(walked).toBeGreaterThan(101);
  expect(walked).toBeLessThan(103);
});

test("a quote before max(open, decision) stays pending and the later fresh book fills it", () => {
  const book = live(["ETH-USD"]);
  applyForward(book, x1({ id: "early", productId: "ETH-USD", tsMs: OPEN, decisionTs: OPEN + 5_000, bookTsMs: OPEN, sendTsMs: OPEN, ask: 101 }));
  expect(book.positions).toHaveLength(0);
  expect(book.pendingFills).toHaveLength(1);
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: OPEN + 4_000, bid: 100, ask: 101 });
  expect(book.positions).toHaveLength(0);
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: OPEN + 5_000, bid: 100, ask: 101 });
  expect(book.positions[0]?.fillPrice).toBe(101);
  const host = startPaperHost(["ETH-USD"], {});
  applyForward(host.book, x1({ id: "hand", productId: "ETH-USD", tsMs: OPEN, decisionTs: OPEN + 8_000, bookTsMs: OPEN, sendTsMs: OPEN }));
  const raw = JSON.parse(hotSnapshot(host)) as PaperStateBody;
  expect(raw.pendingFills?.[0]?.id).toBe("hand");
  const heir = startPaperHost(["ETH-USD"], {});
  installPaperState(heir, raw);
  applyForward(heir.book, { kind: "mid", productId: "ETH-USD", tsMs: OPEN + 8_000, bid: 100, ask: 101 });
  expect(heir.book.positions[0]?.fillPrice).toBe(101);
  expect(heir.book.pendingFills).toHaveLength(0);
});

test("a 2.5s book and a REST snapshot are modelled at the open plus half the spread plus 10 bps", () => {
  const stale = live(["ETH-USD"]);
  applyForward(stale, x1({ id: "old", productId: "ETH-USD", bid: 99, ask: 101, nextOpen: 100, bookTsMs: OPEN, sendTsMs: OPEN + 2_500 }));
  const half = 1;
  const expected = 100 + half + (100 * 10) / 10_000;
  expect(stale.positions[0]?.fillPrice).toBeCloseTo(expected, 8);
  expect(stale.positions[0]?.entryFillSrc).toBe("modelled");
  expect(stale.legs[0]?.fillSrc).toBe("modelled");
  const rest = live(["ETH-USD"]);
  applyForward(rest, x1({ id: "rest", productId: "ETH-USD", bid: 99, ask: 101, nextOpen: 100, quoteFallback: true }));
  expect(rest.positions[0]?.fillPrice).toBeCloseTo(expected, 8);
  expect(rest.legs[0]?.fillSrc).toBe("modelled");
});

test("a stop fills at the first fresh bid after the trigger, under the stop on a gap", () => {
  const book = live(["ETH-USD"]);
  applyForward(book, x1({ id: "stop", productId: "ETH-USD", bid: 100, ask: 100, nextOpen: 100, stop: 90 }));
  expect(book.positions[0]?.stop).toBe(90);
  const startSec = Math.floor(OPEN / 1000) + 900;
  const barTs = startSec * 1000;
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: barTs - 1_000, bid: 70, ask: 71 });
  applyForward(book, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec,
    nowSec: startSec + 900,
    open: 85,
    high: 86,
    low: 70,
    close: 84,
    countJev: false,
  });
  expect(book.positions).toHaveLength(1);
  expect(book.pendingFills[0]?.role).toBe("exit");
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: barTs + 100, bid: 80, ask: 81, l2AgeMs: 0, l2Src: "ws" });
  expect(book.positions).toHaveLength(0);
  expect(book.closed[0]?.exitKind).toBe("stop");
  expect(book.closed[0]?.id).toBe("stop");
  const exit = book.legs.find((leg) => leg.side === "exit")!;
  expect(exit.fillPrice).toBe(80);
  expect(exit.fillPrice).toBeLessThan(90);
  expect(exit.fillSrc).toBe("l2");
});

test("exec cost and drift stay signed, and a fill under the mid is a negative cost", () => {
  const book = live(["ETH-USD"]);
  applyForward(book, x1({ id: "sign", productId: "ETH-USD", bid: 100, ask: 101, nextOpen: 100, decisionMid: 99 }));
  const leg = book.legs[0]!;
  expect(leg.fillPrice).toBeGreaterThan(leg.midAtFill!);
  expect(leg.execCostBps!).toBeGreaterThan(0);
  expect(leg.midAtFill!).toBeGreaterThan(leg.fillAnchorOpen!);
  expect(leg.driftBps!).toBeGreaterThan(0);
  expect(leg.execCostBps).toBeCloseTo(execCostBps("buy", leg.fillPrice, leg.midAtFill!)!, 8);
  expect(leg.driftBps).toBeCloseTo(((leg.midAtFill! - 100) / 100) * 10_000, 8);
  expect(execCostBps("buy", 99, 100)).toBeCloseTo(-100, 8);
  expect(execCostBps("sell", 101, 100)).toBeCloseTo(-100, 8);
  const under = live(["ETH-USD"]);
  applyForward(under, x1({ id: "under", productId: "ETH-USD", bid: 110, ask: 112, nextOpen: 100, bookTsMs: OPEN, sendTsMs: OPEN + 2_500 }));
  expect(under.legs[0]!.fillPrice).toBeLessThan(under.legs[0]!.midAtFill!);
  expect(under.legs[0]!.execCostBps!).toBeLessThan(0);
});

test("parity replay stays on the half-spread fill and two replays match", () => {
  const events: ForwardEvent[] = [
    { kind: "clock", tsMs: OPEN },
    x1({ id: "p", productId: "ETH-USD", bid: 100, ask: 101, nextOpen: 100 }),
  ];
  const config = { members: ["ETH-USD"], parity: { riskUsd: 20, sBtBps: 5 }, liveQuotes: true };
  const left = replayInjected(events, config);
  const right = replayInjected(events, config);
  expect(left.positions[0]?.fillPrice).toBeCloseTo(x1FillPrice(100, "buy", 5), 8);
  expect(left.positions[0]?.fillPrice).not.toBe(101);
  expect(JSON.stringify(left.positions)).toBe(JSON.stringify(right.positions));
  expect(JSON.stringify(left.closed)).toBe(JSON.stringify(right.closed));
  expect(left.legs[0]?.fillSrc).toBeUndefined();
});

test("the four pre-fix B fills keep their price, carry a shadow, and leave the slippage stats", () => {
  for (const productId of PRE_FIX_PRODUCTS) {
    expect(isPreFixB({ classId: "B", productId, exitTs: PRE_FIX_BEFORE_MS - 1 })).toBe(true);
    expect(isPreFixB({ classId: "B", productId, exitTs: PRE_FIX_BEFORE_MS })).toBe(false);
    expect(isPreFixB({ classId: "C", productId, exitTs: PRE_FIX_BEFORE_MS - 1 })).toBe(false);
  }
  const book = freshBook({ members: ["AERO-USD"] });
  applyForward(book, x1({ id: "aero", productId: "AERO-USD", classId: "B", bid: 100, ask: 100, nextOpen: 100, dailyAtr: 0 }));
  const position = book.positions[0]!;
  expect(position.entryFillSrc).toBeUndefined();
  const startSec = Math.floor(OPEN / 1000) + 900;
  applyForward(book, {
    kind: "bar15",
    productId: "AERO-USD",
    startSec,
    nowSec: startSec + 900,
    open: 80,
    high: 86,
    low: 70,
    close: 84,
    countJev: false,
  });
  const trade = book.closed[0]!;
  expect(trade.fillSrc).toBe(PRE_FIX_FILL_SRC);
  expect(inSlippageStats(trade.fillSrc)).toBe(false);
  expect(trade.shadowFill).toBeCloseTo(modelledPx(100, 100, 100, "buy"), 8);
  expect(trade.fillNetUsd).toBeCloseTo(trade.netUsd - (position.fillPrice - trade.shadowFill!) * position.units, 6);
  expect(trade.netUsd).toBeCloseTo(trade.shadowNetUsd!, 8);
  expect(trade.netR).toBeCloseTo(trade.shadowNetR!, 8);
  expect(book.classes.B.cumUsd).toBeCloseTo(trade.shadowNetUsd!, 8);
  expect(book.legs.find((leg) => leg.side === "entry")?.fillPrice).toBe(position.fillPrice);
  expect(book.legs.find((leg) => leg.side === "entry")?.fillSrc).toBe(PRE_FIX_FILL_SRC);
  const parity = replayInjected(
    [
      x1({ id: "aero", productId: "AERO-USD", classId: "B", bid: 100, ask: 100, nextOpen: 100, dailyAtr: 0 }),
      { kind: "bar15", productId: "AERO-USD", startSec, nowSec: startSec + 900, open: 80, high: 86, low: 70, close: 84, countJev: false },
    ],
    { members: ["AERO-USD"], parity: { riskUsd: 20, sBtBps: 5 } },
  );
  expect(parity.closed[0]?.fillSrc).toBeUndefined();
  const later = freshBook({ members: ["AERO-USD"] });
  const after = PRE_FIX_BEFORE_MS + 3_600_000;
  applyForward(later, x1({ id: "late", productId: "AERO-USD", classId: "B", tsMs: after, bid: 100, ask: 100, nextOpen: 100, dailyAtr: 0 }));
  const lateBar = Math.floor(after / 1000) + 900;
  applyForward(later, {
    kind: "bar15",
    productId: "AERO-USD",
    startSec: lateBar,
    nowSec: lateBar + 900,
    open: 80,
    high: 86,
    low: 70,
    close: 84,
    countJev: false,
  });
  expect(later.closed[0]?.fillSrc).toBeUndefined();
});

test("a modelled share above 10% is unreliable and 10% is not", () => {
  const rows = [
    ...Array.from({ length: 3 }, () => ({ classId: "B", side: "entry", fillSrc: "modelled" })),
    { classId: "B", side: "entry", fillSrc: "l2" },
  ];
  expect(modelledShare(rows, "B")).toBeCloseTo(0.75, 8);
  expect(execCostWord(modelledShare(rows, "B"))).toBe("unreliable");
  expect(execCostWord(0.1)).toBe("ok");
  const mixed = [
    ...Array.from({ length: 9 }, () => ({ classId: "B", fillSrc: PRE_FIX_FILL_SRC })),
    { classId: "B", fillSrc: "modelled" },
  ];
  expect(modelledShare(mixed, "B")).toBe(1);
  expect(modelledShare(mixed.slice(0, 9), "B")).toBe(0);
  const book = live(["ETH-USD"]);
  applyForward(book, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec: Math.floor(OPEN / 1000) - 1_800,
    nowSec: Math.floor(OPEN / 1000) - 900,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    countJev: false,
    phase: "rest",
  });
  applyForward(book, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec: Math.floor(OPEN / 1000) - 900,
    nowSec: Math.floor(OPEN / 1000),
    open: 105,
    high: 115,
    low: 95,
    close: 110,
    countJev: false,
    phase: "rest",
  });
  const magnitude = book.sBtMagnitudeBps["ETH-USD"]!;
  expect(magnitude).toBeGreaterThanOrEqual(5);
  expect(magnitude).toBeLessThanOrEqual(15);
  expect(book.sBtStressBps["ETH-USD"]).toBeCloseTo(magnitude * 2, 8);
  expect(sBtMagnitude(1_000).magnitude).toBe(15);
  expect(sBtMagnitude(1_000).stress).toBe(30);
  applyForward(book, x1({ id: "cost", productId: "ETH-USD", bid: 100, ask: 101, nextOpen: 100 }));
  const leg = book.legs[0]!;
  expect(leg.liveCostBps).toBeCloseTo(leg.execCostBps! + leg.driftBps!, 8);
});

test("P/L if closed now marks four positions to the bid and matches markedPnl at that bid", () => {
  const products = ["BTC-USD", "ETH-USD", "SOL-USD", "AVAX-USD"];
  const positions = products.map((productId) => ({ productId, fillPrice: 100, units: 1, entryFeeUsd: 0.9, riskUsd: 20 }));
  const now = Date.parse("2026-10-20T18:00:00.000Z");
  const quotes = Object.fromEntries(products.map((productId) => [productId, { bid: 94.65, tsMs: now }]));
  const mark = closedNow(positions, quotes, now);
  expect(mark.label).toBe(MARK_LABEL);
  expect(mark.state).toBe("live");
  expect(mark.openRGross).toBeCloseTo(-5.35 / 20, 8);
  expect(Number(mark.openRGross!.toFixed(2))).toBe(-0.27);
  const one = (94.65 - 100) * 1 - 0.9 - 94.65 * 1 * (TAKER_FEE_BPS / 10_000);
  expect(mark.pnlNow).toBeCloseTo(one * 4, 8);
  const book = live(["ETH-USD"]);
  applyForward(book, x1({ id: "mark", productId: "ETH-USD", bid: 100, ask: 100, nextOpen: 100 }));
  const position = book.positions[0]!;
  expect(position.sLiveBps).toBe(0);
  const bid = 95;
  const mid = 100;
  const half = mid - bid;
  expect(bid).toBe(mid - half);
  expect(positionPnlNow({ productId: "ETH-USD", fillPrice: position.fillPrice, units: position.units, entryFeeUsd: position.entryFeeUsd, riskUsd: position.riskUsd }, bid)).toBeCloseTo(
    markedPnl(book, position, bid),
    6,
  );
});

test("a stale mark keeps the last bid, a 15 minute gap uses the REST bid, and a missing bid is n/a", async () => {
  clearRestCache();
  const products = ["BTC-USD", "ETH-USD", "SOL-USD", "AVAX-USD"];
  const positions = products.map((productId) => ({
    productId,
    id: `C-${productId}-1`,
    fillPrice: 100,
    units: 1,
    entryFeeUsd: 0.9,
    riskUsd: 20,
    mfeBasis: "bid1m",
  }));
  const now = Date.parse("2026-10-20T18:00:00.000Z");
  const kv = memoryKv();
  await kv.set(
    "p6:hot",
    JSON.stringify({
      positions,
      quotes: products.map((productId) => [productId, 94.65, now - 90_000]),
      feedLive: true,
      closed: [
        { classId: "B", fillSrc: "modelled" },
        { classId: "B", fillSrc: "modelled" },
        { classId: "B", fillSrc: "l2" },
      ],
    }),
  );
  await kv.set("p6:lastRun", JSON.stringify({ outcome: "handover" }));
  let fetches = 0;
  const page = await readP6Page(kv, now, async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ bid: "90" }) };
  });
  expect(fetches).toBe(0);
  expect(page.view.mark?.state).toBe("stale");
  expect(page.view.mark?.staleText).toMatch(/^stale since \d{2}:\d{2} CT$/);
  expect(page.view.mark?.pnlNow).toBeCloseTo(closedNow(positions, Object.fromEntries(products.map((id) => [id, { bid: 94.65, tsMs: now }])), now).pnlNow!, 6);
  expect(page.view.markInputs).toBeUndefined();
  expect(page.view.fills?.find((row) => row.classId === "B")?.execCost).toBe("unreliable");
  const shown = redactP6View(page.view);
  expect(shown.mark?.label).toBe(MARK_LABEL);
  expect(shown.positions[0]?.mfeBasis).toBe("bid1m");

  const restKv = memoryKv();
  await restKv.set(
    "p6:hot",
    JSON.stringify({
      positions,
      quotes: products.map((productId) => [productId, 94.65, now - 16 * 60_000]),
      feedLive: true,
    }),
  );
  await restKv.set("p6:lastRun", JSON.stringify({ outcome: "handover" }));
  const rest = await readP6Page(restKv, now, async (url) => {
    fetches += 1;
    expect(url.startsWith("https://api.exchange.coinbase.com/products/")).toBe(true);
    return { ok: true, json: async () => ({ bid: "90" }) };
  });
  expect(rest.view.mark?.state).toBe("rest");
  expect(rest.view.mark?.restLabel).toBe(REST_LABEL);
  const restRow = (90 - 100) * 1 - 0.9 - 90 * 0.009;
  expect(rest.view.mark?.pnlNow).toBeCloseTo(restRow * 4, 6);
  const again = await readP6Page(restKv, now + 30_000, async () => {
    fetches += 1;
    return { ok: true, json: async () => ({ bid: "1" }) };
  });
  expect(again.view.mark?.pnlNow).toBeCloseTo(rest.view.mark!.pnlNow!, 6);
  const fetchesAfterCache = fetches;
  expect(fetchesAfterCache).toBe(4);

  const bare = memoryKv();
  await bare.set("p6:hot", JSON.stringify({ positions, quotes: products.slice(0, 3).map((productId) => [productId, 94.65, now]), feedLive: false }));
  await bare.set("p6:lastRun", JSON.stringify({ outcome: "handover" }));
  const missing = await readP6Page(bare, now, async () => {
    throw new Error("missing bid must not fetch");
  });
  expect(missing.view.mark?.state).toBe("na");
  expect(missing.view.mark?.pnlNow).toBeNull();
  const direct = closedNow(positions, { "BTC-USD": { bid: 94.65, tsMs: now - 10_000 } }, now, { disconnected: true });
  expect(direct.state).toBe("na");
  const staleLive = closedNow([positions[0]!], { "BTC-USD": { bid: 94.65, tsMs: now } }, now, { disconnected: true });
  expect(staleLive.state).toBe("stale");
  expect(staleLive.pnlNow).not.toBeNull();
});

test("a direct extreme note ignores a quote from before the entry", () => {
  const row: { entryTs: number; mfeBid1m: number | null } = { entryTs: 1_000, mfeBid1m: null };
  noteBidExtreme(row, 50, 51, 999);
  expect(row.mfeBid1m).toBeNull();
  noteBidExtreme(row, 50, 51, 1_000);
  expect(row.mfeBid1m).toBe(50);
});
