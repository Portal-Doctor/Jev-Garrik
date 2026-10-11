import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findBannedKeys } from "../data/banned";

test("the pre-hash geometry has no banned fields and was not tuned", () => {
  const doc = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "data", "reports", "p5-v31-geometry.json"), "utf8")) as {
    tuned: boolean;
    breadth: { entryDays: number; pausedDays: number; pausedShare: number; flag: boolean };
    momentum: { conditionDates: string[]; blockedDates: string[] };
    clusters: { monthCount: number; monthsAbove60: number; flag: boolean; months: { month: string; largestShare: number; largestAbove60: boolean }[] };
    maxOpen: null;
    maxOpenNote: string;
    commitSha: string;
    createdAt: string;
  };
  expect(findBannedKeys(doc)).toEqual([]);
  expect(doc.tuned).toBe(false);
  expect(doc.breadth.entryDays).toBe(334);
  expect(doc.breadth.pausedDays).toBe(222);
  expect(doc.breadth.pausedShare).toBeCloseTo(222 / 334, 10);
  expect(doc.breadth.flag).toBe(true);
  expect(doc.momentum.conditionDates).toEqual([]);
  expect(doc.momentum.blockedDates).toEqual([]);
  expect(doc.clusters.monthCount).toBe(11);
  expect(doc.clusters.monthsAbove60).toBe(1);
  expect(doc.clusters.flag).toBe(false);
  expect(doc.clusters.months.find((row) => row.month === "2026-03-01")?.largestAbove60).toBe(true);
  expect(doc.maxOpen).toBeNull();
  expect(doc.maxOpenNote).toBe("G2 concurrency measured in the post-hash rerun");
  expect(doc.commitSha).toBe("c48580363bcb4600512c4f7ac1564c482f8e52db");
  expect(doc.createdAt.endsWith("Z")).toBe(true);
});
