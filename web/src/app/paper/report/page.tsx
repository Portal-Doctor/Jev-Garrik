"use client";

import { useEffect, useMemo, useState } from "react";
import type { PairDiagnostics, PairReport, Report } from "@/lib/paperTypes";
import { fmtUsd } from "@/lib/format";
import styles from "./report.module.css";

const API_URL = process.env.NEXT_PUBLIC_PAPER_API_URL ?? "http://localhost:3001";
const hhLabel = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600}h` : `${Math.round(sec / 60)}m`);
const pct = (n: number, d = 1) => `${(n * 100).toFixed(d)}%`;

/** "in 38m" / "in 20h 41m" until the next outcome resolves at a horizon; the resolver sweeps once a minute. */
const fmtNextRead = (at: number | null, now: number): string => {
  if (at == null) return "none pending";
  const ms = at - now;
  if (ms <= 0) return "due now";
  const mins = Math.ceil(ms / 60_000);
  return mins < 60 ? `in ${mins}m` : `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
};

type Status = "loading" | "ok" | "error";

/** Fetch /report on mount and every 20s; keeps the last good report if a refresh fails. */
function useReport(): { report: Report | null; status: Status; updatedAt: number | null; refresh: () => void } {
  const [report, setReport] = useState<Report | null>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    const base = API_URL.replace(/\/+$/, "");
    const load = async () => {
      try {
        const res = await fetch(`${base}/report`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as Report;
        if (alive) {
          setReport(data);
          setStatus("ok");
          setUpdatedAt(Date.now());
        }
      } catch {
        if (alive) setStatus((s) => (s === "loading" ? "error" : s));
      }
    };
    load();
    const t = setInterval(load, 20_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [nonce]);

  return { report, status, updatedAt, refresh: () => setNonce((n) => n + 1) };
}

export default function ReportPage() {
  const { report, status, updatedAt, refresh } = useReport();

  const totals = useMemo(() => {
    const pairs = report?.pairs ?? [];
    const t = pairs.reduce(
      (a, p) => ({
        gross: a.gross + p.pnl.grossUsd,
        fees: a.fees + p.pnl.feesUsd,
        inference: a.inference + p.pnl.inferenceUsd,
        net: a.net + p.pnl.netUsd,
        oracle: a.oracle + p.pnl.oracleUsd,
      }),
      { gross: 0, fees: 0, inference: 0, net: 0, oracle: 0 },
    );
    return { ...t, capture: t.oracle > 0 ? t.gross / t.oracle : null, gatesPassing: pairs.filter((p) => p.gate.passes).length, nPairs: pairs.length };
  }, [report]);

  const th = report?.tradedHorizonSec ?? 14_400;
  const makerTiers = report?.pairs[0]?.makerFeeSensitivity.map((s) => s.makerBps) ?? [50, 25, 10, 0];
  const hasData = (report?.pairs.length ?? 0) > 0;
  // Countdown to the next resolvable outcome at the traded horizon and beyond (4h and 24h by default).
  const nextReads = (report?.nextReads ?? []).filter((r) => r.horizonSec >= th);

  return (
    <div className="card">
      <header className={styles.top}>
        <div className={styles.title}>
          <h1>P&amp;L Report</h1>
          <span className={styles.sub}>
            Realized from the fills ledger, after fees and inference. Traded horizon {hhLabel(th)}
          </span>
        </div>
        <div className={styles.actions}>
          <span className={styles.updated}>
            {status === "error" && !report ? "backend unreachable" : updatedAt ? `updated ${new Date(updatedAt).toLocaleTimeString()}` : "loading…"}
          </span>
          <button className={styles.refreshBtn} onClick={refresh} type="button">
            Refresh
          </button>
        </div>
      </header>

      {status === "error" && !report ? (
        <p className={styles.note}>Could not reach the backend at {API_URL}. Is the engine running?</p>
      ) : !hasData ? (
        <p className={styles.note}>
          No decisions recorded yet, so there is nothing to report. Once the engine has traded and outcomes resolve, the
          P&amp;L breakdown appears here. (Report shape is live. It is simply empty.)
        </p>
      ) : (
        <>
          <section className={styles.summary}>
            <Stat label="Net P&L" value={fmtUsd(totals.net, 2)} tone={totals.net} big />
            <Stat label="Gross (price)" value={fmtUsd(totals.gross, 2)} tone={totals.gross} />
            <Stat label="Fees" value={fmtUsd(-totals.fees, 2)} tone={-1} />
            <Stat label="Inference" value={fmtUsd(-totals.inference, 4)} tone={-1} />
            <Stat label="Capture" value={totals.capture == null ? "-" : pct(totals.capture)} />
            <Stat label="Gates passing" value={`${totals.gatesPassing}/${totals.nPairs}`} />
            {nextReads.map((r) => (
              <Stat key={r.horizonSec} label={`Next ${hhLabel(r.horizonSec)} read`} value={fmtNextRead(r.at, updatedAt ?? Date.now())} />
            ))}
          </section>

          <section className={styles.block}>
            <h2>Per-pair P&amp;L</h2>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th className={styles.num}>Net</th>
                  <th className={styles.num}>Gross</th>
                  <th className={styles.num}>Fees</th>
                  <th className={styles.num}>Inference</th>
                  <th className={styles.num}>Capture</th>
                  <th className={styles.num}>Taker fills</th>
                  <th className={styles.num}>Max DD</th>
                  <th>Gate</th>
                </tr>
              </thead>
              <tbody>
                {report!.pairs.map((p) => (
                  <tr key={p.pair}>
                    <td className={styles.pair}>{p.pair}</td>
                    <td className={`${styles.num} ${p.pnl.netUsd >= 0 ? styles.pos : styles.neg}`}>{fmtUsd(p.pnl.netUsd, 2)}</td>
                    <td className={styles.num}>{fmtUsd(p.pnl.grossUsd, 2)}</td>
                    <td className={styles.num}>{fmtUsd(p.pnl.feesUsd, 2)}</td>
                    <td className={styles.num}>{fmtUsd(p.pnl.inferenceUsd, 4)}</td>
                    <td className={styles.num}>{p.pnl.capture == null ? "-" : pct(p.pnl.capture)}</td>
                    <td className={styles.num}>{pct(p.takerFillShare, 0)}</td>
                    <td className={styles.num}>{p.maxDrawdownPct.toFixed(1)}%</td>
                    <td>
                      <span className={`${styles.gateTag} ${p.gate.passes ? styles.gatePass : styles.gateFail}`}>
                        {p.gate.passes ? "PASS" : "measuring"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className={styles.block}>
            <h2>Directional accuracy, traded horizon {hhLabel(th)}</h2>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th className={styles.num}>n</th>
                  <th className={styles.num}>Accuracy</th>
                  <th className={styles.num}>Wilson 95%</th>
                  <th className={styles.num}>Brier</th>
                  <th className={styles.num}>Edge (bps)</th>
                </tr>
              </thead>
              <tbody>
                {report!.pairs.map((p) => {
                  const h = p.horizons.find((x) => x.horizonSec === th);
                  return (
                    <tr key={p.pair}>
                      <td className={styles.pair}>{p.pair}</td>
                      <td className={styles.num}>{h?.n ?? 0}</td>
                      <td className={styles.num}>{h && h.n > 0 ? pct(h.accuracy) : "-"}</td>
                      <td className={styles.num}>{h && h.n > 0 ? `${pct(h.wilsonLower)} to ${pct(h.wilsonUpper)}` : "-"}</td>
                      <td className={styles.num}>{h && h.n > 0 ? h.brier.toFixed(4) : "-"}</td>
                      <td className={`${styles.num} ${h && h.edgeBps >= 0 ? styles.pos : styles.neg}`}>
                        {h && h.n > 0 ? h.edgeBps.toFixed(1) : "-"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          <section className={styles.block}>
            <h2>Maker-fee sensitivity, net P&amp;L</h2>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Pair</th>
                  {makerTiers.map((bps) => (
                    <th key={bps} className={styles.num}>
                      {bps} bps
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report!.pairs.map((p) => (
                  <tr key={p.pair}>
                    <td className={styles.pair}>{p.pair}</td>
                    {p.makerFeeSensitivity.map((s) => (
                      <td key={s.makerBps} className={`${styles.num} ${s.netUsd >= 0 ? styles.pos : styles.neg}`}>
                        {fmtUsd(s.netUsd, 2)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <HorizonComparison pairs={report!.pairs} />
          <DiagnosticsTable pairs={report!.pairs} />

          <section className={styles.block}>
            <h2>Promotion gate</h2>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>n ≥ 200</th>
                  <th>lower &gt; 52%</th>
                  <th>net &gt; 0</th>
                  <th>DD &lt; 15%</th>
                  <th>incidents &lt; 1/day</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {report!.pairs.map((p) => (
                  <tr key={p.pair}>
                    <td className={styles.pair}>{p.pair}</td>
                    <Check ok={p.gate.resolved200} />
                    <Check ok={p.gate.accuracyLowerAbove52} />
                    <Check ok={p.gate.netPnlPositive} />
                    <Check ok={p.gate.drawdownUnder15} />
                    <Check ok={p.gate.incidentsUnder1PerDay} />
                    <td>
                      <span className={`${styles.gateTag} ${p.gate.passes ? styles.gatePass : styles.gateFail}`}>
                        {p.gate.passes ? "PASS" : "measuring"}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}

function fmtHold(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "-";
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins}m`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function fmtRatio(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "-";
  return n.toFixed(2);
}

function HorizonComparison({ pairs }: { pairs: PairReport[] }) {
  const horizons = pairs[0]?.horizons ?? [];
  if (horizons.length === 0) return null;
  return (
    <section className={styles.block}>
      <h2>Horizon comparison</h2>
      <p className={styles.note}>Scored only. The traded hold stays 4h until a later week picks a winner with n at least 200.</p>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Pair</th>
            {horizons.map((h) => (
              <th key={h.horizonSec} className={styles.num}>
                {hhLabel(h.horizonSec)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {pairs.map((p) => (
            <tr key={p.pair}>
              <td className={styles.pair}>{p.pair}</td>
              {p.horizons.map((h) => (
                <td key={h.horizonSec} className={styles.num}>
                  {h.n > 0 ? `${h.n} / ${h.edgeBps.toFixed(1)} bps` : "-"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function DiagnosticsTable({ pairs }: { pairs: PairReport[] }) {
  const rows = pairs.filter((p): p is PairReport & { diagnostics: PairDiagnostics } => p.diagnostics != null);
  if (rows.length === 0) return null;
  return (
    <section className={styles.block}>
      <h2>Pair diagnostics</h2>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Pair</th>
            <th className={styles.num}>Score</th>
            <th className={styles.num}>Quiet</th>
            <th className={styles.num}>Yield</th>
            <th className={styles.num}>Entries</th>
            <th className={styles.num}>Stops</th>
            <th className={styles.num}>Take profit</th>
            <th className={styles.num}>Hold p50</th>
            <th className={styles.num}>Edge</th>
            <th className={styles.num}>Net</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => {
            const d = p.diagnostics;
            return (
              <tr key={p.pair}>
                <td className={styles.pair}>{p.pair}{d.demote ? " demote" : ""}</td>
                <td className={styles.num}>{d.score}</td>
                <td className={styles.num}>{d.refused.quiet}</td>
                <td className={styles.num}>{d.refused.yield}</td>
                <td className={styles.num}>{d.fills.entry}</td>
                <td className={styles.num}>{d.fills.stop}</td>
                <td className={styles.num}>{d.fills.takeProfit}</td>
                <td className={styles.num}>{fmtHold(d.holdMs.p50)}</td>
                <td className={styles.num}>{fmtRatio(d.edgeRatio)}</td>
                <td className={`${styles.num} ${d.netUsd >= 0 ? styles.pos : styles.neg}`}>{fmtUsd(d.netUsd, 2)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

function Stat({ label, value, tone, big }: { label: string; value: string; tone?: number; big?: boolean }) {
  const cls = tone === undefined ? "" : tone > 0 ? styles.pos : tone < 0 ? styles.neg : "";
  return (
    <div className={`${styles.stat} ${big ? styles.statBig : ""}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${cls}`}>{value}</span>
    </div>
  );
}

function Check({ ok }: { ok: boolean }) {
  return <td className={`${styles.num} ${ok ? styles.pos : styles.neg}`}>{ok ? "✓" : "✗"}</td>;
}
