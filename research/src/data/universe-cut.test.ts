import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoBannedKeys, findBannedKeys } from "./banned";
import { sha256Text } from "./hash";
import { parseProductStats } from "./product-stats";
import { applyUniverseCut, GRANULARITY_DECIDED_AT, READDED_BELOW_RANK_CUTOFF } from "./universe-cut";

test("24h OHLC keys are allowed on stats and a forward field is not", () => {
  const ohlc = { open: "1", high: "1.1", low: "0.9", last: "1", volume_30day: "10" };
  expect(findBannedKeys(ohlc)).toEqual([]);
  assertNoBannedKeys(ohlc, "ohlc");
  expect(() => assertNoBannedKeys({ forward: "1" }, "stats")).toThrow(/banned fields/);
});

test("the cut on the committed stats snapshot keeps 360 and drops 132", () => {
  const text = readFileSync(join(import.meta.dir, "..", "..", "data", "reports", "product-stats.json"), "utf8");
  const stats = parseProductStats(text);
  const decision = applyUniverseCut(stats);
  const cut = decision.entries[2];
  expect(cut.owner).toBe("Brian");
  expect(decision.entries[0].decidedAt).toBe(GRANULARITY_DECIDED_AT);
  expect(decision.entries[0].decidedAt > "2026-10-10T23:45:34.000Z").toBe(true);
  expect(decision.entries[1].decidedAt).toBe("2026-10-10T23:38:00.000Z");
  expect(decision.entries.map((entry) => entry.owner)).toEqual(["Brian", "Brian", "Brian", "Brian"]);
  expect(cut.kept).toHaveLength(360);
  expect(cut.dropped).toHaveLength(132);
  expect(cut.readded.map((row) => row.productId)).toEqual([...READDED_BELOW_RANK_CUTOFF]);
  expect(new Set(cut.dropped.map((row) => row.reason)).has("below-rank-cutoff")).toBe(false);
  expect(sha256Text(`${cut.kept.join("\n")}\n`)).toBe("563cd584c8760da171efee3aa7878cbd46ceb3f9894262c9e673e408af798efe");
  expect(sha256Text(`${cut.dropped.map((row) => row.productId).join("\n")}\n`)).toBe(
    "b73b371188bd09b02962e4c27ced0d1d2c657505bc82004f4e69aaea8dd53c8d",
  );
  expect(findBannedKeys(decision)).toEqual([]);
});

test("a synthetic book applies non-200, volume, flat, and erratic cuts", () => {
  const decision = applyUniverseCut({
    fetchedAt: "2026-10-11T00:00:00.000Z",
    fetchedAtNote: "fixture",
    endpoint: "https://api.exchange.coinbase.com/products/{productId}/stats",
    ohlcNote: "24h OHLC for the cut only",
    products: [
      { productId: "DEAD-USD", status: "delisted", httpStatus: 400, stats: null, error: "no" },
      { productId: "TINY-USD", status: "online", httpStatus: 200, stats: { high: "1.01", low: "1", last: "1", volume_30day: "10" }, error: null },
      { productId: "FLAT-USD", status: "online", httpStatus: 200, stats: { high: "1.001", low: "1", last: "1", volume_30day: "5000000" }, error: null },
      { productId: "WILD-USD", status: "online", httpStatus: 200, stats: { high: "2", low: "1", last: "1", volume_30day: "5000000" }, error: null },
      { productId: "OK-USD", status: "online", httpStatus: 200, stats: { high: "1.1", low: "1", last: "1", volume_30day: "5000000" }, error: null },
    ],
  });
  const cut = decision.entries[2];
  expect(cut.dropped.map((row) => `${row.productId}:${row.reason}`)).toEqual([
    "DEAD-USD:no-30-day-stats",
    "FLAT-USD:flat-price",
    "TINY-USD:negligible-volume",
    "WILD-USD:erratic-price",
  ]);
  expect(cut.kept).toEqual(["OK-USD"]);
});
