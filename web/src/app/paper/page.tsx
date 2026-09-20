"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePaperFeed } from "@/lib/usePaperFeed";
import { useUptime } from "@/lib/useUptime";
import { fmtUsd } from "@/lib/format";
import type { PaperPosition, PairFeedState, LastDecision, Report, PairReport } from "@/lib/paperTypes";
import styles from "./paper.module.css";

const API_URL = process.env.NEXT_PUBLIC_PAPER_API_URL ?? "http://localhost:3001";

/** Price precision that adapts to the pair's scale (SOL ~113 vs DOGE ~0.08). */
function fmtPrice(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const d = abs >= 100 ? 2 : abs >= 1 ? 3 : abs >= 0.01 ? 5 : 7;
  return n.toFixed(d);
}

const hhLabel = (sec: number) => (sec % 3600 === 0 ? `${sec / 3600}h` : `${Math.round(sec / 60)}m`);

/** Base-asset ticker from a "XRP-USD"-style pair. */
const baseSymbol = (pair: string) => pair.split("-")[0] ?? pair;

/** Coin-quantity precision that adapts to scale (SOL ~9 vs DOGE ~11,000). */
function fmtQty(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const d = abs >= 1000 ? 2 : abs >= 1 ? 4 : 6;
  return n.toFixed(d);
}

type Health = "checking" | "connected" | "disconnected";

/** Poll the backend /health probe; independent of the SSE stream so it reports raw reachability. */
function useHealth(apiUrl: string, everyMs = 15_000): Health {
  const [health, setHealth] = useState<Health>("checking");
  useEffect(() => {
    let alive = true;
    const base = apiUrl.replace(/\/+$/, "");
    const check = async () => {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), 5_000);
      try {
        const res = await fetch(`${base}/health`, { signal: ctrl.signal, cache: "no-store" });
        if (alive) setHealth(res.ok ? "connected" : "disconnected");
      } catch {
        if (alive) setHealth("disconnected");
      } finally {
        clearTimeout(to);
      }
    };
    check();
    const t = setInterval(check, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [apiUrl, everyMs]);
  return health;
}

