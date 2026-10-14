/**
 * Reworded handover rule. Brian approved the wording at 2026-10-12T22:23:00Z.
 * The V6 and V6.1 files are not edited. The rule is live. There is no feature flag.
 */

import { AMENDMENT_V61_SHA256 } from "./amendment-v61";

export const AMENDMENT_V62_RULE = [
  "This rewords the V6.1 handover rule. The V6.1 files are not edited.",
  "A handover is handover_micro, covered and excluded from the 1% weekly gap cap, only when all of the following hold.",
  "The incoming instance's own socket for each product ran with no sequence_num hole from at least 60 seconds before the outgoing instance's last frame until after takeover.",
  "Proof of that run is the incoming instance's own socket. Sequence numbers are not compared across sockets.",
  "The writer switch took under 1 second.",
  "The buffer did not overflow.",
  "The engine resumes on the incoming stream at the first event after the last event the outgoing writer processed.",
  "That cut is matched by exchange identifiers, trade_id per product, or exchange time plus price plus size, and never by socket sequence_num.",
  "Events before the cut are skipped as duplicates.",
  "Every event after the cut is evaluated for stops and trade-through.",
  "If the cut cannot be matched without ambiguity, the handover is uncovered.",
  "The handover_micro count is logged per week.",
  "The incoming instance may also record whether it saw an event timestamped before the outgoing instance's last frame.",
  "That check does not by itself change the covered result.",
].join(" ");

export function amendmentV62Body(): {
  amendmentV61Sha256: string;
  amendmentV61File: string;
  amendmentV61Edited: false;
  amendmentV6Edited: false;
  registrationEdited: false;
  rule: string;
  live: true;
  featureFlag: false;
} {
  return {
    amendmentV61Sha256: AMENDMENT_V61_SHA256,
    amendmentV61File: "research/data/reports/p6-amendment-v61.json",
    amendmentV61Edited: false,
    amendmentV6Edited: false,
    registrationEdited: false,
    rule: AMENDMENT_V62_RULE,
    live: true,
    featureFlag: false,
  };
}

/** Wording-only approval. It does not cite a hash of the amendment file and does not edit the V6.1 records. */
export function amendmentV62ApprovalBody(): {
  approvedBy: "Brian";
  approvedAt: "2026-10-12T22:23:00Z";
  confirmedBy: ["Quant", "Trader"];
  approvalOf: "wording";
  rule: string;
  bindsToFileHash: false;
  amendmentV61Sha256: string;
  amendmentV61Edited: false;
  amendmentV6Edited: false;
  note: string;
} {
  return {
    approvedBy: "Brian",
    approvedAt: "2026-10-12T22:23:00Z",
    confirmedBy: ["Quant", "Trader"],
    approvalOf: "wording",
    rule: AMENDMENT_V62_RULE,
    bindsToFileHash: false,
    amendmentV61Sha256: AMENDMENT_V61_SHA256,
    amendmentV61Edited: false,
    amendmentV6Edited: false,
    note: "Brian approved this wording. Quant and Trader's conditions are in the rule. The optional pre-frame timestamp check is recorded and does not by itself change the covered result. This record does not bind the approval to a file hash, and it does not edit the V6.1 files.",
  };
}
