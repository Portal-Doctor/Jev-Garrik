import { test, expect } from "bun:test";
import { PairBook, summarizeTape } from "./feed";

test("book tracks best bid/ask, mid and spread; absolute quantities", () => {
  const b = new PairBook();
  b.set("bid", 99, 10);
  b.set("bid", 98, 5);
  b.set("offer", 101, 8);
  b.set("offer", 102, 4);
  expect(b.bestBid()).toBe(99);
  expect(b.bestAsk()).toBe(101);
  expect(b.mid()).toBe(100);
  expect(b.spreadBps()).toBeCloseTo(((101 - 99) / 100) * 10_000, 6); // 200 bps
  b.set("bid", 99, 0); // remove level
  expect(b.bestBid()).toBe(98);
});

test("depth bands accumulate cumulative size within each band of mid", () => {
  const b = new PairBook();
  b.set("bid", 100, 10); // 0 bps from a mid of ~100.05
  b.set("bid", 99.9, 5); // ~10 bps
  b.set("offer", 100.1, 7);
  b.set("offer", 100.6, 3); // ~55 bps, outside 50
  const d = b.depthBands([10, 25, 50]);
  expect(d["10bps"]!.bid).toBeGreaterThan(0);
  expect(d["50bps"]!.ask).toBe(7); // the 100.6 level is beyond 50 bps
  expect(d["50bps"]!.bid).toBe(15);
});

test("imbalance is signed and bounded", () => {
  const b = new PairBook();
  b.set("bid", 100, 30);
  b.set("offer", 100.2, 10);
  const imb = b.imbalance(0.01);
  expect(imb).toBeGreaterThan(0); // more bids than asks
  expect(imb).toBeLessThanOrEqual(1);
});

test("tape summary computes CVD from taker side over the window", () => {
  const now = 1_000_000;
  const tape = [
    { ts: now - 5_000, price: 100, size: 2, takerSide: "buy" as const },
    { ts: now - 4_000, price: 101, size: 1, takerSide: "sell" as const },
    { ts: now - 3_000, price: 102, size: 3, takerSide: "buy" as const },
    { ts: now - 120_000, price: 90, size: 9, takerSide: "sell" as const }, // outside 60s window
  ];
  const s = summarizeTape(tape, 60, now);
  expect(s.count).toBe(3);
  expect(s.buyBase).toBe(5);
  expect(s.sellBase).toBe(1);
  expect(s.cvdBase).toBe(4);
  expect(s.lastSide).toBe("buy");
  expect(s.vwap).toBeCloseTo((100 * 2 + 101 * 1 + 102 * 3) / 6, 6);
});
