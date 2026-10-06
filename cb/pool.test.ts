import { expect, test } from "bun:test";
import {
  MAX_CONCURRENT,
  POOL_TRIP_EQUITY,
  POOL_USD,
  compareRank,
  planRotation,
  poolDrawdownTripped,
  rankOf,
} from "./pool";

const base = {
  atr: 2,
  close: 110,
  prior20High: 100,
  ema: 105,
  emaPrev: 104,
};

test("a 2 ATR break ranks above a 0.5 ATR break when slope and MFE are equal", () => {
  const strong = rankOf({ ...base, close: 104, prior20High: 100, ema: 100, emaPrev: 100, atr: 2 });
  const weak = rankOf({ ...base, close: 101, prior20High: 100, ema: 100, emaPrev: 100, atr: 2 });
  expect(strong.breakQualityAtr).toBe(2);
  expect(weak.breakQualityAtr).toBe(0.5);
  expect(strong.emaSlopeAtr).toBe(0);
  expect(weak.emaSlopeAtr).toBe(0);
  expect(strong.openMfeAtr).toBe(0);
  expect(weak.openMfeAtr).toBe(0);
  expect(strong.rank).toBeGreaterThan(weak.rank);
});

test("open MFE adds ATR units and a broken trail ranks below every finite rank", () => {
  const open = rankOf({ ...base, fill: 100, highestCloseSinceEntry: 106, atr: 2, close: 100, prior20High: 100, ema: 100, emaPrev: 100 });
  expect(open.openMfeAtr).toBe(3);
  expect(open.rank).toBe(3);
  const broken = rankOf({ ...base, brokenTrail: true, fill: 100, highestCloseSinceEntry: 106 });
  expect(broken.rank).toBe(Number.NEGATIVE_INFINITY);
  expect(compareRank({ pair: "UNI-USD", rank: broken.rank, open: true }, { pair: "NEAR-USD", rank: -100, open: false })).toBeGreaterThan(0);
});

test("equal rank keeps the open slot, then sorts by pair name", () => {
  expect(compareRank({ pair: "UNI-USD", rank: 1, open: true }, { pair: "NEAR-USD", rank: 1, open: false })).toBeLessThan(0);
  expect(compareRank({ pair: "ARB-USD", rank: 1, open: false }, { pair: "ZEC-USD", rank: 1, open: false })).toBeLessThan(0);
});

test("flatten-to-fund drops the lowest-rank open for a higher-rank candidate", () => {
  const plan = planRotation({
    equityUsd: POOL_USD,
    cashUsd: 100,
    grossUsd: 1500,
    maxGrossUsd: 3000,
    maxConcurrent: MAX_CONCURRENT,
    makerFeeBps: 40,
    minSizeUsd: 25,
    names: [
      { pair: "UNI-USD", rank: 0.4, clipUsd: 600, open: true, candidate: false },
      { pair: "NEAR-USD", rank: 1.2, clipUsd: 300, open: true, candidate: false },
      { pair: "BCH-USD", rank: 0.9, clipUsd: 500, open: true, candidate: false },
      { pair: "ZEC-USD", rank: 2.5, clipUsd: 600, open: false, candidate: true },
    ],
  });
  expect(plan.halt).toBe(false);
  expect(plan.enter).toEqual([]);
  expect(plan.flatten).toEqual(["UNI-USD"]);
});

test("a higher-rank open is not flattened to fund a weaker candidate", () => {
  const plan = planRotation({
    equityUsd: POOL_USD,
    cashUsd: 100,
    grossUsd: 1500,
    maxGrossUsd: 3000,
    maxConcurrent: MAX_CONCURRENT,
    makerFeeBps: 40,
    minSizeUsd: 25,
    names: [
      { pair: "UNI-USD", rank: 3, clipUsd: 600, open: true, candidate: false },
      { pair: "NEAR-USD", rank: 2, clipUsd: 300, open: true, candidate: false },
      { pair: "BCH-USD", rank: 1.5, clipUsd: 500, open: true, candidate: false },
      { pair: "ZEC-USD", rank: 1.4, clipUsd: 600, open: false, candidate: true },
    ],
  });
  expect(plan.flatten).toEqual([]);
  expect(plan.enter).toEqual([]);
});

