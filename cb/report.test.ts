import { test, expect } from "bun:test";
import { wilson, brier, calibration, edgeBps, maxDrawdownPct, makerFeeSensitivity, pnlFromFills, takerFillShare, fmtHorizonCell, liveReportPairs } from "./report";
import type { FillRow } from "./db/store";

test("wilson interval brackets the point estimate and tightens with n", () => {
  const small = wilson(6, 10);
  const large = wilson(600, 1000);
  expect(small.p).toBeCloseTo(0.6, 9);
  expect(small.lower).toBeLessThan(small.p);
  expect(small.upper).toBeGreaterThan(small.p);
  expect(large.upper - large.lower).toBeLessThan(small.upper - small.lower); // more data, tighter
  expect(wilson(0, 0).lower).toBe(0);
});

test("brier is 0 for perfect calls and 0.25 for hedged 0.5 calls", () => {
  expect(brier([{ pBuy: 1, up: 1 }, { pBuy: 0, up: 0 }])).toBeCloseTo(0, 9);
  expect(brier([{ pBuy: 0.5, up: 1 }, { pBuy: 0.5, up: 0 }])).toBeCloseTo(0.25, 9);
});

test("calibration buckets predicted probability against realized frequency", () => {
  const pts = [
    { pBuy: 0.05, up: 0 },
    { pBuy: 0.08, up: 0 },
    { pBuy: 0.95, up: 1 },
    { pBuy: 0.92, up: 1 },
  ];
  const b = calibration(pts, 10);
  expect(b[0]!.n).toBe(2);
  expect(b[0]!.freq).toBe(0);
  expect(b[9]!.n).toBe(2);
  expect(b[9]!.freq).toBe(1);
});

test("edge is the mean signed move minus the round-trip cost", () => {
  const rows = [
    { action: "buy" as const, moveBps: 100 }, // +100
    { action: "sell" as const, moveBps: -60 }, // sell correct on a -60 move -> +60
  ];
  expect(edgeBps(rows, 140)).toBeCloseTo((100 + 60) / 2 - 140, 9); // 80 - 140 = -60
});

test("max drawdown is peak-to-trough as a fraction of bankroll", () => {
  expect(maxDrawdownPct([100, 110, 95, 105], 1000)).toBeCloseTo(((110 - 95) / 1000) * 100, 9); // 1.5%
  expect(maxDrawdownPct([], 1000)).toBe(0);
});

const fill = (over: Partial<FillRow>): FillRow => ({
  id: crypto.randomUUID(),
  run_id: "r",
  order_id: null,
  venue: "paper",
  external_id: crypto.randomUUID(),
  pair: "SOL-USD",
  side: "buy",
  price: 100,
  size_base: 1,
  notional_usd: 100,
  fee_usd: 0,
  liquidity: "maker",
  cost_basis_usd: 0,
  proceeds_usd: 0,
  source: "paper_sim",
  traded_at: 0,
  recorded_at: 0,
  ...over,
});

test("pnl split: gross is pre-fee, net subtracts fees and inference exactly once (closed round trip)", () => {
  const fills = [
    fill({ side: "buy", size_base: 1, notional_usd: 1000, fee_usd: 5 }),
    fill({ side: "sell", size_base: 1, notional_usd: 1100, fee_usd: 5.5 }),
  ];
  const p = pnlFromFills(fills, 0.2);
  expect(p.feesUsd).toBeCloseTo(10.5, 9);
  expect(p.grossUsd).toBeCloseTo(100, 9); // 1100 - 1000 price move, pre-fee
  expect(p.unrealizedUsd).toBe(0); // fully closed
  expect(p.netUsd).toBeCloseTo(1094.5 - 1005 - 0.2, 9); // 89.3
});

test("pnl split: an open position is marked at lastMid, not expensed as a realized loss (PL-REVENUE-REVIEW.md 2.2/3.5)", () => {
  const fills = [fill({ side: "buy", size_base: 10, notional_usd: 1000, fee_usd: 5 })]; // cost basis 1005, no exit
  const noMid = pnlFromFills(fills, 0, null);
  expect(noMid.unrealizedUsd).toBe(0); // unknown mark: valued at neither gain nor loss
  expect(noMid.netUsd).toBe(0); // NOT -1005, the old defect this replaces

  const atMid = pnlFromFills(fills, 0, 100); // flat mid: MTM should show only the entry fee drag
  expect(atMid.unrealizedUsd).toBeCloseTo(10 * 100 - 1005, 9); // -5
  expect(atMid.netUsd).toBeCloseTo(-5, 9);
});

test("taker fill share is the fraction of fills that were taker (instruments 3.4)", () => {
  const fills = [
    fill({ liquidity: "maker" }),
    fill({ liquidity: "maker" }),
    fill({ liquidity: "taker" }),
  ];
  expect(takerFillShare(fills)).toBeCloseTo(1 / 3, 9);
  expect(takerFillShare([])).toBe(0);
});

test("CLI horizon cells print 'pending' when n=0 instead of a literal zero (SENIOR-DEV-REPORT-2026-09-19.md item 4)", () => {
  expect(fmtHorizonCell(0, "0.0%")).toBe("pending");
  expect(fmtHorizonCell(0, "0.0000")).toBe("pending");
  expect(fmtHorizonCell(26, "72.4%")).toBe("72.4%");
  expect(fmtHorizonCell(1, "0.0%")).toBe("0.0%"); // n>0 with a genuinely-zero value is not "pending"
});

test("maker fee sensitivity recomputes maker fees, keeping taker fills fixed", () => {
  const fills = [
    fill({ side: "buy", liquidity: "maker", notional_usd: 1000, fee_usd: 5, cost_basis_usd: 1005 }),
    fill({ side: "sell", liquidity: "taker", notional_usd: 1000, fee_usd: 9, proceeds_usd: 991 }),
  ];
  const grid = makerFeeSensitivity(fills, [50, 0], 0);
  const at50 = grid.find((g) => g.makerBps === 50)!;
  const at0 = grid.find((g) => g.makerBps === 0)!;
  // gross = 1000(sell) - 1000(buy) = 0; taker fee 9 fixed.
  expect(at50.netUsd).toBeCloseTo(0 - 9 - (1000 * 50) / 10_000, 9); // -14
  expect(at0.netUsd).toBeCloseTo(0 - 9 - 0, 9); // -9, the maker leg is free
});

test("live report pairs are the intersection of venue history and config, never MON-USDC", () => {
  const history = ["DOGE-USD", "MON-USDC", "SOL-USD", "XRP-USD"];
  expect(liveReportPairs(history, ["SOL-USD"])).toEqual(["SOL-USD"]);
  expect(liveReportPairs(history, ["SOL-USD", "DOGE-USD"])).toEqual(["DOGE-USD", "SOL-USD"]);
  expect(liveReportPairs(["MON-USDC"], ["MON-USDC"])).toEqual([]);
});
