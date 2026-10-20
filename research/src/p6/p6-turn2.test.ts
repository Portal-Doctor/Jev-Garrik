import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { stepRCurve, freshRCurve } from "../p5/guards";
import { percentileLinear } from "../p5/stats";
import { amendment2Body, METRIC_SHA256 } from "./amendment2";
import { stepBleed, freshBleed, acceptBrianOk } from "./bleed";
import { applyForward, bookRoundTrip, freshBook, replayInjected } from "./engine";
import { forwardClassRisk, kellyRulingBody, PAPER_BANKROLL_USD, UNPROMOTED_RISK_USD } from "./kelly";
import { classDollarBackstop, classBlockers, freshClassCurve, stepClass } from "./session";
import { colourDrawdown, colourExTop3, costDrag, MASTER_SEED, mostlyGreen, payoffBreakEven, subSeed, wilsonLower, WILSON_Z80, WILSON_Z95 } from "./metrics";
import { applyMidSample, freshMidBook, missingMidShare, shardProducts, takerSideFromMaker } from "./mid-feed";
import { fifteenMinuteUrl, strategyFetchAt, tradesBuilt15m, closeDivergenceBps } from "./rest-bars";
import { AMENDMENT_2A_RULE, freshClassPause, REARM_RULE, stepClassPause } from "./rearm";
import { assertP6Target, writeP6 } from "./write";

const monday = Date.parse("2026-03-02T00:00:00.000Z");
const wednesday = Date.parse("2026-03-04T00:00:00.000Z");
const nextMonday = Date.parse("2026-03-09T00:00:00.000Z");

function walk(values: readonly number[]) {
  let state = freshClassPause();
  for (const value of values) state = stepClassPause(state, value);
  return state;
}

test("amendment 2a kills from the running high and does not reset it on a pause", () => {
  expect(REARM_RULE).toBe(
    "the 10R pause re-fires only on a new trough below the prior one, or on a 10R drawdown from a new peak; the 20R kill is measured from the original peak.",
  );
  expect(AMENDMENT_2A_RULE).toContain("running high-water mark");
  const resumed = walk([0, -16, -11]);
  expect(resumed.paused).toBe(false);
  expect(resumed.peak).toBe(0);
  const dip = stepClassPause(resumed, -11.1);
  expect(dip.paused).toBe(false);
  expect(dip.killed).toBe(false);
  const trough = stepClassPause(dip, -16.1);
  expect(trough.paused).toBe(true);
  expect(trough.killed).toBe(false);
  expect(trough.priorTrough).toBe(-16.1);
  expect(trough.peak).toBe(0);

  const marked = walk([4, -8, -3]);
  expect(marked.paused).toBe(false);
  expect(marked.peak).toBe(4);
  expect(stepClassPause(marked, 6).peak).toBe(6);

  const peaked = walk([0, -16, -11, 5, -5]);
  expect(peaked.paused).toBe(true);
  expect(peaked.killed).toBe(false);
  expect(peaked.peak).toBe(5);

  const killed = walk([0, -16, -11, 8, -12]);
  expect(killed.killed).toBe(true);
  expect(killed.peak).toBe(8);
  const notYet = walk([0, -16, -11, 8, -11.5]);
  expect(notYet.killed).toBe(false);
  expect(notYet.paused).toBe(true);

  const historical = [0, -16, -11, -11.1].reduce((state, cum) => stepRCurve(state, cum), freshRCurve());
  expect(historical.paused).toBe(true);
});

