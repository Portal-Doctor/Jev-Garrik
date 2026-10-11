/**
 * Proposed exclusion list from product ids. Quant/Trader confirm it before the hash.
 * The proposal is not a registration hash while confirmed is false.
 */

export const PROPOSED_STABLE_BASES = [
  "USDT", "USDC", "DAI", "TUSD", "USDP", "GUSD", "PYUSD", "USD1", "USDS", "FRAX", "LUSD", "GHO", "CRVUSD", "USDE",
] as const;

export const PROPOSED_WRAPPED_OR_STAKED_BASES = [
  "WBTC", "WETH", "CBETH", "WSTETH", "STETH", "RETH", "WEETH", "METH", "MSOL", "JITOSOL",
] as const;

export const PROPOSED_PEGGED_BASES = ["PAXG", "XAUT"] as const;

export interface ExclusionProposal {
  confirmed: false;
  note: string;
  productIds: string[];
}

export function proposeExclusions(productIds: readonly string[]): ExclusionProposal {
  const blocked = new Set<string>([...PROPOSED_STABLE_BASES, ...PROPOSED_WRAPPED_OR_STAKED_BASES, ...PROPOSED_PEGGED_BASES]);
  const productIdsOut = productIds
    .filter((id) => {
      const base = id.split("-")[0] ?? "";
      return blocked.has(base.toUpperCase());
    })
    .sort();
  return {
    confirmed: false,
    note: "Proposed from metadata by base-asset name. Edge cases are not decided. Quant/Trader confirm before the hash.",
    productIds: productIdsOut,
  };
}
