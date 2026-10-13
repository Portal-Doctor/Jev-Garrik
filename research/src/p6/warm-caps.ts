/**
 * Shared warm windows. The host and the offline replay both import this object.
 * Daily history is not capped: it is the full series offline already loads.
 * 4h EMA200 seed weight at 700 bars is about (199/201)^500 ≈ 0.7%.
 * 1h ATR14 seed weight at 240 bars is about (13/14)^226.
 */

export const WARM = {
  HOUR_KEEP: 240,
  FOUR_KEEP: 700,
} as const;

export const HOUR_KEEP = WARM.HOUR_KEEP;
export const FOUR_KEEP = WARM.FOUR_KEEP;

/** Hour pages that cover FOUR_KEEP 4h bars, plus one hour of alignment. */
export function hourPagesForKeep(keep: number = FOUR_KEEP, pageBars = 300): number {
  return Math.ceil((keep * 4 + 4) / pageBars);
}
