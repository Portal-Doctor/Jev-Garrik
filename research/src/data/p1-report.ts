import type { ArtifactStamp } from "../manifest";
import { findBannedKeys } from "./banned";
import type { CoverageReport } from "./coverage";
import { parseDecimal } from "./decimal";
import type { DataManifest } from "./manifest-file";
import type { DelistedProbeReport } from "./probe";
import type { TickReport } from "./tick";

export interface P1Report extends ArtifactStamp {
  snapshot: NonNullable<DataManifest["snapshot"]>;
  revisionCheck: {
    status: "dropped";
    openItemForHash: false;
    note: string;
  };
  openQuestions: { id: string; question: string }[];
  coverage: {
    productCount: number;
    downloadedProductCount: number;
    products: {
      productId: string;
      status: string;
      delisted: boolean;
      downloadedMonths: number;
      firstNonemptyBar: string | null;
      lastNonemptyBar: string | null;
      historyLengthDays: string | null;
      yearsOfDownloadedHistory: string | null;
      candlesServed: boolean | null;
    }[];
  };
  delistedProbe: {
    productCount: number;
    candlesServed: number;
    candlesNotServed: number;
    unknown: number;
    sampleDays: string[];
  };
  tickSize: {
    productCount: number;
    historyAvailable: number;
    tickMayHaveChanged: number;
    tickField: "quote_increment";
  };
}

const REVISION_NOTE =
  "Dropped by owner decision (Brian, 2026-10-10 18:16 CT). No re-download comparison is scheduled. This is not an open item for the hash.";

export function buildP1Report(opts: {
  stamp: ArtifactStamp;
  manifest: DataManifest;
  coverage: CoverageReport;
  probe: DelistedProbeReport;
  ticks: TickReport;
}): P1Report {
  if (opts.manifest.snapshot?.status !== "frozen") throw new Error("snapshot is not frozen");
  const products = opts.coverage.products.map((row) => ({
    productId: row.productId,
    status: row.status,
    delisted: row.delisted,
    downloadedMonths: row.months.filter((month) => month.complete).length,
    firstNonemptyBar: row.firstNonemptyBar,
    lastNonemptyBar: row.lastNonemptyBar,
    historyLengthDays: row.historyLengthDays,
    yearsOfDownloadedHistory: yearsFromDaySpan(row.historyLengthDays),
    candlesServed: row.probe.candlesServed,
  }));
  const report: P1Report = {
    commitSha: opts.stamp.commitSha,
    dataRootHash: opts.manifest.dataRootHash,
    createdAt: opts.stamp.createdAt,
    phaseId: opts.stamp.phaseId,
    snapshot: opts.manifest.snapshot,
    revisionCheck: {
      status: "dropped",
      openItemForHash: false,
      note: REVISION_NOTE,
    },
    openQuestions: [
      {
        id: "listing-date",
        question:
          "The exchange products payload has no listing timestamp. Advanced Trade new_at is 2023-01-01T00:00:00Z for names listed years earlier, so it was not used. Every downloaded window starts at 2023-10-01T00:00:00.000Z.",
      },
      {
        id: "delisted-trading-life",
        question:
          "Delisted products have no listing or delist time in the payload. The probe requested fixed sample windows (2019-01-01, 2021-01-01, 2023-10-01, 2025-01-01, and the latest completed UTC day). It does not decide whether candles exist across a product's whole trading life.",
      },
    ],
    coverage: {
      productCount: products.length,
      downloadedProductCount: products.filter((row) => row.downloadedMonths > 0).length,
      products,
    },
    delistedProbe: {
      productCount: opts.probe.products.length,
      candlesServed: opts.probe.products.filter((row) => row.candlesServed === true).length,
      candlesNotServed: opts.probe.products.filter((row) => row.candlesServed === false).length,
      unknown: opts.probe.products.filter((row) => row.candlesServed == null).length,
      sampleDays: opts.probe.sampleDays,
    },
    tickSize: {
      productCount: opts.ticks.flags.length,
      historyAvailable: opts.ticks.flags.filter((flag) => flag.historyAvailable).length,
      tickMayHaveChanged: opts.ticks.flags.filter((flag) => flag.tickMayHaveChanged).length,
      tickField: "quote_increment",
    },
  };
  const banned = findBannedKeys(report);
  if (banned.length > 0) throw new Error(`p1 report has banned fields: ${banned.join(", ")}`);
  const revisionOpen = report.openQuestions.some((item) => item.id.includes("revision"));
  if (revisionOpen || report.revisionCheck.openItemForHash) throw new Error("revision check must not be an open item");
  return report;
}

function yearsFromDaySpan(dayText: string | null): string | null {
  if (dayText == null) return null;
  const days = parseDecimal(dayText);
  if (days.mag === 0n) return "0.00";
  const numer = days.mag * 400n;
  const denom = 1461n * 10n ** BigInt(days.scale);
  const hundredths = numer / denom;
  const whole = hundredths / 100n;
  const frac = (hundredths % 100n).toString().padStart(2, "0");
  return days.neg ? `-${whole}.${frac}` : `${whole}.${frac}`;
}
