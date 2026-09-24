import { test, expect } from "bun:test";
import { KillSwitch } from "./kill";

test("a daily loss through the limit blocks new entries", () => {
  const k = new KillSwitch();
  const t0 = Date.UTC(2026, 8, 20, 12);
  k.recordUsd(-100, t0);
  expect(k.blocked(t0)).toBeNull();
  k.recordUsd(-2000, t0);
  expect(k.blocked(t0)).toContain("daily loss");
});

test("the UTC day roll clears the daily tally", () => {
  const k = new KillSwitch();
  const day1 = Date.UTC(2026, 8, 20, 23);
  const day2 = Date.UTC(2026, 8, 21, 1);
  k.recordUsd(-2000, day1);
  expect(k.blocked(day1)).toContain("daily loss");
  expect(k.blocked(day2)).toBeNull();
});
