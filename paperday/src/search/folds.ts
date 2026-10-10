/**
 * Walk-forward split for the six months ending 2026-10-09.
 * Months step on the 9th, the same convention as the 1m/3m/6m windows.
 * The last month is the holdout. Search code is not allowed to see it.
 * Three rolling folds: 2 months in-sample, then the next month out-of-sample.
 */

export const SERIES_START_MS = Date.parse("2026-04-09T00:00:00.000Z");
export const HOLDOUT_START_MS = Date.parse("2026-09-09T00:00:00.000Z");
export const HOLDOUT_END_MS = Date.parse("2026-10-09T00:00:00.000Z");

export interface Fold {
  id: 1 | 2 | 3;
  isFrom: number;
  isTo: number;
  oosFrom: number;
  oosTo: number;
}

const MAY = Date.parse("2026-05-09T00:00:00.000Z");
const JUN = Date.parse("2026-06-09T00:00:00.000Z");
const JUL = Date.parse("2026-07-09T00:00:00.000Z");
const AUG = Date.parse("2026-08-09T00:00:00.000Z");

/** OOS months are June, July, and August 9ths: months 3, 4, and 5 of the six. */
export const FOLDS: readonly Fold[] = [
  { id: 1, isFrom: SERIES_START_MS, isTo: JUN, oosFrom: JUN, oosTo: JUL },
  { id: 2, isFrom: MAY, isTo: JUL, oosFrom: JUL, oosTo: AUG },
  { id: 3, isFrom: JUN, isTo: AUG, oosFrom: AUG, oosTo: HOLDOUT_START_MS },
];

export function foldsOverlapOwnSample(folds: readonly Fold[] = FOLDS): string[] {
  const problems: string[] = [];
  for (const fold of folds) {
    if (!(fold.isFrom < fold.isTo)) problems.push(`fold ${fold.id} in-sample is empty`);
    if (!(fold.oosFrom < fold.oosTo)) problems.push(`fold ${fold.id} out-of-sample is empty`);
    if (fold.oosFrom < fold.isTo) problems.push(`fold ${fold.id} OOS overlaps its in-sample`);
    if (fold.oosTo > HOLDOUT_START_MS) problems.push(`fold ${fold.id} OOS enters the holdout`);
    if (fold.isFrom < SERIES_START_MS) problems.push(`fold ${fold.id} starts before the series`);
  }
  return problems;
}

export interface BarLike {
  ts: number;
}

/** Drops every bar at or after the holdout. The returned series is what search may read. */
export function stripHoldout<T extends BarLike>(bars: readonly T[], holdoutStart = HOLDOUT_START_MS): T[] {
  return bars.filter((bar) => bar.ts < holdoutStart);
}

export function assertNoHoldout(candles: Record<string, readonly BarLike[]>, holdoutStart = HOLDOUT_START_MS): void {
  for (const [pair, bars] of Object.entries(candles)) {
    for (const bar of bars) {
      if (bar.ts >= holdoutStart) {
        throw new Error(`search read a holdout bar on ${pair} at ${new Date(bar.ts).toISOString()}`);
      }
    }
  }
}

export function stripBook(candles: Record<string, BarLike[]>, holdoutStart = HOLDOUT_START_MS): Record<string, BarLike[]> {
  const out: Record<string, BarLike[]> = {};
  for (const [pair, bars] of Object.entries(candles)) out[pair] = stripHoldout(bars, holdoutStart);
  assertNoHoldout(out, holdoutStart);
  return out;
}
