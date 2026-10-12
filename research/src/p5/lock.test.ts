import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";

const reports = join(import.meta.dir, "..", "..", "data", "reports");

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("the approved registration and the geometry scan are unchanged", () => {
  expect(sha256(join(reports, "p4-registration.json"))).toBe("49bc506092114e2dec3e3ec73faa1adad4afdf04b0941d4c7b01bd22cd2317f3");
  expect(readFileSync(join(reports, "p4-registration.sha256"), "utf8")).toBe(
    "49bc506092114e2dec3e3ec73faa1adad4afdf04b0941d4c7b01bd22cd2317f3  research/data/reports/p4-registration.json\n",
  );
  expect(sha256(join(reports, "geometry-scan.json"))).toBe("7c8901dbd891e7343aa0713ac3724a907480cf9e51da344f295050b3b52dbd44");
  const registration = JSON.parse(readFileSync(join(reports, "p4-registration.json"), "utf8")) as {
    approved: boolean;
    feeTier: { makerBps: number; takerBps: number };
    validation: { maxOfN: number; nCum: number };
    execution: { sBt: { baseBps: number; stressBps: number } };
  };
  expect(registration.approved).toBe(false);
  expect(registration.feeTier.makerBps).toBe(50);
  expect(registration.feeTier.takerBps).toBe(90);
  expect(registration.validation.maxOfN).toBe(7);
  expect(registration.validation.nCum).toBe(135);
  expect(registration.execution.sBt.baseBps).toBe(5);
  expect(registration.execution.sBt.stressBps).toBe(10);
});

test("the uncapped diagnostic keeps its results hash and the amendment is stamped", () => {
  const report = JSON.parse(readFileSync(join(reports, "p5-historical.json"), "utf8")) as {
    role: string;
    registrationSha256: string;
    geometryScanSha256: string;
    jevCalls: number;
    resultsHash: string;
    results: { label: string; configs: { config: string; base: { oos: { verdict: string; n: number } } }[] };
  };
  expect(report.role).toBe("UNCAPPED DIAGNOSTIC");
  expect(report.registrationSha256).toBe("49bc506092114e2dec3e3ec73faa1adad4afdf04b0941d4c7b01bd22cd2317f3");
  expect(report.geometryScanSha256).toBe("7c8901dbd891e7343aa0713ac3724a907480cf9e51da344f295050b3b52dbd44");
  expect(report.jevCalls).toBe(0);
  expect(report.resultsHash).toBe("608c52b8c6f9c2e48591d39873571497454ef55936c06a160e2ea98441f2d601");
  expect(sha256(join(reports, "p5-historical.json"))).not.toBe(report.resultsHash);
  expect(createHash("sha256").update(JSON.stringify(report.results)).digest("hex")).toBe(report.resultsHash);
  expect(report.results.label).toBe("1-year, 15m, short-history, EXPLORATORY");
  expect(report.results.configs.find((row) => row.config === "B")?.base.oos.verdict).toBe("keep");
  expect(report.results.configs.find((row) => row.config === "B")?.base.oos.n).toBe(42);
  expect(sha256(join(reports, "p4-amendment-1.json"))).toBe("e0948e26f2bbe2ec7c113d23db8b4dbb9daed70a9d2cef0e3f0a0c49f70d7760");
  expect(readFileSync(join(reports, "p4-amendment-1.sha256"), "utf8")).toBe(
    "e0948e26f2bbe2ec7c113d23db8b4dbb9daed70a9d2cef0e3f0a0c49f70d7760  research/data/reports/p4-amendment-1.json\n",
  );
  const amendment = JSON.parse(readFileSync(join(reports, "p4-amendment-1.json"), "utf8")) as {
    registrationSha256: string;
    approvedAt: string;
    registrationEdited: boolean;
  };
  expect(amendment.registrationSha256).toBe("49bc506092114e2dec3e3ec73faa1adad4afdf04b0941d4c7b01bd22cd2317f3");
  expect(amendment.approvedAt).toBe("2026-10-11T19:45:00Z");
  expect(amendment.registrationEdited).toBe(false);
});

