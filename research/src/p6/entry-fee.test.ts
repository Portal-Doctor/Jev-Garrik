import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { MAKER_FEE_BPS, TAKER_FEE_BPS, DEPLOYABLE_USD } from "../../vendor/87b35d0/config.ts";
import { BACKSTOP_PAIR_USD, BOOK_HALT_USD, DAILY_HALT_USD, WEEKLY_HALT_USD, x1FillPrice } from "../p3/design-rules";
import { CLASS_DOLLAR_BACKSTOP_USD } from "../p5/risk";
import { netBps } from "../p5/walk";
import { AMENDMENT_V63_RULE, amendmentV63Body } from "./amendment-v63";
import { applyForward, freshBook, paperPnl, replayInjected, type Book, type ForwardEvent, type Position } from "./engine";
import { ACCT_KEY, acctFromDay, captureHot, loadSplit, parseAcctMarker, persistSplit } from "./hot-store";
import { forwardClassRisk, forwardDays } from "./kelly";
import { installPaperState, startPaperHost } from "./paper-host";
import { LEASE_KEY, decodeLease, memoryKv, tryAcquire } from "./relay";
import { classDollarBackstop } from "./session";

const SAT = Date.parse("2026-10-17T12:00:00.000Z");
const MONDAY = Date.parse("2026-03-02T00:00:00.000Z");

function x1(id: string, productId: string, tsMs: number, stop: number): ForwardEvent {
  return {
    kind: "x1",
    id,
    classId: "C",
    productId,
    tsMs,
    nextOpen: 100,
    stop,
    atr1h: 1,
    bid: 100,
    ask: 100,
    bookTsMs: tsMs,
    sendTsMs: tsMs + 5,
    decisionMid: 100,
  };
}

function exitCostUsd(position: Position, mark: number): number {
  return (mark * position.units * (TAKER_FEE_BPS + position.sLiveBps)) / 10_000;
}

/** Mark where price change plus the taker exit estimate equals `priceAndExitLoss` dollars. */
function markForPriceLoss(position: Position, priceAndExitLoss: number): number {
  const k = (TAKER_FEE_BPS + position.sLiveBps) / 10_000;
  return (position.fillPrice * position.units - priceAndExitLoss) / (position.units * (1 - k));
}

/**
 * Price-and-exit loss is the halt threshold minus the entry fee, so equity loss equals the threshold.
 * The extra 1e-9 dollar keeps a float that lands one ulp short of `<=` / `>=` on the trip side.
 */
function markForEquityLoss(position: Position, thresholdUsd: number): number {
  return markForPriceLoss(position, thresholdUsd - position.entryFeeUsd + 1e-9);
}

function openTakers(products: readonly string[], stop: number): Book {
  const events: ForwardEvent[] = [{ kind: "clock", tsMs: SAT - 60_000 }];
  products.forEach((productId, index) => events.push(x1(`c${index}`, productId, SAT, stop)));
  return replayInjected(events);
}

function markAll(book: Book, priceFor: (position: Position) => number): Book {
  let next = book;
  for (const position of book.positions) next = applyForward(next, { kind: "mark", productId: position.productId, price: priceFor(position) });
  return next;
}

