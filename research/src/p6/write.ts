/**
 * Guarded P6 writer. Production calls this. It checks git itself and the frozen
 * candle and derived roots. It refuses the registration, amendment 1, and the
 * approved amendment 2 record. The stamp is the caller's. Production passes
 * stampFromGit on the clean tree this function just checked.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
]);

export function assertP6Target(name: string): void {
  const base = name.split("/").pop() ?? name;
  if (FROZEN.has(base)) throw new Error(`refusing to overwrite ${base}`);
}

export function writeP6(
  path: string,
  body: Record<string, unknown>,
  opts: { stamp: ArtifactStamp; cwd?: string; sidecarLabel?: string },
): { sha256: string } {
  const cwd = opts.cwd ?? repoRoot();
  assertCleanWorkTree(cwd);
  if (opts.cwd == null) assertFrozenRoots(join(repoRoot(), "research/data"));
  assertP6Target(path);
  writeJson(path, { ...opts.stamp, ...body });
  const sha256 = createHash("sha256").update(readFileSync(path)).digest("hex");
  const base = path.split("/").pop() ?? path;
  const sidecar = path.endsWith(".json") ? `${path.slice(0, -5)}.sha256` : `${path}.sha256`;
  assertP6Target(sidecar);
  const label = opts.sidecarLabel ?? `research/data/reports/${base}`;
  writeFileSync(sidecar, `${sha256}  ${label}\n`);
  return { sha256 };
}
