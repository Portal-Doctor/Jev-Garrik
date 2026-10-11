import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { ArtifactStamp } from "../manifest";
import { rootHash, type HashedFile } from "./hash";
import { sha256File } from "./store";

export interface DerivedManifest extends ArtifactStamp {
  derivedRootHash: string;
  files: HashedFile[];
}

export function scanDerivedFiles(dataDir: string): HashedFile[] {
  const root = join(dataDir, "derived");
  if (!existsSync(root)) return [];
  const files: HashedFile[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const path = relative(dataDir, abs).split(sep).join("/");
      files.push({ path, sha256: sha256File(abs), bytes: statSync(abs).size });
    }
  };
  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

export function buildDerivedManifest(opts: { stamp: ArtifactStamp; dataDir: string }): DerivedManifest {
  const files = scanDerivedFiles(opts.dataDir);
  return {
    commitSha: opts.stamp.commitSha,
    dataRootHash: opts.stamp.dataRootHash,
    createdAt: opts.stamp.createdAt,
    phaseId: opts.stamp.phaseId,
    derivedRootHash: rootHash(files),
    files,
  };
}
