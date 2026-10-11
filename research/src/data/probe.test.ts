import { expect, test } from "bun:test";
import { findBannedKeys } from "./banned";
import { probeDelisted } from "./probe";
import type { UsdSpotProduct } from "./products";

const stamp = {
  commitSha: "e".repeat(40),
  dataRootHash: null,
  createdAt: "2026-10-10T00:00:00.000Z",
  phaseId: "P1",
};

function product(productId: string, statusRaw: string): UsdSpotProduct {
  return {
    productId,
    base: "X",
    quote: "USD",
    status: statusRaw === "delisted" ? "delisted" : statusRaw === "online" ? "online" : "other",
    statusRaw,
    tickSize: "0.01",
    tradingDisabled: statusRaw !== "online",
    listingDate: null,
  };
}

test("delisted probe records whether candles are served and makes no decision", async () => {
  const report = await probeDelisted({
    products: [product("BTC-USD", "online"), product("LRC-USD", "delisted"), product("OLD-USD", "offline")],
    now: new Date("2026-10-10T22:00:00.000Z"),
    stamp,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.includes("LRC-USD") && href.includes("start=1696118400")) {
        return new Response("[[1696118400, 0.2, 0.3, 0.2, 0.25, 10]]", { status: 200 });
      }
      return new Response("[]", { status: 200 });
    },
  });
  expect(report.products.map((row) => row.productId)).toEqual(["LRC-USD", "OLD-USD"]);
  expect(report.products.find((row) => row.productId === "LRC-USD")?.candlesServed).toBe(true);
  expect(report.products.find((row) => row.productId === "OLD-USD")?.candlesServed).toBe(false);
  expect(JSON.stringify(report)).not.toContain("survivor");
  expect(findBannedKeys(report)).toEqual([]);
});