test("rolling-20 stays paused until 20 minimum-size trades sum to at least 0, or Brian's OK", () => {
  let state = freshBleed();
  const history: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    state = stepBleed(state, history, -0.25, true);
    history.push(-0.25);
  }
  expect(state.paused).toBe(true);
  state = stepBleed(state, history, 100, true);
  expect(state.paused).toBe(true);
  expect(rollingSum(state.postPause)).toBe(100);
  for (let i = 0; i < 18; i += 1) state = stepBleed(state, history, 0, true);
  expect(state.paused).toBe(true);
  state = stepBleed(state, history, 0, false);
  expect(state.postPause).toHaveLength(19);
  state = stepBleed(state, history, 0, true);
  expect(state.paused).toBe(false);
  let stuck = freshBleed();
  const again: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    stuck = stepBleed(stuck, again, -0.25, true);
    again.push(-0.25);
  }
  const cleared = acceptBrianOk(stuck);
  expect(cleared.paused).toBe(false);
  expect(cleared.brianOk).toBe(false);
  let rearmed = cleared;
  const later: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    rearmed = stepBleed(rearmed, later, -1, true);
    later.push(-1);
  }
  expect(rearmed.paused).toBe(true);
});

function rollingSum(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

test("the $1,200 class backstop uses closed-trade dollars", () => {
  let curve = freshClassCurve();
  curve = stepClass(curve, -0.5, -600);
  expect(classDollarBackstop(curve)).toBe(false);
  curve = stepClass(curve, -0.5, -600);
  expect(classDollarBackstop(curve)).toBe(true);
  expect(classBlockers("A", curve, { halt: false, backstop: false, momentumBlocked: false, killSwitch: false })).toContain("backstop");
});

test("unpromoted classes stay at $20, a promoted class uses forward Kelly, and the week holds", () => {
  const streams = ["A", "B", "C", "D", "E"].map((id) => ({ id, netR: id === "A" ? mixed() : [] }));
  const quiet = forwardClassRisk({
    classId: "A",
    forward: [],
    streams: streams.map((stream) => ({ id: stream.id, netR: [] })),
    nowMs: monday,
    held: null,
    bootstrapSeed: 1,
    reps: 50,
  });
  expect(quiet.riskUsd).toBe(UNPROMOTED_RISK_USD);
  expect(quiet.promoted).toBe(false);
  expect(quiet.bankrollUsd).toBe(PAPER_BANKROLL_USD);
  expect(quiet.riskUsd).not.toBe(60);

  const points = mixed().map((netR) => ({ netR, entryDate: "2025-12-02" }));
  const tooSoon = forwardClassRisk({
    classId: "A",
    forward: points.map((point) => ({ ...point, entryDate: "2026-02-24" })),
    streams,
    nowMs: monday,
    held: null,
    bootstrapSeed: 1,
    reps: 20,
  });
  expect(tooSoon.promoted).toBe(false);
  expect(tooSoon.riskUsd).toBe(20);
  const promoted = forwardClassRisk({
    classId: "A",
    forward: points,
    streams,
    nowMs: monday,
    held: null,
    bootstrapSeed: 422_918_504,
    reps: 50,
  });
  expect(promoted.promoted).toBe(true);
  expect(promoted.riskUsd).toBeCloseTo(60, 6);
  expect(promoted.l80).toBeGreaterThan(0);
  expect(promoted.forwardDays).toBeGreaterThanOrEqual(90);

  const held = forwardClassRisk({
    classId: "A",
    forward: points.map((point) => ({ ...point, netR: -1 })),
    streams,
    nowMs: wednesday,
    held: { reviewMonday: promoted.reviewMonday, riskUsd: promoted.riskUsd, promoted: true },
    bootstrapSeed: 1,
    reps: 20,
  });
  expect(held.held).toBe(true);
  expect(held.riskUsd).toBeCloseTo(60, 6);

  const demoted = forwardClassRisk({
    classId: "A",
    forward: points.map((point) => ({ netR: -1, entryDate: "2026-03-04" })),
    streams: streams.map((stream) => ({ id: stream.id, netR: stream.id === "A" ? points.map(() => -1) : [] })),
    nowMs: nextMonday,
    held: { reviewMonday: "2026-03-02", riskUsd: 60, promoted: true },
    bootstrapSeed: 1,
    reps: 20,
  });
  expect(demoted.held).toBe(false);
  expect(demoted.riskUsd).toBe(20);
  expect(demoted.promoted).toBe(false);
  expect(kellyRulingBody().partOfAmendment2).toBe(false);
  expect(kellyRulingBody().registeredRiskUsd).toBe(60);
  expect(kellyRulingBody().registrationEdited).toBe(false);
});

function mixed(): number[] {
  return Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? 0.8 : 1.2));
}

