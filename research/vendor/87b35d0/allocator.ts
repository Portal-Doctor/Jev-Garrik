/**
 * Capital allocator. Formula only. Jev never sizes.
 * $2,000 of the $10,000 budget is never allocated.
 * Over-commit refuses the idea and does not change reserved cash.
 */

import { DEPLOYABLE_USD, RESERVE_USD, STARTING_BUDGET_USD, type AllocatorMode, type ShareFormula } from "./config";

export interface ShareMap {
  [pair: string]: number;
}

export function equalShares(deployable: number, pairs: readonly string[]): ShareMap {
  const n = pairs.length;
  if (n < 1 || !(deployable > 0)) return {};
  const share = deployable / n;
  const out: ShareMap = {};
  for (const p of pairs) out[p] = share;
  return out;
}

/**
 * Inverse-ATR weights. A pair with no positive ATR gets zero and is left out of the sum.
 * Shares of the pairs that have an ATR add up to `deployable`.
 */
export function atrScaledShares(deployable: number, atrByPair: Record<string, number>): ShareMap {
  const entries = Object.entries(atrByPair).filter(([, atr]) => atr > 0 && Number.isFinite(atr));
  const out: ShareMap = {};
  for (const key of Object.keys(atrByPair)) out[key] = 0;
  if (entries.length === 0 || !(deployable > 0)) return out;
  let weight = 0;
  const inv: Array<[string, number]> = [];
  for (const [pair, atr] of entries) {
    const w = 1 / atr;
    inv.push([pair, w]);
    weight += w;
  }
  for (const [pair, w] of inv) out[pair] = (deployable * w) / weight;
  return out;
}

export interface ReserveState {
  mode: AllocatorMode;
  formula: ShareFormula;
  deployable: number;
  reserve: number;
  /** Notional currently reserved, by pair. */
  byPair: Record<string, number>;
  total: number;
}

export interface ReserveResult {
  ok: boolean;
  reason: string;
  state: ReserveState;
}

export function blankAllocator(mode: AllocatorMode, formula: ShareFormula): ReserveState {
  return { mode, formula, deployable: DEPLOYABLE_USD, reserve: RESERVE_USD, byPair: {}, total: 0 };
}

export function shareFor(
  state: ReserveState,
  pair: string,
  enabledPairs: readonly string[],
  atrByPair: Record<string, number>,
): number {
  if (state.mode === "SILO" || state.formula === "equal") {
    const shares = equalShares(state.deployable, enabledPairs);
    return shares[pair] ?? 0;
  }
  return atrScaledShares(state.deployable, atrByPair)[pair] ?? 0;
}

/**
 * Atomically reserve `amount` for one idea.
 * Refuses when the amount exceeds the pair formula, the silo bucket, the
 * deployable cap, or the cash sitting above the never-allocated reserve.
 */
export function reserve(
  state: ReserveState,
  pair: string,
  amount: number,
  opts: { enabledPairs: readonly string[]; atrByPair: Record<string, number>; allocatableUsd: number },
): ReserveResult {
  const fail = (reason: string): ReserveResult => ({ ok: false, reason, state });
  if (!(amount > 0) || !Number.isFinite(amount)) return fail("amount not positive");
  const formulaShare = shareFor(state, pair, opts.enabledPairs, opts.atrByPair);
  if (!(formulaShare > 0)) return fail("no share");
  if (amount > formulaShare + 1e-6) return fail("above formula share");
  const nextTotal = state.total + amount;
  if (nextTotal > state.deployable + 1e-6) return fail("total cap");
  const pairUsed = state.byPair[pair] ?? 0;
  if (state.mode === "SILO") {
    const bucket = equalShares(state.deployable, opts.enabledPairs)[pair] ?? 0;
    if (pairUsed + amount > bucket + 1e-6) return fail("silo bucket");
  }
  if (amount > opts.allocatableUsd + 1e-6) return fail("reserve protected");
  if (nextTotal > STARTING_BUDGET_USD - RESERVE_USD + 1e-6) return fail("reserve protected");
  const byPair = { ...state.byPair, [pair]: pairUsed + amount };
  return {
    ok: true,
    reason: "reserved",
    state: { ...state, byPair, total: nextTotal },
  };
}

export function release(state: ReserveState, pair: string, amount: number): ReserveState {
  const used = state.byPair[pair] ?? 0;
  const next = Math.max(0, used - amount);
  const byPair = { ...state.byPair, [pair]: next };
  return { ...state, byPair, total: Math.max(0, state.total - Math.min(used, amount)) };
}
