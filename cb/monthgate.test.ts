import { expect, test } from "bun:test";
import { MISS_MONTHS_PER_YEAR, MONTHLY_TARGET_USD, scoreMonthlyGate } from "./monthgate";

test("the $300 target and two misses per year are constants", () => {
  expect(MONTHLY_TARGET_USD).toBe(300);
  expect(MISS_MONTHS_PER_YEAR).toBe(2);
});

test("Jul/Aug/Sep with one hit and two misses is still inside the annual miss budget", () => {
  const g = scoreMonthlyGate(
    [
      { month: "2026-07", netUsd: 400 },
      { month: "2026-08", netUsd: -10 },
      { month: "2026-09", netUsd: 0 },
    ],
    ["2026-07", "2026-08", "2026-09"],
  );
  expect(g.hits).toBe(1);
  expect(g.misses).toBe(2);
  expect(g.passes).toBe(true);
});

test("three miss months fail even with two misses allowed per year", () => {
  const g = scoreMonthlyGate(
    [
      { month: "2026-07", netUsd: 299.99 },
      { month: "2026-08", netUsd: 0 },
      { month: "2026-09", netUsd: -1 },
    ],
    ["2026-07", "2026-08", "2026-09"],
  );
  expect(g.hits).toBe(0);
  expect(g.misses).toBe(3);
  expect(g.passes).toBe(false);
});

test("a missing calendar month counts as a zero and therefore a miss", () => {
  const g = scoreMonthlyGate([{ month: "2026-07", netUsd: 1000 }], ["2026-07", "2026-08", "2026-09"]);
  expect(g.nets).toEqual([1000, 0, 0]);
  expect(g.hits).toBe(1);
  expect(g.misses).toBe(2);
});