test("amendment 2 Wilson, cost, and seeds match the worked examples", () => {
  expect(wilsonLower(12, 30, WILSON_Z80)).toBeCloseTo(0.328, 3);
  expect(wilsonLower(12, 30, WILSON_Z95)).toBeCloseTo(0.267, 3);
  const sample = [...Array.from({ length: 12 }, () => 2.5), ...Array.from({ length: 18 }, () => -1)];
  const payoff = payoffBreakEven(sample);
  expect(payoff.pHat).toBeCloseTo(0.4, 8);
  expect(payoff.pStar).toBeCloseTo(0.286, 3);
  expect(payoff.margin).toBeCloseTo(0.114, 3);
  expect(payoff.wilsonMargin80).toBeCloseTo(0.042, 3);
  expect(payoff.colour).toBe("GREEN");
  const drag = costDrag([{ costUsd: 40, grossUsd: 100, riskUsd: 20, notionalUsd: 200 }, { costUsd: 10, grossUsd: -5, riskUsd: 20, notionalUsd: 200 }]);
  expect(drag.cd).toBeCloseTo(0.5, 8);
  expect(drag.colour).toBe("GREY");
  const red = costDrag(Array.from({ length: 10 }, () => ({ costUsd: 1, grossUsd: -1, riskUsd: 20, notionalUsd: 100 })));
  expect(red.status).toBe("n/a");
  expect(red.colour).toBe("RED");
  expect(subSeed("3a", "placebo")).toBe(2_613_899_018);
  expect(subSeed("A", "bootstrap")).toBe(422_918_504);
  expect(subSeed("book", "bootstrap")).toBe(921_260_057);
  expect(MASTER_SEED).toBe(4_109_854_067);
  expect(colourDrawdown("A", 6.9, 2).colour).toBe("GREEN");
  expect(colourDrawdown("A", 7, 2).colour).toBe("YELLOW");
  expect(colourDrawdown("C", 5, 2).colour).toBe("YELLOW");
  expect(colourDrawdown("A", 10, 2).colour).toBe("RED");
  expect(colourExTop3("A", 30, 0, 0.1).scored).toBe(false);
  expect(colourExTop3("A", 30, -1, -0.6).colour).toBe("RED");
  expect(colourExTop3("C", 30, 0, 0.1).colour).toBe("YELLOW");
  expect(mostlyGreen([
    { name: "a", colour: "GREEN", scored: true },
    { name: "b", colour: "GREEN", scored: true },
    { name: "c", colour: "GREEN", scored: true },
    { name: "d", colour: "GREEN", scored: true },
    { name: "e", colour: "YELLOW", scored: true },
    { name: "f", colour: "YELLOW", scored: true },
  ])).toBe(true);
  expect(percentileLinear([1, 2, 3, 4], 0.95)).toBeCloseTo(3.85, 8);
});

