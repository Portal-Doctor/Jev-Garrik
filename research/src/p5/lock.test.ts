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
