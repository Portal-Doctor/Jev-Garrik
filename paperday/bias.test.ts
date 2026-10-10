import { expect, test } from "bun:test";
import { trendFromFourHour } from "../cb/trend";
import type { Candle } from "../cb/backtest";
import { biasFromFourHour } from "./src/bias";

function candles(closes: number[]): Candle[] {
  return closes.map((close, i) => ({ ts: i, open: close, high: close, low: close, close, volume: 1 }));
}

test("bias gate matches cb/trend.ts trendFromFourHour", () => {
  const samples = [
    [1, 1, 1, 1, 1, 1, 1],
    [10, 10, 10, 11, 12, 13, 14, 15, 16],
    [20, 19, 18, 17, 16, 15, 14, 13],
    [5, 5, 6, 6, 7, 8, 7, 9, 8, 10],
  ];
  for (const closes of samples) {
    const bars = candles(closes);
    const repo = trendFromFourHour(bars, 50);
    const paper = biasFromFourHour(closes.map((close) => ({ close })), 50);
    expect(paper.known).toBe(repo.known);
    expect(paper.up).toBe(repo.up);
    expect(paper.lastClose).toBe(repo.lastClose);
    expect(paper.ema).toBe(repo.ema);
  }
  expect(biasFromFourHour([{ close: 1 }, { close: 2 }], 50).known).toBe(false);
});
