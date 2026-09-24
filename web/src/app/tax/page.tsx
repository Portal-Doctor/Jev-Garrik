"use client";

import Link from "next/link";
import { fmtUsd } from "@/lib/format";
import { downloadCsv, taxLotsCsv } from "@/lib/taxCsv";
import type { TaxReport } from "@/lib/taxTypes";
import { useTax } from "@/lib/useTax";
import styles from "./tax.module.css";

const PAPER_URL = process.env.NEXT_PUBLIC_PAPER_API_URL ?? "http://localhost:3001";

function tone(n: number): string {
  if (n > 0) return styles.pos;
  if (n < 0) return styles.neg;
  return "";
}

function Stat({ label, value, toneN, big }: { label: string; value: string; toneN?: number; big?: boolean }) {
  return (
    <div className={`${styles.stat} ${big ? styles.statBig : ""}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${toneN == null ? "" : tone(toneN)}`}>{value}</span>
    </div>
  );
}

function EngineFold({
  title,
  href,
  report,
  status,
  apiUrl,
}: {
  title: string;
  href: string;
  report: TaxReport | null;
  status: "loading" | "ok" | "error";
  apiUrl: string;
}) {
  const t = report?.totals;
  return (
    <details className={styles.fold} open>
      <summary>
        <span className={styles.engineHead}>
          <span className={styles.pair}>{title}</span>
          <span className={styles.tag}>{report?.paper ? "paper" : report ? "live fills" : ""}</span>
        </span>
        <span className={styles.sub}>{t ? `${t.fills} fills. ${t.openLots} open lots` : status === "error" ? "unreachable" : "loading"}</span>
        <span className={`${styles.num} ${t ? tone(t.realizedUsd) : ""}`}>{t ? fmtUsd(t.realizedUsd, 4) : "-"}</span>
      </summary>
      <div className={styles.foldBody}>
        {status === "error" && !report ? (
          <p className={styles.sub}>Could not reach {apiUrl}.</p>
        ) : !report ? (
          <p className={styles.sub}>No fills yet.</p>
        ) : (
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Pair</th>
                <th className={styles.num}>Fills</th>
                <th className={styles.num}>Proceeds</th>
                <th className={styles.num}>Cost</th>
                <th className={styles.num}>Fees</th>
                <th className={styles.num}>Realized</th>
                <th>Open</th>
              </tr>
            </thead>
            <tbody>
              {report.pairs.map((p) => (
                <tr key={p.pair}>
                  <td className={styles.pair}>{p.pair}</td>
                  <td className={styles.num}>{p.fills}</td>
                  <td className={styles.num}>{fmtUsd(p.proceedsUsd, 4)}</td>
                  <td className={styles.num}>{fmtUsd(p.costBasisUsd, 4)}</td>
                  <td className={styles.num}>{fmtUsd(p.feesUsd, 4)}</td>
                  <td className={`${styles.num} ${tone(p.realizedUsd)}`}>{fmtUsd(p.realizedUsd, 4)}</td>
                  <td>
                    {p.openSide} {p.openSize.toFixed(4)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className={styles.actions} style={{ marginTop: 10 }}>
          <Link href={href} className={styles.linkBtn}>
            Open worksheet
          </Link>
        </div>
      </div>
    </details>
  );
}

export default function TaxSummaryPage() {
  const paper = useTax(PAPER_URL);
  const realized = paper.report?.totals.realizedUsd ?? 0;
  const proceeds = paper.report?.totals.proceedsUsd ?? 0;
  const cost = paper.report?.totals.costBasisUsd ?? 0;
  const fees = paper.report?.totals.feesUsd ?? 0;
  const fills = paper.report?.totals.fills ?? 0;

  const exportPaper = () => {
    if (!paper.report) return;
    downloadCsv("coinbase-tax-lots.csv", taxLotsCsv(paper.report.lots, "coinbase", paper.report.paper));
  };

  return (
    <div className={`card ${styles.page}`}>
      <header className={styles.top}>
        <div className={styles.title}>
          <h1>Tax worksheet</h1>
          <span className={styles.sub}>FIFO lots after fees. Open a row to drill into pairs.</span>
        </div>
        <div className={styles.actions}>
          <button className={styles.refreshBtn} type="button" onClick={() => paper.refresh()}>
            Refresh
          </button>
          <button className={styles.linkBtn} type="button" disabled={!paper.report} onClick={exportPaper}>
            Export CSV
          </button>
        </div>
      </header>

      <p className={styles.disclaimer}>
        Paper fills are a worksheet only. Do not file them. Export CSV downloads closed Coinbase lots.
        Open the worksheet for the fill blotter and year filter.
      </p>

      <section className={styles.summary}>
        <Stat label="Realized" value={fmtUsd(realized, 4)} toneN={realized} big />
        <Stat label="Proceeds" value={fmtUsd(proceeds, 4)} />
        <Stat label="Cost basis" value={fmtUsd(cost, 4)} />
        <Stat label="Fees" value={fmtUsd(fees, 4)} toneN={fees ? -1 : 0} />
        <Stat label="Fills" value={String(fills)} />
      </section>

      <section className={styles.block}>
        <h2>Coinbase</h2>
        <EngineFold title="Coinbase" href="/tax/paper" report={paper.report} status={paper.status} apiUrl={PAPER_URL} />
      </section>
    </div>
  );
}
