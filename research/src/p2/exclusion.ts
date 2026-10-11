/**
 * Agreed exclusion list. Quant and Trader accepted these 23 names.
 * `confirmed` stays false until that list is hashed with the registration.
 * A name is excluded for what the asset is, not for how the ticker is spelled.
 */

export interface ExclusionEntry {
  productId: string;
  rule: "fiat-or-fx" | "commodity" | "wrapped-or-bridged" | "staking-receipt";
  source: string;
}

export const AGREED_EXCLUSIONS: readonly ExclusionEntry[] = [
  { productId: "CBETH-USD", rule: "staking-receipt", source: "Liquid staked ETH. Staking receipt, same class as the original proposed list." },
  { productId: "DAI-USD", rule: "fiat-or-fx", source: "Original proposed list. Fiat-pegged stablecoin." },
  { productId: "GUSD-USD", rule: "fiat-or-fx", source: "Original proposed list. Fiat-pegged stablecoin." },
  { productId: "JITOSOL-USD", rule: "staking-receipt", source: "Original proposed list. Liquid-staking receipt." },
  { productId: "MSOL-USD", rule: "staking-receipt", source: "Original proposed list. Liquid-staking receipt." },
  { productId: "PAXG-USD", rule: "commodity", source: "Original proposed list. Gold-backed token." },
  { productId: "PYUSD-USD", rule: "fiat-or-fx", source: "Original proposed list. Fiat-pegged stablecoin." },
  { productId: "USD1-USD", rule: "fiat-or-fx", source: "Original proposed list. Fiat-pegged stablecoin." },
  { productId: "USDS-USD", rule: "fiat-or-fx", source: "Original proposed list. Fiat-pegged stablecoin." },
  { productId: "USDT-USD", rule: "fiat-or-fx", source: "Original proposed list. Issuer peg; Coinbase fx_stablecoin is false, so the flag alone is not the source." },
  { productId: "WBTC-USD", rule: "wrapped-or-bridged", source: "Original proposed list. Wrapped bitcoin." },
  { productId: "EURC-USD", rule: "fiat-or-fx", source: "Coinbase fx_stablecoin = true. Euro stablecoin." },
  { productId: "LSETH-USD", rule: "staking-receipt", source: "Liquid Staked ETH: a staking receipt on ETH plus rewards." },
  { productId: "WAMPL-USD", rule: "wrapped-or-bridged", source: "Wrapped Ampleforth, a non-rebasing wrapper of AMPL." },
  { productId: "WCFG-USD", rule: "wrapped-or-bridged", source: "Wrapped Centrifuge. CFG-USD was listed at the same time." },
  { productId: "WAXL-USD", rule: "wrapped-or-bridged", source: "Coinbase asset page: WAXL is an ERC-20 that represents AXL, 1:1. AXL-USD is also listed." },
  { productId: "WLUNA-USD", rule: "wrapped-or-bridged", source: "Wrapped LUNA (Classic)." },
  { productId: "WRON-USD", rule: "wrapped-or-bridged", source: "Wrapped Ronin. Coinbase page and Ronin: 1 wRON = 1 RON." },
  { productId: "PAX-USD", rule: "fiat-or-fx", source: "USDP. Coinbase fx_stablecoin = true." },
  { productId: "GYEN-USD", rule: "fiat-or-fx", source: "Coinbase fx_stablecoin = true." },
  { productId: "MUSD-USD", rule: "fiat-or-fx", source: "Coinbase fx_stablecoin = true." },
  { productId: "UST-USD", rule: "fiat-or-fx", source: "Coinbase fx_stablecoin = true." },
  { productId: "BUSD-USD", rule: "fiat-or-fx", source: "Coinbase fx_stablecoin = true." },
];

export interface ExclusionProposal {
  confirmed: false;
  note: string;
  productIds: string[];
  entries: ExclusionEntry[];
}

/** The agreed 23, limited to ids present in the catalog. Native W-tickers are not on this list. */
export function proposeExclusions(productIds: readonly string[]): ExclusionProposal {
  const present = new Set(productIds);
  const entries = AGREED_EXCLUSIONS.filter((row) => present.has(row.productId)).slice().sort((a, b) => (a.productId < b.productId ? -1 : 1));
  return {
    confirmed: false,
    note: "Quant and Trader accepted these names. confirmed stays false until the registration hash. Native W, WAL, WCT, WELL, WET, WHUF, WIF, WLD, WLFI, and WMTX stay in.",
    productIds: entries.map((row) => row.productId),
    entries,
  };
}