test("at the fill, open equity charges the entry fee and the exit cost", () => {
  const taker = openTakers(["ETH-USD"], 90);
  const position = taker.positions[0]!;
  expect(position.sLiveBps).toBe(0);
  expect(position.fillPrice).toBe(100);
  const marked = applyForward(taker, { kind: "mark", productId: "ETH-USD", price: position.fillPrice });
  const exitCost = exitCostUsd(position, position.fillPrice);
  const pnl = paperPnl(marked);
  expect(marked.realizedUsd).toBe(0);
  expect(pnl.unrealizedUsd).toBeCloseTo(-(position.entryFeeUsd + exitCost), 8);
  expect(pnl.equityUsd).toBeCloseTo(DEPLOYABLE_USD - position.entryFeeUsd - exitCost, 8);
  expect(pnl.equityUsd).toBeCloseTo(8000 - position.entryFeeUsd - exitCost, 8);
  const withoutFee = (position.fillPrice - position.fillPrice) * position.units - exitCost;
  expect(Math.abs(pnl.unrealizedUsd - withoutFee)).toBeCloseTo(position.entryFeeUsd, 8);

  const placed = SAT;
  let maker = replayInjected([
    { kind: "clock", tsMs: placed - 60_000 },
    {
      kind: "d-order",
      id: "d1",
      productId: "ETH-USD",
      limit: 100,
      units: 1,
      placedTs: placed,
      stop: 90,
      bid: 100,
      ask: 100,
      bookTsMs: placed,
      sendTsMs: placed + 5,
      decisionMid: 100,
      target: 100,
      tick: 0.01,
    },
    { kind: "trade", productId: "ETH-USD", price: 99.98, size: 10_000, makerSide: "sell", tsMs: placed + 1_000 },
  ]);
  const made = maker.positions[0]!;
  expect(made.fillPrice).toBe(100);
  expect(made.entryFeeUsd).toBeCloseTo((made.notionalUsd * MAKER_FEE_BPS) / 10_000, 8);
  maker = applyForward(maker, { kind: "mark", productId: "ETH-USD", price: made.fillPrice });
  const makerExitEstimate = exitCostUsd(made, made.fillPrice);
  const makerPnl = paperPnl(maker);
  expect(maker.realizedUsd).toBe(0);
  expect(makerPnl.equityUsd).toBeCloseTo(DEPLOYABLE_USD - made.entryFeeUsd - makerExitEstimate, 8);
});

test("a round trip keeps the pre-change close, and equity is continuous for a taker exit", () => {
  const opened = openTakers(["ETH-USD"], 90);
  const position = opened.positions[0]!;
  const atFill = applyForward(opened, { kind: "mark", productId: "ETH-USD", price: position.fillPrice });
  const openEquity = paperPnl(atFill).equityUsd;
  const holdMs = 72 * 3_600_000;
  const barTs = Math.ceil((position.entryTs + holdMs) / 900_000) * 900_000;
  const startSec = barTs / 1000;
  const closed = applyForward(atFill, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec,
    nowSec: startSec + 900,
    open: position.fillPrice,
    high: position.fillPrice,
    low: position.fillPrice,
    close: position.fillPrice,
  });
  const trade = closed.closed[0]!;
  const exitFee = (position.units * position.fillPrice * TAKER_FEE_BPS) / 10_000;
  expect(closed.positions).toHaveLength(0);
  expect(closed.realizedUsd).toBeCloseTo(trade.netUsd, 8);
  expect(trade.netUsd).toBeCloseTo(-(position.entryFeeUsd + exitFee), 8);
  expect(trade.netUsd).toBeCloseTo(-180 / 59, 8);
  expect(trade.netUsd).toBeCloseTo(-3.0508474576271185, 8);
  expect(trade.netR).toBeCloseTo(trade.netUsd / position.riskUsd, 8);
  expect(trade.netR).toBeCloseTo(-9 / 59, 8);
  expect(trade.netR).toBeCloseTo(-0.15254237288135593, 8);
  expect(Math.abs(trade.netUsd - (-(2 * position.entryFeeUsd + exitFee)))).toBeGreaterThan(1);
  expect(closed.legs.reduce((sum, leg) => sum + leg.feesUsd, 0)).toBeCloseTo(position.entryFeeUsd + exitFee, 8);
  expect(paperPnl(closed).equityUsd).toBeCloseTo(openEquity, 6);
  expect(paperPnl(closed).equityUsd).toBeCloseTo(DEPLOYABLE_USD + trade.netUsd, 8);
  expect(closed.classes.C.cumUsd).toBeCloseTo(trade.netUsd, 8);
  expect(paperPnl(closed).classes.C.killed).toBe(false);
  expect(paperPnl(closed).classes.C.drawdownR).toBeLessThan(10);
  expect(classDollarBackstop(closed.classes.C)).toBe(false);
  expect(CLASS_DOLLAR_BACKSTOP_USD).toBe(1200);

  const replayed = applyForward(freshBook(), {
    kind: "realize",
    id: trade.id,
    classId: "C",
    productId: trade.productId,
    netR: trade.netR,
    netUsd: trade.netUsd,
    riskUsd: trade.riskUsd,
    entryDate: trade.entryDate,
    exitTs: trade.exitTs,
  });
  expect(JSON.stringify(replayed.classes)).toBe(JSON.stringify(closed.classes));

  const placed = SAT;
  const maker = replayInjected([
    { kind: "clock", tsMs: placed - 60_000 },
    {
      kind: "d-order",
      id: "d1",
      productId: "ETH-USD",
      limit: 100,
      units: 1,
      placedTs: placed,
      stop: 90,
      bid: 100,
      ask: 100,
      bookTsMs: placed,
      sendTsMs: placed + 5,
      decisionMid: 100,
      target: 100,
      tick: 0.01,
    },
    { kind: "trade", productId: "ETH-USD", price: 99.98, size: 10_000, makerSide: "sell", tsMs: placed + 1_000 },
    { kind: "trade", productId: "ETH-USD", price: 100.02, size: 10_000, makerSide: "buy", tsMs: placed + 2_000 },
  ]);
  const makerTrade = maker.closed[0]!;
  const makerFee = maker.legs[0]!.feesUsd;
  const makerExit = maker.legs[1]!.feesUsd;
  expect(maker.positions).toHaveLength(0);
  expect(maker.realizedUsd).toBeCloseTo(makerTrade.netUsd, 8);
  expect(makerFee).toBeCloseTo(makerExit, 8);
  expect(makerTrade.netUsd).toBeCloseTo(-(makerFee + makerExit), 8);
  expect(makerTrade.netUsd).toBeCloseTo(-100 / 57, 8);
  expect(makerTrade.netUsd).toBeCloseTo(-1.7543859649122806, 8);
  expect(makerTrade.netR).toBeCloseTo(-5 / 57, 8);
  expect(Math.abs(makerTrade.netUsd - (-(2 * makerFee + makerExit)))).toBeGreaterThan(0.5);
  expect(maker.classes.D.cumUsd).toBeCloseTo(makerTrade.netUsd, 8);
});

