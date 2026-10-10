import type { ArtifactStamp } from "../manifest";
import { findBannedKeys } from "./banned";
import type { CoverageReport } from "./coverage";
import { parseDecimal } from "./decimal";
import type { DataManifest, SnapshotFreeze, SnapshotLift } from "./manifest-file";
import type { DelistedProbeReport } from "./probe";
import type { TickReport } from "./tick";

export interface P1Report extends ArtifactStamp {
  snapshot: SnapshotFreeze | null;
  snapshotLift: SnapshotLift | null;
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
      effectiveListing: "first available candle" | null;
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
  planDeviations: { id: string; detail: string }[];
  ownerDecision: OwnerDecision | null;
}

export interface OwnerDecision {
  granularitySec: number;
  windowDays: number;
  measuredRequestsPerSec: number;
  fiveMinuteProjectedSec: number;
  fifteenMinuteProjectedSec: number | null;
  choice: string;
  universeCut: {
    rule: string;
    kept: number;
    dropped: { productId: string; reason: string }[];
  } | null;
}

/** Parts of the design or plan that assumed 1m bars or more than one year. Not redesigned. */
export const PLAN_DEVIATIONS: { id: string; detail: string }[] = [
  {
    id: "candle-spec",
    detail:
      "Build plan task 7 asks for public 1m candles from 2023-10-01 through the latest completed day. The stored candles are one year of coarser bars by owner decision.",
  },
  {
    id: "derived-from-1m",
    detail:
      "Build plan task 10 derives 1h, 4h, and daily bars from 1m candles. Those bars are now aggregated from the stored coarser candles. UTC boundary rules are unchanged.",
  },
  {
    id: "empty-1m-liquidity",
    detail:
      "Design §2 and plan task 12 and task 15 use percent non-empty 1m bars over 30 days as a liquidity proxy (threshold 95 percent). Coverage now reports that percent on the stored bar size.",
  },
  {
    id: "trade-through-1m",
    detail:
      "Design §4 and plan task 19 approximate maker trade-through as a 1m low at or below the limit minus one tick, with a 0.5 volume haircut on 1m volume. Class D also cancels a maker after 120 seconds. Neither 5m nor 15m bars can reproduce that path.",
  },
  {
    id: "missing-1m-kill",
    detail:
      "Design §6 kills new entries when at least 5 percent of 1m bars are missing that day. The snapshot has no 1m bars to feed that check.",
  },
  {
    id: "corwin-schultz-1m",
    detail:
      "Design feasibility notes Corwin-Schultz on 1m bars, and the open data question asks for the share of empty 1m bars. Gap 17 later specifies the backtest spread from 1h bars, which can still be derived. The 1m empty-bar share cannot.",
  },
  {
    id: "class-e-15m-trigger",
    detail:
      "Class E enters on a 15m close above anchored VWAP and the latest 15m swing high, within 6 hours of a 1h event. A 1m or 5m store would have to be aggregated to 15m. A native 15m store matches that trigger and cannot rebuild 5m or 1m triggers.",
  },
  {
    id: "walk-forward",
    detail:
      "Design §8 walk-forward is 12 months in-sample to 3 months out-of-sample, stepped 3 months, about 8 out-of-sample quarters, on a target window of Oct 2023 through Oct 2026. One year cannot hold a 15-month fold, so the fold count and the 60 percent-of-folds gate have no layout on this snapshot.",
  },
  {
    id: "listing-and-volume-windows",
    detail:
      "Universe entry requires 90 days listed and a 90-day median daily volume. Both need history before the first eligible day. A window that starts only 365 days before the end has no earlier lookback, so the first 90 days cannot apply those rules as written.",
  },
  {
    id: "ema200-warmup",
    detail:
      "Class A requires daily EMA200, with a fallback only when a name has under 200 days. Class D's locked daily bias also requires 200 daily bars so EMA200 exists. Indicators are warmed on history before fold 1. One year leaves EMA200 defined only after day 200, with no warmup before the window.",
  },
  {
    id: "three-year-scans",
    detail:
      "The agreed history is 3 or more years where it exists. The geometry scan's signal counts, BTC filter shares, and per-pair depth questions are specified on that span. This snapshot is 365 days.",
  },
  {
    id: "class-d-evidence-window",
    detail:
      "Class D evidence is only folds ending before 2026-02-09, plus forward paper. A one-year window ending 2026-10-10 includes the contaminated stretch after that date and only about four months before it.",
  },
  {
    id: "jev-1m-book",
    detail:
      "Jev's packet always includes the live 1m order-book snapshot (1m RSI and the other MarketState fields). That feed is not in this historical candle snapshot. No Jev call is made here.",
  },
];

const REVISION_NOTE =
  "Dropped by owner decision (Brian, 2026-10-10 18:16 CT). No re-download comparison is scheduled. This is not an open item for the hash.";

export function buildP1Report(opts: {
  stamp: ArtifactStamp;
  manifest: DataManifest;
  coverage: CoverageReport;
  probe: DelistedProbeReport;
  ticks: TickReport;
  ownerDecision?: OwnerDecision | null;
}): P1Report {
  const products = opts.coverage.products.map((row) => ({
    productId: row.productId,
    status: row.status,
    delisted: row.delisted,
    downloadedMonths: row.months.filter((month) => month.complete).length,
    firstNonemptyBar: row.firstNonemptyBar,
    lastNonemptyBar: row.lastNonemptyBar,
    historyLengthDays: row.historyLengthDays,
    yearsOfDownloadedHistory: yearsFromDaySpan(row.historyLengthDays),
    effectiveListing: row.effectiveListing,
    candlesServed: row.probe.candlesServed,
  }));
  const report: P1Report = {
    commitSha: opts.stamp.commitSha,
    dataRootHash: opts.manifest.dataRootHash,
    createdAt: opts.stamp.createdAt,
    phaseId: opts.stamp.phaseId,
    snapshot: opts.manifest.snapshot?.status === "frozen" ? opts.manifest.snapshot : null,
    snapshotLift: opts.manifest.snapshotLift ?? null,
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
        id: "effective-listing",
        question:
          "Coverage sets effective_listing to the first available candle when one exists. That flag is not a listing-date decision. Both listing-date questions stay open for Architect.",
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
    planDeviations: PLAN_DEVIATIONS,
    ownerDecision: opts.ownerDecision ?? null,
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
