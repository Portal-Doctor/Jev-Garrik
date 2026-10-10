/**
 * Pre-registered walk-forward search.
 * Usage: bun run paperday/src/search-cli.ts
 * The grid hash is locked before any engine call. The holdout opens once.
 */

import { join } from "node:path";
import { runSearch } from "./search/execute";

const root = join(import.meta.dir, "..");

const report = await runSearch({
  gridPath: join(root, "search", "grid-v1.json"),
  manifestPath: join(root, "results", "search-manifest.json"),
  checkpointPath: join(root, "results", "search-v1-runs.jsonl"),
  lockPath: join(root, "results", "holdout-open.json"),
  reportPath: join(root, "results", "search-v1.md"),
  rawPath: join(root, "results", "search-v1.json"),
  cacheDir: join(root, "cache", "candles"),
});

console.log(`selected ${report.selected?.score.id ?? "null"}`);
console.log(`grid ${report.gridHash} configs ${report.configCount}`);
console.log(report.coverage.reason ?? "jev executed");