test("parity marks stay on the round-trip formula and replay bit-identical", () => {
  const events: ForwardEvent[] = [
    { kind: "clock", tsMs: SAT - 60_000 },
    x1("p1", "ETH-USD", SAT, 90),
    { kind: "mark", productId: "ETH-USD", price: 110 },
  ];
  const config = { parity: { riskUsd: 20, sBtBps: 5 }, members: ["ETH-USD"] };
  const first = replayInjected(events, config);
  const second = replayInjected(events, config);
  expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  const position = first.positions[0]!;
  const exitFill = x1FillPrice(110, "sell", 5);
  const net = netBps(position.fillPrice, exitFill, TAKER_FEE_BPS, TAKER_FEE_BPS);
  const formula = (net / 10_000) * position.units * position.fillPrice;
  expect(paperPnl(first).unrealizedUsd).toBeCloseTo(formula, 8);
  expect(Math.abs(paperPnl(first).unrealizedUsd - (formula - position.entryFeeUsd))).toBeGreaterThan(0.01);
});

test("halts and the pair backstop trip at the threshold minus the entry fee", () => {
  expect(DAILY_HALT_USD).toBe(240);
  expect(WEEKLY_HALT_USD).toBe(480);
  expect(BOOK_HALT_USD).toBe(-1_600);
  expect(BACKSTOP_PAIR_USD).toBe(500);

  const daily = openTakers(["ETH-USD"], 99.8);
  const dailyPos = daily.positions[0]!;
  expect(dailyPos.entryFeeUsd).toBeCloseTo(9, 6);
  const dailyMarked = applyForward(daily, { kind: "mark", productId: "ETH-USD", price: markForEquityLoss(dailyPos, DAILY_HALT_USD) });
  expect(dailyMarked.realizedUsd).toBe(0);
  expect(DEPLOYABLE_USD - paperPnl(dailyMarked).equityUsd).toBeCloseTo(DAILY_HALT_USD, 6);
  const dailyLatched = applyForward(dailyMarked, { kind: "clock", tsMs: SAT });
  expect(dailyLatched.haltWeeks).toHaveLength(1);
  const blocked = applyForward(dailyLatched, x1("again", "SOL-USD", SAT, 99.8));
  expect(blocked.rejected.at(-1)?.reason ?? "").toContain("halt");

  const dailyShort = applyForward(openTakers(["ETH-USD"], 99.8), {
    kind: "mark",
    productId: "ETH-USD",
    price: markForEquityLoss(openTakers(["ETH-USD"], 99.8).positions[0]!, DAILY_HALT_USD - 0.01),
  });
  expect(DEPLOYABLE_USD - paperPnl(dailyShort).equityUsd).toBeCloseTo(DAILY_HALT_USD - 0.01, 4);
  const dailyOpen = applyForward(applyForward(dailyShort, { kind: "clock", tsMs: SAT }), x1("again", "SOL-USD", SAT, 99.8));
  expect(dailyOpen.haltWeeks).toHaveLength(0);
  expect(dailyOpen.rejected.some((row) => row.reason.includes("halt"))).toBe(false);
  expect(dailyOpen.positions.some((row) => row.id === "again")).toBe(true);

  const weekly = openTakers(["ETH-USD"], 99.8);
  const weeklyMarked = applyForward(weekly, {
    kind: "mark",
    productId: "ETH-USD",
    price: markForEquityLoss(weekly.positions[0]!, WEEKLY_HALT_USD),
  });
  expect(weeklyMarked.realizedUsd).toBe(0);
  expect(DEPLOYABLE_USD - paperPnl(weeklyMarked).equityUsd).toBeCloseTo(WEEKLY_HALT_USD, 6);
  expect(applyForward(weeklyMarked, { kind: "clock", tsMs: SAT }).haltWeeks).toHaveLength(1);
  const weeklyShort = applyForward(openTakers(["ETH-USD"], 99.8), {
    kind: "mark",
    productId: "ETH-USD",
    price: markForEquityLoss(openTakers(["ETH-USD"], 99.8).positions[0]!, WEEKLY_HALT_USD - 0.01),
  });
  expect(DEPLOYABLE_USD - paperPnl(weeklyShort).equityUsd).toBeLessThan(WEEKLY_HALT_USD);

  const book = openTakers(["ETH-USD", "BTC-USD"], 99.8);
  expect(book.positions).toHaveLength(2);
  const bookMarked = markAll(book, (position) => markForEquityLoss(position, 800));
  expect(bookMarked.realizedUsd).toBe(0);
  expect(paperPnl(bookMarked).book.drawdownUsd).toBeCloseTo(1_600, 6);
  expect(paperPnl(bookMarked).book.roomUsd).toBeCloseTo(0, 4);
  expect(applyForward(bookMarked, { kind: "clock", tsMs: SAT }).haltWeeks).toHaveLength(1);
  const bookShort = markAll(openTakers(["ETH-USD", "BTC-USD"], 99.8), (position) => markForEquityLoss(position, 800 - 0.01));
  expect(paperPnl(bookShort).book.drawdownUsd).toBeLessThan(1_600);
  expect(paperPnl(bookShort).book.roomUsd).toBeGreaterThan(0);

  const pair = openTakers(["ETH-USD"], 99.8);
  const pairMarked = applyForward(pair, {
    kind: "mark",
    productId: "ETH-USD",
    price: markForEquityLoss(pair.positions[0]!, BACKSTOP_PAIR_USD),
  });
  expect(pairMarked.realizedUsd).toBe(0);
  expect(pairMarked.pairs["ETH-USD"]?.latched).toBe(true);
  expect(pairMarked.pairs["ETH-USD"]?.baselineUsd).toBe(0);
  const pairShort = applyForward(openTakers(["ETH-USD"], 99.8), {
    kind: "mark",
    productId: "ETH-USD",
    price: markForEquityLoss(openTakers(["ETH-USD"], 99.8).positions[0]!, BACKSTOP_PAIR_USD - 0.01),
  });
  expect(pairShort.pairs["ETH-USD"]?.latched).toBe(false);
});

