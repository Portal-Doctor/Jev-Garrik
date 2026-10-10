/** Unused. Owner dropped P1 task 9 on 2026-10-10. Do not schedule a re-download comparison. */

import type { ArtifactStamp } from "../manifest";
import type { HashedFile } from "./hash";

export const REVISION_FRACTION = 0.02;
export const REVISION_WAIT_MS = 24 * 60 * 60 * 1000;

export interface RevisionFile {
  path: string;
  sha256: string;
}

export interface RevisionSample extends ArtifactStamp {
  status: "pending" | "empty";
  fraction: typeof REVISION_FRACTION;
  rounding: "floor(population * fraction)";
  seed: string;
  population: number;
  sampleCount: number;
  earliestCompareAt: string | null;
  files: RevisionFile[];
  mismatches: null;
}

export interface RevisionCheck {
  status: "pending" | "complete";
  compared: boolean;
  earliestCompareAt: string | null;
  mismatches: { path: string; expected: string; actual: string }[] | null;
}

export function sampleCount(population: number, fraction = REVISION_FRACTION): number {
  if (population < 0) throw new Error("population must be >= 0");
  return Math.floor(population * fraction);
}

export function chooseSample(paths: readonly string[], fraction: number, seedHex: string): string[] {
  const count = sampleCount(paths.length, fraction);
  if (count === 0) return [];
  return shuffle(paths.slice().sort(), seedHex).slice(0, count).sort();
}

export function buildRevisionSample(opts: {
  files: readonly HashedFile[];
  stamp: ArtifactStamp;
  seed: string;
  now?: Date;
}): RevisionSample {
  const now = opts.now ?? new Date(opts.stamp.createdAt);
  const chosen = new Set(chooseSample(opts.files.map((file) => file.path), REVISION_FRACTION, opts.seed));
  const files = opts.files
    .filter((file) => chosen.has(file.path))
    .map((file) => ({ path: file.path, sha256: file.sha256 }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const empty = files.length === 0;
  return {
    ...opts.stamp,
    createdAt: now.toISOString(),
    status: empty ? "empty" : "pending",
    fraction: REVISION_FRACTION,
    rounding: "floor(population * fraction)",
    seed: opts.seed,
    population: opts.files.length,
    sampleCount: files.length,
    earliestCompareAt: empty ? null : new Date(now.getTime() + REVISION_WAIT_MS).toISOString(),
    files,
    mismatches: null,
  };
}

export function revisionDue(sample: Pick<RevisionSample, "status" | "earliestCompareAt">, now: Date): boolean {
  if (sample.status === "empty" || sample.earliestCompareAt == null) return false;
  return now.getTime() >= Date.parse(sample.earliestCompareAt);
}

export async function runRevisionCheck(
  sample: RevisionSample,
  now: Date,
  redownload: () => Promise<readonly RevisionFile[]>,
): Promise<RevisionCheck> {
  if (!revisionDue(sample, now)) {
    return { status: "pending", compared: false, earliestCompareAt: sample.earliestCompareAt, mismatches: null };
  }
  const actual = await redownload();
  const byPath = new Map(actual.map((file) => [file.path, file.sha256]));
  const mismatches = sample.files
    .filter((file) => byPath.get(file.path) !== file.sha256)
    .map((file) => ({ path: file.path, expected: file.sha256, actual: byPath.get(file.path) ?? "missing" }));
  return { status: "complete", compared: true, earliestCompareAt: sample.earliestCompareAt, mismatches };
}

function shuffle<T>(items: readonly T[], seedHex: string): T[] {
  const out = items.slice();
  const rand = mulberry32(seedToUint32(seedHex));
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const left = out[i];
    const right = out[j];
    if (left === undefined || right === undefined) continue;
    out[i] = right;
    out[j] = left;
  }
  return out;
}

function seedToUint32(seedHex: string): number {
  const hex = seedHex.replace(/[^0-9a-f]/gi, "").padEnd(8, "0").slice(0, 8);
  return Number.parseInt(hex, 16);
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
