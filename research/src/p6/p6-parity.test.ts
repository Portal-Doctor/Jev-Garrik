import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { replayFrozenWindow } from "./parity";

test("seven frozen P5 days match the A20-k2 base book at $60", () => {
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
