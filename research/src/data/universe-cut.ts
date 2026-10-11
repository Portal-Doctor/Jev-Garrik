/**
 * Pure universe cut. Reads the stats snapshot. Does not fetch.
 * Brian, 2026-10-11 01:19 UTC: the rank cutoff is not part of the rule.
 * The 56 names below were dropped by that cutoff and are added back.
 */

import { assertNoBannedKeys } from "./banned";
import { addDecimal, compareDecimal, formatDecimal, parseDecimal, type Decimal } from "./decimal";
import { OHLC_NOTE, type ProductStatsFile, type ProductStatRow } from "./product-stats";

export const NEGLIGIBLE_QUOTE_VOLUME_30D = "1000000";
export const FLAT_RANGE_24H_BELOW = "0.005";
export const ERRATIC_RANGE_24H_ABOVE = "0.5";

/** Names the rank cutoff dropped. Brian added every one of them back. */
export const READDED_BELOW_RANK_CUTOFF = [
  "AERGO-USD",
  "AGLD-USD",
  "AI-USD",
  "ARKM-USD",
  "ASM-USD",
  "AUCTION-USD",
  "AWE-USD",
  "BARD-USD",
  "BIGTIME-USD",
  "BLUR-USD",
  "BTRST-USD",
  "DEGEN-USD",
  "DIEM-USD",
  "DOOD-USD",
  "ELA-USD",
  "FIDA-USD",
  "FIGHT-USD",
  "FUN1-USD",
  "GODS-USD",
  "GROVE-USD",
  "GST-USD",
  "HOPR-USD",
  "ICNT-USD",
  "IMU-USD",
  "INDEX-USD",
  "INX-USD",
  "IRYS-USD",
  "KAVA-USD",
  "KNC-USD",
  "LINEA-USD",
  "LQTY-USD",
  "MATH-USD",
  "MEZO-USD",
  "MLN-USD",
  "NEX-USD",
  "NOICE-USD",
  "OCEAN-USD",
  "OPN-USD",
  "OSMO-USD",
  "PERP-USD",
  "PLU-USD",
  "POLS-USD",
  "RECALL-USD",
  "RPL-USD",
  "SAPIEN-USD",
  "SD-USD",
  "SHPING-USD",
  "SUKU-USD",
  "SUP-USD",
  "SYND-USD",
  "TNSR-USD",
  "VOXEL-USD",
  "WAL-USD",
  "WHUF-USD",
  "ZETACHAIN-USD",
  "ZKP-USD",
] as const;

const CUT_RULE =
  "Public GET /products/{id}/stats from the committed product-stats.json snapshot. Stats are not re-fetched. quote_volume_30d = volume_30day × last. range_24h = (high − low) / last, compared by cross-multiplication so the ratio is not rounded. Drop HTTP responses that are not 200 (no-30-day-stats). Drop quote_volume_30d < 1000000 (negligible-volume). Drop last = 0 or range_24h < 0.005 (flat-price). Drop range_24h > 0.5 (erratic-price). There is no rank cutoff. Names are not hand-picked. Brian (2026-10-11 01:19 UTC) adds back the 56 names the earlier rank cutoff had dropped.";

export interface CutRow {
  productId: string;
  reason: string;
  quoteVolume30d: string | null;
  range24h: string | null;
}

export interface OwnerDecisionFile {
  entries: [
    {
      id: "granularity";
      owner: "Brian";
      decidedAt: string;
      granularitySec: 900;
      note: string;
    },
    {
      id: "window";
      owner: "Brian";
      decidedAt: string;
      windowDays: 365;
      windowStart: string;
      windowEnd: string;
      note: string;
    },
    {
      id: "universe-cut";
      owner: "Brian";
      decidedAt: string;
      rule: string;
      ohlcNote: string;
      thresholds: {
        negligibleQuoteVolume30d: string;
        flatRange24hBelow: string;
        erraticRange24hAbove: string;
      };
      inputs: "research/data/reports/product-stats.json";
      kept: string[];
      dropped: CutRow[];
      readded: CutRow[];
    },
    {
      id: "revision-check";
      owner: "Brian";
      decidedAt: string;
      status: "dropped";
      openItemForHash: false;
      note: string;
    },
  ];
}

export function droppedProductIds(decision: OwnerDecisionFile): string[] {
  const cut = decision.entries.find((entry) => entry.id === "universe-cut");
  if (!cut || cut.id !== "universe-cut") throw new Error("owner decision has no universe cut");
  return cut.dropped.map((row) => row.productId);
}

