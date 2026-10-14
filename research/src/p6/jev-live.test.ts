import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { JEV_BUILD_CAP_USD, jevSpendFromFile } from "./jev-live";

const receiptPath = fileURLToPath(new URL("../../data/reports/p6-jev-spend.json", import.meta.url));

test("the one P6 Jev call is the recorded synthetic receipt", () => {
  expect(existsSync(receiptPath)).toBe(true);
  const spend = jevSpendFromFile(receiptPath);
  expect(spend).not.toBeNull();
  expect(spend!.calls).toBe(1);
  expect(spend!.synthetic).toBe(true);
  expect(spend!.modelId.length).toBeGreaterThan(0);
  expect(spend!.totalTokens).toBeGreaterThan(0);
  expect(spend!.costUsd).toBeGreaterThan(0);
  expect(spend!.costUsd!).toBeLessThanOrEqual(JEV_BUILD_CAP_USD);
});
