import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findBannedKeys } from "./banned";
import { buildCoverage } from "./coverage";
import type { UsdSpotProduct } from "./products";
import { writePairMonth, WRITER_VERSION } from "./store";

const stamp = {
  commitSha: "f".repeat(40),
    dataRootHash: "abc",
    createdAt: "2026-10-10T00:00:00.000Z",
    phaseId: "P1",
    barSec: 300,
  };

function product(productId: string, statusRaw: string): UsdSpotProduct {
  return {
    productId,
    base: productId.slice(0, productId.indexOf("-")),
    quote: "USD",
    status: statusRaw === "delisted" ? "delisted" : "online",
    statusRaw,
    tickSize: "0.01",
    tradingDisabled: statusRaw === "delisted",
    listingDate: null,
  };
}

test("coverage lists every snapshot product, including delisted, with the probe result", () => {
  const dir = mkdtempSync(join(tmpdir(), "research-cov-"));
  const start = Date.parse("2023-10-01T00:00:00.000Z") / 1000;
  writePairMonth(
    join(dir, "candles", "BTC-USD", "2023-10.sqlite"),
    {
      pair: "BTC-USD",
      month: "2023-10",
      windowStart: "2023-10-01T00:00:00.000Z",
      windowEnd: "2023-10-01T00:02:00.000Z",
      granularitySec: "60",
      emptyPolicy: "recorded-not-filled",
      writerVersion: WRITER_VERSION,
    },
    [
      { minuteSec: start, empty: false, open: "1", high: "1", low: "1", close: "1", volume: "1" },
      { minuteSec: start + 60, empty: true, open: null, high: null, low: null, close: null, volume: null },
    ],
  );
  const products = [product("BTC-USD", "online"), product("LRC-USD", "delisted")];
  const report = buildCoverage({
    products,
    probes: [
      { productId: "LRC-USD", status: "delisted", statusRaw: "delisted", candlesServed: true, windows: [] },
    ],
    dataDir: dir,
    stamp,
  });
  expect(report.productCount).toBe(2);
  expect(report.products.map((row) => row.productId)).toEqual(["BTC-USD", "LRC-USD"]);
  const btc = report.products[0];
  const lrc = report.products[1];
  expect(btc?.probe).toEqual({ sampled: false, candlesServed: null });
  expect(btc?.months[0]?.pctNonempty).toBe("50.0000");
  expect(btc?.firstNonemptyBar).toBe("2023-10-01T00:00:00.000Z");
  expect(btc?.effectiveListing).toBe("first available candle");
  expect(btc?.listingDate).toBeNull();
  expect(lrc?.effectiveListing).toBeNull();
  expect(lrc?.delisted).toBe(true);
  expect(lrc?.probe).toEqual({ sampled: true, candlesServed: true });
  expect(lrc?.months).toEqual([]);
  expect(findBannedKeys(report)).toEqual([]);
});
