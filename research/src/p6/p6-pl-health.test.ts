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
import { BID_BASIS, FALLBACK_BASIS, HOT_REV, MAE15_BASIS, MFE15_BASIS, minuteBucket, noteBar15Extreme, noteBidExtreme } from "./extremes";
import { HOT_MAX_BYTES, hotBytes, hotSnapshot } from "./hot-store";
import { clearRestCache, closedNow, MARK_LABEL, positionPnlNow, quoteAgeState, REST_LABEL } from "./mark-now";
import { installPaperState, startPaperHost, type PaperStateBody } from "./paper-host";
import { forwardBound } from "./kelly";
import { forwardReview } from "./review";
import { memoryKv } from "./relay";
import {
  classMeanNetR,
  classStress,
  ENTRY_STALE_FILL_SRC,
  entryQuoteFillSrc,
  execCostBps,
  execCostWord,
  inSlippageStats,
  isPreFixB,
  l2Fresh,
  modelledPx,
  modelledShare,
  type FillSrc,
  PRE_FIX_BEFORE_MS,
  PRE_FIX_FILL_SRC,
  PRE_FIX_PRODUCTS,
  sBtMagnitude,
  SHADOW_FILL_KIND,
  shadowAtModelled,
  STALE_QUOTE_FILL_SRC,
} from "./x1-fill";

const OPEN = Date.parse("2026-03-04T00:00:00.000Z");

function live(members: string[]): Book {
  return freshBook({ members, liveQuotes: true });
}

function x1(over: Partial<Extract<ForwardEvent, { kind: "x1" }>> & { id: string; productId: string }): Extract<ForwardEvent, { kind: "x1" }> {
  const ts = over.tsMs ?? OPEN;
  const nextOpen = over.nextOpen ?? 100;
  const event: Extract<ForwardEvent, { kind: "x1" }> = {
    kind: "x1",
    classId: "C",
    nextOpen,
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
  if (!Object.prototype.hasOwnProperty.call(over, "fillAnchorOpen") && nextOpen > 0) event.fillAnchorOpen = nextOpen;
  if (Object.prototype.hasOwnProperty.call(over, "fillAnchorOpen") && !(over.fillAnchorOpen != null && over.fillAnchorOpen > 0)) delete event.fillAnchorOpen;
  return event;
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
  const worse = startSec + 900;
  applyForward(book, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec: worse,
    nowSec: worse + 900,
    open: 100,
    high: 110,
    low: 96,
    close: 100,
    countJev: false,
  });
  expect(position.mfe15).toBe(130);
  expect(position.mae15).toBe(95);
  const better = worse + 900;
  applyForward(book, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec: better,
    nowSec: better + 900,
    open: 100,
    high: 140,
    low: 90,
    close: 100,
    countJev: false,
  });
  expect(position.mfe15).toBe(140);
  expect(position.mae15).toBe(90);
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
  const raw = hotSnapshot(host);
  expect(raw.startsWith("{")).toBe(true);
  expect(raw.startsWith("gz1:")).toBe(false);
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

test("a 2.5s book is an entry stale quote at the registered model price, and a REST snapshot at the open stays modelled", () => {
  const stale = live(["ETH-USD"]);
  applyForward(stale, x1({ id: "old", productId: "ETH-USD", bid: 99, ask: 101, nextOpen: 100, bookTsMs: OPEN, sendTsMs: OPEN + 2_500, asks: [[101, 0.0001], [130, 1_000]] }));
  const half = 1;
  const expected = 100 + half + (100 * 10) / 10_000;
  expect(stale.pendingFills).toHaveLength(0);
  expect(stale.positions[0]?.fillPrice).toBeCloseTo(expected, 8);
  expect(stale.positions[0]?.fillPrice).toBeLessThan(130);
  expect(stale.positions[0]?.entryFillSrc).toBe(ENTRY_STALE_FILL_SRC);
  expect(stale.legs[0]?.fillSrc).toBe(ENTRY_STALE_FILL_SRC);
  expect(inSlippageStats(stale.legs[0]?.fillSrc)).toBe(false);
  const rest = live(["ETH-USD"]);
  applyForward(rest, x1({ id: "rest", productId: "ETH-USD", bid: 99, ask: 101, nextOpen: 100, quoteFallback: true }));
  expect(rest.positions[0]?.fillPrice).toBeCloseTo(expected, 8);
  expect(rest.legs[0]?.fillSrc).toBe("modelled");
});

test("a stop fills at the first fresh bid after the trigger, under the stop on a gap", () => {
  const book = live(["ETH-USD"]);
  applyForward(book, x1({ id: "stop", productId: "ETH-USD", bid: 100, ask: 100, nextOpen: 100, stop: 90 }));
  expect(book.positions[0]?.stop).toBe(90);
  const units = book.positions[0]!.units;
  const startSec = Math.floor(OPEN / 1000) + 900;
  const nowSec = startSec + 900;
  applyForward(book, {
    kind: "mid",
    productId: "ETH-USD",
    tsMs: nowSec * 1000,
    bid: 80,
    ask: 81,
    bids: [[80, 0.01], [70, units]],
    l2AgeMs: 0,
    l2Src: "ws",
  });
  applyForward(book, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec,
    nowSec,
    open: 85,
    high: 86,
    low: 70,
    close: 84,
    countJev: false,
  });
  expect(book.positions).toHaveLength(0);
  expect(book.closed[0]?.exitKind).toBe("stop");
  expect(book.closed[0]?.gap).toBe(true);
  expect(book.closed[0]?.id).toBe("stop");
  const exit = book.legs.find((leg) => leg.side === "exit")!;
  expect(exit.fillPrice).toBeLessThan(80);
  expect(exit.fillPrice).toBeGreaterThan(70);
  expect(exit.fillPrice).not.toBe(90);
  expect(exit.fillSrc).toBe("l2");
  expect(book.closed[0]?.gapSlippageBps).toBeGreaterThan(0);
});