test("1s mids become 1m bars when the minute changes, and 5 percent missing mids kill", () => {
  const state = freshMidBook();
  expect(applyMidSample(state, { productId: "BTC-USD", nowMs: 1_000, bid: 10, ask: 10.2 }).completed).toBeNull();
  expect(applyMidSample(state, { productId: "BTC-USD", nowMs: 2_000, bid: 10.4, ask: 10.6, tradeVolume: 2 }).completed).toBeNull();
  const rolled = applyMidSample(state, { productId: "BTC-USD", nowMs: 61_000, bid: 11, ask: 11 });
  expect(rolled.completed?.ts).toBe(0);
  expect(rolled.completed?.close).toBeCloseTo(10.5, 8);
  expect(rolled.completed?.volumeBase).toBe(2);
  expect(missingMidShare(100, 95).kill).toBe(true);
  expect(missingMidShare(100, 96).kill).toBe(false);
  expect(takerSideFromMaker("BUY")).toBe("sell");
  expect(shardProducts(["A", "B", "C"], 2)).toEqual([["A", "B"], ["C"]]);
  expect(() => shardProducts(["A"], 0)).toThrow(/not specified/);
  const url = fifteenMinuteUrl("BTC-USD", 0, 900);
  expect(url).toContain("granularity=900");
  expect(strategyFetchAt(900_000, 3)).toBe(903_000);
  const built = tradesBuilt15m([{ productId: "ETH-USD", tsSec: 10, price: 5, size: 1 }, { productId: "ETH-USD", tsSec: 20, price: 7, size: 1 }]);
  expect(built[0]?.close).toBe(7);
  expect(closeDivergenceBps(100, 101)).toBeCloseTo(100, 6);
});

test("the paper book trades at $20 until a Monday review, then holds Kelly, and logs the leg", () => {
  const x1 = {
    kind: "x1" as const,
    id: "a1",
    classId: "A" as const,
    productId: "ETH-USD",
    tsMs: wednesday,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.2,
    bookTsMs: wednesday,
    sendTsMs: wednesday + 5,
    decisionMid: 100.05,
    aConfig: "A55-k3",
  };
  const early = replayInjected([{ kind: "clock", tsMs: wednesday }, x1]);
  expect(early.positions[0]?.riskUsd).toBe(20);
  expect(early.positions[0]?.riskUsd).not.toBe(60);
  const leg = early.legs[0]!;
  expect(leg.arrivalBid).toBe(100);
  expect(leg.arrivalAsk).toBe(100.2);
  expect(leg.arrivalSnapshotTs).toBe(wednesday);
  expect(leg.orderSendTs).toBe(wednesday + 5);
  expect(leg.decisionMid).toBe(100.05);
  expect(leg.activeStop).toBe(90);
  expect(leg.units).toBeGreaterThan(0);
  expect(leg.feesUsd).toBeGreaterThan(0);
  expect(leg.fillPrice).toBeGreaterThan(100);

  const good = mixed().map((netR, index) => ({
    kind: "realize" as const,
    id: `g${index}`,
    classId: "A" as const,
    productId: "ETH-USD",
    netR,
    netUsd: netR * 20,
    riskUsd: 20,
    entryDate: "2025-12-02",
    exitTs: monday - 1,
  }));
  const primed = replayInjected(good);
  primed.acctFromDay = "2025-12-02";
  let reviewed = applyForward(primed, { kind: "clock", tsMs: monday });
  reviewed = applyForward(reviewed, x1);
  expect(reviewed.kelly.A?.promoted).toBe(true);
  expect(reviewed.positions[0]?.riskUsd).toBeCloseTo(60, 6);
  const heldBook = applyForward(reviewed, { kind: "clock", tsMs: wednesday });
  expect(heldBook.kelly.A?.riskUsd).toBeCloseTo(60, 6);
  const bad = mixed().map((_, index) => ({
    kind: "realize" as const,
    id: `b${index}`,
    classId: "A" as const,
    productId: "ETH-USD",
    netR: -1,
    netUsd: -20,
    riskUsd: 20,
    entryDate: "2026-03-04",
    exitTs: wednesday,
  }));
  let demoted = heldBook;
  for (const event of bad) demoted = applyForward(demoted, event);
  demoted = applyForward(demoted, { kind: "clock", tsMs: wednesday });
  expect(demoted.kelly.A?.riskUsd).toBeCloseTo(60, 6);
  demoted = applyForward(demoted, { kind: "clock", tsMs: nextMonday });
  expect(demoted.kelly.A?.riskUsd).toBe(20);
  expect(demoted.kelly.A?.promoted).toBe(false);
});

