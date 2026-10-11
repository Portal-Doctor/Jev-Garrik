import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { repoRoot } from "../manifest";

const COMMIT = "87b35d093710e3683d5910ee81bf7b1a46276bbc";
const FILES = [
  "swing.ts",
  "swing4h.ts",
  "position.ts",
  "fill.ts",
  "indicators.ts",
  "rules.ts",
  "expectancy.ts",
  "fees.ts",
  "bias.ts",
  "clock.ts",
  "config.ts",
  "jev.ts",
] as const;

test("vendored class D sources match the 87b35d0 blobs", () => {
  const cwd = repoRoot();
  for (const name of FILES) {
    const blob = spawnSync("git", ["rev-parse", `${COMMIT}:paperday/src/${name}`], { cwd, encoding: "utf8" });
    if (blob.status !== 0) {
      throw new Error(
        `git rev-parse ${COMMIT}:paperday/src/${name} failed. The research workflow must fetch this commit before the tests.\n${blob.stderr}`,
      );
    }
    const local = spawnSync("git", ["hash-object", `research/vendor/87b35d0/${name}`], { cwd, encoding: "utf8" });
    expect(local.status).toBe(0);
    expect(local.stdout.trim()).toBe(blob.stdout.trim());
  }
});

test("CI fetches 87b35d0 before the research tests", () => {
  const workflow = readFileSync(new URL("../../../.github/workflows/research.yml", import.meta.url), "utf8");
  const fetchAt = workflow.indexOf("git fetch --depth=1 origin 87b35d093710e3683d5910ee81bf7b1a46276bbc");
  const testAt = workflow.indexOf("run: bun test research");
  expect(fetchAt).toBeGreaterThan(-1);
  expect(testAt).toBeGreaterThan(fetchAt);
});