test("a mid-bar quote is not the stop fill when the decision clock is the bar close", () => {
  const book = live(["ETH-USD"]);
  applyForward(book, x1({ id: "qa", productId: "ETH-USD", bid: 100, ask: 100, nextOpen: 100, stop: 95 }));
  const startSec = Math.floor(OPEN / 1000) + 900;
  const nowSec = startSec + 900;
  applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: startSec * 1000 + 5 * 60_000, bid: 99.9, ask: 100.1 });
  applyForward(book, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec,
    nowSec,
    open: 100,
    high: 101,
    low: 94,
    close: 96,
    countJev: false,
  });
  expect(book.positions).toHaveLength(0);
  const exit = book.legs.find((leg) => leg.side === "exit")!;
  expect(exit.fillPrice).not.toBeCloseTo(99.9, 6);
  expect(exit.fillSrc).toBe(STALE_QUOTE_FILL_SRC);
  expect(book.closed[0]?.exitKind).toBe("stop");
  expect(book.closed[0]?.gap).toBeUndefined();
});

test("a non-fresh stop is modelled from the lower of the open and the stop", () => {
  const startSec = Math.floor(OPEN / 1000) + 900;
  const nowSec = startSec + 900;
  const decisionMs = nowSec * 1000;
  const closeAt = (id: string, quote: { tsMs: number; bid: number; ask: number } | null, open = 100) => {
    const book = live(["ETH-USD"]);
    applyForward(book, x1({ id, productId: "ETH-USD", bid: 100, ask: 100, nextOpen: 100, stop: 95 }));
    if (quote) applyForward(book, { kind: "mid", productId: "ETH-USD", tsMs: quote.tsMs, bid: quote.bid, ask: quote.ask });
    else delete book.quotes["ETH-USD"];
    applyForward(book, {
      kind: "bar15",
      productId: "ETH-USD",
      startSec,
      nowSec,
      open,
      high: 101,
      low: 94,
      close: 96,
      countJev: false,
    });
    return book;
  };
  const cases: { id: string; quote: { tsMs: number; bid: number; ask: number } | null; fillSrc: FillSrc; misses: number }[] = [
    { id: "mid", quote: { tsMs: startSec * 1000 + 5 * 60_000, bid: 99, ask: 101 }, fillSrc: STALE_QUOTE_FILL_SRC, misses: 1 },
    { id: "pre", quote: { tsMs: startSec * 1000 - 1_000, bid: 99, ask: 101 }, fillSrc: STALE_QUOTE_FILL_SRC, misses: 1 },
    { id: "slow", quote: { tsMs: decisionMs - 20_000, bid: 99, ask: 101 }, fillSrc: STALE_QUOTE_FILL_SRC, misses: 1 },
    { id: "late", quote: { tsMs: decisionMs - 2_500, bid: 99, ask: 101 }, fillSrc: "modelled", misses: 0 },
    { id: "none", quote: null, fillSrc: STALE_QUOTE_FILL_SRC, misses: 1 },
  ];
  for (const row of cases) {
    const book = closeAt(row.id, row.quote);
    expect(book.positions).toHaveLength(0);
    expect(book.closed[0]?.exitKind).toBe("stop");
    expect(book.closed[0]?.gap).toBeUndefined();
    expect(book.staleQuoteMisses).toBe(row.misses);
    const exit = book.legs.find((leg) => leg.side === "exit")!;
    const bid = row.quote?.bid ?? 100;
    const ask = row.quote?.ask ?? 100;
    expect(exit.fillSrc).toBe(row.fillSrc);
    expect(exit.fillPrice).toBeLessThanOrEqual(95);
    expect(exit.fillPrice).toBeCloseTo(modelledPx(95, bid, ask, "sell"), 8);
  }
  const early = closeAt("clock", { tsMs: decisionMs - 1_000, bid: 99, ask: 101 });
  const earlyExit = early.legs.find((leg) => leg.side === "exit")!;
  expect(earlyExit.fillSrc).toBe("modelled");
  expect(earlyExit.fillPrice).toBeLessThanOrEqual(95);
  expect(earlyExit.fillPrice).toBeCloseTo(modelledPx(95, 99, 101, "sell"), 8);
  expect(early.staleQuoteMisses).toBe(0);
  const touched = live(["ETH-USD"]);
  applyForward(touched, x1({ id: "touch", productId: "ETH-USD", bid: 100, ask: 100, nextOpen: 100, stop: 95 }));
  applyForward(touched, { kind: "mid", productId: "ETH-USD", tsMs: decisionMs, bid: 95, ask: 96, l2AgeMs: 0, l2Src: "ws" });
  applyForward(touched, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec,
    nowSec,
    open: 100,
    high: 101,
    low: 94,
    close: 96,
    countJev: false,
  });
  expect(touched.legs.find((leg) => leg.side === "exit")?.fillSrc).toBe("l2");
  expect(touched.closed[0]?.gap).toBeUndefined();
  const through = closeAt("through", { tsMs: decisionMs - 20_000, bid: 99, ask: 101 }, 95);
  expect(through.closed[0]?.gap).toBe(true);
  expect(through.legs.find((leg) => leg.side === "exit")?.fillPrice).toBeLessThanOrEqual(95);
  const gapped = closeAt("gapped", { tsMs: decisionMs - 2_500, bid: 99, ask: 101 }, 90);
  const gappedExit = gapped.legs.find((leg) => leg.side === "exit")!;
  expect(gapped.closed[0]?.gap).toBe(true);
  expect(gappedExit.fillSrc).toBe("modelled");
  expect(gapped.staleQuoteMisses).toBe(0);
  expect(gappedExit.fillPrice).toBeCloseTo(modelledPx(90, 99, 101, "sell"), 8);
  expect(gappedExit.fillPrice).toBeLessThanOrEqual(90);
  const timed = live(["ETH-USD"]);
  applyForward(timed, x1({ id: "time", productId: "ETH-USD", bid: 100, ask: 100, nextOpen: 100, stop: 95 }));
  const timeStart = Math.floor(OPEN / 1000) + 72 * 3_600;
  applyForward(timed, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec: timeStart,
    nowSec: timeStart + 900,
    open: 100,
    high: 101,
    low: 96,
    close: 100,
    countJev: false,
  });
  const timeExit = timed.legs.find((leg) => leg.side === "exit")!;
  expect(timed.closed[0]?.exitKind).toBe("time");
  expect(timeExit.fillPrice).toBeCloseTo(modelledPx(100, 100, 100, "sell"), 8);
  expect(timeExit.fillPrice).toBeGreaterThan(95);
  const atClose = live(["ETH-USD"]);
  applyForward(atClose, x1({ id: "at-close", productId: "ETH-USD", bid: 100, ask: 100, nextOpen: 100, stop: 95 }));
  applyForward(atClose, { kind: "mid", productId: "ETH-USD", tsMs: (startSec + 900) * 1000, bid: 99, ask: 101 });
  applyForward(atClose, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec,
    nowSec: startSec + 901,
    open: 100,
    high: 101,
    low: 94,
    close: 96,
    countJev: false,
  });
  const closeExit = atClose.legs.find((leg) => leg.side === "exit")!;
  expect(closeExit.fillSrc).toBe("l2");
  expect(closeExit.fillPrice).toBeCloseTo(99, 6);
});

