import { expect, test } from "bun:test";
import { HISTORICAL_ENTRY_MODES, intrabarFill, trailAfterCompletedBar } from "./fills";

test("a 15m bar that touches stop and target fills the stop first", () => {
  const both = intrabarFill({ open: 100, high: 110, low: 90, close: 100 }, 95, 105);
  expect(both).toEqual({ kind: "stop", price: 95 });
  const gap = intrabarFill({ open: 90, high: 110, low: 89, close: 100 }, 95, 105);
  expect(gap).toEqual({ kind: "stop", price: 90 });
  const target = intrabarFill({ open: 100, high: 110, low: 96, close: 108 }, 95, 105);
  expect(target).toEqual({ kind: "target", price: 105 });
});

test("trails move only after a bar completes, and only upward", () => {
  expect(trailAfterCompletedBar(90, 100, 2)).toBe(94);
  expect(trailAfterCompletedBar(94, 95, 2)).toBe(94);
});

test("historical entry modes are X1 only", () => {
  expect([...HISTORICAL_ENTRY_MODES]).toEqual(["X1"]);
  expect(JSON.stringify(HISTORICAL_ENTRY_MODES).includes("X2")).toBe(false);
  expect(JSON.stringify(HISTORICAL_ENTRY_MODES).includes("X3")).toBe(false);
});
