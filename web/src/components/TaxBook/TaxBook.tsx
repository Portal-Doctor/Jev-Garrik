"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { fmtUsd } from "@/lib/format";
import { downloadCsv, engineLabel, taxFillsCsv, taxLotsCsv } from "@/lib/taxCsv";
import type { TaxLine, TaxLot, TaxMonth, TaxPair, TaxReport } from "@/lib/taxTypes";
import styles from "../../app/tax/tax.module.css";

function tone(n: number): string {
  if (n > 0) return styles.pos;
  if (n < 0) return styles.neg;
  return "";
}

function fmtWhen(ts: number): string {
  const d = new Date(Number(ts));
  if (!Number.isFinite(d.getTime())) return "-";
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

function fmtHold(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function yearOf(month: string): string {
  return month.slice(0, 4);
}

function filterReport(report: TaxReport, year: string | "all"): {
  months: TaxMonth[];
  pairs: TaxPair[];
  lines: TaxLine[];
  lots: TaxLot[];
  fills: number;
  proceedsUsd: number;
  costBasisUsd: number;
  feesUsd: number;
  realizedUsd: number;
} {
  const months = year === "all" ? report.months : report.months.filter((m) => yearOf(m.month) === year);
  const lines = year === "all" ? report.lines : report.lines.filter((l) => String(new Date(Number(l.tradedAt)).getUTCFullYear()) === year);
  const lots = year === "all" ? report.lots : report.lots.filter((l) => String(new Date(Number(l.closedAt)).getUTCFullYear()) === year);
  const pairNames = new Set(lines.map((l) => l.pair));
  const pairs = report.pairs
    .filter((p) => pairNames.has(p.pair))
    .map((p) => {
      const pl = lines.filter((l) => l.pair === p.pair);
      const cl = lots.filter((l) => l.pair === p.pair);
      return {
        ...p,
        fills: pl.length,
        feesUsd: pl.reduce((s, l) => s + l.feeUsd, 0),
        realizedUsd: pl.reduce((s, l) => s + l.realizedUsd, 0),
        proceedsUsd: cl.reduce((s, l) => s + l.proceedsUsd, 0),
        costBasisUsd: cl.reduce((s, l) => s + l.costBasisUsd, 0),
      };
    });
  return {
    months,
    pairs,
    lines,
    lots,
    fills: lines.length,
    proceedsUsd: lots.reduce((s, l) => s + l.proceedsUsd, 0),
    costBasisUsd: lots.reduce((s, l) => s + l.costBasisUsd, 0),
    feesUsd: lines.reduce((s, l) => s + l.feeUsd, 0),
    realizedUsd: lines.reduce((s, l) => s + l.realizedUsd, 0),
  };
}

function Stat({ label, value, toneN, big }: { label: string; value: string; toneN?: number; big?: boolean }) {
  return (
    <div className={`${styles.stat} ${big ? styles.statBig : ""}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${toneN == null ? "" : tone(toneN)}`}>{value}</span>
    </div>
  );
}

function FillTable({ lines }: { lines: TaxLine[] }) {
  if (!lines.length) return <p className={styles.sub}>No fills in this slice.</p>;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>When</th>
          <th>Pair</th>
          <th>Side</th>
          <th>Kind</th>
          <th className={styles.num}>Size</th>
          <th className={styles.num}>Price</th>
          <th className={styles.num}>Notional</th>
          <th className={styles.num}>Fee</th>
          <th className={styles.num}>Realized</th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l) => (
          <tr key={l.id}>
            <td>{fmtWhen(l.tradedAt)}</td>
            <td className={styles.pair}>{l.pair}</td>
            <td>{l.side}</td>
            <td>{l.kind}</td>
            <td className={styles.num}>{l.size.toFixed(4)}</td>
            <td className={styles.num}>{l.price.toFixed(6)}</td>
            <td className={styles.num}>{fmtUsd(l.notionalUsd, 4)}</td>
            <td className={styles.num}>{fmtUsd(l.feeUsd, 4)}</td>
            <td className={`${styles.num} ${tone(l.realizedUsd)}`}>{fmtUsd(l.realizedUsd, 4)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LotTable({ lots }: { lots: TaxLot[] }) {
  if (!lots.length) return <p className={styles.sub}>No closed lots in this slice.</p>;
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Pair</th>
          <th>Side</th>
          <th>Opened</th>
          <th>Closed</th>
          <th>Held</th>
          <th className={styles.num}>Size</th>
          <th className={styles.num}>Cost</th>
          <th className={styles.num}>Proceeds</th>
          <th className={styles.num}>Realized</th>
        </tr>
      </thead>
      <tbody>
        {lots.map((l, i) => (
          <tr key={`${l.pair}-${l.openedAt}-${l.closedAt}-${i}`}>
            <td className={styles.pair}>{l.pair}</td>
            <td>{l.side}</td>
            <td>{fmtWhen(l.openedAt)}</td>
            <td>{fmtWhen(l.closedAt)}</td>
            <td>{fmtHold(l.holdMs)}</td>
            <td className={styles.num}>{l.size.toFixed(4)}</td>
            <td className={styles.num}>{fmtUsd(l.costBasisUsd, 4)}</td>
            <td className={styles.num}>{fmtUsd(l.proceedsUsd, 4)}</td>
            <td className={`${styles.num} ${tone(l.realizedUsd)}`}>{fmtUsd(l.realizedUsd, 4)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TaxBook({
  title,
  report,
  status,
  updatedAt,
  apiUrl,
  refresh,
  detailHref,
}: {
  title: string;
  report: TaxReport | null;
  status: "loading" | "ok" | "error";
  updatedAt: number | null;
  apiUrl: string;
  refresh: () => void;
  detailHref?: string;
}) {
  const years = useMemo(() => {
    const set = new Set((report?.months ?? []).map((m) => yearOf(m.month)));
    return ["all", ...[...set].sort().reverse()] as Array<"all" | string>;
  }, [report]);
  const [year, setYear] = useState<"all" | string>("all");
  const slice = report ? filterReport(report, year) : null;

  return (
    <div className={`card ${styles.page}`}>
      <header className={styles.top}>
        <div className={styles.title}>
          <h1>{title}</h1>
          <span className={styles.sub}>
            FIFO lots after fees. Paper rows stay on this worksheet until a live fill exists.
          </span>
        </div>
        <div className={styles.actions}>
          <span className={styles.updated}>
            {status === "error" && !report ? "backend unreachable" : updatedAt ? `updated ${new Date(updatedAt).toLocaleTimeString()}` : "loading"}
          </span>
          <button className={styles.refreshBtn} onClick={refresh} type="button">
            Refresh
          </button>
          <button
            className={styles.linkBtn}
            type="button"
            disabled={!slice}
            title="Closed FIFO lots for the selected year"
            onClick={() => {
              if (!report || !slice) return;
              const engine = engineLabel(report.venue);
              const suffix = year === "all" ? "" : `-${year}`;
              downloadCsv(`${engine}-tax-lots${suffix}.csv`, taxLotsCsv(slice.lots, engine, report.paper));
            }}
          >
            Export CSV
          </button>
          <button
            className={styles.refreshBtn}
            type="button"
            disabled={!slice}
            title="Fill blotter with assigned realized"
            onClick={() => {
              if (!report || !slice) return;
              const engine = engineLabel(report.venue);
              const suffix = year === "all" ? "" : `-${year}`;
              downloadCsv(`${engine}-tax-fills${suffix}.csv`, taxFillsCsv(slice.lines, engine, report.paper));
            }}
          >
            Export fills
          </button>
          {detailHref && (
            <Link href={detailHref} className={styles.linkBtn}>
              Open engine
            </Link>
          )}
        </div>
      </header>

      {status === "error" && !report ? (
        <p className={styles.note}>Could not reach {apiUrl}. Start the engine and refresh.</p>
      ) : !report || !slice ? (
        <p className={styles.note}>Waiting for the first fill. The worksheet fills in as paper trades close.</p>
      ) : (
        <>
          <p className={styles.disclaimer}>
            {report.paper
              ? "These are paper fills. Do not file them. The layout is the live worksheet: proceeds, cost basis, fees, gas, and inference."
              : "FIFO worksheet from venue fills. Confirm lots against broker records before any filing."}
          </p>

          {years.length > 2 && (
            <div className={styles.years}>
              {years.map((y) => (
                <button
                  key={y}
                  type="button"
                  className={`${styles.year} ${year === y ? styles.yearOn : ""}`}
                  onClick={() => setYear(y)}
                >
                  {y === "all" ? "All years" : y}
                </button>
              ))}
            </div>
          )}

          <section className={styles.summary}>
            <Stat label="Realized" value={fmtUsd(slice.realizedUsd, 4)} toneN={slice.realizedUsd} big />
            <Stat label="Proceeds" value={fmtUsd(slice.proceedsUsd, 4)} />
            <Stat label="Cost basis" value={fmtUsd(slice.costBasisUsd, 4)} />
            <Stat label="Fees" value={fmtUsd(slice.feesUsd, 4)} toneN={slice.feesUsd ? -1 : 0} />
            <Stat label="Inference" value={fmtUsd(report.inferenceUsd, 4)} toneN={report.inferenceUsd ? -1 : 0} />
            <Stat label="Gas" value={fmtUsd(report.gasUsd, 4)} toneN={report.gasUsd ? -1 : 0} />
            <Stat label="Fills" value={String(slice.fills)} />
            <Stat label="Open lots" value={String(year === "all" ? report.totals.openLots : "-")} />
          </section>

          <section className={styles.block}>
            <h2>Months. Open a row for fills.</h2>
            {slice.months.length === 0 && <p className={styles.sub}>No months yet.</p>}
            {slice.months.map((m) => (
              <details key={m.month} className={styles.fold}>
                <summary>
                  <span className={styles.pair}>{m.month}</span>
                  <span className={styles.sub}>{m.fills} fills</span>
                  <span className={`${styles.num} ${tone(m.realizedUsd)}`}>{fmtUsd(m.realizedUsd, 4)}</span>
                </summary>
                <div className={styles.foldBody}>
                  <FillTable lines={slice.lines.filter((l) => `${new Date(l.tradedAt).getUTCFullYear()}-${String(new Date(l.tradedAt).getUTCMonth() + 1).padStart(2, "0")}` === m.month)} />
                </div>
              </details>
            ))}
          </section>

          <section className={styles.block}>
            <h2>Pairs. Open a row for fills.</h2>
            {slice.pairs.length === 0 && <p className={styles.sub}>No pairs yet.</p>}
            {slice.pairs.map((p) => (
              <details key={p.pair} className={styles.fold}>
                <summary>
                  <span className={styles.pair}>{p.pair}</span>
                  <span className={styles.sub}>
                    {p.fills} fills. Open {p.openSide} {p.openSize.toFixed(4)}
                  </span>
                  <span className={`${styles.num} ${tone(p.realizedUsd)}`}>{fmtUsd(p.realizedUsd, 4)}</span>
                </summary>
                <div className={styles.foldBody}>
                  <FillTable lines={slice.lines.filter((l) => l.pair === p.pair)} />
                </div>
              </details>
            ))}
          </section>

          <section className={styles.block}>
            <h2>Closed lots</h2>
            <LotTable lots={slice.lots} />
          </section>
        </>
      )}
    </div>
  );
}
