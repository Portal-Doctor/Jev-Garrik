import { expect, test } from "bun:test";
import { proposeExclusions } from "./exclusion";

test("the exclusion proposal is the agreed 23 and stays unconfirmed", () => {
  const proposal = proposeExclusions(["BTC-USD", "USDC-USD", "WBTC-USD", "ETH-USD", "PAXG-USD", "WIF-USD", "WAXL-USD"]);
  expect(proposal.confirmed).toBe(false);
  expect(proposal.productIds).toEqual(["PAXG-USD", "WAXL-USD", "WBTC-USD"]);
  expect(proposal.productIds.includes("USDC-USD")).toBe(false);
  expect(proposal.productIds.includes("WIF-USD")).toBe(false);
  expect(proposal.entries).toHaveLength(3);
});
