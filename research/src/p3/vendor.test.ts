import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../manifest";

/**
 * Blob ids from `git rev-parse 87b35d093710e3683d5910ee81bf7b1a46276bbc:paperday/src/<file>`.
 * Pinned so a shallow CI checkout does not have to contain that commit.
 */
const BLOBS = {
  "swing.ts": "59019571745d0a7d3eafd27ffd47b98676ec5336",
  "swing4h.ts": "0448c5b6394a84207842dd9353d574faa44959df",
  "position.ts": "fa69b62f1a65469849bfb98250a8654a996920a2",
  "fill.ts": "c52ffb2288a9fbe9b95d0020145222e459428245",
} as const;

test("vendored class D sources match the 87b35d0 blobs", () => {
  const cwd = repoRoot();
  for (const [name, expected] of Object.entries(BLOBS)) {
    const local = spawnSync("git", ["hash-object", `research/vendor/87b35d0/${name}`], { cwd, encoding: "utf8" });
    expect(local.status).toBe(0);
    expect(local.stdout.trim()).toBe(expected);
  }
});
