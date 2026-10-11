import { expect, test } from "bun:test";
import { minutesForChunk, parseCandlePayload } from "./candles";
import { BAR_SEC } from "./time";

test("candle parser keeps JSON number lexemes and exchange column order", () => {
  const rows = parseCandlePayload("[[1704067200, 42261.58, 42351.1, 42288.58, 42300.78, 53.9337796]]");
  expect(rows).toEqual([
    {
      minuteSec: 1704067200,
      low: "42261.58",
      high: "42351.1",
      open: "42288.58",
      close: "42300.78",
      volume: "53.9337796",
    },
  ]);
});

test("bars outside the half-open chunk are dropped and missing bars stay empty", () => {
  const start = 1_700_001_000;
  const end = start + 3 * BAR_SEC;
  const candles = parseCandlePayload(`[
    [${start - BAR_SEC}, 1, 1, 1, 1, 1],
    [${start}, 1, 2, 1.5, 1.8, 3],
    [${end}, 9, 9, 9, 9, 9]
  ]`);
  const rows = minutesForChunk(start, end, candles);
  expect(rows).toHaveLength(3);
  expect(rows[0]?.empty).toBe(false);
  expect(rows[0]?.close).toBe("1.8");
  expect(rows[1]).toEqual({ minuteSec: start + BAR_SEC, empty: true, open: null, high: null, low: null, close: null, volume: null });
  expect(rows[2]?.empty).toBe(true);
  expect(rows.map((row) => row.close)).not.toContain("9");
});
