/**
 * Point-in-time universe. Inputs are candle-derived facts and the exclusion file.
 * This module does not read the stats snapshot or the owner cut.
 */

export const FIRST_UNIVERSE_DATE = "2025-11-10";

/** D3(b) with D1: IS 2025-11-10 through 2026-02-09, then eight OOS months. */
export const OOS_START = "2026-02-10";
export const OOS_END = "2026-10-09";

export interface VolumeTierDecision {
  tier: "5M/3M" | "3M/2M";
  entryUsd: number;
  exitUsd: number;
  rebalanceDates: number;
  datesWithAtLeast30: number;
  share: number;
}

export function chooseVolumeTier(namesAtOrAbove5M: readonly number[]): VolumeTierDecision {
  const datesWithAtLeast30 = namesAtOrAbove5M.filter((count) => count >= 30).length;
  const rebalanceDates = namesAtOrAbove5M.length;
  const share = rebalanceDates === 0 ? 0 : datesWithAtLeast30 / rebalanceDates;
  const high = share >= 0.8;
  return {
    tier: high ? "5M/3M" : "3M/2M",
    entryUsd: high ? 5_000_000 : 3_000_000,
    exitUsd: high ? 3_000_000 : 2_000_000,
    rebalanceDates,
    datesWithAtLeast30,
    share,
  };
}

export function passCountFlag(combinedPassCounts: readonly number[]): { flagged: boolean; thinDates: number; dates: number; thinShare: number } {
  const dates = combinedPassCounts.length;
  const thinDates = combinedPassCounts.filter((count) => count < 20).length;
  const thinShare = dates === 0 ? 0 : thinDates / dates;
  return { flagged: thinShare > 0.2, thinDates, dates, thinShare };
}

export function onOrAfterFirstUniverseDate(date: string): boolean {
  return date >= FIRST_UNIVERSE_DATE;
}

export function inD3bOos(date: string): boolean {
  return date >= OOS_START && date <= OOS_END;
}

export interface MembershipInput {
  date: string;
  listedDays: number;
  excluded: boolean;
  liquidityPass: boolean;
  volumeUsd: number;
  tier: VolumeTierDecision;
  inTier: boolean;
}

/** Cap 40 is applied by the caller after ranking the names this predicate accepts. */
export function memberPredicate(input: MembershipInput): boolean {
  if (!onOrAfterFirstUniverseDate(input.date)) return false;
  if (input.excluded || !input.liquidityPass) return false;
  if (input.listedDays < 90) return false;
  return input.inTier;
}

export function volumeHysteresis(inside: boolean, volumeUsd: number, tier: VolumeTierDecision): boolean {
  if (!inside && volumeUsd >= tier.entryUsd) return true;
  if (inside && volumeUsd < tier.exitUsd) return false;
  return inside;
}
