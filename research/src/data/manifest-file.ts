import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStamp } from "../manifest";
import { rootHash, type HashedFile } from "./hash";
import { writeJson } from "./io";
import { dataPaths } from "./paths";
import { sha256File } from "./store";
import { BAR_SEC } from "./time";

export const ROOT_HASH_INPUT = "sorted lines of relativePath TAB sha256 LF, UTF-8";

export const SNAPSHOT_FREEZE_REASON =
  "Owner decision (Brian, 2026-10-10 18:16 CT): P1 task 9, the 24h revision check, is dropped. This download is the final snapshot. The revision check is not an open item for the hash.";

export const SNAPSHOT_LIFT_REASON =
  "Owner correction (Brian, 2026-10-10): the earlier freeze only dropped the 24h revision check. It did not make the partial download final. Resume continues through the USD snapshot. The revision check stays dropped and is not an open item for the hash.";

/** Brian, 2026-10-10 20:19 CT, which is 2026-10-11 01:19Z. */
/** Brian approved D1-D5 at 8:50 PM CT on 2026-10-10, which is 01:50Z on 2026-10-11. */
export const D1_FREEZE_REASON =
  "Owner decision (Brian, 2026-10-10 20:50 CT (01:50Z)): D1 daily supplement frozen. Three years or since listing, ending 2026-10-11T00:00:00.000Z. Used only for warmup and listing dates before 2025-10-11. Not part of the 15m candle root.";

export const D2_LIFT_REASON =
  "Owner decision (Brian, 2026-10-10 20:50 CT (01:50Z)): D2 downloads the same 15m window (2025-10-11T00:00:00.000Z inclusive through 2026-10-11T00:00:00.000Z exclusive) for delisted products whose probe served candles and for names the owner cut dropped. Chained to the prior frozen root. The owner cut is not the trading universe.";

export const BELOW_RANK_CUTOFF_LIFT_REASON =
  "Owner decision (Brian, 2026-10-10 20:19 CT (01:19Z)): add back the 56 below-rank-cutoff names on the same 900-second window (2025-10-11T00:00:00.000Z inclusive through 2026-10-11T00:00:00.000Z exclusive). RESEARCH_LIFT_COMPLETED_FREEZE=1 is the guard change that allows this resume. Other cuts stay. Stats were not re-fetched.";

export interface SnapshotFreeze {
  status: "frozen";
  reason: string;
  downloadStartedAt: string;
  downloadUpdatedAt: string;
  frozenAt: string;
  universeComplete?: boolean;
  blocksResume?: boolean;
  supersededDataRootHash?: string | null;
}

export interface SnapshotLift {
  liftedAt: string;
  reason: string;
  supersededDataRootHash: string;
  supersededFrozenAt: string;
  supersededFileCount: number;
  /** Earlier lift, so a second owner resume keeps the chain. */
  priorSnapshotLift?: SnapshotLift;
}

export interface DataManifest extends ArtifactStamp {
  updatedAt: string;
  /** Set by refresh-reports. Never replaces commitSha or snapshot.frozenAt. */
  lastRefreshed?: { commit: string; at: string };
  hashAlgorithm: "sha256";
  rootHashInput: typeof ROOT_HASH_INPUT;
  bunVersion: string;
  writerVersion: "1";
  barSec?: number;
  files: HashedFile[];
  snapshot?: SnapshotFreeze;
  snapshotLift?: SnapshotLift;
  /** Pointer to the derived-bar manifest. Not part of the candle root hash. */
  derivedManifest?: {
    path: string;
    sha256: string;
    derivedRootHash: string;
    fileCount: number;
    bytes: number;
  };
  downloadRun?: { completedMonths: number; requests: number; stopped: string };
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
  barSec?: number;
  snapshotLift?: SnapshotLift;
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
    barSec: opts.barSec ?? BAR_SEC,
    ...(opts.snapshotLift ? { snapshotLift: opts.snapshotLift } : {}),
    files,
  };
}

