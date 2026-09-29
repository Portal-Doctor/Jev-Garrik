import { expect, test } from "bun:test";
import { MAX_DRAWDOWN, MAX_MISS_RATE, MIN_BREAKOUT_TRADES, scoreAdoption, type AdoptionPair } from "./adoption";

const pair = (over: Partial<AdoptionPair> & { pair: string }): AdoptionPair => ({
  bankrollUsd: 2_000,
  fixedTrades: 150,
  fixedWinRate: 0.25,
  fixedNetUsd: -500,
  fixedMaxDrawdown: 0.3,
  breakoutTrades: 6,
  breakoutWinRate: 0.3,
  breakoutNetUsd: 150,
  breakoutMaxDrawdown: 0.08,
  missedEntries: 1,
  vetoedEntries: 0,
  signals: 7,
  ...over,
});

const six = (over: Array<Partial<AdoptionPair>> = []) =>
  ["UNI-USD", "NEAR-USD", "BCH-USD", "SUI-USD", "AVAX-USD", "ARB-USD"].map((p, i) => pair({ pair: p, ...over[i] }));

const rule = (pairs: AdoptionPair[], n: number) => scoreAdoption(pairs).rules.find((r) => r.n === n)!;

test("the locked thresholds are constants, not arguments a caller could widen", () => {
  expect(MAX_DRAWDOWN).toBe(0.15);
  expect(MAX_MISS_RATE).toBe(0.5);
  expect(MIN_BREAKOUT_TRADES).toBe(30);
  expect(scoreAdoption.length).toBe(1);
});

test("all five rules pass on a healthy book", () => {
  const score = scoreAdoption(six());
  expect(score.passes).toBe(true);
  expect(score.rules.every((r) => r.passes)).toBe(true);
  expect(score.combinedBreakoutNetUsd).toBe(900);
  expect(score.totalBreakoutTrades).toBe(36);
});

test("rule 1 fails when the combined breakout net is not above zero", () => {
  expect(rule(six([{ breakoutNetUsd: -900 }]), 1).passes).toBe(false);
  // Exactly zero is not above zero.
  expect(rule(six().map((p) => ({ ...p, breakoutNetUsd: 0 })), 1).passes).toBe(false);
});

test("rule 2 needs breakout ahead on at least 4 of the 6 pairs", () => {
  const behind = (n: number) => Array.from({ length: n }, () => ({ breakoutNetUsd: -600 }));
  expect(rule(six(behind(2)), 2).passes).toBe(true);
  expect(rule(six(behind(3)), 2).passes).toBe(false);
  expect(rule(six(behind(3)), 2).detail).toContain("3 of 6");
});

test("rule 3 fails at exactly 15% drawdown and the limit does not move", () => {
  expect(rule(six([{ breakoutMaxDrawdown: 0.1499 }]), 3).passes).toBe(true);
  expect(rule(six([{ breakoutMaxDrawdown: 0.15 }]), 3).passes).toBe(false);
  expect(rule(six([{ breakoutMaxDrawdown: 0.1505 }]), 3).passes).toBe(false);
  expect(rule(six([{ pair: "NEAR-USD", breakoutMaxDrawdown: 0.1505 }]), 3).detail).toContain("15.05%");
});

test("rule 4 fails when any pair misses half its signals, even if the total is fine", () => {
  expect(rule(six([{ missedEntries: 10, signals: 20 }]), 4).passes).toBe(false);
  expect(rule(six([{ missedEntries: 9, signals: 20 }]), 4).passes).toBe(true);
});

test("rule 5 needs 30 closed breakout trades across the six pairs", () => {
  expect(rule(six().map((p) => ({ ...p, breakoutTrades: 5 })), 5).passes).toBe(true);
  expect(rule(six().map((p) => ({ ...p, breakoutTrades: 4 })), 5).passes).toBe(false);
});

test("one failing rule fails the whole score and the others still report honestly", () => {
  const score = scoreAdoption(six([{ pair: "UNI-USD", breakoutMaxDrawdown: 0.2 }]));
  expect(score.passes).toBe(false);
  expect(score.rules.filter((r) => !r.passes).map((r) => r.n)).toEqual([3]);
});
