/**
 * Amendment V6.1. Brian approved the wording at 2026-10-12T18:35:00Z (1:35 PM CT).
 * Quant and Trader confirmed it. The V6 files are not edited.
 * The rule is live. There is no feature flag.
 */

import { AMENDMENT_2B_SHA256 } from "./amendment-v6";
import { AMENDMENT1_SHA256, AMENDMENT2_SHA256, REGISTRATION_SHA256 } from "./amendment2a";
import { AMENDMENT_2A_SHA256 } from "./amendment2b";

/** Bytes of the frozen V6 record. This amendment does not rewrite that file. */
export const AMENDMENT_V6_SHA256 = "8f66b3f91ca73eca4a7b574c7b66c706e562e4b85cc9e190f81158771f01e1f0";

export const AMENDMENT_V61_RULE = [
  "A handover is handover_micro, covered and excluded from the 1% weekly gap cap, only when its duration is under 1 second and the level2 sequence numbers and market_trades trade ids are contiguous across the handover.",
  "The incoming instance checks those values against the last ones stored in Redis.",
  "Otherwise the handover is uncovered and counts toward the 1% cap, the 15-minute cap, and the stale-feed rules, whatever its duration.",
  "After a handover, replay the buffered messages in sequence order.",
  "Evaluate stops and trade-through fills on each message using the exchange trade timestamp.",
  "A crossed stop fills at the first trade at or through it and is tagged handover_micro.",
  "If the order or the timestamps cannot be guaranteed, the handover is uncovered and those messages are not applied.",
  "Log the handover_micro count per week.",
].join(" ");

export function amendmentV61Body(): {
  registrationSha256: string;
  amendment1Sha256: string;
  amendment2Sha256: string;
  amendment2aSha256: string;
  amendment2bSha256: string;
  amendmentV6Sha256: string;
  amendmentV6File: string;
  rule: string;
  live: true;
  featureFlag: false;
  registrationEdited: false;
  amendment1Edited: false;
  amendment2Edited: false;
  amendment2aEdited: false;
  amendment2bEdited: false;
  amendmentV6Edited: false;
} {
  return {
    registrationSha256: REGISTRATION_SHA256,
    amendment1Sha256: AMENDMENT1_SHA256,
    amendment2Sha256: AMENDMENT2_SHA256,
    amendment2aSha256: AMENDMENT_2A_SHA256,
    amendment2bSha256: AMENDMENT_2B_SHA256,
    amendmentV6Sha256: AMENDMENT_V6_SHA256,
    amendmentV6File: "research/data/reports/p6-amendment-v6.json",
    rule: AMENDMENT_V61_RULE,
    live: true,
    featureFlag: false,
    registrationEdited: false,
    amendment1Edited: false,
    amendment2Edited: false,
    amendment2aEdited: false,
    amendment2bEdited: false,
    amendmentV6Edited: false,
  };
}

/** Approval of the wording. It does not cite a hash of the amendment file. */
export function amendmentV61ApprovalBody(): {
  approvedBy: "Brian";
  approvedAt: "2026-10-12T18:35:00Z";
  confirmedBy: ["Quant", "Trader"];
  approvalOf: "wording";
  rule: string;
  amendmentV6Sha256: string;
  bindsToFileHash: false;
  note: string;
  registrationEdited: false;
  amendmentV6Edited: false;
} {
  return {
    approvedBy: "Brian",
    approvedAt: "2026-10-12T18:35:00Z",
    confirmedBy: ["Quant", "Trader"],
    approvalOf: "wording",
    rule: AMENDMENT_V61_RULE,
    amendmentV6Sha256: AMENDMENT_V6_SHA256,
    bindsToFileHash: false,
    note: "Brian approved the wording at 1:35 PM CT on 2026-10-12. Quant and Trader confirmed. This record does not bind that approval to a file hash.",
    registrationEdited: false,
    amendmentV6Edited: false,
  };
}
