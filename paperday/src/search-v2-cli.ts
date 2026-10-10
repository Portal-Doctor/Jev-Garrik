/**
 * Grid v2 entry. `geometry` records the 6b drops and the hash.
 * `search` is the first step that computes P&L.
 */

import { runSearchV2, v2Paths, writeGeometry } from "./search/execute-v2";

const mode = process.argv[2] ?? "geometry";
if (mode === "geometry") {
  await writeGeometry(v2Paths());
} else if (mode === "search") {
  await runSearchV2(v2Paths());
} else {
  console.error("usage: bun run paperday/src/search-v2-cli.ts geometry|search");
  process.exit(1);
}
