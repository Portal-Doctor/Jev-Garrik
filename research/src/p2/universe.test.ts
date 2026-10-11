import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { chooseVolumeTier, FIRST_UNIVERSE_DATE, memberPredicate, passCountFlag, volumeHysteresis, type VolumeTierDecision } from "./universe";

test("the first universe date is 2025-11-10 and stats are not an input", () => {
  const source = readFileSync(new URL("./universe.ts", import.meta.url), "utf8");
  expect(source.includes("product-stats.json")).toBe(false);
  expect(source.includes("owner-decision.json")).toBe(false);
  expect(source.includes("from \"../data/product-stats\"")).toBe(false);
  expect(FIRST_UNIVERSE_DATE).toBe("2025-11-10");
  const tier: VolumeTierDecision = {
    tier: "3M/2M",
    entryUsd: 3_000_000,
    exitUsd: 2_000_000,
    rebalanceDates: 1,
    datesWithAtLeast30: 0,
    share: 0,
  };
  expect(memberPredicate({
    date: "2025-11-09",
    listedDays: 400,
    excluded: false,
    liquidityPass: true,
    volumeUsd: 9_000_000,
    tier,
    inTier: true,
  })).toBe(false);
  expect(memberPredicate({
    date: "2025-11-10",
    listedDays: 400,
    excluded: false,
    liquidityPass: true,
    volumeUsd: 9_000_000,
    tier,
    inTier: true,
  })).toBe(true);
});

test("volume tier is 5M/3M only when 30 names clear on at least 80 percent of dates", () => {
  const high = chooseVolumeTier([40, 35, 31, 30, 10]);
  expect(high.tier).toBe("5M/3M");
  expect(high.rebalanceDates).toBe(5);
  const low = chooseVolumeTier([40, 10, 10, 10, 10]);
  expect(low.tier).toBe("3M/2M");
  expect(low.entryUsd).toBe(3_000_000);
});

test("volume membership keeps hysteresis and the pass-count flag uses 20 percent", () => {
  const tier = chooseVolumeTier([10]);
  expect(volumeHysteresis(false, 3_000_000, tier)).toBe(true);
  expect(volumeHysteresis(true, 2_500_000, tier)).toBe(true);
  expect(volumeHysteresis(true, 1_000_000, tier)).toBe(false);
  expect(passCountFlag([25, 25, 25, 25, 10]).flagged).toBe(false);
  expect(passCountFlag([25, 10, 10, 10, 10]).flagged).toBe(true);
});
