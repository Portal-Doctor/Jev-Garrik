import { test, expect } from "bun:test";
import { DECIDE_DEADLINE_MS } from "./engine";
import {
  LIVE_PAIRS,
  PAIR_BOOKS,
  activePairs,
  assertPairBooks,
  bookFor,
  hurdleAtAssumedSpread,
  minHorizonVolBps,
  payoffLegs,
} from "./books";

const fees50 = { makerFeeBps: 50, takerFeeBps: 90, feeBuffer: 1.5 };
const fees40 = { makerFeeBps: 40, takerFeeBps: 80, feeBuffer: 1.5 };
const SIX = ["UNI-USD", "NEAR-USD", "BCH-USD", "SUI-USD", "AVAX-USD", "ARB-USD"];
const NEW_LIVE = ["VVV-USD", "ZEC-USD", "PUMP-USD", "XLM-USD"];
const PARKED = ["TAO-USD", "ADA-USD"];

test("the live set is the original six plus the four names that boot at 40/80", () => {
  expect([...LIVE_PAIRS]).toEqual([...SIX, ...NEW_LIVE]);
  expect(PAIR_BOOKS.filter((b) => b.enabled).map((b) => b.pair)).toEqual([...LIVE_PAIRS]);
  expect(PAIR_BOOKS.some((b) => b.pair === "SOL-USD")).toBe(false);
  for (const pair of PARKED) expect(bookFor(pair).enabled).toBe(false);
});

test("stop is one sigma and take-profit is four sigma", () => {
  for (const book of PAIR_BOOKS) {
    expect(book.stopLossBps).toBe(book.sigmaBps);
    expect(book.takeProfitBps).toBe(book.sigmaBps * 4);
  }
  expect(bookFor("ARB-USD")).toMatchObject({ stopLossBps: 390, takeProfitBps: 1560, notionalUsd: 300 });
  expect(bookFor("VVV-USD")).toMatchObject({ stopLossBps: 312, takeProfitBps: 1248, notionalUsd: 400 });
  expect(bookFor("ZEC-USD")).toMatchObject({ stopLossBps: 273, takeProfitBps: 1092, notionalUsd: 600 });
  expect(bookFor("PUMP-USD")).toMatchObject({ stopLossBps: 246, takeProfitBps: 984, notionalUsd: 300 });
  expect(bookFor("XLM-USD")).toMatchObject({ stopLossBps: 189, takeProfitBps: 756, notionalUsd: 400 });
});

test("enabled books clear the 2-to-1 payoff at 40/80", () => {
  for (const pair of LIVE_PAIRS) {
    const book = bookFor(pair);
    const legs = payoffLegs(book.takeProfitBps, book.stopLossBps, 40, 80);
    expect(legs.winnerBps).toBeGreaterThanOrEqual(2 * legs.loserBps);
  }
  expect(() => assertPairBooks([...LIVE_PAIRS], fees40)).not.toThrow();
});

test("the original six still clear the 2-to-1 payoff at 50/90", () => {
  for (const pair of SIX) {
    const book = bookFor(pair);
    const legs = payoffLegs(book.takeProfitBps, book.stopLossBps, 50, 90);
    expect(legs.winnerBps).toBeGreaterThanOrEqual(2 * legs.loserBps);
  }
  const sui = payoffLegs(876, 219, 50, 90);
  expect(sui.winnerBps).toBe(736);
  expect(sui.loserBps).toBe(359);
  expect(() => assertPairBooks(SIX, fees50)).not.toThrow();
});

test("TAO and ADA fail the 2-to-1 boot at 40/80 so they stay out of CB_PAIRS", () => {
  const tao = payoffLegs(708, 177, 40, 80);
  const ada = payoffLegs(628, 157, 40, 80);
  expect(tao.winnerBps).toBeLessThan(2 * tao.loserBps);
  expect(ada.winnerBps).toBeLessThan(2 * ada.loserBps);
  expect(() => assertPairBooks(["TAO-USD"], fees40)).toThrow(/twice/);
  expect(() => assertPairBooks(["ADA-USD"], fees40)).toThrow(/twice/);
});

test("a take-profit at two sigma fails the after-fee payoff at 50 and 90", () => {
  const halved = PAIR_BOOKS.map((b) => ({ ...b, takeProfitBps: b.sigmaBps * 2 }));
  expect(() => assertPairBooks(["SUI-USD"], fees50, halved)).toThrow(/twice/);
});

test("enabled clips exceed the 3000 gross cap and the cap is not raised", () => {
  const sum = PAIR_BOOKS.filter((b) => b.enabled).reduce((s, b) => s + b.notionalUsd, 0);
  expect(sum).toBe(4200);
  expect(sum).toBeGreaterThan(3000);
});

test("the NEAR clip is halved to 300 and its stop, take-profit, and sigma are untouched", () => {
  expect(bookFor("NEAR-USD")).toMatchObject({
    notionalUsd: 300,
    stopLossBps: 331,
    takeProfitBps: 1324,
    sigmaBps: 331,
  });
});

test("original six clips are unchanged", () => {
  expect(Object.fromEntries(SIX.map((p) => [p, bookFor(p).notionalUsd]))).toEqual({
    "UNI-USD": 600,
    "NEAR-USD": 300,
    "BCH-USD": 500,
    "SUI-USD": 400,
    "AVAX-USD": 400,
    "ARB-USD": 300,
  });
});

test("boot accepts the live ten and rejects an unknown pair or a stop under the hurdle", () => {
  expect(() => assertPairBooks([...LIVE_PAIRS], fees40)).not.toThrow();
  expect(() => assertPairBooks(["SOL-USD"], fees40)).toThrow(/no book/);
  expect(() => bookFor("SOL-USD")).toThrow(/no book/);
  const hurdle = hurdleAtAssumedSpread(40, 1.5, 2);
  expect(hurdle).toBeCloseTo(121.5, 6);
  for (const pair of LIVE_PAIRS) expect(bookFor(pair).stopLossBps).toBeGreaterThanOrEqual(hurdle);
});

test("the vol floor is the hurdle divided by the buy-threshold edge", () => {
  const hurdle = hurdleAtAssumedSpread(40, 1.5, 2);
  expect(minHorizonVolBps(hurdle, 0.7)).toBeCloseTo(hurdle / 0.4, 6);
  expect(minHorizonVolBps(hurdle, 0.5)).toBe(Number.POSITIVE_INFINITY);
});

test("a disabled book stays in the table and drops out of the live set", () => {
  expect(activePairs([...LIVE_PAIRS, ...PARKED])).toEqual([...LIVE_PAIRS]);
  expect(activePairs(["SOL-USD", "UNI-USD"])).toEqual(["UNI-USD"]);
});

test("ten-pair stagger stays wider than a hung classify", () => {
  const staggerMs = (300 * 1000) / LIVE_PAIRS.length;
  expect(staggerMs).toBe(30_000);
  expect(DECIDE_DEADLINE_MS).toBeLessThan(staggerMs);
});
