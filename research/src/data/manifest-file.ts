import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStamp } from "../manifest";
import { rootHash, type HashedFile } from "./hash";
import { writeJson } from "./io";
import { dataPaths } from "./paths";
import { sha256File } from "./store";

export const ROOT_HASH_INPUT = "sorted lines of relativePath TAB sha256 LF, UTF-8";

export const SNAPSHOT_FREEZE_REASON =
  "Owner decision (Brian, 2026-10-10 18:16 CT): P1 task 9, the 24h revision check, is dropped. This download is the final snapshot. The revision check is not an open item for the hash.";

export interface SnapshotFreeze {
  status: "frozen";
  reason: string;
  downloadStartedAt: string;
  downloadUpdatedAt: string;
  frozenAt: string;
}

export interface DataManifest extends ArtifactStamp {
  updatedAt: string;
  hashAlgorithm: "sha256";
  rootHashInput: typeof ROOT_HASH_INPUT;
  bunVersion: string;
  writerVersion: "1";
  files: HashedFile[];
  snapshot?: SnapshotFreeze;
}

export function scanCandleFiles(dataDir: string): HashedFile[] {
  const candles = dataPaths(dataDir).candles;
  if (!existsSync(candles)) return [];
  const files: HashedFile[] = [];
  for (const pair of readdirSync(candles).sort()) {
    const dir = join(candles, pair);
    if (!statSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!name.endsWith(".sqlite") || name.endsWith(".partial.sqlite")) continue;
      const rel = `candles/${pair}/${name}`;
      const abs = join(dataDir, rel);
      files.push({ path: rel, sha256: sha256File(abs), bytes: statSync(abs).size });
    }
  }
  return files;
}

export function buildDataManifest(opts: {
  stamp: ArtifactStamp;
  files: readonly HashedFile[];
  createdAt?: string;
  bunVersion?: string;
}): DataManifest {
  const files = opts.files.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    commitSha: opts.stamp.commitSha,
    dataRootHash: rootHash(files),
    createdAt: opts.createdAt ?? opts.stamp.createdAt,
    updatedAt: opts.stamp.createdAt,
    phaseId: opts.stamp.phaseId,
    hashAlgorithm: "sha256",
    rootHashInput: ROOT_HASH_INPUT,
    bunVersion: opts.bunVersion ?? Bun.version,
    writerVersion: "1",
    files,
  };
}

export function writeDataManifest(dataDir: string, manifest: DataManifest): void {
  writeJson(dataPaths(dataDir).manifest, manifest);
}

/** Records the owner freeze. File hashes and the root hash stay as they are. */
export function sealFrozenSnapshot(manifest: DataManifest, frozenAt: Date): DataManifest {
  return {
    ...manifest,
    snapshot: {
      status: "frozen",
      reason: SNAPSHOT_FREEZE_REASON,
      downloadStartedAt: manifest.createdAt,
      downloadUpdatedAt: manifest.updatedAt,
      frozenAt: frozenAt.toISOString(),
    },
  };
}
