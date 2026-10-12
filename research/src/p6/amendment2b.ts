/**
 * Amendment 2b. Brian approved the wording at 2026-10-12T02:24:00Z.
 * Quant, Trader, and Architect agreed. Earlier amendment files are not edited.
 */

import { AMENDMENT1_SHA256, AMENDMENT2_SHA256, REGISTRATION_SHA256 } from "./amendment2a";

export const AMENDMENT_2A_SHA256 = "99cab8986102bfddb9dd6579fcb99ffd83ed89f065c009811633e19bd59283a0";

export const AMENDMENT_2B_RULE =
  "Rule (a): block only that pair. P&L is cumulative from forward bar 1 (realized net + open mark including the taker exit). (1) Once tripped it latches, and the pair takes no new entries in any class even if the mark recovers. (2) It clears only on Brian's explicit, logged re-enable. (3) Open positions on the pair run to their normal exit. (4) Log the trip time and the pair's realized and marked P&L. (5) On re-enable it re-arms at -$500 from the pair's cumulative P&L at that moment.";

export function amendment2bBody(): {
  registrationSha256: string;
  amendment1Sha256: string;
  amendment1File: string;
  amendment2Sha256: string;
  amendment2File: string;
  amendment2aSha256: string;
  amendment2aFile: string;
  rule: string;
  registrationEdited: false;
  amendment1Edited: false;
  amendment2Edited: false;
  amendment2aEdited: false;
} {
  return {
    registrationSha256: REGISTRATION_SHA256,
    amendment1Sha256: AMENDMENT1_SHA256,
    amendment1File: "research/data/reports/p4-amendment-1.json",
    amendment2Sha256: AMENDMENT2_SHA256,
    amendment2File: "research/data/reports/p6-amendment-2.json",
    amendment2aSha256: AMENDMENT_2A_SHA256,
    amendment2aFile: "research/data/reports/p6-amendment-2a.json",
    rule: AMENDMENT_2B_RULE,
    registrationEdited: false,
    amendment1Edited: false,
    amendment2Edited: false,
    amendment2aEdited: false,
  };
}

/** Approval of the wording. It does not cite a hash of the amendment file. */
export function amendment2bApprovalBody(): {
  approvedBy: "Brian";
  approvedAt: "2026-10-12T02:24:00Z";
  confirmedBy: ["Quant", "Trader", "Architect"];
  approvalOf: "wording";
  rule: string;
  registrationSha256: string;
  amendment1Sha256: string;
  amendment2Sha256: string;
  amendment2aSha256: string;
  bindsToFileHash: false;
  note: string;
  registrationEdited: false;
  amendment1Edited: false;
  amendment2Edited: false;
  amendment2aEdited: false;
} {
  return {
    approvedBy: "Brian",
    approvedAt: "2026-10-12T02:24:00Z",
    confirmedBy: ["Quant", "Trader", "Architect"],
    approvalOf: "wording",
    rule: AMENDMENT_2B_RULE,
    registrationSha256: REGISTRATION_SHA256,
    amendment1Sha256: AMENDMENT1_SHA256,
    amendment2Sha256: AMENDMENT2_SHA256,
    amendment2aSha256: AMENDMENT_2A_SHA256,
    bindsToFileHash: false,
    note: "Brian approved the wording. This record does not bind that approval to a file hash he has not seen.",
    registrationEdited: false,
    amendment1Edited: false,
    amendment2Edited: false,
    amendment2aEdited: false,
  };
}