test("p6:acct is NX inside the existing flush and fromDay is the next full UTC day", () => {
  expect(acctFromDay(Date.parse("2026-10-16T23:59:59.999Z"))).toBe("2026-10-17");
  expect(acctFromDay(Date.parse("2026-10-17T00:00:00.000Z"))).toBe("2026-10-18");
  expect(parseAcctMarker(null)).toBeNull();
  expect(parseAcctMarker('{"rev":1,"fromDay":"2026-10-17"}')).toBeNull();

  let now = Date.UTC(2026, 9, 16, 15, 0, 0);
  const kv = memoryKv(() => now);
  expect(acctFromDay(now)).toBe("2026-10-17");
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => now;
  return (async () => {
    expect(await tryAcquire(kv, "K", now + 86_400_000, now)).toBe(true);
    host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
    let flushes = 0;
    const payloads: string[] = [];
    const owned = kv.ownedFlush.bind(kv);
    kv.ownedFlush = async (leaseKey, token, nowMs, payload) => {
      flushes += 1;
      payloads.push(payload);
      return owned(leaseKey, token, nowMs, payload);
    };
    await persistSplit(kv, host);
    expect(flushes).toBe(1);
    const extra = (JSON.parse(payloads[0]!) as { extra: { key: string; value: string; nx?: boolean }[] }).extra.filter((row) => row.key === ACCT_KEY);
    expect(extra).toEqual([{ key: ACCT_KEY, nx: true, value: JSON.stringify({ rev: 2, fromDay: "2026-10-17" }) }]);
    const stored = await kv.get(ACCT_KEY);
    expect(stored).toBe(JSON.stringify({ rev: 2, fromDay: "2026-10-17" }));
    expect(host.book.acctFromDay).toBe("2026-10-17");
    const hot = JSON.stringify(captureHot(host));
    expect(hot.includes("p6:acct")).toBe(false);
    expect(hot.includes("acctFromDay")).toBe(false);
    expect(hot.includes("fromDay")).toBe(false);

    await persistSplit(kv, host);
    expect(flushes).toBe(2);
    expect(await kv.get(ACCT_KEY)).toBe(stored);

    const loaded = startPaperHost(["BTC-USD"], {});
    loaded.clock = () => now;
    const body = await loadSplit(kv, loaded);
    expect(body).not.toBeNull();
    installPaperState(loaded, body!);
    expect(loaded.book.acctFromDay).toBe("2026-10-17");

    now = Date.UTC(2026, 9, 17, 15, 0, 0);
    expect(acctFromDay(now)).toBe("2026-10-18");
    expect(await tryAcquire(kv, "K2", now + 86_400_000, now)).toBe(true);
    const successor = startPaperHost(["BTC-USD"], {});
    successor.clock = () => now;
    successor.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
    await persistSplit(kv, successor);
    expect(await kv.get(ACCT_KEY)).toBe(stored);
    expect(flushes).toBe(3);

    await kv.del(ACCT_KEY);
    const bare = startPaperHost(["BTC-USD"], {});
    bare.clock = () => now;
    const again = await loadSplit(kv, bare);
    expect(again).not.toBeNull();
    installPaperState(bare, again!);
    expect(bare.book.acctFromDay).toBeNull();
  })();
});

