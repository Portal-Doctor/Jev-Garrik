/**
 * Daily (D1) bytes. The parity record stores a hash of the sqlite files.
 * A missing month throws even when it is the first or last file on disk:
 * the inventory is the frozen daily manifest, not the gap between whatever
 * months happen to be present.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SourceDay } from "../p3/bar-access";
import { rootHash } from "../data/hash";
import { scanCandleFiles } from "../data/manifest-file";
import { readPairMonth } from "../data/store";
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

interface ManifestEntry {
  path: string;
  sha256?: string;
}

/**
 * Byte check of the daily store.
 * Full mode: every manifest path is present, every file's sha256 matches, and
 * the root hash is the bytes. Member mode is explicit: products outside
 * `members` (plus BTC-USD) may be absent, a corrupt or extra file still throws,
 * and the hash is only the verified member files.
 */
export function verifyDailyStore(dailyDir: string, members?: readonly string[]): { mode: "full" | "members"; dailyRootHash: string; files: number } {
  const manifestPath = join(dailyDir, "data-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`missing data file ${manifestPath}`);
  const body = JSON.parse(readFileSync(manifestPath, "utf8")) as { files?: ManifestEntry[] };
  const listed = body.files ?? [];
  if (listed.length === 0) throw new Error(`missing data file ${manifestPath}`);
  const expected = new Map<string, string>();
  for (const file of listed) {
    if (!file.path || !file.sha256) throw new Error(`missing data file ${manifestPath}`);
    expected.set(file.path, file.sha256);
  }
  const present = scanCandleFiles(dailyDir);
  const presentPaths = new Set<string>();
  for (const file of present) {
    presentPaths.add(file.path);
    const sha = expected.get(file.path);
    if (!sha) throw new Error(`daily file ${file.path} is not in the manifest`);
    if (file.sha256 !== sha) throw new Error(`daily bytes ${file.path} do not match the manifest`);
  }
  const missing = [...expected.keys()].filter((path) => !presentPaths.has(path));
  if (missing.length === 0) return { mode: "full", dailyRootHash: rootHash(present), files: present.length };
  if (!members) throw new Error(`missing data file ${join(dailyDir, missing[0]!)}`);
  const wanted = new Set([...members, "BTC-USD"]);
  for (const path of missing) {
    const product = path.split("/")[1] ?? "";
    if (wanted.has(product)) throw new Error(`missing data file ${join(dailyDir, path)}`);
  }
  const memberFiles = present.filter((file) => wanted.has(file.path.split("/")[1] ?? ""));
  if (memberFiles.length === 0) throw new Error(`missing data file ${join(dailyDir, "candles")}`);
  return { mode: "members", dailyRootHash: rootHash(memberFiles), files: memberFiles.length };
}

/** One product's daily sqlite history. An absent folder is an empty series, not a throw. */
export function readDailyHistory(dailyDir: string, productId: string): SourceDay[] {
  const folder = join(dailyDir, "candles", productId);
  if (!existsSync(folder)) return [];
  const names = readdirSync(folder).filter((name) => name.endsWith(".sqlite") && !name.endsWith(".partial.sqlite")).sort();
  const days: SourceDay[] = [];
  for (const name of names) {
    const rows = readPairMonth(join(folder, name)).rows;
    for (const row of rows) {
      const date = new Date(row.minuteSec * 1000).toISOString().slice(0, 10);
      if (row.empty || row.open == null || row.high == null || row.low == null || row.close == null) {
        days.push({ date, ts: row.minuteSec, open: 0, high: 0, low: 0, close: 0, volume: 0, empty: true });
        continue;
      }
      days.push({
        date,
        ts: row.minuteSec,
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        volume: Number(row.volume ?? 0),
        empty: false,
      });
    }
  }
  days.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return days;
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