/** Poll the /report endpoint; returns null until the first successful fetch. */
function useReport(apiUrl: string, everyMs = 20_000): Report | null {
  const [report, setReport] = useState<Report | null>(null);
  useEffect(() => {
    let alive = true;
    const base = apiUrl.replace(/\/+$/, "");
    const load = async () => {
      try {
        const res = await fetch(`${base}/report`);
        if (!res.ok) return;
        const data = (await res.json()) as Report;
        if (alive) setReport(data);
      } catch {
        /* backend may be down; keep last */
      }
    };
    load();
    const t = setInterval(load, everyMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [apiUrl, everyMs]);
  return report;
}

/**
 * Drives the reset button's spinner: shown from the click until the backend has visibly gone
 * down and come back up (via the existing /health poll), which is the real signal the restart
 * completed and the DB flush actually took hold - not just that the fetch resolved. A 30s
 * failsafe clears it either way so the button never spins forever.
 */
function useResetControl(apiUrl: string, health: Health): { resetting: boolean; triggerReset: () => void } {
  const [resetting, setResetting] = useState(false);
  const sawDown = useRef(false);
  const base = apiUrl.replace(/\/+$/, "");

  const triggerReset = () => {
    if (resetting) return;
    if (typeof window !== "undefined" && !window.confirm("Clear all paper trading data? This flushes the database and restarts the service.")) return;
    sawDown.current = false;
    setResetting(true);
    fetch(`${base}/reset`, { method: "POST" }).catch(() => {
      /* the request can fail if the process exits before the response flushes; the health poll below still confirms completion */
    });
  };

  useEffect(() => {
    if (!resetting) return;
    if (health === "disconnected") sawDown.current = true;
    if (sawDown.current && health === "connected") {
      setResetting(false);
      return;
    }
    const failsafe = setTimeout(() => setResetting(false), 30_000);
    return () => clearTimeout(failsafe);
  }, [resetting, health]);

  return { resetting, triggerReset };
}

export default function PaperPage() {
  const feed = usePaperFeed(API_URL);
  const report = useReport(API_URL);
  const health = useHealth(API_URL);
  const uptime = useUptime(feed.meta?.startedAt ?? null);
  const { resetting, triggerReset } = useResetControl(API_URL, health);

  const pairs = feed.meta?.pairs ?? Object.keys(feed.feed);
  const positions = Object.values(feed.positions);

  const totals = useMemo(() => {
    return positions.reduce(
      (a, p) => ({
        equity: a.equity + p.equityUsd,
        realized: a.realized + p.realizedUsd,
        unrealized: a.unrealized + p.unrealizedUsd,
        fees: a.fees + p.feesUsd,
        inference: a.inference + p.inferenceUsd,
      }),
      { equity: 0, realized: 0, unrealized: 0, fees: 0, inference: 0 },
    );
  }, [positions]);

  const reportByPair = useMemo(() => {
    const m: Record<string, PairReport> = {};
    for (const p of report?.pairs ?? []) m[p.pair] = p;
    return m;
  }, [report]);

  return (
    <div className="card">
      <header className={styles.top}>
        <div className={styles.title}>
          <h1>Coinbase Paper Trader</h1>
          <span className={styles.sub}>
            Measuring directional edge after fees. <mark className={styles.safe}>no capital at risk</mark>
          </span>
        </div>
        <div className={styles.meta}>
          <span className={`${styles.badge} ${feed.meta?.model === "mock" ? styles.badgeMock : styles.badgeJev}`}>
            {feed.meta?.model ?? "…"}
          </span>
          <span className={styles.uptime}>{uptime}</span>
          <span
            className={`${styles.chip} ${health === "connected" ? styles.chipOk : health === "disconnected" ? styles.chipDown : styles.chipChecking}`}
            title={`backend ${health} · /health polled every 15s`}
          >
            <i /> backend {health}
          </span>
          <span className={`${styles.dot} ${styles[feed.connection]}`} title={feed.connection}>
            <i /> {feed.connection}
          </span>
          <button type="button" className={styles.resetBtn} onClick={triggerReset} disabled={resetting} title="Flush all paper trading data and restart">
            {resetting && <span className={styles.spinner} />}
            {resetting ? "Restarting…" : "Clear paper trades"}
          </button>
        </div>
      </header>

      <section className={styles.equityStrip}>
        <Stat label="Equity" value={fmtUsd(totals.equity, 2)} big />
        <Stat label="Realized" value={fmtUsd(totals.realized, 2)} tone={totals.realized} />
        <Stat label="Unrealized" value={fmtUsd(totals.unrealized, 2)} tone={totals.unrealized} />
        <Stat label="Fees" value={fmtUsd(-totals.fees, 2)} tone={-1} />
        <Stat label="Inference" value={fmtUsd(-totals.inference, 4)} tone={-1} />
      </section>

      <div className={styles.body}>
        <section className={styles.grid}>
          {pairs.map((pair) => (
            <PairCard
              key={pair}
              feed={feed.feed[pair]}
              position={feed.positions[pair]}
              decision={feed.lastDecision[pair]}
              report={reportByPair[pair]}
              tradedHorizonSec={report?.tradedHorizonSec ?? 14_400}
              notionalUsd={report?.config.notionalUsd ?? 1_000}
              nextTs={feed.nextDecision[pair]}
              decideSec={feed.meta?.decideSec ?? 300}
            />
          ))}
        </section>

        <section className={styles.activity}>
          <div className={styles.panel}>
            <h2>Decisions</h2>
            <ul className={styles.log}>
              {feed.recentDecisions.length === 0 && <li className={styles.empty}>waiting for the first decision…</li>}
              {feed.recentDecisions.map((d) => (
                <li key={d.id}>
                  <span className={styles.logPair}>{d.pair}</span>
                  <span className={`${styles.tag} ${d.action === "buy" ? styles.buy : styles.sell}`}>{d.action}</span>
                  <span className={styles.logMuted}>p(up) {Math.round(d.pBuy * 100)}%</span>
                  <span className={styles.logMono}>{fmtPrice(d.mid)}</span>
                </li>
              ))}
            </ul>
          </div>

          <div className={styles.panel}>
            <h2>Fills</h2>
            <ul className={styles.log}>
              {feed.recentFills.length === 0 && <li className={styles.empty}>no fills yet</li>}
              {feed.recentFills.map((f, i) => (
                <li key={`${f.pair}-${f.ts}-${i}`}>
                  <span className={styles.logPair}>{f.pair}</span>
                  <span className={`${styles.tag} ${f.side === "buy" ? styles.buy : styles.sell}`}>{f.side}</span>
                  <span className={styles.logMuted}>{f.purpose}</span>
                  <span className={`${styles.liq} ${f.liquidity === "maker" ? styles.maker : styles.taker}`}>{f.liquidity}</span>
                  <span className={styles.logMono}>{fmtPrice(f.price)}</span>
                  <span className={styles.logFee}>fee {fmtUsd(f.feeUsd, 4)}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </div>
    </div>
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

function Countdown({ nextTs, decideSec }: { nextTs?: number; decideSec: number }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (now == null || typeof nextTs !== "number") return <span className={styles.countdown}>next …</span>;

  const remainingMs = Math.max(0, nextTs - now);
  const secs = Math.ceil(remainingMs / 1000);
  const pct = decideSec > 0 ? Math.min(100, Math.max(0, ((decideSec - remainingMs / 1000) / decideSec) * 100)) : 0;
  const mm = Math.floor(secs / 60);
  const label = mm > 0 ? `${mm}:${String(secs % 60).padStart(2, "0")}` : `${secs}s`;

  return (
    <span className={styles.countdown} title="time until next decision">
      <span className={styles.countdownBar}>
        <span className={styles.countdownFill} style={{ width: `${pct}%` }} />
      </span>
      next {label}
    </span>
  );
}

function PairCard({
  feed,
  position,
  decision,
  report,
  tradedHorizonSec,
  notionalUsd,
  nextTs,
  decideSec,
}: {
  feed?: PairFeedState;
  position?: PaperPosition;
  decision?: LastDecision;
  report?: PairReport;
  tradedHorizonSec: number;
  /** The configured per-trade notional; a balance under this can't fund the next entry. */
  notionalUsd: number;
  nextTs?: number;
  decideSec: number;
}) {
  const pair = feed?.pair ?? position?.pair ?? decision?.pair ?? "";
  const pBuy = decision?.pBuy ?? 0.5;
  const traded = report?.horizons.find((h) => h.horizonSec === tradedHorizonSec);
  const isLong = position?.position === "long";

  return (
    <article className={styles.pairCard}>
      <div className={styles.pairHead}>
        <span className={styles.pairName}>{pair}</span>
        <span className={`${styles.syncDot} ${feed?.synced ? styles.synced : styles.unsynced}`} title={feed?.synced ? "synced" : "syncing"} />
        <span className={styles.mid}>{fmtPrice(feed?.mid)}</span>
        <span className={styles.spread}>{feed?.spreadBps != null ? `${feed.spreadBps.toFixed(1)} bps` : "—"}</span>
        <Countdown nextTs={nextTs} decideSec={decideSec} />
      </div>

      <div className={styles.probRow}>
        <div className={styles.probBar}>
          <div className={styles.probFill} style={{ width: `${Math.round(pBuy * 100)}%` }} />
        </div>
        <span className={styles.probVal}>p(up) {Math.round(pBuy * 100)}%</span>
      </div>

      <div className={styles.posRow}>
        <span className={`${styles.posTag} ${isLong ? styles.buy : styles.flat}`}>{isLong ? "LONG" : "FLAT"}</span>
        {isLong && position?.entryPrice != null && <span className={styles.posDetail}>@ {fmtPrice(position.entryPrice)}</span>}
        {position && (
          <span className={`${styles.posPnl} ${position.unrealizedUsd >= 0 ? styles.pos : styles.neg}`}>
            {fmtUsd(position.unrealizedUsd + position.realizedUsd, 2)}
          </span>
        )}
        {position?.openOrder && (
          <span className={styles.working} title={`working ${position.openOrder.purpose}`}>
            ↻ {position.openOrder.side} @ {fmtPrice(position.openOrder.price)}
          </span>
        )}
      </div>

      {position && (
        <div className={styles.balRow} title="Base-asset quantity currently held">
          <span className={styles.balLabel}>holdings</span>
          <span className={styles.balValue}>
            {fmtQty(position.sizeBase)} <span className={styles.balOf}>{baseSymbol(pair)}</span>
          </span>
        </div>
      )}

      {position && (
        <div className={styles.balRow} title="Cash available to spend on the next entry, out of this pair's allocated bankroll">
          <span className={styles.balLabel}>balance</span>
          <span className={`${styles.balValue} ${position.cashUsd < notionalUsd ? styles.neg : ""}`}>
            {fmtUsd(position.cashUsd, 2)} <span className={styles.balOf}>/ {fmtUsd(position.bankrollUsd, 0)}</span>
          </span>
          {position.cashUsd < notionalUsd && <span className={styles.balWarn}>low funds</span>}
        </div>
      )}

      {traded && (
        <div className={styles.metricRow}>
          <Metric label={`acc ${hhLabel(tradedHorizonSec)}`} value={traded.n > 0 ? `${(traded.accuracy * 100).toFixed(0)}%` : "—"} />
          <Metric label="wilson↓" value={traded.n > 0 ? `${(traded.wilsonLower * 100).toFixed(0)}%` : "—"} />
          <Metric label="edge" value={traded.n > 0 ? `${traded.edgeBps.toFixed(0)}bps` : "—"} tone={traded.edgeBps} />
          <Metric label="n" value={String(traded.n)} />
        </div>
      )}

      {report && (
        <div className={`${styles.gate} ${report.gate.passes ? styles.gatePass : styles.gateFail}`}>
          {report.gate.passes ? "PROMOTION GATE: PASS" : "GATE: measuring"}
          <span className={styles.gateDetail}>
            net {fmtUsd(report.pnl.netUsd, 2)} · dd {report.maxDrawdownPct.toFixed(1)}%
            {report.pnl.capture != null && ` · capture ${(report.pnl.capture * 100).toFixed(0)}%`}
          </span>
        </div>
      )}
    </article>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const cls = tone === undefined ? "" : tone > 0 ? styles.pos : tone < 0 ? styles.neg : "";
  return (
    <div className={styles.metric}>
      <span className={styles.metricLabel}>{label}</span>
      <span className={`${styles.metricValue} ${cls}`}>{value}</span>
    </div>
  );
}
