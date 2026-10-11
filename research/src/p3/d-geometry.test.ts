import { expect, test } from "bun:test";
import { dCandidate, searchSwingTarget, swingFloor, swingStop } from "./d-geometry";

test("swing stop and target match the 87b35d0 geometry", () => {
  const stop = swingStop(100, 90, 4, 1.5);
  expect(stop).toEqual({ stop: 90, stopBps: 1000, swingDist: 10, atrDist: 6 });
  expect(searchSwingTarget(100, 90, 4, 105)).toBe(105);
  expect(searchSwingTarget(100, 90, 4, null)).toBe(140);
  expect(swingFloor(100, 90, 140).pass).toBe(true);
  expect(swingFloor(100, 90, 105).pass).toBe(false);
});

test("D candidates are counts of geometry that clears the floor, with no fill", () => {
  const candidate = dCandidate(100, 90, 4, null);
  expect(candidate?.target).toBe(140);
  expect(dCandidate(100, 90, 4, 105)).toBeNull();
  expect(dCandidate(100, null, 4, null)).toBeNull();
});
