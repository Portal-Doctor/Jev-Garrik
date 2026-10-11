import { expect, test } from "bun:test";
import { assertScanSchema } from "./scan-schema";

test("the geometry scan accepts counts and rejects a banned field", () => {
  assertScanSchema({
    signalCounts: { A: 1 },
    stopWidths: { p50: 100 },
    btcFilterShares: { veto: 0.1 },
    universeSize: [{ date: "2025-11-10", names: 12 }],
    passCounts: [{ date: "2025-12-01", combined: 20 }],
  });
  expect(() => assertScanSchema({ signalCounts: { A: 1 }, forward: 1 })).toThrow(/banned fields/);
  expect(() => assertScanSchema({ pnl: 1 })).toThrow(/banned fields/);
});
