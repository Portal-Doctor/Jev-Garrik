import { expect, test } from "bun:test";
import { section1CostBps } from "../p3/design-rules";
import { applyForward, freshBook, replayInjected } from "./engine";
import { halfSpreadBps, MAX_PRODUCTS_PER_SOCKET, shardProducts, walkedSpreadBps, PairBook } from "./mid-feed";
import { restOrTrades, restSettleSchedule } from "./rest-bars";
import { bookPanel, parity7d } from "./review";
import { AMENDMENT_2A_RULE } from "./rearm";
import { classDollarBackstop, freshClassCurve, stepClass } from "./session";
import { kellyStatusBody, PAPER_BANKROLL_USD } from "./kelly";
import { amendment2aBody } from "./amendment2a";
import { subscribeFrames } from "./public-ws";

const wednesday = Date.parse("2026-03-04T00:00:00.000Z");

test("the dollar backstop uses the running high and a pause does not reset it", () => {
  let curve = freshClassCurve();
  curve = stepClass(curve, 2, 2_000);
  expect(curve.peakUsd).toBe(2_000);
  curve = stepClass(curve, -12, -1_000);
  expect(curve.pause.paused).toBe(true);
  expect(curve.peakUsd).toBe(2_000);
  expect(classDollarBackstop(curve)).toBe(false);
  curve = stepClass(curve, 6, 400);
  expect(curve.pause.paused).toBe(false);
  expect(curve.peakUsd).toBe(2_000);
  curve = stepClass(curve, 1, 900);
  expect(curve.peakUsd).toBe(2_300);
  curve = stepClass(curve, -1, -1_200);
  expect(classDollarBackstop(curve)).toBe(true);
  expect(amendment2aBody().rule).toBe(AMENDMENT_2A_RULE);
  expect(amendment2aBody().amendment2Edited).toBe(false);
});

test("s_live is the half spread and walks the book for size", () => {
  expect(halfSpreadBps(99.9, 100.1)).toBeCloseTo(10, 6);
  const book = new PairBook();
  book.set("bid", 99.9, 2);
  book.set("offer", 100.1, 1);
  book.set("offer", 100.4, 5);
  expect(walkedSpreadBps(book, "buy", 1)).toBeCloseTo(halfSpreadBps(99.9, 100.1)!, 6);
  expect(walkedSpreadBps(book, "buy", 3)!).toBeGreaterThan(halfSpreadBps(99.9, 100.1)!);
});

test("class D is sized at $20, passes the gates, and fills only on a trade-through", () => {
  const book = freshBook({ members: ["ETH-USD"] });
  applyForward(book, { kind: "clock", tsMs: wednesday });
  applyForward(book, {
    kind: "d-order",
    id: "d1",
    productId: "ETH-USD",
    limit: 100,
    units: 50,
    placedTs: wednesday,
    stop: 90,
    bid: 101,
    ask: 101.2,
    bookTsMs: wednesday,
    decisionMid: 101.1,
    tick: 0.01,
    target: 110,
  });
  expect(book.working).toHaveLength(1);
  expect(book.working[0]?.riskUsd).toBe(20);
  expect(book.working[0]?.order.unitsRemaining).not.toBe(50);
  const sLive = halfSpreadBps(101, 101.2)!;
  expect(book.working[0]?.notionalUsd).toBeCloseTo((20 * 10_000) / (1_000 + section1CostBps(0, sLive)), 6);
  applyForward(book, { kind: "minute", productId: "ETH-USD", tsMs: wednesday + 1_000, open: 101, high: 102, low: 99, close: 101, volume: 20 });
  expect(book.positions).toHaveLength(0);
  applyForward(book, { kind: "trade", productId: "ETH-USD", price: 99.995, size: 0.4, makerSide: "sell", tsMs: wednesday + 2_000 });
  expect(book.positions).toHaveLength(0);
  applyForward(book, { kind: "trade", productId: "ETH-USD", price: 99.98, size: 0.4, makerSide: "sell", tsMs: wednesday + 3_000 });
  expect(book.positions).toHaveLength(1);
  expect(book.positions[0]?.units).toBeCloseTo(0.2, 8);
  applyForward(book, { kind: "trade", productId: "ETH-USD", price: 99.98, size: 0.4, makerSide: "sell", tsMs: wednesday + 4_000 });
  expect(book.positions).toHaveLength(1);
  expect(book.positions[0]?.units).toBeCloseTo(0.4, 8);
  applyForward(book, { kind: "trade", productId: "ETH-USD", price: 110.02, size: 2, makerSide: "buy", tsMs: wednesday + 5_000 });
  expect(book.positions).toHaveLength(0);
  expect(book.closed[0]?.exitKind).toBe("target");
  const exit = book.legs.find((leg) => leg.side === "exit");
  expect(exit?.feesUsd).toBeCloseTo((0.4 * 110 * 50) / 10_000, 6);
  expect(exit?.arrivalBid).toBe(101);
  expect(exit?.arrivalAsk).toBe(101.2);
});

