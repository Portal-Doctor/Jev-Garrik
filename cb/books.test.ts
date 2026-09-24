import { test, expect } from "bun:test";
import { DECIDE_DEADLINE_MS } from "./engine";
import {
  PAIR_BOOKS,
  activePairs,
  assertPairBooks,
  bookFor,
  hurdleAtAssumedSpread,
  minHorizonVolBps,
  payoffLegs,
} from "./books";

const fees = { makerFeeBps: 50, takerFeeBps: 90, feeBuffer: 1.5 };
const SIX = ["UNI-USD", "NEAR-USD", "BCH-USD", "SUI-USD", "AVAX-USD", "ARB-USD"];

test("the live table is the six liquid pairs and SOL is absent", () => {
  expect(PAIR_BOOKS.map((b) => b.pair)).toEqual(SIX);
  expect(PAIR_BOOKS.every((b) => b.enabled && b.maxOpen === 1)).toBe(true);
  expect(PAIR_BOOKS.some((b) => b.pair === "SOL-USD")).toBe(false);
});

test("stop is one sigma and take-profit is four sigma, and the winner pays twice the loser", () => {
  for (const book of PAIR_BOOKS) {
    expect(book.stopLossBps).toBe(book.sigmaBps);
    expect(book.takeProfitBps).toBe(book.sigmaBps * 4);
    const legs = payoffLegs(book.takeProfitBps, book.stopLossBps, 50, 90);
    expect(legs.winnerBps).toBeGreaterThanOrEqual(2 * legs.loserBps);
  }
  expect(bookFor("ARB-USD")).toMatchObject({ stopLossBps: 390, takeProfitBps: 1560, notionalUsd: 300 });
  expect(bookFor("UNI-USD")).toMatchObject({ stopLossBps: 295, takeProfitBps: 1180, notionalUsd: 600 });
  const sui = payoffLegs(876, 219, 50, 90);
  expect(sui.winnerBps).toBe(736);
  expect(sui.loserBps).toBe(359);
});

test("a take-profit at two sigma fails the after-fee payoff at 50 and 90", () => {
  const halved = PAIR_BOOKS.map((b) => ({ ...b, takeProfitBps: b.sigmaBps * 2 }));
  expect(() => assertPairBooks(["SUI-USD"], fees, halved)).toThrow(/twice/);
  expect(() => assertPairBooks(SIX, fees)).not.toThrow();
});

test("notionals sum to less than the 3000 gross cap", () => {
  const sum = PAIR_BOOKS.reduce((s, b) => s + b.notionalUsd, 0);
  expect(sum).toBe(2800);
  expect(sum).toBeLessThan(3000);
});

test("boot accepts the six books and rejects an unknown pair or a stop under the hurdle", () => {
  expect(() => assertPairBooks(SIX, fees)).not.toThrow();
  expect(() => assertPairBooks(["SOL-USD"], fees)).toThrow(/no book/);
  expect(() => bookFor("SOL-USD")).toThrow(/no book/);
  const hurdle = hurdleAtAssumedSpread(50, 1.5, 2);
  expect(hurdle).toBeCloseTo(151.5, 6);
  for (const book of PAIR_BOOKS) expect(book.stopLossBps).toBeGreaterThanOrEqual(hurdle);
});

test("the vol floor is the hurdle divided by the buy-threshold edge", () => {
  const hurdle = hurdleAtAssumedSpread(50, 1.5, 2);
  expect(minHorizonVolBps(hurdle, 0.7)).toBeCloseTo(hurdle / 0.4, 6);
  expect(minHorizonVolBps(hurdle, 0.5)).toBe(Number.POSITIVE_INFINITY);
});

test("a disabled book stays in the table and drops out of the live set", () => {
  expect(activePairs(SIX)).toEqual(SIX);
  expect(activePairs(["SOL-USD", "UNI-USD"])).toEqual(["UNI-USD"]);
});

test("six-pair stagger stays wider than a hung classify", () => {
  const staggerMs = (300 * 1000) / SIX.length;
  expect(staggerMs).toBe(50_000);
  expect(DECIDE_DEADLINE_MS).toBeLessThan(staggerMs);
});
