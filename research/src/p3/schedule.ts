import { FIRST_UNIVERSE_DATE, OOS_END, OOS_START } from "../p2/universe";

/** First UTC day of each month on or after the first universe date, through 2026-10-01. */
export function monthlyRebalanceDates(): string[] {
  const out: string[] = [];
  for (let year = 2025; year <= 2026; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const date = `${year}-${String(month).padStart(2, "0")}-01`;
      if (date >= FIRST_UNIVERSE_DATE && date <= "2026-10-01") out.push(date);
    }
  }
  return out;
}

/** Fold starts under D3(b): 2025-11-10, then the eight OOS month starts. */
export function foldStartDates(): string[] {
  return [
    FIRST_UNIVERSE_DATE,
    "2026-02-10",
    "2026-03-10",
    "2026-04-10",
    "2026-05-10",
    "2026-06-10",
    "2026-07-10",
    "2026-08-10",
    "2026-09-10",
  ];
}

export function membershipDates(): string[] {
  return [...new Set([...monthlyRebalanceDates(), ...foldStartDates()])].sort();
}

export function isOosDate(date: string): boolean {
  return date >= OOS_START && date <= OOS_END;
}

/**
 * Recorded before any geometry scan on this tree.
 * 2026-10-11T02:00:00.000Z is earlier than the D1 download start and earlier than the scan clock.
 */
export const OVERLAP_TOLERANCE_RECORDED_AT = "2026-10-11T02:00:00.000Z";

export const OVERLAP_TOLERANCE = {
  priceRelative: 0.0001,
  volumeRelative: 0.01,
  confirmed: false as const,
  recordedAt: OVERLAP_TOLERANCE_RECORDED_AT,
  note: "Default tolerance recorded before the geometry scan. Quant has not confirmed it.",
};
