/**
 * Guarded P6 writer. Refuses a dirty tree, the registration, and amendment 1.
 * The stamp is the caller's. Production passes stampFromGit on a clean tree.
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { writeJson } from "../data/io";
import type { ArtifactStamp } from "../manifest";

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
]);

export function assertP6Target(name: string): void {
  const base = name.split("/").pop() ?? name;
  if (FROZEN.has(base)) throw new Error(`refusing to overwrite ${base}`);
}

export function writeP6(
  path: string,
  body: Record<string, unknown>,
  opts: { stamp: ArtifactStamp; dirty?: boolean; sidecarLabel?: string },
): { sha256: string } {
  if (opts.dirty) throw new Error("refusing to stamp a dirty git tree");
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
