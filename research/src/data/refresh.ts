import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rootHash } from "./hash";
import { scanDerivedFiles } from "./derived-manifest";
import { scanCandleFiles, type DataManifest } from "./manifest-file";
import { dataPaths } from "./paths";

export interface RefreshStamp {
  commit: string;
  at: string;
}

/**
 * Checks the frozen candle root and the derived root before any refresh write.
 * An empty directory, a missing manifest, or a hash mismatch throws.
 */
export function assertFrozenRoots(dataDir: string): { manifest: DataManifest; derivedRootHash: string } {
  const paths = dataPaths(dataDir);
  const derivedPath = join(dataDir, "derived-manifest.json");
  if (!existsSync(paths.manifest) || !existsSync(derivedPath)) {
    throw new Error("refusing to refresh: candle or derived manifest is missing");
  }
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest;
  const derived = JSON.parse(readFileSync(derivedPath, "utf8")) as { derivedRootHash?: string };
  if (!manifest.dataRootHash || !derived.derivedRootHash) {
    throw new Error("refusing to refresh: a frozen root is missing");
  }
  const candles = scanCandleFiles(dataDir);
  if (candles.length === 0 || rootHash(candles) !== manifest.dataRootHash) {
    throw new Error("refusing to refresh: candle files are missing or do not match the frozen root");
  }
  const derivedFiles = scanDerivedFiles(dataDir);
  if (derivedFiles.length === 0 || rootHash(derivedFiles) !== derived.derivedRootHash) {
    throw new Error("refusing to refresh: derived files are missing or do not match the frozen root");
  }
  return { manifest, derivedRootHash: derived.derivedRootHash };
}

/**
 * Candle files must exist and match the frozen root. Does not check derived files.
 * A completed freeze is left unread by callers that must not restamp it.
 */
export function assertCandleRoot(dataDir: string): DataManifest {
  const paths = dataPaths(dataDir);
  if (!existsSync(paths.manifest)) throw new Error("refusing to write: candle manifest is missing");
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest;
  if (!manifest.dataRootHash || manifest.snapshot?.status !== "frozen" || !manifest.snapshot.universeComplete) {
    throw new Error("refusing to write: snapshot is not a completed freeze");
  }
  const candles = scanCandleFiles(dataDir);
  if (candles.length === 0 || rootHash(candles) !== manifest.dataRootHash) {
    throw new Error("refusing to write: candle files are missing or do not match the frozen root");
  }
  return manifest;
}

/** Records a refresh without changing the freeze commit or frozenAt. */
export function withLastRefreshed(manifest: DataManifest, refresh: RefreshStamp): DataManifest {
  const commitSha = manifest.commitSha;
  const frozenAt = manifest.snapshot?.frozenAt;
  const next: DataManifest = { ...manifest, lastRefreshed: refresh };
  if (next.commitSha !== commitSha) throw new Error("refresh changed the frozen commit");
  if ((next.snapshot?.frozenAt ?? undefined) !== frozenAt) throw new Error("refresh changed frozenAt");
  return next;
}