test("the registered capped run keeps its results hash", () => {
  const report = JSON.parse(readFileSync(join(reports, "p5-registered.json"), "utf8")) as {
    commitSha: string;
    amendmentSha256: string;
    registrationSha256: string;
    jevCalls: number;
    resultsHash: string;
    results: {
      selection: { chosen: string; l80NetUsdPerMonth: number };
      maxOfN: { registered: number };
      dsr: { registeredTrials: number; sensitivityTrials: number };
      blocked: { officialBase: { betaApplied?: boolean; hits: { slotA: number; beta?: number } } };
      holm: { historical: { id: string; holmPass: boolean }[]; alpha: number };
      configs: { config: string; selected: boolean; base: { oos: { n: number; verdict: string } } }[];
      classB: { base: { oos: { n: number; verdict: string } } };
    };
  };
  expect(report.commitSha).toBe("79258bd11a3763a6365ca13e8d6a292f072cc8bb");
  expect(report.registrationSha256).toBe("49bc506092114e2dec3e3ec73faa1adad4afdf04b0941d4c7b01bd22cd2317f3");
  expect(report.amendmentSha256).toBe("e0948e26f2bbe2ec7c113d23db8b4dbb9daed70a9d2cef0e3f0a0c49f70d7760");
  expect(report.jevCalls).toBe(0);
  expect(report.resultsHash).toBe("47444899b20c3f3f035c65f613898aba547ca8ddc77426f61282fac505c50d51");
  expect(createHash("sha256").update(JSON.stringify(report.results)).digest("hex")).toBe(report.resultsHash);
  expect(report.results.selection.chosen).toBe("A55-k3");
  expect(report.results.maxOfN.registered).toBe(7);
  expect(report.results.dsr.registeredTrials).toBe(135);
  expect(report.results.dsr.sensitivityTrials).toBe(154);
  expect(report.results.holm.alpha).toBe(0.05);
  expect(report.results.holm.historical.every((row) => row.holmPass === false)).toBe(true);
  const selected = report.results.configs.find((row) => row.selected);
  expect(selected?.base.oos.n).toBe(8);
  expect(selected?.base.oos.verdict).toBe("insufficient");
  expect(report.results.classB.base.oos.n).toBe(34);
  expect(report.results.classB.base.oos.verdict).toBe("keep");
  expect(report.results.blocked.officialBase.hits.slotA).toBe(32);
});

test("the v3.1 approval cites the fingerprint and leaves the registration bytes", () => {
  const registration = sha256(join(reports, "p5-v31-registration.json"));
  expect(registration).toBe("f4f7657329237bd29a3fe8f752daca82d4ef2a2b887346772e112146e7272c1d");
  expect(readFileSync(join(reports, "p5-v31-registration.sha256"), "utf8")).toBe(
    "f4f7657329237bd29a3fe8f752daca82d4ef2a2b887346772e112146e7272c1d  research/data/reports/p5-v31-registration.json\n",
  );
  const approval = JSON.parse(readFileSync(join(reports, "p5-v31-approval.json"), "utf8")) as {
    registrationSha256: string;
    approvedBy: string;
    approvedAt: string;
    commit: string;
    commitSha: string;
  };
  expect(approval.registrationSha256).toBe(registration);
  expect(approval.approvedBy).toBe("Brian");
  expect(approval.approvedAt).toBe("2026-10-12T00:22:00Z");
  expect(approval.commit).toBe("95d0203e6fec1e8fba0938f7fdc36aa214be6580");
  expect(approval.commitSha).toBe("95d0203e6fec1e8fba0938f7fdc36aa214be6580");
});

