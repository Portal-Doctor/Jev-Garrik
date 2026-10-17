/**
 * Open marks charge the entry fee. Once merged, that rule is the live code
 * and there is no feature flag. This record is still awaiting Brian's stamp.
 * The V6.2 files are not edited. Halt thresholds are unchanged.
 * There is no approval stamp.
 */

export const AMENDMENT_V62_SHA256 = "2f734d18c82308d6e7a58e519cf502755dfc4101a8f6c1c47630e0453df7acb8";

export const AMENDMENT_V63_RULE =
  "open marks also charge the entry fee; thresholds unchanged; promotion day count restarts at fromDay; an invalid or garbage marker is ignored and repaired by the next flush of the process that loaded it; a first Monday review with no marker counts from the next UTC day";

export function amendmentV63Body(): {
  amendmentV62Sha256: string;
  amendmentV62File: string;
  amendmentV62Edited: false;
  registrationEdited: false;
  metricDefinitionsEdited: false;
  haltThresholdsUnchanged: true;
  rule: string;
  awaiting: "AWAITING Brian's approval stamp";
  mergedCode: "live once merged, with no feature flag";
} {
  return {
    amendmentV62Sha256: AMENDMENT_V62_SHA256,
    amendmentV62File: "research/data/reports/p6-amendment-v62.json",
    amendmentV62Edited: false,
    registrationEdited: false,
    metricDefinitionsEdited: false,
    haltThresholdsUnchanged: true,
    rule: AMENDMENT_V63_RULE,
    awaiting: "AWAITING Brian's approval stamp",
    mergedCode: "live once merged, with no feature flag",
  };
}
