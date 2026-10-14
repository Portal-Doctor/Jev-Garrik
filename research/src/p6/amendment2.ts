/**
 * Amendment 2 record. The registration and amendment 1 are not edited.
 * The Architect Kelly ruling is a separate file.
 */

import { REARM_RULE } from "./rearm";

export const REGISTRATION_SHA256 = "f4f7657329237bd29a3fe8f752daca82d4ef2a2b887346772e112146e7272c1d";
export const AMENDMENT_1_SHA256 = "e0948e26f2bbe2ec7c113d23db8b4dbb9daed70a9d2cef0e3f0a0c49f70d7760";
export const METRIC_SHA256 = "1ddfd23d3f21552398cd2e9f11a392fc4652da1537ca04b1e2c6536b93420789";
export const METRIC_FILE = "research/data/registration-sources/p6-metric-definitions.md";

export function amendment2Body(): {
  registrationSha256: string;
  amendment1Sha256: string;
  amendment1File: string;
  metricFile: string;
  metricSha256: string;
  rearm: string;
  approvedBy: "Brian";
  approvedAt: "2026-10-12T01:23:00Z";
  registrationEdited: false;
  amendment1Edited: false;
  approval: "approved";
  kellyIncluded: false;
  note: string;
} {
  return {
    registrationSha256: REGISTRATION_SHA256,
    amendment1Sha256: AMENDMENT_1_SHA256,
    amendment1File: "research/data/reports/p4-amendment-1.json",
    metricFile: METRIC_FILE,
    metricSha256: METRIC_SHA256,
    rearm: REARM_RULE,
    approvedBy: "Brian",
    approvedAt: "2026-10-12T01:23:00Z",
    registrationEdited: false,
    amendment1Edited: false,
    approval: "approved",
    kellyIncluded: false,
    note: "Amendment 2 is the frozen metric definitions plus the confirmed 1c pause re-arm. The Architect Kelly ruling is recorded separately and is not part of this amendment.",
  };
}
