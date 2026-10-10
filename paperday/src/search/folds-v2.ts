/**
 * Walk-forward for the 18-month public series ending 2026-10-09.
 * Months step on the 9th. Fold 1 starts on the first 9th at which the daily
 * EMA200 is already warm. Each fold is 3 months in-sample and the next month
 * out-of-sample. Holdout v2 is forward paper, so the last historical month
 * is an ordinary OOS fold and is not a confirmatory holdout.
 */

export const SERIES_V2_START_MS = Date.parse("2025-04-09T00:00:00.000Z");
export const SERIES_V2_END_MS = Date.parse("2026-10-09T00:00:00.000Z");
export const DAILY_EMA200 = 200;
const DAY = 86_400_000;

export interface FoldV2 {
  id: number;
  isFrom: number;
  isTo: number;
  oosFrom: number;
  oosTo: number;
}

/** First close at which an SMA-seeded EMA of `period` daily bars exists. */
export function emaWarmCloseMs(dailyOpenTs: readonly number[], period = DAILY_EMA200): number | null {
  if (dailyOpenTs.length < period) return null;
  return dailyOpenTs[period - 1]! + DAY;
}

/** The UTC 9th at or after `ms`. Month steps match the 1m/3m/6m windows. */
export function ninthOnOrAfter(ms: number): number {
  const d = new Date(ms);
  let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 9);
  if (t < ms) t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 9);
  return t;
}

function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, d.getUTCDate());
}

/**
 * Rolling folds. `warmCloseMs` is the daily EMA200 close. The first in-sample
 * month begins on the following 9th, so every fold is warmed by bars before it.
 */
export function buildFoldsV2(warmCloseMs: number, endMs = SERIES_V2_END_MS): FoldV2[] {
  const folds: FoldV2[] = [];
  let isFrom = ninthOnOrAfter(warmCloseMs);
  let id = 1;
  while (true) {
    const isTo = addMonths(isFrom, 3);
    const oosTo = addMonths(isTo, 1);
    if (oosTo > endMs) break;
    folds.push({ id, isFrom, isTo, oosFrom: isTo, oosTo });
    id += 1;
    isFrom = addMonths(isFrom, 1);
  }
  return folds;
}

export function foldsV2Problems(folds: readonly FoldV2[]): string[] {
  const problems: string[] = [];
  let prevOos = -Infinity;
  for (const fold of folds) {
    if (!(fold.isFrom < fold.isTo)) problems.push(`fold ${fold.id} in-sample is empty`);
    if (fold.oosFrom !== fold.isTo) problems.push(`fold ${fold.id} OOS does not start when in-sample ends`);
    if (!(fold.oosFrom < fold.oosTo)) problems.push(`fold ${fold.id} out-of-sample is empty`);
    if (fold.oosFrom < prevOos) problems.push(`fold ${fold.id} OOS overlaps the previous OOS`);
    prevOos = fold.oosFrom;
  }
  return problems;
}