test("room under the concurrent cap enters without flattening", () => {
  const plan = planRotation({
    equityUsd: POOL_USD,
    cashUsd: 12_000,
    grossUsd: 600,
    maxGrossUsd: 3000,
    maxConcurrent: MAX_CONCURRENT,
    makerFeeBps: 40,
    minSizeUsd: 25,
    names: [
      { pair: "UNI-USD", rank: 1, clipUsd: 600, open: true, candidate: false },
      { pair: "ZEC-USD", rank: 2, clipUsd: 600, open: false, candidate: true },
    ],
  });
  expect(plan.flatten).toEqual([]);
  expect(plan.enter).toEqual(["ZEC-USD"]);
});

test("only one flatten-to-fund per plan", () => {
  const plan = planRotation({
    equityUsd: POOL_USD,
    cashUsd: 0,
    grossUsd: 1500,
    maxGrossUsd: 3000,
    maxConcurrent: MAX_CONCURRENT,
    makerFeeBps: 40,
    minSizeUsd: 25,
    names: [
      { pair: "UNI-USD", rank: 0.1, clipUsd: 600, open: true, candidate: false },
      { pair: "NEAR-USD", rank: 0.2, clipUsd: 300, open: true, candidate: false },
      { pair: "BCH-USD", rank: 0.3, clipUsd: 500, open: true, candidate: false },
      { pair: "ZEC-USD", rank: 4, clipUsd: 600, open: false, candidate: true },
      { pair: "SUI-USD", rank: 5, clipUsd: 400, open: false, candidate: true },
    ],
  });
  expect(plan.flatten).toEqual(["UNI-USD"]);
  expect(plan.enter).toEqual([]);
});

test("broken-trail opens flatten before a rotation is considered", () => {
  const plan = planRotation({
    equityUsd: POOL_USD,
    cashUsd: 12_000,
    grossUsd: 600,
    maxGrossUsd: 3000,
    maxConcurrent: MAX_CONCURRENT,
    makerFeeBps: 40,
    minSizeUsd: 25,
    names: [
      { pair: "UNI-USD", rank: Number.NEGATIVE_INFINITY, clipUsd: 600, open: true, candidate: false },
      { pair: "ZEC-USD", rank: 2, clipUsd: 600, open: false, candidate: true },
    ],
  });
  expect(plan.flatten).toEqual(["UNI-USD"]);
  expect(plan.enter).toEqual(["ZEC-USD"]);
});

test("equity at the $10,200 trip flattens all and later candidates cannot enter", () => {
  expect(poolDrawdownTripped(10_200.01)).toBe(false);
  expect(poolDrawdownTripped(10_200)).toBe(true);
  expect(POOL_TRIP_EQUITY).toBe(10_200);
  const tripped = planRotation({
    equityUsd: 10_200,
    cashUsd: 12_000,
    grossUsd: 0,
    maxGrossUsd: 3000,
    maxConcurrent: MAX_CONCURRENT,
    makerFeeBps: 40,
    minSizeUsd: 25,
    names: [
      { pair: "UNI-USD", rank: 1, clipUsd: 600, open: true, candidate: false },
      { pair: "ZEC-USD", rank: 9, clipUsd: 600, open: false, candidate: true },
    ],
  });
  expect(tripped.halt).toBe(true);
  expect(tripped.flatten).toEqual(["UNI-USD"]);
  expect(tripped.enter).toEqual([]);
  const after = planRotation({
    equityUsd: 11_000,
    cashUsd: 12_000,
    grossUsd: 0,
    maxGrossUsd: 3000,
    maxConcurrent: MAX_CONCURRENT,
    makerFeeBps: 40,
    minSizeUsd: 25,
    halted: true,
    names: [{ pair: "ZEC-USD", rank: 9, clipUsd: 600, open: false, candidate: true }],
  });
  expect(after.halt).toBe(true);
  expect(after.enter).toEqual([]);
});