test("promotion days ignore every day before fromDay and a missing marker does not", () => {
  const points = Array.from({ length: 30 }, (_, index) => ({ netR: index % 2 === 0 ? 0.8 : 1.2, entryDate: "2025-12-02" }));
  const streams = ["A", "B", "C", "D", "E"].map((id) => ({ id, netR: id === "A" ? points.map((point) => point.netR) : [] }));
  expect(forwardDays(points, MONDAY)).toBe(90);
  expect(forwardDays(points, MONDAY, null)).toBe(90);
  expect(forwardDays(points, MONDAY, "2025-12-02")).toBe(90);
  expect(forwardDays(points, MONDAY, "2025-01-01")).toBe(90);
  expect(forwardDays(points, MONDAY, "2026-02-01")).toBe(29);
  expect(forwardDays(points, MONDAY, "2026-03-03")).toBe(0);
  expect(forwardDays([], MONDAY, "2026-02-01")).toBe(0);

  const open = forwardClassRisk({
    classId: "A",
    forward: points,
    streams,
    nowMs: MONDAY,
    held: null,
    bootstrapSeed: 422_918_504,
    reps: 50,
  });
  expect(open.promoted).toBe(true);
  expect(open.forwardDays).toBe(90);
  expect(open.riskUsd).toBeCloseTo(60, 6);

  const restarted = forwardClassRisk({
    classId: "A",
    forward: points,
    streams,
    nowMs: MONDAY,
    held: null,
    bootstrapSeed: 422_918_504,
    reps: 50,
    fromDay: "2026-02-01",
  });
  expect(restarted.forwardDays).toBe(29);
  expect(restarted.promoted).toBe(false);
  expect(restarted.riskUsd).toBe(20);

  const held = forwardClassRisk({
    classId: "A",
    forward: points,
    streams,
    nowMs: MONDAY,
    held: { reviewMonday: open.reviewMonday, riskUsd: open.riskUsd, promoted: true },
    bootstrapSeed: 1,
    reps: 20,
    fromDay: "2026-02-01",
  });
  expect(held.held).toBe(true);
  expect(held.forwardDays).toBe(29);
  expect(held.riskUsd).toBeCloseTo(60, 6);

  const engine = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");
  expect(engine).toContain("fromDay: book.acctFromDay");
});

