/**
 * Stamp carried by every research artifact: code commit, data root hash
 * (null until the candle manifest exists), creation timestamp, and phase id.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ArtifactStamp {
  commitSha: string;
  dataRootHash: string | null;
  createdAt: string;
  phaseId: string;
}

export function stampArtifact(opts: {
  commitSha: string;
  dataRootHash?: string | null;
  createdAt?: Date;
  phaseId: string;
}): ArtifactStamp {
  if (opts.commitSha.trim() === "") throw new Error("commitSha is required");
  if (opts.phaseId.trim() === "") throw new Error("phaseId is required");
  const createdAt = (opts.createdAt ?? new Date()).toISOString();
  if (!createdAt.endsWith("Z")) throw new Error(`createdAt must be UTC, got ${createdAt}`);
  return {
    commitSha: opts.commitSha,
    dataRootHash: opts.dataRootHash ?? null,
    createdAt,
    phaseId: opts.phaseId,
  };
}

export function repoRoot(start: string = import.meta.dir): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repo root not found");
    dir = parent;
  }
}

export function gitCommitSha(cwd: string = repoRoot()): string {
  const proc = spawnSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" });
  if (proc.status !== 0) {
    throw new Error(proc.stderr?.trim() || "git rev-parse HEAD failed");
  }
  const sha = proc.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`unexpected commit sha ${sha}`);
  return sha;
}
