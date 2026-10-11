import { expect, test } from "bun:test";
import { findBannedKeys } from "./banned";
import { tickReport } from "./tick";
import type { UsdSpotProduct } from "./products";

const stamp = {
  commitSha: "c".repeat(40),
  dataRootHash: null,
  createdAt: "2026-10-10T00:00:00.000Z",
  phaseId: "P1",
};

test("current tick is recorded and every product is flagged because history is absent", () => {
  const products: UsdSpotProduct[] = [
    { productId: "BTC-USD", base: "BTC", quote: "USD", status: "online", statusRaw: "online", tickSize: "0.01", tradingDisabled: false, listingDate: null },
    { productId: "LRC-USD", base: "LRC", quote: "USD", status: "delisted", statusRaw: "delisted", tickSize: "0.0001", tradingDisabled: true, listingDate: null },
  ];
  const report = tickReport(products, stamp);
  expect(report.flags.map((flag) => flag.tickSize)).toEqual(["0.01", "0.0001"]);
  expect(report.flags.every((flag) => flag.historyAvailable === false && flag.tickMayHaveChanged === true)).toBe(true);
  expect(findBannedKeys(report)).toEqual([]);
});