test("a second D order on the same pair is rejected, and a $500 pair loss blocks that pair", () => {
  const book = freshBook({ members: ["ETH-USD", "SOL-USD"] });
  applyForward(book, { kind: "clock", tsMs: wednesday });
  const order = {
    kind: "d-order" as const,
    productId: "ETH-USD",
    limit: 100,
    units: 1,
    placedTs: wednesday,
    stop: 90,
    bid: 101,
    ask: 101.1,
    bookTsMs: wednesday,
    decisionMid: 101,
    tick: 0.01,
  };
  applyForward(book, { ...order, id: "one" });
  applyForward(book, { kind: "trade", productId: "ETH-USD", price: 99.98, size: 10, makerSide: "sell", tsMs: wednesday + 1_000 });
  applyForward(book, { ...order, id: "two", placedTs: wednesday + 2_000 });
  expect(book.rejected.some((row) => row.id === "two" && row.reason.includes("onePerPair"))).toBe(true);
  applyForward(book, {
    kind: "realize",
    id: "pair-loss",
    classId: "A",
    productId: "SOL-USD",
    netR: -1,
    netUsd: -500,
    riskUsd: 20,
    entryDate: "2026-03-04",
    exitTs: wednesday + 3_000,
  });
  applyForward(book, {
    kind: "x1",
    id: "sol",
    classId: "A",
    productId: "SOL-USD",
    tsMs: wednesday + 90_000_000,
    nextOpen: 10,
    stop: 9,
    atr1h: 0.2,
    bid: 10,
    ask: 10.02,
    bookTsMs: wednesday,
    sendTsMs: wednesday,
    decisionMid: 10,
  });
  expect(book.rejected.some((row) => row.id === "sol")).toBe(true);
});

test("bars before the entry and forming bars do not stop, and the trail, ten-day, and break-even moves do", () => {
  const start = Math.floor(wednesday / 1000);
  const book = freshBook({ members: ["ETH-USD"] });
  applyForward(book, { kind: "clock", tsMs: wednesday });
  applyForward(book, {
    kind: "x1",
    id: "a",
    classId: "A",
    productId: "ETH-USD",
    tsMs: wednesday,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.2,
    bookTsMs: wednesday,
    sendTsMs: wednesday,
    decisionMid: 100,
    dailyAtr: 2,
    priorDailyCloses: Array(10).fill(100),
  });
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: start, nowSec: start + 100, open: 110, high: 112, low: 80, close: 110 });
  expect(book.positions).toHaveLength(1);
  expect(book.positions[0]?.stop).toBe(90);
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: start, nowSec: start + 900, open: 110, high: 112, low: 100, close: 110 });
  expect(book.positions[0]?.stop).toBeCloseTo(104, 6);
  expect(book.positions[0]?.pendingExit).toBeNull();
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: start + 900, nowSec: start + 1_800, open: 108, high: 109, low: 105, close: 99, dailyClose: true });
  expect(book.positions[0]?.pendingExit).toBe("rule");
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: start + 1_800, nowSec: start + 2_700, open: 108, high: 109, low: 107, close: 108 });
  expect(book.positions).toHaveLength(0);
  expect(book.closed[0]?.exitKind).toBe("rule");
  const exit = book.legs.find((leg) => leg.side === "exit")!;
  expect(exit.fillPrice).toBeLessThan(108);
  expect(exit.decisionMid).toBe(108);

  const swing = freshBook();
  applyForward(swing, { kind: "clock", tsMs: wednesday });
  applyForward(swing, {
    kind: "x1",
    id: "e",
    classId: "E",
    productId: "ETH-USD",
    tsMs: wednesday,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.2,
    bookTsMs: wednesday,
    sendTsMs: wednesday,
    decisionMid: 100,
    target: 120,
  });
  applyForward(swing, { kind: "bar15", productId: "ETH-USD", startSec: start, nowSec: start + 900, open: 100, high: 112, low: 99, close: 111 });
  expect(swing.positions[0]?.stop).toBeCloseTo(swing.positions[0]!.fillPrice, 8);
  applyForward(swing, { kind: "bar15", productId: "ETH-USD", startSec: start + 900, nowSec: start + 1_800, open: 112, high: 121, low: 111, close: 120 });
  expect(swing.closed[0]?.exitKind).toBe("target");
});