export function applyUniverseCut(stats: ProductStatsFile): OwnerDecisionFile {
  const kept: string[] = [];
  const dropped: CutRow[] = [];
  const byId = new Map<string, CutRow>();
  for (const row of stats.products) {
    const judged = judgeRow(row);
    if (judged.reason == null) kept.push(row.productId);
    else dropped.push({ productId: row.productId, reason: judged.reason, quoteVolume30d: judged.quoteVolume30d, range24h: judged.range24h });
    byId.set(row.productId, {
      productId: row.productId,
      reason: judged.reason ?? "kept",
      quoteVolume30d: judged.quoteVolume30d,
      range24h: judged.range24h,
    });
  }
  kept.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  dropped.sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
  const readded: CutRow[] = [];
  for (const productId of READDED_BELOW_RANK_CUTOFF) {
    const row = byId.get(productId);
    if (!row) continue;
    if (!kept.includes(productId)) throw new Error(`${productId} was marked re-added but the cut does not keep it`);
    readded.push({ productId, reason: "readded-below-rank-cutoff", quoteVolume30d: row.quoteVolume30d, range24h: row.range24h });
  }
  const decision: OwnerDecisionFile = {
    entries: [
      {
        id: "granularity",
        owner: "Brian",
        decidedAt: "2026-10-10T23:38:00.000Z",
        granularitySec: 900,
        note: "Brian chose fifteen-minute candles. The 5-minute download started at 2026-10-10T23:45:34Z. A 60-second sample from chunk 200 to chunk 800 ran at 9.997 requests/second. 174168 five-minute requests project to 17422 seconds (4.84 hours), past two hours. 59040 fifteen-minute requests at that rate project to 5906 seconds (1.64 hours). The fifteen-minute download then sustained about 7.5 requests/second over its first 16 minutes (7250 chunks). The kept 304-name download ran from 2026-10-11T00:08:14Z to 2026-10-11T01:00:46.608Z at 9.997 requests/second (31515 requests, 3952 pair-month files).",
      },
      {
        id: "window",
        owner: "Brian",
        decidedAt: "2026-10-10T23:38:00.000Z",
        windowDays: 365,
        windowStart: "2025-10-11T00:00:00.000Z",
        windowEnd: "2026-10-11T00:00:00.000Z",
        note: "One year ending at the latest completed UTC day when the kept download ran. The stored window is 2025-10-11T00:00:00.000Z inclusive through 2026-10-11T00:00:00.000Z exclusive.",
      },
      {
        id: "universe-cut",
        owner: "Brian",
        decidedAt: "2026-10-11T01:19:00.000Z",
        rule: CUT_RULE,
        ohlcNote: OHLC_NOTE,
        thresholds: {
          negligibleQuoteVolume30d: NEGLIGIBLE_QUOTE_VOLUME_30D,
          flatRange24hBelow: FLAT_RANGE_24H_BELOW,
          erraticRange24hAbove: ERRATIC_RANGE_24H_ABOVE,
        },
        inputs: "research/data/reports/product-stats.json",
        kept,
        dropped,
        readded,
      },
      {
        id: "revision-check",
        owner: "Brian",
        decidedAt: "2026-10-10T23:16:00.000Z",
        status: "dropped",
        openItemForHash: false,
        note: "Brian dropped P1 task 9, the 24h revision check, on 2026-10-10 18:16 CT. No re-download comparison is scheduled. This is not an open item for the hash.",
      },
    ],
  };
  assertNoBannedKeys(decision, "owner decision");
  return decision;
}

function judgeRow(row: ProductStatRow): { reason: string | null; quoteVolume30d: string | null; range24h: string | null } {
  if (row.httpStatus !== 200 || row.stats == null) return { reason: "no-30-day-stats", quoteVolume30d: null, range24h: null };
  const stats = row.stats;
  if (stats.last == null || stats.high == null || stats.low == null || stats.volume_30day == null) {
    throw new Error(`${row.productId} is missing last, high, low, or volume_30day`);
  }
  const last = parseDecimal(stats.last);
  const high = parseDecimal(stats.high);
  const low = parseDecimal(stats.low);
  const volume = parseDecimal(stats.volume_30day);
  const quote = mul(volume, last);
  const quoteVolume30d = formatDecimal(quote);
  if (last.mag === 0n) return { reason: "flat-price", quoteVolume30d, range24h: null };
  const span = sub(high, low);
  const range24h = truncRatio(span, last, 40);
  if (compareDecimal(quote, parseDecimal(NEGLIGIBLE_QUOTE_VOLUME_30D)) < 0) {
    return { reason: "negligible-volume", quoteVolume30d, range24h };
  }
  if (compareDecimal(span, mul(last, parseDecimal(FLAT_RANGE_24H_BELOW))) < 0) {
    return { reason: "flat-price", quoteVolume30d, range24h };
  }
  if (compareDecimal(span, mul(last, parseDecimal(ERRATIC_RANGE_24H_ABOVE))) > 0) {
    return { reason: "erratic-price", quoteVolume30d, range24h };
  }
  return { reason: null, quoteVolume30d, range24h };
}

function mul(a: Decimal, b: Decimal): Decimal {
  if (a.mag === 0n || b.mag === 0n) return { neg: false, mag: 0n, scale: 0 };
  return { neg: a.neg !== b.neg, mag: a.mag * b.mag, scale: a.scale + b.scale };
}

function sub(a: Decimal, b: Decimal): Decimal {
  return addDecimal(a, { neg: b.mag !== 0n ? !b.neg : false, mag: b.mag, scale: b.scale });
}

function truncRatio(num: Decimal, den: Decimal, places: number): string {
  if (den.mag === 0n) throw new Error("zero denominator");
  const neg = num.neg !== den.neg && num.mag !== 0n;
  const digits = (num.mag * 10n ** BigInt(den.scale + places)) / (den.mag * 10n ** BigInt(num.scale));
  return formatDecimal({ neg, mag: digits, scale: places });
}
