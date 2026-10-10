import { expect, test } from "bun:test";
import { findBannedKeys } from "./banned";
import type { CoverageReport } from "./coverage";
import { sealFrozenSnapshot, type DataManifest } from "./manifest-file";
import { buildP1Report } from "./p1-report";
import type { DelistedProbeReport } from "./probe";
import type { TickReport } from "./tick";

const stamp = {
  commitSha: "a".repeat(40),
  dataRootHash: null,
  createdAt: "2026-10-10T23:20:00.000Z",
  phaseId: "P1",
};

test("the P1 report freezes the snapshot and does not leave the revision check open", () => {
  const manifest = sealFrozenSnapshot(
    {
      commitSha: stamp.commitSha,
      dataRootHash: "root",
      createdAt: "2026-10-10T22:46:57.932Z",
      updatedAt: "2026-10-10T23:14:12.287Z",
      phaseId: "P1",
      hashAlgorithm: "sha256",
      rootHashInput: "sorted lines of relativePath TAB sha256 LF, UTF-8",
      bunVersion: "1.4.3",
      writerVersion: "1",
      files: [],
    } satisfies DataManifest,
    new Date("2026-10-10T23:20:00.000Z"),
  );
  const coverage = {
    ...stamp,
    dataRootHash: "root",
    productCount: 2,
    products: [
      {
        productId: "00-USD",
        base: "00",
        quote: "USD",
        status: "online",
        statusRaw: "online",
        delisted: false,
        tickSize: "0.0001",
        listingDate: null,
        probe: { sampled: false, candlesServed: null },
        unavailable: null,
        firstNonemptyBar: "2023-10-01T00:09:00.000Z",
        lastNonemptyBar: "2026-10-09T00:00:00.000Z",
        historyLengthDays: "1096",
        months: [{ month: "2023-10", expectedMinutes: 1, storedMinutes: 1, nonemptyMinutes: 1, emptyMinutes: 0, pctNonempty: "100.0000", complete: true }],
      },
      {
        productId: "LRC-USD",
        base: "LRC",
        quote: "USD",
        status: "delisted",
        statusRaw: "delisted",
        delisted: true,
        tickSize: "0.0001",
        listingDate: null,
        probe: { sampled: true, candlesServed: true },
        unavailable: null,
        firstNonemptyBar: null,
        lastNonemptyBar: null,
        historyLengthDays: null,
        months: [],
      },
    ],
  } satisfies CoverageReport;
  const probe = {
    ...stamp,
    note: "sample",
    sampleDays: ["2019-01-01"],
    products: [{ productId: "LRC-USD", status: "delisted", statusRaw: "delisted", candlesServed: true, windows: [] }],
  } satisfies DelistedProbeReport;
  const ticks = {
    ...stamp,
    note: "report only",
    flags: [
      {
        productId: "00-USD",
        tickSize: "0.0001",
        tickField: "quote_increment",
        historyAvailable: false,
        tickMayHaveChanged: true,
        reason: "product payload publishes only the current quote_increment; no tick-size history is in the snapshot",
      },
    ],
  } satisfies TickReport;
  const report = buildP1Report({ stamp, manifest, coverage, probe, ticks });
  expect(report.snapshot.status).toBe("frozen");
  expect(report.revisionCheck).toEqual({
    status: "dropped",
    openItemForHash: false,
    note: expect.stringContaining("not an open item"),
  });
  expect(report.openQuestions.map((item) => item.id)).toEqual(["listing-date", "delisted-trading-life"]);
  expect(report.coverage.products[0]?.yearsOfDownloadedHistory).toBe("3.00");
  expect(report.coverage.products[1]?.yearsOfDownloadedHistory).toBeNull();
  expect(findBannedKeys(report)).toEqual([]);
});
