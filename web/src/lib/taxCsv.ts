import type { TaxLine, TaxLot, TaxReport } from "./taxTypes";

function csvCell(value: string | number): string {
  const s = typeof value === "number" ? (Number.isFinite(value) ? String(value) : "") : value;
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, "\"\"")}"`;
  return s;
}

function csvDay(ts: number): string {
  const d = new Date(Number(ts));
  return Number.isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : "";
}

export function taxLotsCsv(lots: TaxLot[], engine: string, paper: boolean): string {
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
  const rows = lots.map((l) =>
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
      paper ? "yes" : "no",
    ]
      .map(csvCell)
      .join(","),
  );
  return `${header.join(",")}\r\n${rows.join("\r\n")}${rows.length ? "\r\n" : ""}`;
}

export function taxFillsCsv(lines: TaxLine[], engine: string, paper: boolean): string {
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
  const rows = lines.map((l) =>
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
      paper ? "yes" : "no",
    ]
      .map(csvCell)
      .join(","),
  );
  return `${header.join(",")}\r\n${rows.join("\r\n")}${rows.length ? "\r\n" : ""}`;
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function engineLabel(_venue: TaxReport["venue"]): string {
  return "coinbase";
}
