import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { replayFrozenWindow, wideParityReport } from "./parity";

const candleRoot = fileURLToPath(new URL("../../data/candles", import.meta.url));
const dailyRoot = fileURLToPath(new URL("../../data/daily", import.meta.url));
/** 15m and daily bytes are gitignored. A checkout without them cannot claim parity. */
const frozenStore = existsSync(candleRoot) && existsSync(dailyRoot);

test.skipIf(!frozenStore)("seven frozen P5 days match the A20-k2 base book at $60", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../data/data-manifest.json", import.meta.url), "utf8")) as { dataRootHash: string };
  expect(manifest.dataRootHash).toBe("1ccc8879994d100896844b53a878e6570102046b35ebd6e40250857924eb30a8");
  const { diffs, published } = replayFrozenWindow();
  expect(published.map((trade) => `${trade.entryDate} ${trade.classId} ${trade.productId} ${trade.reason}`)).toEqual([
    "2025-11-11 A AERO-USD stop",
    "2025-11-17 B AERO-USD rule",
    "2025-11-17 B ICP-USD rule",
    "2025-11-17 B NEAR-USD rule",
    "2025-11-17 B UNI-USD rule",
  ]);
  expect(diffs).toEqual([]);
}, 60_000);

test.skipIf(!frozenStore)("six books match every non-window trade from 2025-11-11 through 2026-10-05", () => {
  const report = wideParityReport() as {
    storeHash: string;
    storeHashFiles: number;
    comparable: number;
    diffs: number;
    gapFillStops: number;
    exits: Record<string, number>;
    books: { book: string; diffs: number; comparable: number; aPublished: number; aCovered: number }[];
  };
  expect(report.storeHashFiles).toBeGreaterThan(0);
  expect(report.storeHash).toBe("1ccc8879994d100896844b53a878e6570102046b35ebd6e40250857924eb30a8");
  expect(report.comparable).toBe(338);
  expect(report.diffs).toBe(0);
  expect(report.books).toHaveLength(6);
  for (const book of report.books) {
    expect(book.diffs).toBe(0);
    expect(book.aCovered).toBe(book.aPublished);
  }
  expect(report.exits["A stop"]).toBeGreaterThan(0);
  expect(report.exits["A trail stop"]).toBeGreaterThan(0);
  expect(report.exits["A 10-day"]).toBeGreaterThan(0);
  expect(report.exits["A 30-day"]).toBeGreaterThan(0);
  expect(report.exits["B held-set"]).toBeGreaterThan(0);
  expect(report.exits["B disaster stop"]).toBeGreaterThan(0);
  expect(report.gapFillStops).toBe(0);
}, 300_000);

test("a checkout without the gitignored candle store does not invent a parity result", () => {
  const ignore = readFileSync(fileURLToPath(new URL("../../.gitignore", import.meta.url)), "utf8");
  expect(ignore).toContain("data/candles/");
  expect(ignore).toContain("data/daily/");
  if (!frozenStore) {
    expect(existsSync(candleRoot)).toBe(false);
  }
});