test("stops, maker orders, halts, packets, and the kill switch run on injected events", () => {
  const book = freshBook({ members: ["ETH-USD"] });
  applyForward(book, { kind: "clock", tsMs: wednesday });
  applyForward(book, {
    kind: "x1",
    id: "s1",
    classId: "A",
    productId: "ETH-USD",
    tsMs: wednesday,
    nextOpen: 100,
    stop: 95,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: wednesday,
    sendTsMs: wednesday,
    decisionMid: 100,
    aConfig: "A55-k3",
  });
  expect(book.positions).toHaveLength(1);
  applyForward(book, { kind: "mark", productId: "ETH-USD", price: 50 });
  expect(book.classes.A.pause.paused).toBe(false);
  const startSec = Math.floor(wednesday / 1000);
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec, nowSec: startSec, open: 90, high: 91, low: 89, close: 90 });
  expect(book.packets).toHaveLength(0);
  expect(book.positions).toHaveLength(1);
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: 1_700_000_000, nowSec: 1_700_000_900, open: 90, high: 91, low: 80, close: 90 });
  expect(book.positions).toHaveLength(1);
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec, nowSec: startSec + 900, open: 90, high: 91, low: 89, close: 90 });
  expect(book.positions).toHaveLength(0);
  expect(book.closed[0]?.exitKind).toBe("stop");
  expect(book.legs.find((leg) => leg.side === "exit")?.fillPrice).toBe(90);
  expect(book.legs.some((leg) => leg.side === "exit" && leg.triggerBarTs != null)).toBe(true);

  applyForward(book, { kind: "kill-switch", on: true });
  applyForward(book, {
    kind: "x1",
    id: "blocked",
    classId: "C",
    productId: "SOL-USD",
    tsMs: wednesday + 1,
    nextOpen: 10,
    stop: 9,
    atr1h: 0.1,
    bid: 10,
    ask: 10.01,
    bookTsMs: wednesday,
    sendTsMs: wednesday,
    decisionMid: 10,
  });
  expect(book.rejected.some((row) => row.id === "blocked")).toBe(true);
  applyForward(book, { kind: "kill-switch", on: false });

  applyForward(book, {
    kind: "d-order",
    id: "d1",
    productId: "ETH-USD",
    limit: 100,
    units: 1,
    placedTs: wednesday + 2 * 86_400_000,
    stop: 90,
    bid: 101,
    ask: 101.1,
    bookTsMs: wednesday + 2 * 86_400_000,
    decisionMid: 101,
  });
  expect(book.working).toHaveLength(1);
  applyForward(book, { kind: "gap", productId: "ETH-USD" });
  expect(book.working).toHaveLength(0);
  expect(book.indeterminateByClass.D).toBe(1);
  expect(book.positions.some((position) => position.id === "d1")).toBe(false);

  applyForward(book, {
    kind: "d-order",
    id: "d2",
    productId: "ETH-USD",
    limit: 100,
    units: 1,
    placedTs: wednesday + 2 * 86_400_000,
    stop: 90,
    bid: 101,
    ask: 101.1,
    bookTsMs: wednesday + 2 * 86_400_000,
    decisionMid: 101,
  });
  applyForward(book, { kind: "minute", productId: "ETH-USD", tsMs: wednesday + 2 * 86_400_000 + 1_000, open: 101, high: 102, low: 100, close: 101, volume: 4 });
  expect(book.positions.some((position) => position.id === "d2")).toBe(false);
  expect(book.working.some((order) => order.order.id === "d2")).toBe(true);

  const halted = freshBook();
  applyForward(halted, { kind: "clock", tsMs: Date.parse("2026-03-02T00:00:00.000Z") });
  applyForward(halted, { kind: "realize", id: "loss", classId: "B", productId: "BTC-USD", netR: -1, netUsd: -240, riskUsd: 20, entryDate: "2026-03-02", exitTs: monday });
  const mondayEquity = halted.realizedUsd + 0;
  expect(mondayEquity).toBe(-240);
  applyForward(halted, {
    kind: "x1",
    id: "after-halt",
    classId: "B",
    productId: "BTC-USD",
    tsMs: monday + 1,
    nextOpen: 10,
    stop: 9,
    atr1h: 0.1,
    bid: 10,
    ask: 10.01,
    bookTsMs: monday,
    sendTsMs: monday,
    decisionMid: 10,
  });
  expect(halted.rejected.some((row) => row.id === "after-halt")).toBe(true);
  applyForward(halted, { kind: "clock", tsMs: Date.parse("2026-03-03T00:00:00.000Z") });
  applyForward(halted, {
    kind: "x1",
    id: "next-day",
    classId: "E",
    productId: "SOL-USD",
    tsMs: Date.parse("2026-03-03T00:01:00.000Z"),
    nextOpen: 10,
    stop: 9,
    atr1h: 0.1,
    bid: 10,
    ask: 10.01,
    bookTsMs: Date.parse("2026-03-03T00:01:00.000Z"),
    sendTsMs: Date.parse("2026-03-03T00:01:00.000Z"),
    decisionMid: 10,
  });
  expect(halted.positions.some((position) => position.id === "next-day")).toBe(true);

  const copied = bookRoundTrip(halted);
  expect(copied.positions[0]?.id).toBe("next-day");
  expect(copied.closed[0]?.netUsd).toBe(-240);
});

