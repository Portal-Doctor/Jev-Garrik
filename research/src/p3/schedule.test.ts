import { expect, test } from "bun:test";
import { foldStartDates, isOosDate, membershipDates, monthlyRebalanceDates, OVERLAP_TOLERANCE, OVERLAP_TOLERANCE_RECORDED_AT } from "./schedule";

test("D3(b) has eleven monthly rebalance dates and eight OOS months after 2025-11-10", () => {
  expect(monthlyRebalanceDates()[0]).toBe("2025-12-01");
  expect(monthlyRebalanceDates()).toHaveLength(11);
  expect(foldStartDates()).toHaveLength(9);
  expect(membershipDates()[0]).toBe("2025-11-10");
  expect(isOosDate("2026-02-10")).toBe(true);
  expect(isOosDate("2026-02-09")).toBe(false);
  expect(isOosDate("2025-11-10")).toBe(false);
  expect(OVERLAP_TOLERANCE.recordedAt).toBe(OVERLAP_TOLERANCE_RECORDED_AT);
  expect(OVERLAP_TOLERANCE.confirmed).toBe(false);
  expect(Date.parse(OVERLAP_TOLERANCE_RECORDED_AT)).toBeLessThan(Date.parse("2026-10-11T02:05:00.000Z"));
});
