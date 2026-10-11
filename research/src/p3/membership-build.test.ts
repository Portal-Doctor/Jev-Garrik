import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildMembership, type NameDateSample } from "./membership-build";

const passLiq = { nonemptyShare: 1, medianUsd: 20_000, csMedianBps: 10 };

test("the volume tier is chosen from the full monthly sample before any date is admitted", () => {
  const dates = ["2025-12-01", "2026-01-01", "2026-02-01", "2026-03-01", "2026-04-01"];
  const names = Array.from({ length: 30 }, (_, i) => `H${i}-USD`);
  const samplesFor = (date: string): NameDateSample[] => {
    const high = date === "2025-12-01";
    const rows = names.map((productId) => ({
      productId,
      volumeUsd: high ? 6_000_000 : 0,
      listedDays: 400,
      liquidity: passLiq,
    }));
    rows.push({ productId: "MID-USD", volumeUsd: 4_000_000, listedDays: 400, liquidity: passLiq });
    return rows;
  };
  const built = buildMembership({
    dates,
    monthlyDates: new Set(dates),
    excluded: new Set(),
    samplesFor,
  });
  expect(built.volumeTier.tier).toBe("3M/2M");
  expect(built.members.get("2025-12-01")?.has("MID-USD")).toBe(true);
  expect(built.above5m).toEqual([30, 0, 0, 0, 0]);
});

test("membership code does not read the stats snapshot or the owner cut", () => {
  for (const name of ["membership-build.ts", "geometry-run.ts"]) {
    const source = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    expect(source.includes("product-stats.json")).toBe(false);
    expect(source.includes("owner-decision.json")).toBe(false);
    expect(source.includes("from \"../data/product-stats\"")).toBe(false);
  }
});
