import { expect, test } from "bun:test";
import { jevAllowsEntry, MAX_POSITIONS, notionalUsd, SLOT_CAPS, tieRank } from "./portfolio";

test("notional is risk divided by stop plus cost, capped at 1500", () => {
  expect(notionalUsd(1000, 50)).toBeCloseTo(60 / 0.105, 6);
  expect(notionalUsd(10, 5)).toBe(1500);
});

test("tie order is A, C, B, D, E and slots sum to the book cap", () => {
  expect(tieRank("A")).toBeLessThan(tieRank("C"));
  expect(tieRank("C")).toBeLessThan(tieRank("B"));
  expect(tieRank("B")).toBeLessThan(tieRank("D"));
  expect(tieRank("D")).toBeLessThan(tieRank("E"));
  expect(SLOT_CAPS.A + SLOT_CAPS.B + SLOT_CAPS.C + SLOT_CAPS.D + SLOT_CAPS.E).toBe(11);
  expect(MAX_POSITIONS).toBe(8);
});

test("a Jev outage adds no trade", () => {
  const attempt = { classId: "A" as const, pair: "SYNTHETIC-USD", jevAvailable: false };
  expect(jevAllowsEntry(attempt, "required")).toBe(false);
  expect(jevAllowsEntry({ ...attempt, jevAvailable: true }, "required")).toBe(true);
  expect(jevAllowsEntry(attempt, "off")).toBe(true);
});