test("the entry-fee amendment cites the V6.2 file and waits for Brian", () => {
  const raw = readFileSync(fileURLToPath(new URL("../../data/reports/p6-amendment-v62.json", import.meta.url)));
  const side = readFileSync(fileURLToPath(new URL("../../data/reports/p6-amendment-v62.sha256", import.meta.url)), "utf8");
  const fileHash = createHash("sha256").update(raw).digest("hex");
  expect(side).toBe(`${fileHash}  research/data/reports/p6-amendment-v62.json\n`);
  const body = amendmentV63Body();
  expect(body.amendmentV62Sha256).toBe(fileHash);
  expect(body.amendmentV62Edited).toBe(false);
  expect(body.registrationEdited).toBe(false);
  expect(body.metricDefinitionsEdited).toBe(false);
  expect(body.haltThresholdsUnchanged).toBe(true);
  expect(body.rule).toBe(AMENDMENT_V63_RULE);
  expect(body.rule).toBe("open marks also charge the entry fee; thresholds unchanged; promotion day count restarts at fromDay; an invalid or garbage marker is ignored and repaired by the next flush of the process that loaded it; a first Monday review with no marker counts from the next UTC day");
  expect(body.awaiting).toBe("AWAITING Brian's approval stamp");
  expect(body.mergedCode).toBe("live once merged, with no feature flag");
  expect("live" in body).toBe(false);
  expect("featureFlag" in body).toBe(false);
  expect("approvedAt" in body).toBe(false);
  expect("approvedBy" in body).toBe(false);
  expect(createHash("sha256").update(JSON.stringify(body)).digest("hex")).toBe("da93a6ad0ed82b4374a0a3d0ecaff736b6b72fe5f05d12bccfbf1382bd78e6db");
});

test("partial D adds accumulate the entry fee and open equity charges the sum", () => {
  const placed = SAT;
  const book = replayInjected([
    { kind: "clock", tsMs: placed - 60_000 },
    {
      kind: "d-order",
      id: "d-partial",
      productId: "ETH-USD",
      limit: 100,
      units: 1,
      placedTs: placed,
      stop: 90,
      bid: 100,
      ask: 100,
      bookTsMs: placed,
      sendTsMs: placed + 5,
      decisionMid: 100,
      tick: 0.01,
    },
    { kind: "trade", productId: "ETH-USD", price: 99.98, size: 0.2, makerSide: "sell", tsMs: placed + 1_000 },
    { kind: "trade", productId: "ETH-USD", price: 99.98, size: 0.6, makerSide: "sell", tsMs: placed + 2_000 },
  ]);
  expect(book.positions).toHaveLength(1);
  const position = book.positions[0]!;
  expect(position.fillPrice).toBe(100);
  expect(position.units).toBeCloseTo(0.4, 8);
  const fee = (units: number) => (units * position.fillPrice * MAKER_FEE_BPS) / 10_000;
  expect(position.entryFeeUsd).toBeCloseTo(fee(0.1) + fee(0.3), 8);
  expect(Math.abs(position.entryFeeUsd - fee(0.1))).toBeGreaterThan(1e-6);
  expect(Math.abs(position.entryFeeUsd - fee(0.3))).toBeGreaterThan(1e-6);
  const marked = applyForward(book, { kind: "mark", productId: "ETH-USD", price: position.fillPrice });
  const pnl = paperPnl(marked);
  const exit = exitCostUsd(position, position.fillPrice);
  expect(pnl.unrealizedUsd).toBeCloseTo(-(fee(0.1) + fee(0.3) + exit), 8);
  expect(pnl.equityUsd).toBeCloseTo(DEPLOYABLE_USD - (fee(0.1) + fee(0.3)) - exit, 8);
  expect(Math.abs(pnl.unrealizedUsd - (-(fee(0.1) + exit)))).toBeCloseTo(fee(0.3), 8);
  expect(Math.abs(pnl.equityUsd - (DEPLOYABLE_USD - fee(0.1) - exit))).toBeCloseTo(fee(0.3), 8);
});

