import { test, expect } from "bun:test";
import { Accounting, feeUsd } from "./accounting";

test("feeUsd applies bps to notional", () => {
  expect(feeUsd(1000, 50)).toBeCloseTo(5, 9); // 0.50% maker
  expect(feeUsd(1000, 90)).toBeCloseTo(9, 9); // 0.90% taker
  expect(feeUsd(1000, 0)).toBe(0);
});

test("a maker-in / taker-out round trip nets price move minus both fees, counted once", () => {
  const a = new Accounting(10_000);
  // Enter long: buy 10 at 100, maker 50 bps.
  const buyNotional = 10 * 100;
  a.apply({ side: "buy", sizeBase: 10, notionalUsd: buyNotional, feeUsd: feeUsd(buyNotional, 50) });
  // Exit: sell 10 at 100 (flat price move), taker 90 bps.
  const sellNotional = 10 * 100;
  a.apply({ side: "sell", sizeBase: 10, notionalUsd: sellNotional, feeUsd: feeUsd(sellNotional, 90) });

  // No price move: realized is exactly the negative of the two fees (5 + 9).
  expect(a.realizedUsd).toBeCloseTo(-(5 + 9), 9);
  expect(a.feesUsd).toBeCloseTo(14, 9);
  expect(a.positionBase).toBe(0);
});

test("the fee tier changes the round-trip hurdle a move must beat", () => {
  const roundTrip = (makerBps: number, takerBps: number, notional: number) => feeUsd(notional, makerBps) + feeUsd(notional, takerBps);
  // Entry-tier US fees (50 maker / 90 taker) on $1,000: 5 + 9 = 14 -> 140 bps of the notional.
  expect(roundTrip(50, 90, 1000)).toBeCloseTo(14, 9);
  // A hypothetical maker-only 0 bps tier collapses the hurdle to just the taker exit.
  expect(roundTrip(0, 90, 1000)).toBeCloseTo(9, 9);
});
