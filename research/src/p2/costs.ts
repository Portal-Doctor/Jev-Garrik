/**
 * Gap 17 as restated by Delta 1.
 * s_bt = max(5 bps, 0.5 × CS15m 30-day median), capped at 15 bps per taker leg.
 * The stress row is 2× the capped value, so 10–30 bps. The cap applies to the base row only.
 * Maker legs pay none.
 */

export interface SpreadCost {
  /** Base taker-leg spread cost in bps, in [5, 15]. */
  baseBps: number;
  /** 2× the capped base, in [10, 30]. */
  stressBps: number;
}

export function spreadCost(csMedianBps: number): SpreadCost {
  if (!Number.isFinite(csMedianBps) || csMedianBps < 0) throw new Error("CS median must be a non-negative number");
  const uncapped = Math.max(5, 0.5 * csMedianBps);
  const baseBps = Math.min(15, uncapped);
  return { baseBps, stressBps: baseBps * 2 };
}

/** Round-trip taker cost. Maker legs contribute 0. */
export function takerLegCost(legs: readonly ("taker" | "maker")[], csMedianBps: number, stress = false): number {
  const cost = spreadCost(csMedianBps);
  const perLeg = stress ? cost.stressBps : cost.baseBps;
  return legs.reduce((sum, leg) => sum + (leg === "taker" ? perLeg : 0), 0);
}
