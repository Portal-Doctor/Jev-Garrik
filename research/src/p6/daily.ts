/**
 * Daily (D1) bytes. The parity record stores a hash of the sqlite files.
 * A missing month throws even when it is the first or last file on disk:
 * the inventory is the frozen daily manifest, not the gap between whatever
 * months happen to be present.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rootHash } from "../data/hash";
import { scanCandleFiles } from "../data/manifest-file";
import { repoRoot } from "../manifest";

const WIDE_PARITY_SHA = "c8e598b2abd31126f3cdf5197ff64592fb640b4ccc4fdbadc097cec9e97d1edd";
const CANDLE_STORE_HASH = "1ccc8879994d100896844b53a878e6570102046b35ebd6e40250857924eb30a8";

interface ManifestFile {
  path: string;
}

export function assertDailyInventory(dailyDir: string): void {
  const manifestPath = join(dailyDir, "data-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`missing data file ${manifestPath}`);
  const body = JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: ManifestFile[] };
  const files = body.files ?? [];
  if (files.length === 0) throw new Error(`missing data file ${manifestPath}`);
  for (const file of files) {
    if (!file.path) throw new Error(`missing data file ${manifestPath}`);
    const abs = join(dailyDir, file.path);
    if (!existsSync(abs)) throw new Error(`missing data file ${abs}`);
  }
}

/** Hash of the daily sqlite bytes. This does not copy the manifest's dataRootHash string. */
export function dailyByteHash(dailyDir: string): { dailyRootHash: string; files: number } {
  assertDailyInventory(dailyDir);
  const hashed = scanCandleFiles(dailyDir);
  if (hashed.length === 0) throw new Error(`missing data file ${join(dailyDir, "candles")}`);
  return { dailyRootHash: rootHash(hashed), files: hashed.length };
}

/**
 * Superseding parity record. The wide replay file is frozen, so the daily
 * byte hash is written here. A mismatch with the frozen daily manifest throws
 * before anything is written.
 */
export function d1ParityBody(root = repoRoot()): Record<string, unknown> {
  const dailyDir = join(root, "research/data/daily");
  const hashed = dailyByteHash(dailyDir);
  const manifest = JSON.parse(readFileSync(join(dailyDir, "data-manifest.json"), "utf8")) as { dataRootHash?: string };
  if (!manifest.dataRootHash || hashed.dailyRootHash !== manifest.dataRootHash) {
    throw new Error(`daily bytes ${hashed.dailyRootHash} do not match the frozen daily manifest ${manifest.dataRootHash ?? "missing"}`);
  }
  return {
    supersedes: "research/data/reports/p6-wide-parity.json",
    supersedesSha256: WIDE_PARITY_SHA,
    candleStoreHash: CANDLE_STORE_HASH,
    dailyRootHash: hashed.dailyRootHash,
    dailyFiles: hashed.files,
    dailyHashInput: "sha256 of each daily candles sqlite, then rootHash of sorted path TAB sha256 lines",
    missingMonth: "a path listed in research/data/daily/data-manifest.json and absent on disk throws missing data file",
  };
}
