import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { repoRoot } from "../manifest";

const COMMIT = "87b35d093710e3683d5910ee81bf7b1a46276bbc";
const FILES = ["swing.ts", "swing4h.ts", "position.ts", "fill.ts"];

test("vendored class D sources match the 87b35d0 blobs", () => {
  const cwd = repoRoot();
  for (const name of FILES) {
    const blob = spawnSync("git", ["rev-parse", `${COMMIT}:paperday/src/${name}`], { cwd, encoding: "utf8" });
    const local = spawnSync("git", ["hash-object", `research/vendor/87b35d0/${name}`], { cwd, encoding: "utf8" });
    expect(blob.status).toBe(0);
    expect(local.status).toBe(0);
    expect(local.stdout.trim()).toBe(blob.stdout.trim());
  }
});
