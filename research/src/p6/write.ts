/**
 * Guarded P6 writer. Production calls this. Paths stay inside this repo.
 * Frozen names are refused before the git check, so a dirty tree or another
 * worktree cannot overwrite them. The stamp is the caller's. Production passes
 * stampFromGit on the clean tree this function just checked.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { writeJson } from "../data/io";
import { assertFrozenRoots } from "../data/refresh";
import { assertCleanWorkTree, repoRoot, type ArtifactStamp } from "../manifest";

const FROZEN = new Set([
  "p5-v31-registration.json",
  "p5-v31-registration.sha256",
  "p4-amendment-1.json",
  "p4-amendment-1.sha256",
  "p4-registration.json",
  "p4-registration.sha256",
  "p5-registered.json",
  "p5-v31-results.json",
  "p5-v31-results.sha256",
  "p5-v31-geometry.json",
  "p5-v31-geometry.sha256",
  "p5-historical.json",
  "p6-amendment-2.json",
  "p6-amendment-2.sha256",
  "p6-kelly-ruling.json",
  "p6-kelly-ruling.sha256",
  "p6-amendment-2a.json",
  "p6-amendment-2a.sha256",
  "p6-amendment-2a-approval.json",
  "p6-amendment-2a-approval.sha256",
  "p6-kelly-status.json",
  "p6-kelly-status.sha256",
  "p6-amendment-2b.json",
  "p6-amendment-2b.sha256",
  "p6-amendment-2b-approval.json",
  "p6-amendment-2b-approval.sha256",
  "p6-jev-spend.json",
  "p6-jev-spend.sha256",
  "p6-b-sizing-check.json",
  "p6-b-sizing-check.sha256",
  "data-manifest.json",
  "derived-manifest.json",
]);

const FROZEN_DIRS = ["research/data/registration-sources/", "research/data/candles/", "research/data/daily/"];

export function assertP6Target(name: string): void {
  const base = name.split("/").pop() ?? name;
  if (FROZEN.has(base)) throw new Error(`refusing to overwrite ${base}`);
  const normalized = name.replaceAll("\\", "/");
  for (const dir of FROZEN_DIRS) {
    if (normalized.includes(dir)) throw new Error(`refusing to overwrite ${dir}`);
  }
}

/** Absolute path inside this repo, or a refusal. A throwaway worktree is not a target. */
export function assertInsideRepo(path: string): string {
  const root = resolve(repoRoot());
  const abs = resolve(path);
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === ".." || rel.includes(`..${sep}`)) {
    throw new Error(`refusing to write outside the repo root: ${path}`);
  }
  return abs;
}

export function writeP6(
  path: string,
  body: Record<string, unknown>,
  opts: { stamp: ArtifactStamp; sidecarLabel?: string },
): { sha256: string } {
  const abs = assertInsideRepo(path);
  assertP6Target(abs);
  const root = repoRoot();
  assertCleanWorkTree(root);
  assertFrozenRoots(joinData(root));
  writeJson(abs, { ...opts.stamp, ...body });
  const sha256 = createHash("sha256").update(readFileSync(abs)).digest("hex");
  const base = abs.split("/").pop() ?? abs;
  const sidecar = abs.endsWith(".json") ? `${abs.slice(0, -5)}.sha256` : `${abs}.sha256`;
  assertP6Target(sidecar);
  const label = opts.sidecarLabel ?? `research/data/reports/${base}`;
  writeFileSync(sidecar, `${sha256}  ${label}\n`);
  return { sha256 };
}

function joinData(root: string): string {
  return `${root}/research/data`;
}