test("a fourth name in one cluster is blocked by the book itself", () => {
  const names = ["ETH-USD", "BTC-USD", "SOL-USD", "LINK-USD"] as const;
  let book = freshBook({ members: [...names] });
  book = applyForward(book, { kind: "clock", tsMs: wednesday });
  for (let i = 0; i < names.length; i += 1) {
    for (let j = i + 1; j < names.length; j += 1) {
      book = applyForward(book, { kind: "rho", a: names[i]!, b: names[j]!, rho: 0.9 });
    }
  }
  const classes = ["A", "B", "C", "E"] as const;
  for (let i = 0; i < names.length; i += 1) {
    book = applyForward(book, {
      kind: "x1",
      id: names[i]!,
      classId: classes[i]!,
      productId: names[i]!,
      tsMs: wednesday + i,
      nextOpen: 100,
      stop: 90,
      atr1h: 1,
      bid: 100,
      ask: 100.1,
      bookTsMs: wednesday,
      sendTsMs: wednesday,
      decisionMid: 100,
      ...(classes[i] === "A" ? { aConfig: "A55-k3" } : {}),
    });
  }
  expect(book.positions.map((position) => position.productId)).toEqual(["ETH-USD", "BTC-USD", "SOL-USD"]);
  expect(book.rejected.some((row) => row.id === "LINK-USD" && row.reason.includes("cluster"))).toBe(true);
});

test("the stamped amendment 2 record is approved and the Kelly ruling is separate", () => {
  const raw = readFileSync(fileURLToPath(new URL("../../data/reports/p6-amendment-2.json", import.meta.url)));
  const doc = JSON.parse(raw.toString()) as { approvedAt: string; approvedBy: string; rearm: string; kellyIncluded: boolean; commitSha: string; registrationEdited: boolean };
  expect(doc.approvedAt).toBe("2026-10-12T01:23:00Z");
  expect(doc.approvedBy).toBe("Brian");
  expect(doc.rearm).toBe(REARM_RULE);
  expect(doc.kellyIncluded).toBe(false);
  expect(doc.registrationEdited).toBe(false);
  expect(doc.commitSha).toBe("d6c77d7e7a5853bb7ee5b967fb3bea557052aff0");
  const hash = createHash("sha256").update(raw).digest("hex");
  const side = readFileSync(fileURLToPath(new URL("../../data/reports/p6-amendment-2.sha256", import.meta.url)), "utf8");
  expect(side).toBe(`${hash}  research/data/reports/p6-amendment-2.json\n`);
  const kelly = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/reports/p6-kelly-ruling.json", import.meta.url)), "utf8")) as { partOfAmendment2: boolean; registeredRiskUsd: number; registrationEdited: boolean };
  expect(kelly.partOfAmendment2).toBe(false);
  expect(kelly.registeredRiskUsd).toBe(60);
  expect(kelly.registrationEdited).toBe(false);
});

