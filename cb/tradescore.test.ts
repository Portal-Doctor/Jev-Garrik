import { expect, test } from "bun:test";
import { closedTradeScore, rescaleDrawdown } from "./tradescore";
import { MAX_DRAWDOWN } from "./adoption";

test("closed-trade accuracy, Wilson, Brier, and edge come from the tape, not guesses", () => {
  const trades = [
    { openedTs: 1, closedTs: 2, netUsd: 10, entryNotionalUsd: 100, exitNotionalUsd: 110 },
    { openedTs: 3, closedTs: 4, netUsd: -10, entryNotionalUsd: 100, exitNotionalUsd: 90 },
  ];
  const s = closedTradeScore(trades, 1);
  expect(s.n).toBe(2);
  expect(s.accuracy).toBe(0.5);
  expect(s.wilson95!.lower).toBeLessThan(0.5);
  expect(s.wilson95!.upper).toBeGreaterThan(0.5);
  expect(s.brier).toBeCloseTo(0.5, 8);
  expect(s.edgeBps).toBeCloseTo(0, 8);
});

test("rescaling pair bankroll does not move the 15% drawdown limit", () => {
  expect(MAX_DRAWDOWN).toBe(0.15);
  expect(rescaleDrawdown(0.0822, 2_000, 750)).toBeCloseTo(0.2192, 4);
  expect(rescaleDrawdown(0.0822, 2_000, 750)! >= MAX_DRAWDOWN).toBe(true);
});
