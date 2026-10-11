import { expect, test } from "bun:test";
import { corwinSchultzBps, csMedianBps, EMPTY_LIQUIDITY, liquidityPasses, medianUsdWithGaps, stepLiquidity, type LiquiditySample } from "./liquidity";

const pass: LiquiditySample = { nonemptyShare: 1, medianUsd: 20_000, csMedianBps: 10 };
const between: LiquiditySample = { nonemptyShare: 0.98, medianUsd: 8_000, csMedianBps: 22 };
const fail: LiquiditySample = { nonemptyShare: 0.9, medianUsd: 1_000, csMedianBps: 40 };

test("liquidity legs use entry and exit hysteresis", () => {
  const entered = stepLiquidity(EMPTY_LIQUIDITY, pass);
  expect(liquidityPasses(entered)).toBe(true);
  const held = stepLiquidity(entered, between);
  expect(held).toEqual(entered);
  const exited = stepLiquidity(held, fail);
  expect(liquidityPasses(exited)).toBe(false);
  const stillOut = stepLiquidity(exited, between);
  expect(liquidityPasses(stillOut)).toBe(false);
});

test("a name between the thresholds does not enter", () => {
  expect(liquidityPasses(stepLiquidity(EMPTY_LIQUIDITY, between))).toBe(false);
});

test("a missing 15m bar counts as zero dollars in the median", () => {
  expect(medianUsdWithGaps([100], 3)).toBe(0);
  expect(medianUsdWithGaps([10, 20, 30, 40], 4)).toBe(25);
});

test("Corwin-Schultz is floored at 0 and the 30-day median has a 2 bp floor", () => {
  expect(corwinSchultzBps(1, 2, 1, 1)).toBe(0);
  expect(csMedianBps([0, 0, 0])).toBe(2);
  expect(csMedianBps([10, 30, 20])).toBe(20);
  expect(csMedianBps([])).toBeNull();
});