test("p6:acct rejects a non-object or impossible day, and a bad body is repaired", async () => {
  const now = Date.UTC(2026, 9, 16, 15, 0, 0);
  const bad = [
    "null",
    "[]",
    "123",
    '"x"',
    "true",
    "not-json",
    '{"rev":2,"fromDay":"2026-02-30"}',
    '{"rev":2,"fromDay":"9999-12-31"}',
    '{"rev":2,"fromDay":"not-a-date"}',
    '{"rev":2,"fromDay":"2026-13-01"}',
    '{"rev":1,"fromDay":"2026-10-17"}',
    '{"rev":"2","fromDay":"2026-10-17"}',
    '{"rev":2,"fromDay":"2025-12-31"}',
    '{"rev":2,"fromDay":"2026-10-18"}',
  ];
  for (const raw of bad) expect(parseAcctMarker(raw, now)).toBeNull();
  expect(parseAcctMarker('{"rev":2,"fromDay":"2026-01-01"}', now)).toEqual({ rev: 2, fromDay: "2026-01-01" });
  expect(parseAcctMarker('{"rev":2,"fromDay":"2026-10-17"}', now)).toEqual({ rev: 2, fromDay: "2026-10-17" });
  const mondayMidnight = Date.parse("2026-10-19T00:00:00.000Z");
  expect(acctFromDay(mondayMidnight)).toBe("2026-10-20");
  expect(parseAcctMarker('{"rev":2,"fromDay":"2026-10-20"}', mondayMidnight)).toEqual({ rev: 2, fromDay: "2026-10-20" });
  expect(parseAcctMarker('{"rev":2,"fromDay":"2026-10-21"}', mondayMidnight)).toBeNull();

  const kv = memoryKv(() => now);
  const writer = startPaperHost(["BTC-USD"], {});
  writer.clock = () => now;
  await persistSplit(kv, writer);
  expect(writer.book.acctFromDay).toBe("2026-10-17");
  expect(writer.acctRepair).toBe(false);

  for (const raw of bad) {
    await kv.set(ACCT_KEY, raw);
    const loaded = startPaperHost(["BTC-USD"], {});
    loaded.clock = () => now;
    const body = await loadSplit(kv, loaded);
    expect(body).not.toBeNull();
    installPaperState(loaded, body!);
    expect(loaded.book.acctFromDay).toBeNull();
    expect(loaded.acctRepair).toBe(true);
  }

  const repair = startPaperHost(["BTC-USD"], {});
  repair.clock = () => now;
  expect(await tryAcquire(kv, "K", now + 86_400_000, now)).toBe(true);
  repair.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
  const payloads: string[] = [];
  const owned = kv.ownedFlush.bind(kv);
  kv.ownedFlush = async (leaseKey, token, nowMs, payload) => {
    payloads.push(payload);
    return owned(leaseKey, token, nowMs, payload);
  };
  const before = await loadSplit(kv, repair);
  installPaperState(repair, before!);
  expect(repair.acctRepair).toBe(true);
  expect(repair.book.acctFromDay).toBeNull();
  await persistSplit(kv, repair);
  const extra = (JSON.parse(payloads[0]!) as { extra: { key: string; value: string; nx?: boolean }[] }).extra.filter((row) => row.key === ACCT_KEY);
  const repaired = JSON.stringify({ rev: 2, fromDay: "2026-10-17" });
  expect(extra).toEqual([{ key: ACCT_KEY, nx: false, value: repaired }]);
  expect(await kv.get(ACCT_KEY)).toBe(repaired);
  expect(repair.book.acctFromDay).toBe("2026-10-17");
  expect(repair.acctRepair).toBe(false);
  await persistSplit(kv, repair);
  expect(await kv.get(ACCT_KEY)).toBe(repaired);
  const second = (JSON.parse(payloads[1]!) as { extra: { key: string; nx?: boolean }[] }).extra.find((row) => row.key === ACCT_KEY);
  expect(second?.nx).toBe(true);

  const kept = startPaperHost(["BTC-USD"], {});
  kept.clock = () => Date.UTC(2026, 9, 17, 15, 0, 0);
  const keptBody = await loadSplit(kv, kept);
  installPaperState(kept, keptBody!);
  expect(kept.book.acctFromDay).toBe("2026-10-17");
  expect(kept.acctRepair).toBe(false);
  expect(await tryAcquire(kv, "K2", kept.clock() + 86_400_000, kept.clock())).toBe(true);
  kept.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
  await persistSplit(kv, kept);
  expect(await kv.get(ACCT_KEY)).toBe(repaired);
});

