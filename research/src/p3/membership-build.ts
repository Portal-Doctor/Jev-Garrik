/**
 * Universe membership from candle-derived samples.
 * The volume tier is chosen once, from every monthly count, and then applied to every date.
 */

import { EMPTY_LIQUIDITY, liquidityPasses, stepLiquidity, type LiquiditySample, type LiquidityState } from "../p2/liquidity";
import { chooseVolumeTier, volumeHysteresis, type VolumeTierDecision } from "../p2/universe";

export interface NameDateSample {
  productId: string;
  volumeUsd: number | null;
  listedDays: number;
  liquidity: LiquiditySample | null;
}

export interface PassCountRow {
  date: string;
  legA: number;
  legB: number;
  legC: number;
  tier: number;
  combined: number;
}

export function buildMembership(opts: {
  dates: readonly string[];
  monthlyDates: ReadonlySet<string>;
  excluded: ReadonlySet<string>;
  samplesFor: (date: string) => readonly NameDateSample[];
}): {
  volumeTier: VolumeTierDecision;
  above5m: number[];
  passCounts: PassCountRow[];
  members: Map<string, Set<string>>;
} {
  const above5m: number[] = [];
  for (const date of opts.dates) {
    if (!opts.monthlyDates.has(date)) continue;
    above5m.push(opts.samplesFor(date).filter((row) => (row.volumeUsd ?? 0) >= 5_000_000).length);
  }
  const volumeTier = chooseVolumeTier(above5m);
  const state = new Map<string, { liquidity: LiquidityState; inTier: boolean }>();
  const members = new Map<string, Set<string>>();
  const passCounts: PassCountRow[] = [];
  for (const date of opts.dates) {
    let legA = 0;
    let legB = 0;
    let legC = 0;
    let tierCount = 0;
    const passing: { id: string; volume: number }[] = [];
    for (const row of opts.samplesFor(date)) {
      const prior = state.get(row.productId) ?? { liquidity: { ...EMPTY_LIQUIDITY }, inTier: false };
      const liquidity = row.liquidity ? stepLiquidity(prior.liquidity, row.liquidity) : prior.liquidity;
      const inTier = row.volumeUsd == null ? false : volumeHysteresis(prior.inTier, row.volumeUsd, volumeTier);
      state.set(row.productId, { liquidity, inTier });
      if (liquidity.nonempty) legA += 1;
      if (liquidity.volume) legB += 1;
      if (liquidity.spread) legC += 1;
      if (inTier) tierCount += 1;
      const pass = !opts.excluded.has(row.productId) && row.listedDays >= 90 && liquidityPasses(liquidity) && inTier;
      if (pass && row.volumeUsd != null) passing.push({ id: row.productId, volume: row.volumeUsd });
    }
    passing.sort((a, b) => b.volume - a.volume || (a.id < b.id ? -1 : 1));
    const capped = new Set(passing.slice(0, 40).map((row) => row.id));
    members.set(date, capped);
    if (opts.monthlyDates.has(date)) {
      passCounts.push({ date, legA, legB, legC, tier: tierCount, combined: capped.size });
    }
  }
  return { volumeTier, above5m, passCounts, members };
}
