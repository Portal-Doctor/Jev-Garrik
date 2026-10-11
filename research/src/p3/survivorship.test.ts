import { expect, test } from "bun:test";
import { survivorshipReport } from "./survivorship";

test("D2 replaces the download-scope label and still lists names with no candles", () => {
  const report = survivorshipReport({
    catalog: ["AAA-USD", "BBB-USD"],
    downloaded: ["AAA-USD"],
    reasonFor: () => "delisted-candles-not-served",
    d2Executed: true,
  });
  expect(report.label.includes("D2 executed")).toBe(true);
  expect(report.missing).toEqual([{ productId: "BBB-USD", reason: "delisted-candles-not-served" }]);
  const before = survivorshipReport({
    catalog: ["AAA-USD"],
    downloaded: [],
    reasonFor: () => "negligible-volume",
    d2Executed: false,
  });
  expect(before.label).toBe("survivorship from download scope");
});
