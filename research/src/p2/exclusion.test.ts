import { expect, test } from "bun:test";
import { proposeExclusions } from "./exclusion";

test("the exclusion proposal is unconfirmed and keeps ordinary names", () => {
  const proposal = proposeExclusions(["BTC-USD", "USDC-USD", "WBTC-USD", "ETH-USD", "PAXG-USD"]);
  expect(proposal.confirmed).toBe(false);
  expect(proposal.productIds).toEqual(["PAXG-USD", "USDC-USD", "WBTC-USD"]);
});
