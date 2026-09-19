import { test, expect } from "bun:test";
import { Accounting, feeUsd } from "./accounting";

const buy = (sizeBase: number, price: number, bps: number) => ({
  side: "buy" as const,
  sizeBase,
  notionalUsd: sizeBase * price,
  feeUsd: feeUsd(sizeBase * price, bps),
});
const sell = (sizeBase: number, price: number, bps: number) => ({
  side: "sell" as const,
  sizeBase,
  notionalUsd: sizeBase * price,
  feeUsd: feeUsd(sizeBase * price, bps),
});

test("flat position has no basis, entry or unrealized", () => {
  const a = new Accounting(10_000);
  expect(a.positionBase).toBe(0);
  expect(a.entryPrice()).toBeNull();
  expect(a.unrealized(100)).toBe(0);
  expect(a.equity(100)).toBe(10_000);
});

test("buy sets a fee-inclusive cost basis and average entry", () => {
  const a = new Accounting(10_000);
  a.apply(buy(10, 100, 50)); // notional 1000, fee 5
  expect(a.positionBase).toBe(10);
  expect(a.costBasisUsd).toBeCloseTo(1005, 9);
  expect(a.entryPrice()).toBeCloseTo(100.5, 9);
  // mark flat at entry price: unrealized equals the negative of fees paid so far
  expect(a.unrealized(100)).toBeCloseTo(-5, 9);
});

test("full close realizes proceeds minus cost basis exactly once", () => {
  const a = new Accounting(10_000);
  a.apply(buy(10, 100, 50)); // cost basis 1005
  a.apply(sell(10, 110, 50)); // notional 1100, fee 5.5, proceeds 1094.5
  expect(a.positionBase).toBe(0);
  expect(a.costBasisUsd).toBe(0);
  expect(a.realizedUsd).toBeCloseTo(1094.5 - 1005, 9); // 89.5
  expect(a.equity(110)).toBeCloseTo(10_000 + 89.5, 9);
  expect(a.feesUsd).toBeCloseTo(10.5, 9);
});

test("partial close uses weighted-average cost and leaves the remainder open", () => {
  const a = new Accounting(10_000);
  a.apply(buy(10, 100, 0)); // basis 1000, avg 100
  a.apply(buy(10, 120, 0)); // basis 2200, avg 110 over 20
  a.apply(sell(5, 130, 0)); // proceeds 650, closed cost 5*110 = 550
  expect(a.positionBase).toBe(15);
  expect(a.entryPrice()).toBeCloseTo(110, 9);
  expect(a.realizedUsd).toBeCloseTo(100, 9);
  expect(a.costBasisUsd).toBeCloseTo(15 * 110, 9);
});

test("long/flat invariant: a sell never drives the position negative", () => {
  const a = new Accounting(10_000);
  a.apply(buy(5, 100, 0));
  a.apply(sell(10, 100, 0)); // only 5 held, only 5 closes
  expect(a.positionBase).toBe(0);
  expect(a.costBasisUsd).toBe(0);
  expect(a.realizedUsd).toBeCloseTo(0, 9);
});

test("inference cost reduces equity without touching realized", () => {
  const a = new Accounting(10_000);
  a.addInference(0.25);
  expect(a.realizedUsd).toBe(0);
  expect(a.equity(100)).toBeCloseTo(9_999.75, 9);
});

test("cashUsd is the bankroll flat, and drops by the cost basis while a position is open", () => {
  const a = new Accounting(2_500);
  expect(a.cashUsd()).toBe(2_500); // flat: all cash free
  a.apply(buy(10, 100, 50)); // cost basis 1005 tied up
  expect(a.cashUsd()).toBeCloseTo(2_500 - 1005, 9); // 1495, not the full bankroll
  a.apply(sell(10, 110, 50)); // closes fully, realizes 89.5
  expect(a.cashUsd()).toBeCloseTo(2_500 + 89.5, 9); // cash is free again, plus the gain
});

test("cashUsd falls with realized losses and inference cost, independent of mark-to-market", () => {
  const a = new Accounting(2_500);
  a.apply(buy(10, 100, 90)); // cost basis 1009
  a.apply(sell(10, 90, 90)); // a losing round trip
  a.addInference(0.1);
  expect(a.cashUsd()).toBeCloseTo(2_500 + a.realizedUsd - 0.1, 9);
  expect(a.cashUsd()).toBeLessThan(2_500); // confirms losses actually reduce spendable cash
});
