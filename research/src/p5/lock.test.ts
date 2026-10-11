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

test("the P5 report cites the approved registration and its own results hash", () => {
  const report = JSON.parse(readFileSync(join(reports, "p5-historical.json"), "utf8")) as {
    registrationSha256: string;
    geometryScanSha256: string;
    jevCalls: number;
    resultsHash: string;
    results: { label: string; configs: { config: string; base: { oos: { verdict: string; n: number } } }[] };
  };
  expect(report.registrationSha256).toBe("49bc506092114e2dec3e3ec73faa1adad4afdf04b0941d4c7b01bd22cd2317f3");
  expect(report.geometryScanSha256).toBe("7c8901dbd891e7343aa0713ac3724a907480cf9e51da344f295050b3b52dbd44");
  expect(report.jevCalls).toBe(0);
  expect(report.resultsHash).toBe("608c52b8c6f9c2e48591d39873571497454ef55936c06a160e2ea98441f2d601");
  expect(report.results.label).toBe("1-year, 15m, short-history, EXPLORATORY");
  expect(report.results.configs.find((row) => row.config === "B")?.base.oos.verdict).toBe("keep");
  expect(report.results.configs.find((row) => row.config === "B")?.base.oos.n).toBe(42);
});