test("features.ts is the cb accumulator byte for byte, and the amendment record cites the frozen hash", () => {
  const left = readFileSync(fileURLToPath(new URL("../../../cb/features.ts", import.meta.url)));
  const right = readFileSync(fileURLToPath(new URL("./cb-port/features.ts", import.meta.url)));
  expect(Buffer.compare(left, right)).toBe(0);
  const metric = readFileSync(fileURLToPath(new URL("../../data/registration-sources/p6-metric-definitions.md", import.meta.url)));
  // Item 1 was amended Oct 20. The amendment-2 record still cites the Oct 11 digest. That citation is not rewritten.
  expect(createHash("sha256").update(metric).digest("hex")).toBe("488c70610123178cf2e3a7e9d3e480ffeb153938cff4425b754e114ddd9787ef");
  const body = amendment2Body();
  expect(body.approvedBy).toBe("Brian");
  expect(body.approvedAt).toBe("2026-10-12T01:23:00Z");
  expect(body.rearm).toBe(REARM_RULE);
  expect(body.registrationEdited).toBe(false);
  expect(body.amendment1Edited).toBe(false);
  expect(body.kellyIncluded).toBe(false);
  expect(body.metricSha256).toBe(METRIC_SHA256);
  expect(() => assertP6Target("research/data/reports/p5-v31-registration.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p4-amendment-1.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p6-amendment-2.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p5-v31-geometry.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p6-jev-spend.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p6-amendment-2b.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p6-amendment-2b-approval.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/universe-membership.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p4-approval.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p5-v31-approval.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/geometry-scan.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p1-report.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/owner-decision.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/derived-roots.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p6-forward-a.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p6-kelly-superseding.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p6-wide-parity.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p6-d1-parity.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/reports/p6-kelly-ruling-superseded.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/products/exchange-products.raw.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/products/usd-spot.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/data-manifest.json")).toThrow(/refusing/);
  expect(() => assertP6Target("research/data/registration-sources/p6-metric-definitions.md")).toThrow(/refusing/);
  const dir = mkdtempSync(join(tmpdir(), "p6-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "p6@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "p6"], { cwd: dir });
  writeFileSync(join(dir, "note.txt"), "clean\n");
  execFileSync("git", ["add", "note.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  const stamp = { commitSha: "a".repeat(40), dataRootHash: null, createdAt: "2026-10-12T01:23:00.000Z", phaseId: "P6" as const };
  expect(() => writeP6(join(dir, "p6-note.json"), { ok: true }, { stamp })).toThrow(/repo root/);
  expect(() => writeP6(join(dir, "p5-v31-geometry.json"), { ok: true }, { stamp })).toThrow(/repo root/);
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  expect(() => writeP6(join(root, "research/data/reports/p5-v31-geometry.json"), { ok: true }, { stamp })).toThrow(/refusing to overwrite/);
  expect(() => writeP6(join(root, "research/data/reports/p6-jev-spend.json"), { ok: true }, { stamp })).toThrow(/refusing to overwrite/);
  expect(() => writeP6(join(root, "research/data/registration-sources/p6-metric-definitions.md"), { note: true }, { stamp })).toThrow(/refusing to overwrite/);
});
