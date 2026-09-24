import type { FillRow, Store } from "./db/store";

const EPS = 1e-12;

export interface TaxLine {
  id: string;
  tradedAt: number;
  pair: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  notionalUsd: number;
  feeUsd: number;
  realizedUsd: number;
  kind: "open" | "close" | "flip";
  liquidity: "maker" | "taker";
  source: string;
}

export interface TaxLot {
  pair: string;
  openedAt: number;
  closedAt: number;
  side: "long" | "short";
  size: number;
  costBasisUsd: number;
  proceedsUsd: number;
  realizedUsd: number;
  holdMs: number;
}

export interface TaxPair {
  pair: string;
  fills: number;
  proceedsUsd: number;
  costBasisUsd: number;
  feesUsd: number;
  realizedUsd: number;
  openSize: number;
  openSide: "long" | "short" | "flat";
  openCostUsd: number;
}

export interface TaxMonth {
  month: string;
  fills: number;
  proceedsUsd: number;
  costBasisUsd: number;
  feesUsd: number;
  realizedUsd: number;
}

export interface TaxReport {
  generatedAt: number;
  venue: "paper";
  paper: boolean;
  firstTs: number | null;
  lastTs: number | null;
  inferenceUsd: number;
  gasUsd: number;
  totals: {
    fills: number;
    proceedsUsd: number;
    costBasisUsd: number;
    feesUsd: number;
    realizedUsd: number;
    openLots: number;
    openCostUsd: number;
  };
  pairs: TaxPair[];
  months: TaxMonth[];
  lots: TaxLot[];
  lines: TaxLine[];
}

interface OpenLot {
  openedAt: number;
  side: 1 | -1;
  size: number;
  basisUsd: number;
}

function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function emptyMonth(month: string): TaxMonth {
  return { month, fills: 0, proceedsUsd: 0, costBasisUsd: 0, feesUsd: 0, realizedUsd: 0 };
}

function emptyPair(pair: string): TaxPair {
  return {
    pair,
    fills: 0,
    proceedsUsd: 0,
    costBasisUsd: 0,
    feesUsd: 0,
    realizedUsd: 0,
    openSize: 0,
    openSide: "flat",
    openCostUsd: 0,
  };
}

/**
 * FIFO lot match for tax worksheets. Long lots use cash paid (notional + fee). Short lots use
 * cash received (notional - fee). Realized on a close is proceeds minus allocated basis.
 */