test("a B name that leaves the held set exits on the next open, and a D time exit pays the taker spread", () => {
  const start = Math.floor(wednesday / 1000);
  const held = freshBook({ members: ["ETH-USD", "BTC-USD"] });
  applyForward(held, { kind: "clock", tsMs: wednesday });
  applyForward(held, {
    kind: "x1",
    id: "bh",
    classId: "B",
    productId: "ETH-USD",
    tsMs: wednesday,
    nextOpen: 100,
    stop: 80,
    atr1h: 1,
    bid: 100,
    ask: 100.02,
    bookTsMs: wednesday,
    sendTsMs: wednesday,
    decisionMid: 100,
  });
  applyForward(held, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec: start,
    nowSec: start + 900,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    bScores: [
      { id: "ETH-USD", score: 0, member: true },
      { id: "BTC-USD", score: 2, member: true },
    ],
  });
  expect(held.positions[0]?.pendingExit).toBe("rebalance");
  applyForward(held, { kind: "bar15", productId: "ETH-USD", startSec: start + 900, nowSec: start + 1_800, open: 101, high: 102, low: 100, close: 101 });
  expect(held.closed[0]?.exitKind).toBe("rebalance");
  expect(held.legs.find((leg) => leg.side === "exit")!.fillPrice).toBeLessThan(101);

  const maker = freshBook({ members: ["ETH-USD"] });
  applyForward(maker, { kind: "clock", tsMs: wednesday });
  applyForward(maker, {
    kind: "d-order",
    id: "dh",
    productId: "ETH-USD",
    limit: 100,
    units: 1,
    placedTs: wednesday,
    stop: 90,
    bid: 101,
    ask: 101.02,
    bookTsMs: wednesday,
    decisionMid: 101,
    tick: 0.01,
  });
  applyForward(maker, { kind: "trade", productId: "ETH-USD", price: 99.98, size: 4, makerSide: "sell", tsMs: wednesday + 1_000 });
  const later = start + 48 * 3_600;
  applyForward(maker, { kind: "bar15", productId: "ETH-USD", startSec: later, nowSec: later + 900, open: 100, high: 101, low: 99, close: 100 });
  expect(maker.closed[0]?.exitKind).toBe("time");
  expect(maker.legs.find((leg) => leg.side === "exit")!.fillPrice).toBeLessThan(100);
});

test("class B disaster and a momentum crash block new B entries", () => {
  const start = Math.floor(wednesday / 1000);
  const book = freshBook({ members: ["ETH-USD"] });
  applyForward(book, { kind: "clock", tsMs: wednesday });
  applyForward(book, {
    kind: "x1",
    id: "b",
    classId: "B",
    productId: "ETH-USD",
    tsMs: wednesday,
    nextOpen: 100,
    stop: 80,
    atr1h: 1,
    bid: 100,
    ask: 100.2,
    bookTsMs: wednesday,
    sendTsMs: wednesday,
    decisionMid: 100,
    dailyAtr: 4,
  });
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: start, nowSec: start + 900, open: 100, high: 101, low: 87, close: 90 });
  expect(book.closed[0]?.exitKind).toBe("stop");
  applyForward(book, { kind: "btc", tsMs: wednesday + 86_400_000, return60: -0.25, return10: 0.15 });
  applyForward(book, {
    kind: "x1",
    id: "b2",
    classId: "B",
    productId: "SOL-USD",
    tsMs: wednesday + 86_400_000 + 1_000,
    nextOpen: 10,
    stop: 9,
    atr1h: 0.2,
    bid: 10,
    ask: 10.02,
    bookTsMs: wednesday,
    sendTsMs: wednesday,
    decisionMid: 10,
  });
  expect(book.rejected.some((row) => row.id === "b2")).toBe(true);
  applyForward(book, {
    kind: "x1",
    id: "a-ok",
    classId: "A",
    productId: "SOL-USD",
    tsMs: wednesday + 86_400_000 + 2_000,
    nextOpen: 10,
    stop: 9,
    atr1h: 0.2,
    bid: 10,
    ask: 10.02,
    bookTsMs: wednesday,
    sendTsMs: wednesday,
    decisionMid: 10,
  });
  expect(book.positions.some((position) => position.id === "a-ok")).toBe(true);
});