test("the v3.1 registration is unapproved and cites the frozen bases", () => {
  const path = join(reports, "p5-v31-registration.json");
  expect(sha256(path)).toBe("f4f7657329237bd29a3fe8f752daca82d4ef2a2b887346772e112146e7272c1d");
  expect(readFileSync(join(reports, "p5-v31-registration.sha256"), "utf8")).toBe(
    "f4f7657329237bd29a3fe8f752daca82d4ef2a2b887346772e112146e7272c1d  research/data/reports/p5-v31-registration.json\n",
  );
  const doc = JSON.parse(readFileSync(path, "utf8")) as {
    approved: boolean;
    approval?: unknown;
    questions?: unknown;
    supersedesSha256: string;
    baseRegistrationSha256: string;
    amendmentSha256: string;
    baseRegistrationEdited: boolean;
    amendmentEdited: boolean;
    geometrySha256: string;
    breadth: { entryDays: number; pausedDays: number; flag: boolean };
    breadthDecision: { option: string; blocksEntries: boolean; resizes: boolean };
    momentumConditionDates: string[];
    clusters: { monthCount: number; monthsAbove60: number; flag: boolean };
    maxOpen: number | null;
    maxOpenNote: string;
    boundarySavedCorrelation: { wifIncluded: boolean; names: string[] };
    resultsPath: string;
    rulesBoundBy: { sha256: string };
    sources: { path: string; sha256: string }[];
    resolvedDefaults: { id: number; status: string; text: string }[];
  };
  expect(doc.approved).toBe(false);
  expect("approval" in doc).toBe(false);
  expect("questions" in doc).toBe(false);
  expect(doc.supersedesSha256).toBe("40f8120ef2b418b48d0e9f9788025aacc5469f29722cac4c21a674f2ffdf7c98");
  expect(doc.rulesBoundBy.sha256).toBe("4ace3c484a9a919f6d319b4582367e0b13b03d55d4b8cadd6f26cc08bf509c15");
  expect(doc.sources.map((row) => row.sha256)).toEqual([
    "7dbf08776ebd7a3e7601b4bd0506080e74ea4da43e82eec4005174ebd67e42d9",
    "65b64dab138b848a30c9471bf75b4b0006d1c240b22e7e75378c8c0d5acaafaa",
    "e212f68fef714d08c2dd7188fb78ef387b12dcbb89018c43ae6c292bc51c7255",
    "002d04227b1017b753be4686f1322998e648dae4e20a874a290b0cb4237a2611",
    "2554b6ef1237ac34462a17400a178a3345b65c0b94ef0d4075570ce77740d458",
    "4ace3c484a9a919f6d319b4582367e0b13b03d55d4b8cadd6f26cc08bf509c15",
    "aa0276da30aa85dbb8618dcdaf2a88821fe4e554a9e0eb49ce897a4370abea67",
    "df6c139749c9592f4d231d998b069d63f8a768a3ffa129ccb2eca20cc214d616",
    "3e465bc145b93d008b6f582f095034351374aa62de9009ee6439a586979fe512",
  ]);
  expect(doc.sources.every((row) => row.path.startsWith("research/data/registration-sources/"))).toBe(true);
  expect(doc.baseRegistrationSha256).toBe("49bc506092114e2dec3e3ec73faa1adad4afdf04b0941d4c7b01bd22cd2317f3");
  expect(doc.amendmentSha256).toBe("e0948e26f2bbe2ec7c113d23db8b4dbb9daed70a9d2cef0e3f0a0c49f70d7760");
  expect(doc.baseRegistrationEdited).toBe(false);
  expect(doc.amendmentEdited).toBe(false);
  expect(doc.geometrySha256).toBe(sha256(join(reports, "p5-v31-geometry.json")));
  expect(doc.geometrySha256).toBe("f492f3634b665e9d0173b6ff35120f9f03eb953b94ca821d69df1c484873e5cf");
  expect(doc.breadth).toEqual({ entryDays: 334, pausedDays: 222, flag: true });
  expect(doc.breadthDecision).toMatchObject({ option: "c", blocksEntries: false, resizes: false });
  expect(doc.momentumConditionDates).toEqual([]);
  expect(doc.clusters).toEqual({ monthCount: 11, monthsAbove60: 1, flag: false });
  expect(doc.maxOpen).toBeNull();
  expect(doc.maxOpenNote).toBe("G2 concurrency measured in the post-hash rerun");
  expect(doc.boundarySavedCorrelation.wifIncluded).toBe(true);
  expect(doc.boundarySavedCorrelation.names).toContain("WIF-USD");
  expect(doc.resultsPath).toBe("research/data/reports/p5-v31-results.json");
  expect(doc.resolvedDefaults).toHaveLength(18);
  expect(doc.resolvedDefaults.filter((row) => row.status === "corrected").map((row) => row.id)).toEqual([1, 4, 6, 7, 9, 14, 15]);
  expect(doc.resolvedDefaults.find((row) => row.id === 15)?.text).toBe(
    "sigma = 1.5R until 20 forward trades, then frozen at the realized SD of net R over trades 1-20; Wald +/- ln 4, H0 +0.25R vs H1 0, report-only. Report both LLR paths (the frozen-realized path and the fixed 1.5R path).",
  );
});
