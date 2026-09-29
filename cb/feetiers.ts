/**
 * Coinbase Advanced Trade US spot fee tiers, copied from Coinbase's published schedule.
 * Nothing here is invented. Every row carries the source it was read from.
 *
 * Coinbase moved the full US Advanced ladder behind a logged-in session in 2026, so two
 * published sources have to be combined and both are kept separate on purpose:
 *
 * - `US_ANNOUNCED_TIERS` are the rows Coinbase published in the September 16, 2026 US
 *   repricing: the entry tier and the first discounted volume step at $10,000.
 * - `ADVANCED_VIP_LADDER` is the tier ladder on Coinbase's own `coinbase.com/advanced-vip`
 *   page. Its volume cutoffs are Coinbase's; its rate column is the non-US ladder, which is
 *   why its entry row is 60/120 rather than the US 50/90.
 *
 * The two disagree above $10,000. Do not silently merge them. Report both and let Brian read
 * the authoritative US column off his logged-in Advanced fee page.
 */

export interface SpotFeeTier {
  name: string;
  /** Trailing 30-day USD volume Coinbase publishes as this tier's cutoff. */
  thirtyDayVolumeUsd: number;
  makerBps: number;
  takerBps: number;
  source: string;
}

const US_ANNOUNCEMENT =
  "Coinbase Advanced US spot repricing, effective September 16, 2026 (entry 0.50% maker / 0.90% taker; first discounted step at $10,000 of 30-day volume at 0.25% / 0.40%)";

const VIP_PAGE = "coinbase.com/advanced-vip fee level table (Coinbase's own page; rate column is the non-US ladder)";

/** The two US rate rows Coinbase published at the September 16, 2026 repricing. */
export const US_ANNOUNCED_TIERS: readonly SpotFeeTier[] = [
  { name: "US entry", thirtyDayVolumeUsd: 0, makerBps: 50, takerBps: 90, source: US_ANNOUNCEMENT },
  { name: "US first discounted step", thirtyDayVolumeUsd: 10_000, makerBps: 25, takerBps: 40, source: US_ANNOUNCEMENT },
];

/** Coinbase's own advanced-vip ladder. Volume cutoffs are Coinbase's; rates are the non-US column. */
export const ADVANCED_VIP_LADDER: readonly SpotFeeTier[] = [
  { name: "Intro 1", thirtyDayVolumeUsd: 0, makerBps: 60, takerBps: 120, source: VIP_PAGE },
  { name: "Intro 2", thirtyDayVolumeUsd: 10_000, makerBps: 40, takerBps: 80, source: VIP_PAGE },
  { name: "Advanced 1", thirtyDayVolumeUsd: 25_000, makerBps: 25, takerBps: 50, source: VIP_PAGE },
  { name: "Advanced 2", thirtyDayVolumeUsd: 75_000, makerBps: 12.5, takerBps: 25, source: VIP_PAGE },
  { name: "Advanced 3", thirtyDayVolumeUsd: 250_000, makerBps: 7.5, takerBps: 15, source: VIP_PAGE },
  { name: "VIP 1", thirtyDayVolumeUsd: 500_000, makerBps: 6, takerBps: 12.5, source: VIP_PAGE },
  { name: "VIP 2", thirtyDayVolumeUsd: 1_000_000, makerBps: 5, takerBps: 10, source: VIP_PAGE },
  { name: "VIP 3", thirtyDayVolumeUsd: 5_000_000, makerBps: 4, takerBps: 8.5, source: VIP_PAGE },
  { name: "VIP 4", thirtyDayVolumeUsd: 10_000_000, makerBps: 2.5, takerBps: 6.5, source: VIP_PAGE },
  { name: "VIP 5", thirtyDayVolumeUsd: 20_000_000, makerBps: 1, takerBps: 5, source: VIP_PAGE },
  { name: "VIP 6", thirtyDayVolumeUsd: 50_000_000, makerBps: 0, takerBps: 3.5, source: VIP_PAGE },
  { name: "VIP 7", thirtyDayVolumeUsd: 100_000_000, makerBps: 0, takerBps: 2.5, source: VIP_PAGE },
  { name: "VIP 8", thirtyDayVolumeUsd: 250_000_000, makerBps: 0, takerBps: 2, source: VIP_PAGE },
];

/**
 * Tiers this book could plausibly reach: the entry row always, plus any row whose published
 * cutoff is within `multiple` times the measured 30-day filled notional. Rows that need tens of
 * millions of dollars of turnover drop out unless the replay actually shows that turnover.
 */
export function tiersInReach(
  tiers: readonly SpotFeeTier[],
  measuredThirtyDayNotionalUsd: number,
  multiple = 10,
): SpotFeeTier[] {
  const ceiling = Math.max(0, measuredThirtyDayNotionalUsd) * Math.max(0, multiple);
  return tiers.filter((t) => t.thirtyDayVolumeUsd <= 0 || t.thirtyDayVolumeUsd <= ceiling);
}

/** Whether measured turnover clears a tier's published cutoff. */
export function tierReached(tier: SpotFeeTier, measuredThirtyDayNotionalUsd: number): boolean {
  return measuredThirtyDayNotionalUsd >= tier.thirtyDayVolumeUsd;
}
