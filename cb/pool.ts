/**
 * One-pool ranking and rotation. Locked in SENIOR-DEV-PLAN-POOLED-CAPITAL.md.
 * Terms are ATR units. There is no extra weight and no $300/mo cutoff.
 */

export const POOL_USD = 12_000;
export const POOL_DD = 0.15;
export const POOL_TRIP_EQUITY = POOL_USD * (1 - POOL_DD);
export const MAX_CONCURRENT = 3;

export interface RankInput {
  atr: number;
  close: number;
  prior20High: number;
  ema: number;
  emaPrev: number;
  fill?: number | null;
  highestCloseSinceEntry?: number | null;
  brokenTrail?: boolean;
}

export interface RankTerms {
  breakQualityAtr: number;
  emaSlopeAtr: number;
  openMfeAtr: number;
  rank: number;
}

export function rankOf(input: RankInput): RankTerms {
  if (input.brokenTrail) {
    return { breakQualityAtr: 0, emaSlopeAtr: 0, openMfeAtr: 0, rank: Number.NEGATIVE_INFINITY };
  }
  if (!(input.atr > 0) || !Number.isFinite(input.atr)) {
    return { breakQualityAtr: 0, emaSlopeAtr: 0, openMfeAtr: 0, rank: Number.NEGATIVE_INFINITY };
  }
  const breakQualityAtr = (input.close - input.prior20High) / input.atr;
  const emaSlopeAtr = (input.ema - input.emaPrev) / input.atr;
  const open =
    input.fill != null && input.fill > 0 && input.highestCloseSinceEntry != null
      ? (input.highestCloseSinceEntry - input.fill) / input.atr
      : 0;
  return {
    breakQualityAtr,
    emaSlopeAtr,
    openMfeAtr: open,
    rank: breakQualityAtr + emaSlopeAtr + open,
  };
}

export interface RankedName {
  pair: string;
  rank: number;
  open: boolean;
}

/** Higher rank first. Equal rank: the open keeps the slot. Then pair name. */
export function compareRank(a: RankedName, b: RankedName): number {
  if (a.rank !== b.rank) return b.rank > a.rank ? 1 : -1;
  if (a.open !== b.open) return a.open ? -1 : 1;
  return a.pair.localeCompare(b.pair);
}

export function poolDrawdownTripped(equityUsd: number, poolUsd = POOL_USD, dd = POOL_DD): boolean {
  return equityUsd <= poolUsd * (1 - dd);
}

export interface RotationName {
  pair: string;
  rank: number;
  clipUsd: number;
  open: boolean;
  candidate: boolean;
}

export interface RotationPlan {
  flatten: string[];
  enter: string[];
  halt: boolean;
}

export function planRotation(opts: {
  equityUsd: number;
  cashUsd: number;
  grossUsd: number;
  maxGrossUsd: number;
  maxConcurrent: number;
  makerFeeBps: number;
  minSizeUsd: number;
  names: readonly RotationName[];
  halted?: boolean;
  poolUsd?: number;
  poolDd?: number;
}): RotationPlan {
  const halt = opts.halted === true || poolDrawdownTripped(opts.equityUsd, opts.poolUsd ?? POOL_USD, opts.poolDd ?? POOL_DD);
  const opens = opts.names.filter((n) => n.open);
  if (halt) {
    return { flatten: opens.map((n) => n.pair), enter: [], halt: true };
  }

  const flatten: string[] = [];
  const broken = opens.filter((n) => !Number.isFinite(n.rank));
  for (const n of broken) flatten.push(n.pair);

  const live = opens.filter((n) => Number.isFinite(n.rank));
  const candidates = opts.names
    .filter((n) => !n.open && n.candidate && Number.isFinite(n.rank))
    .slice()
    .sort(compareRank);

  let concurrent = live.length;
  let cash = opts.cashUsd;
  let gross = opts.grossUsd;
  let rotationUsed = false;
  const enter: string[] = [];
  const maker = Math.max(0, opts.makerFeeBps) / 10_000;

  for (const c of candidates) {
    const clip = Math.max(0, c.clipUsd);
    const need = clip * (1 + maker);
    const roomGross = opts.maxGrossUsd - gross;
    const canFit =
      concurrent < opts.maxConcurrent &&
      cash >= need &&
      roomGross >= Math.max(opts.minSizeUsd, clip) &&
      clip >= opts.minSizeUsd;
    if (canFit) {
      enter.push(c.pair);
      concurrent += 1;
      cash -= need;
      gross += clip;
      continue;
    }
    if (rotationUsed || live.length === 0) continue;
    const weakest = live.slice().sort(compareRank).at(-1);
    if (!weakest || !(c.rank > weakest.rank)) continue;
    flatten.push(weakest.pair);
    rotationUsed = true;
  }

  return { flatten, enter, halt: false };
}