test("a first Monday before p6:acct exists does not promote on earlier days", () => {
  const points = Array.from({ length: 30 }, (_, index) => ({ netR: index % 2 === 0 ? 0.8 : 1.2, entryDate: "2025-12-02" }));
  const trades = points.map((point, index) => ({
    kind: "realize" as const,
    id: `m${index}`,
    classId: "A" as const,
    productId: "ETH-USD",
    netR: point.netR,
    netUsd: point.netR * 20,
    riskUsd: 20,
    entryDate: point.entryDate,
    exitTs: MONDAY - 1,
  }));
  const open = replayInjected([...trades, { kind: "clock", tsMs: MONDAY }]);
  expect(open.acctFromDay).toBeNull();
  expect(open.kelly.A?.promoted).toBe(false);
  expect(open.kelly.A?.riskUsd).toBe(20);

  const stamped = replayInjected(trades);
  stamped.acctFromDay = "2025-12-02";
  const reviewed = applyForward(stamped, { kind: "clock", tsMs: MONDAY });
  expect(reviewed.kelly.A?.promoted).toBe(true);
  expect(reviewed.kelly.A?.riskUsd).toBeCloseTo(60, 6);
});

test("forwardDays floors a partial day", () => {
  const first = Date.parse("2025-12-02T00:00:00.000Z");
  const points = [{ netR: 1, entryDate: "2025-12-02" }];
  expect(forwardDays(points, first + Math.floor(1.9 * 86_400_000))).toBe(1);
  expect(forwardDays(points, first + 2 * 86_400_000 - 1)).toBe(1);
  expect(forwardDays(points, first + 2 * 86_400_000)).toBe(2);
  expect(forwardDays(points, first + 90 * 86_400_000 - 1)).toBe(89);
  expect(forwardDays(points, first + 90 * 86_400_000)).toBe(90);
});

test("a fromDay one day off the first trade does not loosen the count", () => {
  const points = Array.from({ length: 30 }, (_, index) => ({ netR: index % 2 === 0 ? 0.8 : 1.2, entryDate: "2025-12-02" }));
  expect(forwardDays(points, MONDAY)).toBe(90);
  expect(forwardDays(points, MONDAY, "2025-12-01")).toBe(90);
  expect(forwardDays(points, MONDAY, "2025-12-02")).toBe(90);
  expect(forwardDays(points, MONDAY, "2025-12-03")).toBe(89);
});

test("promotion requires 90 forward days and 89 does not promote", () => {
  const points = Array.from({ length: 30 }, (_, index) => ({ netR: index % 2 === 0 ? 0.8 : 1.2, entryDate: "2025-12-02" }));
  const streams = ["A", "B", "C", "D", "E"].map((id) => ({ id, netR: id === "A" ? points.map((point) => point.netR) : [] }));
  const first = Date.parse("2025-12-02T00:00:00.000Z");
  const at89 = forwardClassRisk({
    classId: "A",
    forward: points,
    streams,
    nowMs: first + 89 * 86_400_000,
    held: null,
    bootstrapSeed: 422_918_504,
    reps: 50,
  });
  expect(at89.forwardDays).toBe(89);
  expect(at89.promoted).toBe(false);
  expect(at89.riskUsd).toBe(20);
  const at90 = forwardClassRisk({
    classId: "A",
    forward: points,
    streams,
    nowMs: first + 90 * 86_400_000,
    held: null,
    bootstrapSeed: 422_918_504,
    reps: 50,
  });
  expect(at90.forwardDays).toBe(90);
  expect(at90.promoted).toBe(true);
  expect(at90.riskUsd).toBeCloseTo(60, 6);
});
