import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MinuteRow } from "./candles";
import { readPairMonth, sha256File, writePairMonth, WRITER_VERSION } from "./store";

const rows: MinuteRow[] = [
  { minuteSec: 1_700_000_000, empty: false, open: "1.5", high: "2", low: "1", close: "1.8", volume: "3.25" },
  { minuteSec: 1_700_000_060, empty: true, open: null, high: null, low: null, close: null, volume: null },
];

test("pair-month files are byte-stable and keep empty minutes empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "research-store-"));
  const meta = {
    pair: "BTC-USD",
    month: "2023-11",
    windowStart: "2023-11-14T22:13:20.000Z",
    windowEnd: "2023-11-14T22:15:20.000Z",
    granularitySec: "60" as const,
    emptyPolicy: "recorded-not-filled" as const,
    writerVersion: WRITER_VERSION,
  };
  const a = join(dir, "a.sqlite");
  const b = join(dir, "b.sqlite");
  writePairMonth(a, meta, rows);
  writePairMonth(b, meta, rows.slice().reverse());
  expect(sha256File(a)).toBe(sha256File(b));
  const stored = readPairMonth(a);
  expect(stored.rows[1]).toEqual(rows[1]);
  expect(stored.rows[0]?.close).toBe("1.8");
});