test("a non-positive or non-finite bar print does not set the 15m extreme", () => {
  const row: { mfe15?: number | null; mae15?: number | null } = {};
  noteBar15Extreme(row, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  expect(row.mfe15 ?? null).toBeNull();
  expect(row.mae15 ?? null).toBeNull();
  noteBar15Extreme(row, 0, -1);
  expect(row.mfe15 ?? null).toBeNull();
  expect(row.mae15 ?? null).toBeNull();
  noteBar15Extreme(row, 10, 4);
  expect(row.mfe15).toBe(10);
  expect(row.mae15).toBe(4);
  noteBar15Extreme(row, 10, 4);
  expect(row.mfe15).toBe(10);
  expect(row.mae15).toBe(4);
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

test("a pre-fix B fill keeps the book P/L when live quotes are off, and the shadow stays beside it on a live book", () => {
  const cutoff = Date.parse("2026-10-20T12:07:00.000Z");
  expect(cutoff).toBe(PRE_FIX_BEFORE_MS);
  for (const productId of PRE_FIX_PRODUCTS) {
    expect(isPreFixB({ classId: "B", productId, entryTs: cutoff - 1 })).toBe(true);
    expect(isPreFixB({ classId: "B", productId, entryTs: cutoff })).toBe(false);
    expect(isPreFixB({ classId: "C", productId, entryTs: cutoff - 1 })).toBe(false);
  }
  expect(isPreFixB({ classId: "B", productId: "SUI-USD", entryTs: cutoff - 1 })).toBe(true);
  expect(isPreFixB({ classId: "B", productId: "SUI-USD", entryTs: cutoff })).toBe(false);
  const book = freshBook({ members: ["AERO-USD"] });
  expect(book.config.liveQuotes).toBe(false);
  applyForward(book, x1({ id: "aero", productId: "AERO-USD", classId: "B", bid: 100, ask: 100, nextOpen: 100, dailyAtr: 0 }));
  const position = book.positions[0]!;
  expect(position.entryFillSrc).toBeUndefined();
  const startSec = Math.ceil((OPEN / 1000 + 1) / 900) * 900;
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
  const exitFill = book.legs.find((leg) => leg.side === "exit")!.fillPrice;
  const exitFee = (position.units * exitFill * TAKER_FEE_BPS) / 10_000;
  const netUsd = (exitFill - position.fillPrice) * position.units - position.entryFeeUsd - exitFee;
  const netR = netUsd / position.riskUsd;
  expect(JSON.stringify([trade.netUsd, trade.netR])).toBe(JSON.stringify([netUsd, netR]));
  expect(JSON.stringify(book.classes.B.cumUsd)).toBe(JSON.stringify(trade.netUsd));
  expect(JSON.stringify(book.realizedUsd)).toBe(JSON.stringify(trade.netUsd));
  expect(trade.fillSrc).toBeUndefined();
  expect(trade.shadowFillPx).toBeUndefined();
  expect(trade.shadowNetUsd).toBeUndefined();
  expect(trade.shadowNetR).toBeUndefined();
  expect(trade.shadowFillKind).toBeUndefined();
  expect(book.legs.find((leg) => leg.side === "entry")?.fillPrice).toBe(position.fillPrice);
  expect(book.legs.find((leg) => leg.side === "entry")?.fillSrc).toBeUndefined();
  const parity = replayInjected(
    [
      x1({ id: "aero", productId: "AERO-USD", classId: "B", bid: 100, ask: 100, nextOpen: 100, dailyAtr: 0 }),
      { kind: "bar15", productId: "AERO-USD", startSec, nowSec: startSec + 900, open: 80, high: 86, low: 70, close: 84, countJev: false },
    ],
    { members: ["AERO-USD"], parity: { riskUsd: 20, sBtBps: 5 }, liveQuotes: true },
  );
  expect(parity.closed[0]?.fillSrc).toBeUndefined();
  expect(parity.closed[0]?.shadowNetUsd).toBeUndefined();
  const spanned = freshBook({ members: ["SUI-USD"] });
  applyForward(spanned, x1({ id: "span", productId: "SUI-USD", classId: "B", tsMs: cutoff - 60_000, bid: 100, ask: 100, nextOpen: 100, dailyAtr: 0 }));
  const spanBar = Math.ceil((cutoff / 1000 + 1) / 900) * 900;
  applyForward(spanned, {
    kind: "bar15",
    productId: "SUI-USD",
    startSec: spanBar,
    nowSec: spanBar + 900,
    open: 80,
    high: 86,
    low: 70,
    close: 84,
    countJev: false,
  });
  expect(spanned.closed[0]?.exitTs).toBeGreaterThan(cutoff);
  expect(spanned.closed[0]?.fillSrc).toBeUndefined();
  expect(spanned.closed[0]?.shadowNetUsd).toBeUndefined();
  const later = freshBook({ members: ["AERO-USD"] });
  const after = PRE_FIX_BEFORE_MS + 3_600_000;
  applyForward(later, x1({ id: "late", productId: "AERO-USD", classId: "B", tsMs: after, bid: 100, ask: 100, nextOpen: 100, dailyAtr: 0 }));
  const lateBar = Math.ceil((after / 1000 + 1) / 900) * 900;
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
  expect(later.closed[0]?.shadowFillPx).toBeUndefined();

  const liveBook = freshBook({ members: ["ENA-USD"] });
  applyForward(liveBook, x1({ id: "ena-shadow", productId: "ENA-USD", classId: "B", bid: 100, ask: 100, nextOpen: 100, dailyAtr: 0 }));
  const held = liveBook.positions[0]!;
  liveBook.config.liveQuotes = true;
  applyForward(liveBook, {
    kind: "bar15",
    productId: "ENA-USD",
    startSec,
    nowSec: startSec + 900,
    open: 80,
    high: 86,
    low: 70,
    close: 84,
    countJev: false,
  });
  const shadowed = liveBook.closed[0]!;
  const liveExit = liveBook.legs.find((leg) => leg.side === "exit")!.fillPrice;
  const liveFee = (held.units * liveExit * TAKER_FEE_BPS) / 10_000;
  const liveNet = (liveExit - held.fillPrice) * held.units - held.entryFeeUsd - liveFee;
  expect(JSON.stringify([shadowed.netUsd, shadowed.netR])).toBe(JSON.stringify([liveNet, liveNet / held.riskUsd]));
  expect(JSON.stringify(liveBook.classes.B.cumUsd)).toBe(JSON.stringify(shadowed.netUsd));
  expect(shadowed.shadowFillPx).toBeCloseTo(modelledPx(100, 100, 100, "buy"), 8);
  expect(shadowed.shadowFillKind).toBe(SHADOW_FILL_KIND);
  expect(shadowed.shadowNetUsd).not.toBe(shadowed.netUsd);
  expect(shadowed.shadowNetR).toBeCloseTo(shadowed.shadowNetUsd! / held.riskUsd, 8);
  expect(shadowed.fillSrc).toBe(PRE_FIX_FILL_SRC);
  expect(inSlippageStats(shadowed.fillSrc)).toBe(false);
  expect(liveBook.legs.find((leg) => leg.side === "entry")?.fillPrice).toBe(held.fillPrice);
  expect(liveBook.legs.find((leg) => leg.side === "entry")?.fillSrc).toBe(PRE_FIX_FILL_SRC);
  const spannedLive = freshBook({ members: ["ENA-USD"] });
  applyForward(spannedLive, x1({ id: "span-live", productId: "ENA-USD", classId: "B", tsMs: cutoff - 60_000, bid: 100, ask: 101, nextOpen: 100, dailyAtr: 0 }));
  expect(spannedLive.positions[0]?.entryTs).toBeLessThan(cutoff);
  spannedLive.config.liveQuotes = true;
  const spanLiveBar = Math.ceil((cutoff / 1000 + 1) / 900) * 900;
  applyForward(spannedLive, {
    kind: "bar15",
    productId: "ENA-USD",
    startSec: spanLiveBar,
    nowSec: spanLiveBar + 900,
    open: 80,
    high: 86,
    low: 70,
    close: 84,
    countJev: false,
  });
  expect(spannedLive.closed[0]?.exitTs).toBeGreaterThan(cutoff);
  expect(spannedLive.closed[0]?.fillSrc).toBe(PRE_FIX_FILL_SRC);
  expect(spannedLive.closed[0]?.shadowFillPx).toBeCloseTo(modelledPx(100, 100, 101, "buy"), 8);
});

test("with live quotes off, netUsd and netR match the dev book, including seven March class-B ENA and NEAR trades", () => {
  const rows: { id: string; productId: string; day: string; px: number; classId?: "B" | "C" }[] = [
    { id: "ena-1", productId: "ENA-USD", day: "2026-03-02", px: 0.42 },
    { id: "near-1", productId: "NEAR-USD", day: "2026-03-03", px: 3.1 },
    { id: "ena-2", productId: "ENA-USD", day: "2026-03-06", px: 0.38 },
    { id: "near-2", productId: "NEAR-USD", day: "2026-03-09", px: 2.8 },
    { id: "ena-3", productId: "ENA-USD", day: "2026-03-11", px: 0.51 },
    { id: "near-3", productId: "NEAR-USD", day: "2026-03-16", px: 3.4 },
    { id: "ena-4", productId: "ENA-USD", day: "2026-03-18", px: 0.47 },
    { id: "eth-1", productId: "ETH-USD", day: "2026-03-04", px: 100, classId: "C" },
  ];
  const march = rows.filter((row) => row.productId === "ENA-USD" || row.productId === "NEAR-USD");
  expect(march).toHaveLength(7);
  expect(march.every((row) => row.day.startsWith("2026-03"))).toBe(true);
  const seen: { id: string; netUsd: number; netR: number }[] = [];
  const expected: { id: string; netUsd: number; netR: number }[] = [];
  for (const row of rows) {
    const ts = Date.parse(`${row.day}T16:00:00.000Z`);
    const book = freshBook({ members: [row.productId] });
    expect(book.config.liveQuotes).toBe(false);
    expect(book.config.parity).toBeNull();
    applyForward(book, x1({
      id: row.id,
      productId: row.productId,
      classId: row.classId ?? "B",
      tsMs: ts,
      bid: row.px,
      ask: row.px,
      nextOpen: row.px,
      stop: row.px * 0.9,
      dailyAtr: 0,
    }));
    expect(book.positions).toHaveLength(1);
    const position = book.positions[0]!;
    const startSec = Math.ceil((ts / 1000 + 1) / 900) * 900;
    const barOpen = row.px * 0.8;
    applyForward(book, {
      kind: "bar15",
      productId: row.productId,
      startSec,
      nowSec: startSec + 900,
      open: barOpen,
      high: row.px,
      low: barOpen,
      close: barOpen,
      countJev: false,
    });
    const trade = book.closed[0]!;
    const exitFill = book.legs.find((leg) => leg.side === "exit")!.fillPrice;
    expect(exitFill).toBe(barOpen);
    const exitFee = (position.units * exitFill * TAKER_FEE_BPS) / 10_000;
    const netUsd = (exitFill - position.fillPrice) * position.units - position.entryFeeUsd - exitFee;
    const netR = position.riskUsd > 0 ? netUsd / position.riskUsd : 0;
    const shadow = shadowAtModelled({
      netUsd,
      entryFill: position.fillPrice,
      units: position.units,
      riskUsd: position.riskUsd,
      anchor: position.rawEntry,
      bid: row.px,
      ask: row.px,
    });
    expect(netUsd).not.toBe(shadow.shadowNetUsd);
    expect(trade.shadowNetUsd).toBeUndefined();
    expect(trade.shadowNetR).toBeUndefined();
    expect(trade.shadowFillPx).toBeUndefined();
    expect(trade.shadowFillKind).toBeUndefined();
    expect(trade.fillSrc).toBeUndefined();
    seen.push({ id: trade.id, netUsd: trade.netUsd, netR: trade.netR });
    expected.push({ id: row.id, netUsd, netR });
    expect(JSON.stringify(book.realizedUsd)).toBe(JSON.stringify(trade.netUsd));
    expect(JSON.stringify(book.classes[row.classId ?? "B"].cumUsd)).toBe(JSON.stringify(trade.netUsd));
  }
  expect(JSON.stringify(seen)).toBe(JSON.stringify(expected));

  const parityTs = Date.parse("2026-03-20T16:00:00.000Z");
  const parity = freshBook({ members: ["NEAR-USD"], parity: { riskUsd: 20, sBtBps: 5 } });
  expect(parity.config.liveQuotes).toBe(false);
  applyForward(parity, x1({ id: "near-parity", productId: "NEAR-USD", classId: "B", tsMs: parityTs, bid: 3, ask: 3, nextOpen: 3, stop: 2.7, dailyAtr: 0 }));
  const held = parity.positions[0]!;
  const startSec = Math.ceil((parityTs / 1000 + 1) / 900) * 900;
  applyForward(parity, {
    kind: "bar15",
    productId: "NEAR-USD",
    startSec,
    nowSec: startSec + 900,
    open: 2.4,
    high: 3,
    low: 2.4,
    close: 2.4,
    countJev: false,
  });
  const closed = parity.closed[0]!;
  const exitFill = parity.legs.find((leg) => leg.side === "exit")!.fillPrice;
  const netBps = ((exitFill - held.fillPrice) / held.fillPrice) * 10_000 - TAKER_FEE_BPS - TAKER_FEE_BPS;
  const netUsd = (netBps / 10_000) * held.units * held.fillPrice;
  const netR = netUsd / held.riskUsd;
  expect(JSON.stringify([closed.netUsd, closed.netR])).toBe(JSON.stringify([netUsd, netR]));
  expect(closed.shadowNetUsd).toBeUndefined();
});

test("the first quote at or after the open fills the entry: ≤2s walks, >2s is entry_stale_quote, >15s is a logged miss", () => {
  expect(entryQuoteFillSrc(2_000, true)).toBe("l2");
  expect(entryQuoteFillSrc(2_000, false)).toBe("modelled");
  expect(entryQuoteFillSrc(2_001, false)).toBe(ENTRY_STALE_FILL_SRC);
  expect(entryQuoteFillSrc(15_000, false)).toBe(ENTRY_STALE_FILL_SRC);
  expect(entryQuoteFillSrc(15_001, false)).toBe(STALE_QUOTE_FILL_SRC);
  expect(entryQuoteFillSrc(0, false)).toBe("modelled");

  const touch = live(["ETH-USD"]);
  applyForward(touch, x1({
    id: "le2",
    productId: "ETH-USD",
    bid: 100,
    ask: 101,
    nextOpen: 100,
    bookTsMs: OPEN,
    sendTsMs: OPEN + 2_000,
    asks: [[101, 0.0001], [103, 1_000]],
  }));
  expect(touch.pendingFills).toHaveLength(0);
  expect(touch.positions[0]?.entryFillSrc).toBe("l2");
  expect(touch.positions[0]?.fillPrice).toBeGreaterThan(101);
  expect(touch.positions[0]?.fillPrice).toBeLessThan(103);

  const waiting = live(["ETH-USD"]);
  applyForward(waiting, x1({ id: "wait", productId: "ETH-USD", tsMs: OPEN, decisionTs: OPEN + 4_000, bookTsMs: OPEN, sendTsMs: OPEN, bid: 99, ask: 101 }));
  expect(waiting.positions).toHaveLength(0);
  expect(waiting.pendingFills).toHaveLength(1);
  applyForward(waiting, {
    kind: "mid",
    productId: "ETH-USD",
    tsMs: OPEN + 4_000,
    bid: 99,
    ask: 101,
    l2AgeMs: 2_001,
    asks: [[101, 0.0001], [140, 1_000]],
  });
  expect(waiting.pendingFills).toHaveLength(0);
  expect(waiting.positions[0]?.entryFillSrc).toBe(ENTRY_STALE_FILL_SRC);
  expect(waiting.positions[0]?.fillPrice).toBeCloseTo(modelledPx(100, 99, 101, "buy"), 8);
  expect(waiting.positions[0]?.fillPrice).toBeLessThan(140);
  expect(waiting.staleQuoteMisses).toBe(0);
  expect(inSlippageStats(ENTRY_STALE_FILL_SRC)).toBe(false);
  expect(modelledShare([{ classId: "C", side: "entry", fillSrc: ENTRY_STALE_FILL_SRC }, { classId: "C", side: "entry", fillSrc: "l2" }], "C")).toBe(0.5);
  expect(classStress([{ classId: "C", netUsd: 1, riskUsd: 20, notionalUsd: 100, fillSrc: ENTRY_STALE_FILL_SRC, sBtUncappedBps: 5 }], "C").n).toBe(0);

  const miss = live(["ETH-USD"]);
  applyForward(miss, x1({ id: "gt15", productId: "ETH-USD", bid: 99, ask: 101, nextOpen: 100, bookTsMs: OPEN, sendTsMs: OPEN + 15_001 }));
  expect(miss.positions).toHaveLength(1);
  expect(miss.pendingFills).toHaveLength(0);
  expect(miss.positions[0]?.entryFillSrc).toBe(STALE_QUOTE_FILL_SRC);
  expect(miss.positions[0]?.fillPrice).toBeCloseTo(modelledPx(100, 99, 101, "buy"), 8);
  expect(miss.staleQuoteMisses).toBe(1);
  expect(miss.rejected.some((row) => row.reason === "missed_send_stale_quote")).toBe(false);
});

test("a modelled share above 10% is unreliable and 10% is not", () => {
  const rows = [
    ...Array.from({ length: 3 }, () => ({ classId: "B", side: "entry", fillSrc: "modelled" })),
    { classId: "B", side: "entry", fillSrc: "l2" },
  ];
  expect(modelledShare(rows, "B")).toBeCloseTo(0.75, 8);
  expect(execCostWord(modelledShare(rows, "B"))).toBe("red");
  expect(execCostWord(0.1)).toBe("ok");
  expect(execCostWord(0.11)).toBe("yellow");
  expect(execCostWord(0.25)).toBe("yellow");
  expect(execCostWord(0.26)).toBe("red");
  expect(modelledShare([{ classId: "B", side: "entry", fillSrc: "l2", anchorMissing: true }, { classId: "B", side: "entry", fillSrc: "l2" }], "B")).toBe(0.5);
  expect(modelledShare([{ classId: "B", side: "entry", fillSrc: STALE_QUOTE_FILL_SRC }], "B")).toBe(1);
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
  expect(book.sBtUncappedBps["ETH-USD"]).toBeGreaterThanOrEqual(magnitude);
  expect(sBtMagnitude(1_000).magnitude).toBe(15);
  expect(sBtMagnitude(1_000).uncapped).toBe(500);
  expect(sBtMagnitude(0).magnitude).toBe(5);
  expect(sBtMagnitude(0).uncapped).toBe(5);
  const wide = sBtMagnitude(100);
  expect(wide.uncapped).toBe(50);
  expect(wide.magnitude).toBe(15);
  applyForward(book, x1({ id: "cost", productId: "ETH-USD", bid: 100, ask: 101, nextOpen: 100 }));
  const leg = book.legs[0]!;
  expect(leg.liveCostBps).toBeCloseTo(leg.execCostBps! + leg.driftBps!, 8);
  expect(leg.sBtMagnitudeBps).toBe(magnitude);
  expect(leg.sBtUncappedBps).toBe(book.sBtUncappedBps["ETH-USD"]);
  expect(leg.sBtCapped).toBe((leg.sBtUncappedBps ?? 0) > 15);
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
  expect(page.view.fills?.find((row) => row.classId === "B")?.execCost).toBe("red");
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

test("freshness is 2000 ms, and a quote one millisecond older is not a live book", () => {
  expect(l2Fresh(2_000, "ws")).toBe(true);
  expect(l2Fresh(2_001, "ws")).toBe(false);
  expect(l2Fresh(0, "ws")).toBe(true);
  expect(l2Fresh(-1, "ws")).toBe(false);
  expect(l2Fresh(2_000, "rest_snapshot")).toBe(false);
});

test("a quote of 15s at the open is an entry stale quote, and one millisecond older is a logged miss", () => {
  const within = live(["ETH-USD"]);
  applyForward(within, x1({ id: "edge", productId: "ETH-USD", bookTsMs: OPEN, sendTsMs: OPEN + 15_000, bid: 99, ask: 101, nextOpen: 100 }));
  expect(within.positions[0]?.entryFillSrc).toBe(ENTRY_STALE_FILL_SRC);
  const over = live(["ETH-USD"]);
  applyForward(over, x1({ id: "miss", productId: "ETH-USD", bookTsMs: OPEN, sendTsMs: OPEN + 15_001, bid: 99, ask: 101, nextOpen: 100 }));
  expect(over.positions).toHaveLength(1);
  expect(over.positions[0]?.entryFillSrc).toBe(STALE_QUOTE_FILL_SRC);
  expect(over.staleQuoteMisses).toBe(1);
  expect(over.rejected.some((row) => row.reason === "missed_send_stale_quote")).toBe(false);
  const plain = freshBook({ members: ["ETH-USD"] });
  applyForward(plain, x1({ id: "plain-edge", productId: "ETH-USD", bookTsMs: OPEN, sendTsMs: OPEN + 15_000 }));
  expect(plain.rejected.some((row) => row.reason === "missed_send_stale_quote")).toBe(false);
  expect(plain.positions).toHaveLength(1);
  const plainLate = freshBook({ members: ["ETH-USD"] });
  applyForward(plainLate, x1({ id: "plain-late", productId: "ETH-USD", bookTsMs: OPEN, sendTsMs: OPEN + 15_001 }));
  expect(plainLate.rejected.some((row) => row.reason === "missed_send_stale_quote")).toBe(true);
  expect(plainLate.positions).toHaveLength(0);
  const exitBook = live(["ETH-USD"]);
  applyForward(exitBook, x1({ id: "held", productId: "ETH-USD", bid: 100, ask: 100, nextOpen: 100, stop: 90 }));
  const startSec = Math.floor(OPEN / 1000) + 900;
  const nowSec = startSec + 900;
  const decisionMs = nowSec * 1000;
  applyForward(exitBook, { kind: "mid", productId: "ETH-USD", tsMs: decisionMs - 10_000, bid: 70, ask: 71 });
  applyForward(exitBook, { kind: "bar15", productId: "ETH-USD", startSec, nowSec, open: 80, high: 81, low: 70, close: 80, countJev: false });
  expect(exitBook.positions).toHaveLength(0);
  expect(exitBook.legs.find((leg) => leg.side === "exit")?.fillSrc).toBe("modelled");
  const older = live(["ETH-USD"]);
  applyForward(older, x1({ id: "held2", productId: "ETH-USD", bid: 100, ask: 100, nextOpen: 100, stop: 90 }));
  applyForward(older, { kind: "mid", productId: "ETH-USD", tsMs: decisionMs - 20_000, bid: 70, ask: 71 });
  applyForward(older, { kind: "bar15", productId: "ETH-USD", startSec, nowSec, open: 80, high: 81, low: 70, close: 80, countJev: false });
  expect(older.positions).toHaveLength(0);
  expect(older.legs.find((leg) => leg.side === "exit")?.fillSrc).toBe(STALE_QUOTE_FILL_SRC);
  expect(older.legs.find((leg) => leg.side === "exit")?.fillPrice).not.toBe(70);
});

test("a missing fill anchor leaves drift null and is not promotion evidence", () => {
  const book = live(["ETH-USD"]);
  applyForward(book, x1({ id: "bare", productId: "ETH-USD", bid: 100, ask: 101, nextOpen: 100, fillAnchorOpen: 0 }));
  const leg = book.legs[0]!;
  expect(leg.fillAnchorOpen).toBeUndefined();
  expect(leg.driftBps).toBeNull();
  expect(leg.anchorMissing).toBe(true);
  expect(leg.fillSrc).toBe("l2");
  expect(inSlippageStats(leg.fillSrc, leg.anchorMissing)).toBe(false);
  const position = book.positions[0]!;
  expect(position.anchorMissing).toBe(true);
  const model = modelledPx(100, 100, 101, "buy");
  expect(position.rawEntry).toBeCloseTo(model, 8);
  expect(position.rawEntry).not.toBe(position.fillPrice);
  expect(position.rawEntry).not.toBe(100.5);
  const stopBps = ((model - 90) / model) * 10_000;
  const sLive = 0.5 * (1 / 100.5) * 10_000;
  const cost = 2 * (90 + sLive);
  expect(position.notionalUsd).toBeCloseTo(Math.min(1500, (20 * 10_000) / (stopBps + cost)), 6);
  expect(position.notionalUsd).toBeLessThan(400);
});

test("mark age boundaries, net R, and the walked bid", () => {
  const now = Date.parse("2026-10-20T18:00:00.000Z");
  const position = { productId: "ETH-USD", fillPrice: 100, units: 2, entryFeeUsd: 1.8, riskUsd: 20 };
  expect(quoteAgeState(60_000, false)).toBe("live");
  expect(quoteAgeState(60_001, false)).toBe("stale");
  expect(quoteAgeState(15 * 60_000, false)).toBe("stale");
  expect(quoteAgeState(15 * 60_000 + 1, false)).toBe("rest");
  const fresh = closedNow([position], { "ETH-USD": { bid: 90, tsMs: now - 2_000, bids: [[90, 0.5], [80, 10]] } }, now);
  expect(fresh.quoteFresh).toBe(true);
  expect(fresh.state).toBe("live");
  expect(fresh.rows[0]!.pnl).toBeLessThan((90 - 100) * 2);
  const aged = closedNow([position], { "ETH-USD": { bid: 90, tsMs: now - 2_001 } }, now);
  expect(aged.quoteFresh).toBe(false);
  expect(aged.state).toBe("live");
  const row = fresh.rows[0]!;
  expect(row.netR).toBeCloseTo(row.pnl! / 20, 8);
  expect(row.netR).not.toBeCloseTo(row.grossR!, 6);
  expect(fresh.openRNet).toBeCloseTo(fresh.pnlNow! / 20, 8);
  expect(fresh.openRGross).toBeCloseTo(fresh.grossUsd! / 20, 8);
});

test("2x uncapped stress is a class label, and parity runs are non-X1", () => {
  const row = (index: number, uncapped: number) => ({
    classId: "B",
    netUsd: 10,
    riskUsd: 20,
    notionalUsd: 200,
    exitNotionalUsd: 200,
    sBtUncappedBps: uncapped,
    sBtMagnitudeBps: Math.min(15, uncapped),
    sBtCapped: uncapped > 15,
    fillSrc: "l2",
  });
  const few = classStress(Array.from({ length: 9 }, (_, index) => row(index, 40)), "B");
  expect(few.grade).toBe("insufficient");
  expect(few.n).toBe(9);
  expect(few.netR2xUncapped).toBeNull();
  expect(few.spreadFragile).toBe(false);
  const band = classStress(Array.from({ length: 10 }, (_, index) => row(index, 40)), "B");
  expect(band.grade).toBe("indicative");
  expect(band.capHitCount).toBe(10);
  expect(band.netR2xUncapped).toBeCloseTo(0.42, 8);
  expect(band.netR2xCapped).toBeCloseTo(0.47, 8);
  expect(band.netR2xUncapped!).toBeLessThan(band.netR2xCapped!);
  expect(band.spreadFragile).toBe(false);
  const floored = classStress(Array.from({ length: 10 }, (_, index) => row(index, 0)), "B");
  expect(floored.netR2xUncapped).toBeCloseTo(0.49, 8);
  const flat = classStress(Array.from({ length: 10 }, (_, index) => ({ ...row(index, 40), netUsd: 1.6 })), "B");
  expect(flat.netR2xUncapped).toBeCloseTo(0, 8);
  expect(flat.spreadFragile).toBe(true);
  const grade = classStress(Array.from({ length: 30 }, (_, index) => row(index, 5)), "B");
  expect(grade.grade).toBe("decision-grade");
  expect(grade.capHitCount).toBe(0);
  const parity = classStress([{ ...row(0, 40), parity: true }], "B");
  expect(parity.n).toBe(0);
  const host = startPaperHost(["ETH-USD"], {});
  host.book.config.parity = { riskUsd: 20, sBtBps: 5 };
  const hot = JSON.parse(hotSnapshot(host)) as { runLabel: string };
  expect(hot.runLabel).toBe("non-X1");
  const quotesOff = startPaperHost(["ETH-USD"], {});
  quotesOff.book.config.liveQuotes = false;
  expect((JSON.parse(hotSnapshot(quotesOff)) as { runLabel: string }).runLabel).toBe("non-X1");
  const quotesOn = startPaperHost(["ETH-USD"], {});
  expect((JSON.parse(hotSnapshot(quotesOn)) as { runLabel: string }).runLabel).toBe("X1");
});

test("2x stress charges each taker leg once, and the class mean ignores ineligible rows", () => {
  const copies = (row: { netUsd: number; notionalUsd: number; sBtRawBps: number; sBtMagnitudeBps: number; legs: { liquidity: "maker" | "taker" }[] }) =>
    Array.from({ length: 10 }, () => ({ classId: "B", riskUsd: 20, fillSrc: "l2", ...row }));
  const taker = classStress(copies({ netUsd: 10, notionalUsd: 1_000, sBtRawBps: 10, sBtMagnitudeBps: 5, legs: [{ liquidity: "taker" }, { liquidity: "taker" }] }), "B");
  expect(taker.netR2xUncapped).toBeCloseTo(0.4, 8);
  const maker = classStress(copies({ netUsd: 5, notionalUsd: 500, sBtRawBps: 10, sBtMagnitudeBps: 5, legs: [{ liquidity: "maker" }, { liquidity: "taker" }] }), "B");
  expect(maker.netR2xUncapped).toBeCloseTo(0.225, 8);
  const capped = classStress(copies({ netUsd: 10, notionalUsd: 1_500, sBtRawBps: 10, sBtMagnitudeBps: 5, legs: [{ liquidity: "taker" }, { liquidity: "taker" }] }), "B");
  expect(capped.netR2xCapped).toBeCloseTo(0.425, 8);
  const eight = Array.from({ length: 8 }, (_, index) => ({ classId: "A", netR: 0.5 }));
  const two = [{ classId: "A", netR: -2 / 3 }, { classId: "A", netR: -2 / 3 }];
  const noise = [
    { classId: "A", netR: 9, fillSrc: "modelled" },
    { classId: "A", netR: 9, fillSrc: "stale_quote_modelled" },
    { classId: "A", netR: 9, anchorMissing: true },
    { classId: "A", netR: 9, fillSrc: "pre-fix fill model" },
    { classId: "B", netR: -0.35 },
  ];
  const meanA = classMeanNetR([...eight, ...two, ...noise], "A");
  expect(meanA.n).toBe(10);
  expect(meanA.meanNetR).toBeCloseTo(0.2667, 4);
  const meanB = classMeanNetR(Array.from({ length: 10 }, () => ({ classId: "B", netR: -0.35, fillSrc: "l2" })), "B");
  expect(meanB.n).toBe(10);
  expect(meanB.meanNetR).toBeCloseTo(-0.35, 4);
  expect(classMeanNetR(eight, "A").meanNetR).toBeNull();
  const points = [
    ...Array.from({ length: 10 }, () => ({ netR: 1, entryDate: "2026-03-02" })),
    { netR: -50, entryDate: "2026-03-02", fillSrc: "modelled" as const },
    { netR: -50, entryDate: "2026-03-02", fillSrc: "stale_quote_modelled" as const },
    { netR: -50, entryDate: "2026-03-02", anchorMissing: true },
    { netR: -50, entryDate: "2026-03-02", fillSrc: "pre-fix fill model" as const },
  ];
  expect(forwardBound(points, 1).mean).toBe(1);
  const trade = (netR: number, fillSrc?: string, anchorMissing?: boolean) => ({
    classId: "A" as const,
    productId: "ETH-USD",
    netR,
    netUsd: netR * 20,
    grossUsd: netR * 20,
    costUsd: 0,
    riskUsd: 20,
    notionalUsd: 100,
    entryDate: "2026-03-02",
    breadth: "on" as const,
    ...(fillSrc ? { fillSrc } : {}),
    ...(anchorMissing ? { anchorMissing: true } : {}),
  });
  const review = forwardReview({
    classId: "A",
    trades: [...Array.from({ length: 10 }, () => trade(0.5)), trade(9, "modelled"), trade(9, undefined, true)],
    weeks: ["2026-03-02"],
  });
  expect(review.n).toBe(10);
  expect(review.meanNetR).toBeCloseTo(0.5, 8);
});

test("a missing anchor sizes from the model price, and a thin book walks that size", () => {
  const book = live(["ETH-USD"]);
  const bid = 99.95;
  const ask = 100.05;
  const model = modelledPx(100, bid, ask, "buy");
  const stop = model * 0.95;
  applyForward(book, x1({
    id: "sized",
    productId: "ETH-USD",
    bid,
    ask,
    nextOpen: 100,
    stop,
    fillAnchorOpen: 0,
    asks: [[ask, 0.01], [130, 100]],
  }));
  const position = book.positions[0]!;
  expect(position.anchorMissing).toBe(true);
  expect(position.rawEntry).toBeCloseTo(model, 8);
  expect(position.notionalUsd).toBeCloseTo((20 * 10_000) / 690, 6);
  expect(position.notionalUsd).toBeLessThan(300);
  expect(position.fillPrice).toBeGreaterThan(120);
  const skipped = live(["ETH-USD"]);
  applyForward(skipped, x1({ id: "above", productId: "ETH-USD", bid: 100, ask: 101, nextOpen: 100, stop: 110, fillAnchorOpen: 0 }));
  expect(skipped.positions).toHaveLength(0);
  expect(skipped.rejected.some((row) => row.reason === "anchor_missing")).toBe(true);
  expect(skipped.incidents.some((row) => row.includes("anchor_missing"))).toBe(true);
});
