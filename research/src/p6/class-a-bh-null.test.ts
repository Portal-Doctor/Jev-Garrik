import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classABuyHoldSeries, type ClassABhInput } from "./class-a-paper";

interface BhCase {
  ref: [number, number, string[]][];
  carried: ClassABhInput;
  nulled: ClassABhInput;
}

test("null-candle buy-and-hold matches the reference, including halt cases 1-5", () => {
  const cases = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/bh-cases.json", import.meta.url)), "utf8")) as Record<string, BhCase>;
  const names = Object.keys(cases).sort();
  expect(names).toEqual(["1_halt_mid", "2_delist_day15", "3_delist_lowvol", "4_resume", "5_two_halt", "6_join_listing", "7_empty", "8_quant_fixture"]);
  for (const name of names) {
    const item = cases[name]!;
    for (const rep of ["carried", "nulled"] as const) {
      const series = classABuyHoldSeries(item[rep]);
      expect(series.length, `${name} ${rep} length`).toBe(item.ref.length);
      let maxGap = 0;
      for (let i = 0; i < series.length; i += 1) {
        maxGap = Math.max(maxGap, Math.abs(series[i]!.V - item.ref[i]![1]));
        expect(series[i]!.members.join(","), `${name} ${rep} t${series[i]!.t}`).toBe(item.ref[i]![2].join(","));
      }
      expect(maxGap, `${name} ${rep}`).toBeLessThan(1e-12);
    }
  }
});
