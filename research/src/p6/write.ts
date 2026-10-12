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
  "p4-approval.json",
  "p4-approval.sha256",
  "p5-v31-approval.json",
  "p5-v31-approval.sha256",
  "universe-membership.json",
  "universe-membership.sha256",
  "geometry-scan.json",
  "geometry-scan.sha256",
  "exclusion-proposal.json",
  "exclusion-proposal.sha256",
  "blackout-calendar.json",
  "blackout-calendar.sha256",
  "warmup-ledger.json",
  "warmup-ledger.sha256",
  "overlap-check.json",
  "overlap-check.sha256",
  "survivorship.json",
  "survivorship.sha256",
  "p1-report.json",
  "p1-report.sha256",
  "owner-decision.json",
  "owner-decision.sha256",
  "product-stats.json",
  "product-stats.sha256",
  "coverage.json",
  "coverage.sha256",
  "tick-size.json",
  "tick-size.sha256",
  "derived-roots.json",
  "derived-roots.sha256",
  "d2-names.json",
  "d2-names.sha256",
  "jev-smoke.json",
  "jev-smoke.sha256",
  "delisted-probe.json",
  "delisted-probe.sha256",
  "p3-handoff.json",
  "p3-handoff.sha256",
  "p6-jev-spend.json",
  "p6-jev-spend.sha256",
  "p6-b-sizing-check.json",
  "p6-b-sizing-check.sha256",
  "p6-forward-a.json",
  "p6-forward-a.sha256",
  "p6-kelly-superseding.json",
  "p6-kelly-superseding.sha256",
  "p6-wide-parity.json",
  "p6-wide-parity.sha256",
  "p6-d1-parity.json",
  "p6-d1-parity.sha256",
  "p6-kelly-ruling-superseded.json",
  "p6-kelly-ruling-superseded.sha256",
  "exchange-products.raw.json",
  "usd-spot.json",
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
