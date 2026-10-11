import { findBannedKeys } from "../data/banned";

/** Geometry scan fields. Counts, widths, shares, and coverage only. */
export const SCAN_KEYS = [
  "commitSha",
  "dataRootHash",
  "dailyRootHash",
  "createdAt",
  "phaseId",
  "label",
  "signalCounts",
  "projectedOos",
  "stopWidths",
  "btcFilterShares",
  "universeSize",
  "nonemptyShare",
  "csDistribution",
  "warmupLostDays",
  "passCounts",
  "passCountFlag",
  "volumeTier",
  "class",
  "pairMonth",
  "count",
  "p10",
  "p50",
  "p90",
  "bps",
  "share",
  "date",
  "names",
  "legA",
  "legB",
  "legC",
  "tier",
  "combined",
  "coverage",
  "openItems",
] as const;

export function assertScanSchema(value: unknown): void {
  const banned = findBannedKeys(value);
  if (banned.length > 0) throw new Error(`scan schema rejected banned fields: ${banned.join(", ")}`);
}