test("a non-member does not join a member cluster, and an open tag survives the next month", () => {
  let book = freshBook({ members: ["ETH-USD", "BTC-USD"] });
  book = applyForward(book, { kind: "clock", tsMs: wednesday });
  book = applyForward(book, { kind: "rho", a: "ETH-USD", b: "BTC-USD", rho: 0.9, month: "2026-03" });
  book = applyForward(book, { kind: "rho", a: "ETH-USD", b: "SOL-USD", rho: 0.95, month: "2026-03" });
  const enter = (id: string, productId: string) =>
    applyForward(book, {
      kind: "x1",
      id,
      classId: "A",
      productId,
      tsMs: wednesday + 1_000,
      nextOpen: 100,
      stop: 90,
      atr1h: 1,
      bid: 100,
      ask: 100.1,
      bookTsMs: wednesday,
      sendTsMs: wednesday,
      decisionMid: 100,
    });
  book = enter("eth", "ETH-USD");
  book = enter("sol", "SOL-USD");
  expect(book.positions.map((position) => position.productId).sort()).toEqual(["ETH-USD", "SOL-USD"]);
  const tag = book.positions.find((position) => position.id === "eth")!.clusterId;
  book = applyForward(book, { kind: "rho", a: "ETH-USD", b: "BTC-USD", rho: 0.1, month: "2026-04" });
  expect(book.positions.find((position) => position.id === "eth")!.clusterId).toBe(tag);
});

test("REST settle, the socket cap, the Kelly label, and the book panel", () => {
  const schedule = restSettleSchedule(900_000);
  expect(schedule.firstMs).toBe(915_000);
  expect(schedule.intervalMs).toBe(10_000);
  expect(schedule.deadlineMs - schedule.firstMs).toBe(120_000);
  expect(restOrTrades({ restOk: false, deadlinePassed: true })).toEqual({ source: "trades", incident: true });
  expect(restOrTrades({ restOk: true, deadlinePassed: true }).incident).toBe(false);
  const ids = Array.from({ length: 11 }, (_, index) => `P${index}`);
  expect(shardProducts(ids).map((shard) => shard.length)).toEqual([10, 1]);
  expect(shardProducts(ids, 50).every((shard) => shard.length <= MAX_PRODUCTS_PER_SOCKET)).toBe(true);
  const frames = subscribeFrames(ids, ["level2"], { PATH: "/usr/bin" });
  expect(frames).toHaveLength(2);
  expect(kellyStatusBody().text).toContain("hard-coded $60 was the defect");
  expect(kellyStatusBody().bankrollUsd).toBe(PAPER_BANKROLL_USD);
  expect(kellyStatusBody().kellyInput).toBe("L80");
  const panel = bookPanel({ weeklyHaltsLast6: 1, bookDrawdownUsd: 400, parity7d: parity7d(10, 10) });
  expect(panel.parity7d).toBe("match");
  expect(parity7d(10, 11)).toBe("break");
});

test("an X1 fill matches the half-spread formula, and a replay of the same events matches", () => {
  const bid = 99.9;
  const ask = 100.1;
  const nextOpen = 100;
  const sLive = 0.5 * ((ask - bid) / ((bid + ask) / 2)) * 10_000;
  const expected = nextOpen * (1 + sLive / 10_000);
  const events = [
    { kind: "clock" as const, tsMs: wednesday },
    {
      kind: "x1" as const,
      id: "p",
      classId: "C" as const,
      productId: "ETH-USD",
      tsMs: wednesday,
      nextOpen,
      stop: 90,
      atr1h: 1,
      bid,
      ask,
      bookTsMs: wednesday,
      sendTsMs: wednesday + 250,
      decisionMid: 100,
    },
  ];
  const left = replayInjected(events);
  const right = replayInjected(events);
  expect(left.positions[0]?.fillPrice).toBeCloseTo(expected, 8);
  expect(left.positions[0]?.sLiveBps).toBeCloseTo(sLive, 8);
  expect(right.positions[0]?.fillPrice).toBe(left.positions[0]?.fillPrice);
  expect(left.legs[0]?.orderSendTs - (left.legs[0]?.triggerBarTs ?? left.legs[0]!.orderSendTs)).toBe(0);
  expect(left.legs[0]?.orderSendTs - wednesday).toBe(250);
});