export function buildTax(
  fills: FillRow[],
  opts: { venue: "paper"; inferenceUsd?: number; gasUsd?: number },
): TaxReport {
  const ordered = fills.slice().sort((a, b) => Number(a.traded_at) - Number(b.traded_at) || a.id.localeCompare(b.id));
  const books = new Map<string, OpenLot[]>();
  const lots: TaxLot[] = [];
  const lines: TaxLine[] = [];
  const pairMap = new Map<string, TaxPair>();
  const monthMap = new Map<string, TaxMonth>();

  for (const f of ordered) {
    const size = Number(f.size_base);
    const notional = Number(f.notional_usd);
    const fee = Number(f.fee_usd);
    const price = Number(f.price);
    const tradedAt = Number(f.traded_at);
    if (!(size > 0) || !Number.isFinite(notional) || !Number.isFinite(tradedAt)) continue;

    const signed = f.side === "buy" ? size : -size;
    const book = books.get(f.pair) ?? [];
    const pos = book.reduce((s, l) => s + l.side * l.size, 0);
    const sameDir = Math.abs(pos) < EPS || Math.sign(pos) === Math.sign(signed);

    let remaining = size;
    let realized = 0;
    let closedCost = 0;
    let closedProceeds = 0;
    let kind: TaxLine["kind"] = "open";

    if (!sameDir) {
      kind = "close";
      while (remaining > EPS && book.length) {
        const lot = book[0]!;
        const take = Math.min(lot.size, remaining);
        const lotBasis = lot.basisUsd * (take / lot.size);
        let proceeds: number;
        let cost: number;
        let gain: number;
        if (lot.side === 1) {
          proceeds = (notional - fee) * (take / size);
          cost = lotBasis;
          gain = proceeds - cost;
        } else {
          proceeds = lotBasis;
          cost = (notional + fee) * (take / size);
          gain = proceeds - cost;
        }
        realized += gain;
        closedCost += cost;
        closedProceeds += proceeds;
        lots.push({
          pair: f.pair,
          openedAt: lot.openedAt,
          closedAt: tradedAt,
          side: lot.side === 1 ? "long" : "short",
          size: take,
          costBasisUsd: cost,
          proceedsUsd: proceeds,
          realizedUsd: gain,
          holdMs: Math.max(0, tradedAt - lot.openedAt),
        });
        lot.size -= take;
        lot.basisUsd -= lotBasis;
        remaining -= take;
        if (lot.size <= EPS) book.shift();
      }
      if (remaining > EPS) kind = "flip";
    }

    if (remaining > EPS) {
      const frac = remaining / size;
      const basis = f.side === "buy" ? (notional + fee) * frac : (notional - fee) * frac;
      book.push({
        openedAt: tradedAt,
        side: f.side === "buy" ? 1 : -1,
        size: remaining,
        basisUsd: basis,
      });
    }
    books.set(f.pair, book);

    const pair = pairMap.get(f.pair) ?? emptyPair(f.pair);
    pair.fills += 1;
    pair.feesUsd += fee;
    pair.realizedUsd += realized;
    pair.proceedsUsd += closedProceeds;
    pair.costBasisUsd += closedCost;
    pairMap.set(f.pair, pair);

    const mk = monthKey(tradedAt);
    const month = monthMap.get(mk) ?? emptyMonth(mk);
    month.fills += 1;
    month.feesUsd += fee;
    month.realizedUsd += realized;
    month.proceedsUsd += closedProceeds;
    month.costBasisUsd += closedCost;
    monthMap.set(mk, month);

    lines.push({
      id: f.id,
      tradedAt,
      pair: f.pair,
      side: f.side,
      size,
      price,
      notionalUsd: notional,
      feeUsd: fee,
      realizedUsd: realized,
      kind,
      liquidity: f.liquidity,
      source: f.source,
    });
  }

  const pairs = [...pairMap.values()].sort((a, b) => a.pair.localeCompare(b.pair));
  for (const p of pairs) {
    const book = books.get(p.pair) ?? [];
    const signed = book.reduce((s, l) => s + l.side * l.size, 0);
    p.openSize = Math.abs(signed);
    p.openSide = signed > EPS ? "long" : signed < -EPS ? "short" : "flat";
    p.openCostUsd = book.reduce((s, l) => s + l.basisUsd, 0);
  }

  const openLots = [...books.values()].reduce((n, b) => n + b.length, 0);
  const openCostUsd = pairs.reduce((s, p) => s + p.openCostUsd, 0);
  const proceedsUsd = pairs.reduce((s, p) => s + p.proceedsUsd, 0);
  const costBasisUsd = pairs.reduce((s, p) => s + p.costBasisUsd, 0);
  const feesUsd = pairs.reduce((s, p) => s + p.feesUsd, 0);
  const realizedUsd = pairs.reduce((s, p) => s + p.realizedUsd, 0);
  const paper = ordered.every((f) => f.source === "paper_sim");

  return {
    generatedAt: Date.now(),
    venue: opts.venue,
    paper,
    firstTs: ordered[0] ? Number(ordered[0].traded_at) : null,
    lastTs: ordered.length ? Number(ordered[ordered.length - 1]!.traded_at) : null,
    inferenceUsd: opts.inferenceUsd ?? 0,
    gasUsd: opts.gasUsd ?? 0,
    totals: {
      fills: ordered.length,
      proceedsUsd,
      costBasisUsd,
      feesUsd,
      realizedUsd,
      openLots,
      openCostUsd,
    },
    pairs,
    months: [...monthMap.values()].sort((a, b) => a.month.localeCompare(b.month)),
    lots,
    lines,
  };
}

export async function buildTaxFromStore(store: Store, venue: "paper"): Promise<TaxReport> {
  const fills = await store.fillsByVenue(venue);
  const inferenceUsd = await store.inferenceUsdForVenue(venue);
  return buildTax(fills, { venue, inferenceUsd, gasUsd: 0 });
}

function csvCell(value: string | number): string {
  const s = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, "\"\"")}"`;
  return s;
}

function csvDay(ts: number): string {
  const d = new Date(Number(ts));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
}

/** Closed FIFO lots, one row per lot. This is the tax worksheet file. */
export function taxLotsCsv(report: TaxReport, engine = report.venue): string {
  const header = [
    "engine",
    "pair",
    "side",
    "date_acquired",
    "date_sold",
    "held_seconds",
    "size",
    "cost_basis_usd",
    "proceeds_usd",
    "realized_usd",
    "paper",
  ];
  const rows = report.lots.map((l) =>
    [
      engine,
      l.pair,
      l.side,
      csvDay(l.openedAt),
      csvDay(l.closedAt),
      Math.floor(l.holdMs / 1000),
      l.size,
      l.costBasisUsd,
      l.proceedsUsd,
      l.realizedUsd,
      report.paper ? "yes" : "no",
    ]
      .map(csvCell)
      .join(","),
  );
  return `${header.join(",")}\r\n${rows.join("\r\n")}${rows.length ? "\r\n" : ""}`;
}

/** Fill blotter with assigned realized, for the same year slice as the lots file. */
export function taxFillsCsv(report: TaxReport, engine = report.venue): string {
  const header = [
    "engine",
    "pair",
    "side",
    "kind",
    "traded_at_utc",
    "size",
    "price",
    "notional_usd",
    "fee_usd",
    "realized_usd",
    "liquidity",
    "source",
    "paper",
  ];
  const rows = report.lines.map((l) =>
    [
      engine,
      l.pair,
      l.side,
      l.kind,
      new Date(l.tradedAt).toISOString(),
      l.size,
      l.price,
      l.notionalUsd,
      l.feeUsd,
      l.realizedUsd,
      l.liquidity,
      l.source,
      report.paper ? "yes" : "no",
    ]
      .map(csvCell)
      .join(","),
  );
  return `${header.join(",")}\r\n${rows.join("\r\n")}${rows.length ? "\r\n" : ""}`;
}