export function writeDataManifest(dataDir: string, manifest: DataManifest): void {
  writeJson(dataPaths(dataDir).manifest, manifest);
}

/** Records the owner freeze. File hashes and the root hash stay as they are. */
export function sealFrozenSnapshot(
  manifest: DataManifest,
  frozenAt: Date,
  extra?: { universeComplete?: boolean; hardStop?: boolean; supersededDataRootHash?: string | null },
): DataManifest {
  const superseded = extra?.supersededDataRootHash ?? manifest.snapshotLift?.supersededDataRootHash ?? null;
  const supersededCount = manifest.snapshotLift?.supersededFileCount;
  const hardStop = extra?.hardStop === true;
  const completed = extra?.universeComplete === true && !hardStop;
  const priorRoot = manifest.snapshotLift?.priorSnapshotLift?.supersededDataRootHash;
  const countNote = supersededCount != null ? ` (${supersededCount} files)` : "";
  const supersededNote = priorRoot
    ? `Supersedes ${superseded ?? "none"}${countNote}. Prior root ${priorRoot} stays on snapshotLift.priorSnapshotLift.`
    : `Superseded partial 1m root ${superseded ?? "none"}${countNote}.`;
  return {
    ...manifest,
    snapshot: {
      status: "frozen",
      reason: hardStop
        ? `Frozen by owner decision at the 2026-10-11T01:40:00.000Z hard stop. Complete pair-month files only. ${supersededNote} The 24h revision check stays dropped and is not an open item for the hash.`
        : completed
          ? `Frozen by owner decision after the candle download completed. ${supersededNote} The 24h revision check stays dropped and is not an open item for the hash.`
          : SNAPSHOT_FREEZE_REASON,
      downloadStartedAt: manifest.createdAt,
      downloadUpdatedAt: manifest.updatedAt,
      frozenAt: frozenAt.toISOString(),
      ...(completed ? { universeComplete: true, supersededDataRootHash: superseded } : {}),
      ...(hardStop ? { blocksResume: true, universeComplete: false, supersededDataRootHash: superseded } : {}),
    },
  };
}

/**
 * Clears a completed freeze so an owner can add products.
 * The frozen root becomes snapshotLift, and any earlier lift is kept on priorSnapshotLift.
 */
export function liftCompletedFreeze(manifest: DataManifest, liftedAt: Date, reason: string): DataManifest {
  const snapshot = manifest.snapshot;
  if (snapshot?.status !== "frozen" || snapshot.universeComplete !== true) {
    throw new Error("completed freeze lift requires universeComplete");
  }
  if (manifest.dataRootHash == null) throw new Error("cannot lift a manifest with no root hash");
  const { snapshot: _removed, ...rest } = manifest;
  return {
    ...rest,
    snapshotLift: {
      liftedAt: liftedAt.toISOString(),
      reason,
      supersededDataRootHash: manifest.dataRootHash,
      supersededFrozenAt: snapshot.frozenAt,
      supersededFileCount: manifest.files.length,
      ...(manifest.snapshotLift ? { priorSnapshotLift: manifest.snapshotLift } : {}),
    },
  };
}

/** Clears an in-progress freeze so the download can resume. A completed universe stays frozen. */
export function liftInProgressFreeze(manifest: DataManifest, liftedAt: Date): DataManifest {
  const snapshot = manifest.snapshot;
  if (snapshot?.status !== "frozen") return manifest;
  if (snapshot.universeComplete) throw new Error("completed snapshot stays frozen");
  if (manifest.dataRootHash == null) throw new Error("cannot lift a manifest with no root hash");
  const supersededDataRootHash = manifest.dataRootHash;
  const { snapshot: _removed, ...rest } = manifest;
  return {
    ...rest,
    snapshotLift: {
      liftedAt: liftedAt.toISOString(),
      reason: SNAPSHOT_LIFT_REASON,
      supersededDataRootHash,
      supersededFrozenAt: snapshot.frozenAt,
      supersededFileCount: manifest.files.length,
    },
  };
}
