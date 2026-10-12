/**
 * Amendment 2a. Brian approved the running high-water mark at 2026-10-12T01:49:00Z.
 * Quant and Trader confirmed it. The frozen amendment 2 file is not edited.
 */

import { AMENDMENT_2A_RULE } from "./rearm";

export const REGISTRATION_SHA256 = "f4f7657329237bd29a3fe8f752daca82d4ef2a2b887346772e112146e7272c1d";
export const AMENDMENT1_SHA256 = "e0948e26f2bbe2ec7c113d23db8b4dbb9daed70a9d2cef0e3f0a0c49f70d7760";
export const AMENDMENT2_SHA256 = "bfa6efb2e0e4b12034e34e8481256bb26b6c36a24e3e3a92c5300be9eaf496eb";

export function amendment2aBody(): {
  registrationSha256: string;
  amendment1Sha256: string;
  amendment1File: string;
  amendment2Sha256: string;
  amendment2File: string;
  rule: string;
  registrationEdited: false;
  amendment1Edited: false;
  amendment2Edited: false;
} {
  return {
    registrationSha256: REGISTRATION_SHA256,
    amendment1Sha256: AMENDMENT1_SHA256,
    amendment1File: "research/data/reports/p4-amendment-1.json",
    amendment2Sha256: AMENDMENT2_SHA256,
    amendment2File: "research/data/reports/p6-amendment-2.json",
    rule: AMENDMENT_2A_RULE,
    registrationEdited: false,
    amendment1Edited: false,
    amendment2Edited: false,
  };
}
