import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStamp } from "../manifest";
import { findBannedKeys } from "./banned";
import { addDecimal, formatDecimal, parseDecimal, type Decimal } from "./decimal";
import { readUnavailable } from "./download";
import { candleFile, partialFile } from "./paths";
import type { ProbeProductResult } from "./probe";
import type { UsdSpotProduct } from "./products";
import { openPartial, readPairMonth, readPartialMinutes } from "./store";
import { BAR_SEC, DAY_SEC, isoFromSec } from "./time";

export interface CoverageMonth {
  month: string;
  expectedMinutes: number | null;
  storedMinutes: number;
  nonemptyMinutes: number;
  emptyMinutes: number;
  pctNonempty: string | null;
  complete: boolean;
}

export interface CoverageRow {
  productId: string;
  base: string;
  quote: "USD";
  status: UsdSpotProduct["status"];
  statusRaw: string;
  delisted: boolean;
  tickSize: string | null;
  listingDate: null;
  /** Set when a nonempty candle exists. This is not a decided listing date. */
  effectiveListing: "first available candle" | null;
  probe: {
    sampled: boolean;
    candlesServed: boolean | null;
  };
  unavailable: { httpStatus: number; month: string } | null;
  firstNonemptyBar: string | null;
  lastNonemptyBar: string | null;
  historyLengthDays: string | null;
  months: CoverageMonth[];
}

export interface CoverageReport extends ArtifactStamp {
  barSec: number;
  productCount: number;
  products: CoverageRow[];
}

export function buildCoverage(opts: {
  products: readonly UsdSpotProduct[];
  probes: readonly ProbeProductResult[];
  dataDir: string;
  stamp: ArtifactStamp;
}): CoverageReport {
  const probeById = new Map(opts.probes.map((probe) => [probe.productId, probe]));
  const products = opts.products.map((product) => coverageRow(product, probeById.get(product.productId), opts.dataDir));
  const report: CoverageReport = {
    ...opts.stamp,
    barSec: BAR_SEC,
    productCount: products.length,
    products,
  };
  const banned = findBannedKeys(report);
  if (banned.length > 0) throw new Error(`coverage report has banned fields: ${banned.join(", ")}`);
  return report;
}

function coverageRow(product: UsdSpotProduct, probe: ProbeProductResult | undefined, dataDir: string): CoverageRow {
  const stored = readStored(dataDir, product.productId);
  const first = stored.nonempty[0];
  const last = stored.nonempty[stored.nonempty.length - 1];
  return {
    productId: product.productId,
    base: product.base,
    quote: product.quote,
    status: product.status,
    statusRaw: product.statusRaw,
    delisted: product.status === "delisted",
    tickSize: product.tickSize,
    listingDate: null,
    effectiveListing: first == null ? null : "first available candle",
    probe: {
      sampled: probe != null,
      candlesServed: probe ? probe.candlesServed : null,
    },
    unavailable: readUnavailable(dataDir, product.productId),
    firstNonemptyBar: first == null ? null : isoFromSec(first),
    lastNonemptyBar: last == null ? null : isoFromSec(last),
    historyLengthDays: first == null || last == null ? null : formatDecimal(spanDays(last - first)),
    months: stored.months,
  };
}

function spanDays(spanSec: number): Decimal {
  const whole = Math.floor(spanSec / DAY_SEC);
  const rem = spanSec % DAY_SEC;
  const base = parseDecimal(String(whole));
  if (rem === 0) return base;
  const scaled = (BigInt(rem) * 10n ** 8n) / BigInt(DAY_SEC);
  return addDecimal(base, { neg: false, mag: scaled, scale: 8 });
}

function readStored(dataDir: string, pair: string): { months: CoverageMonth[]; nonempty: number[] } {
  const months: CoverageMonth[] = [];
  const nonempty: number[] = [];
  const dir = join(dataDir, "candles", pair);
  if (!existsSync(dir)) return { months, nonempty };
  const monthIds = new Set<string>();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".sqlite")) continue;
    const month = name.replace(/\.partial\.sqlite$/, "").replace(/\.sqlite$/, "");
    if (/^\d{4}-\d{2}$/.test(month)) monthIds.add(month);
  }
  for (const month of [...monthIds].sort()) {
    const canonical = join(dataDir, candleFile(pair, month));
    const partial = join(dataDir, partialFile(pair, month));
    let rows = [] as ReturnType<typeof readPairMonth>["rows"];
    let expected: number | null = null;
    if (existsSync(canonical)) {
      const stored = readPairMonth(canonical);
      rows = stored.rows;
      expected = (Date.parse(stored.meta.windowEnd) - Date.parse(stored.meta.windowStart)) / 60_000;
    } else if (existsSync(partial)) {
      const db = openPartial(partial);
      try {
        rows = readPartialMinutes(db);
      } finally {
        db.close();
      }
    }
    let nonemptyMinutes = 0;
    let emptyMinutes = 0;
    for (const row of rows) {
      if (row.empty) emptyMinutes += 1;
      else {
        nonemptyMinutes += 1;
        nonempty.push(row.minuteSec);
      }
    }
    const complete = expected != null && rows.length === expected;
    months.push({
      month,
      expectedMinutes: expected,
      storedMinutes: rows.length,
      nonemptyMinutes,
      emptyMinutes,
      pctNonempty: complete && expected != null && expected > 0 ? percent(nonemptyMinutes, expected) : null,
      complete,
    });
  }
  nonempty.sort((a, b) => a - b);
  return { months, nonempty };
}

function percent(nonempty: number, expected: number): string {
  const scaled = (BigInt(nonempty) * 1_000_000n) / BigInt(expected);
  const whole = scaled / 10_000n;
  const frac = (scaled % 10_000n).toString().padStart(4, "0");
  return `${whole}.${frac}`;
}
