"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { BacktestResult, CheckStatus } from "@/lib/backtestTypes";
import { fmtUsd } from "@/lib/format";
import styles from "./backtest.module.css";

const API_URL = process.env.NEXT_PUBLIC_PAPER_API_URL ?? "http://localhost:3001";
const MONTHS = [1, 3, 6] as const;
const BOOK_PAIRS = ["UNI-USD", "NEAR-USD", "BCH-USD", "SUI-USD", "AVAX-USD", "ARB-USD"];

const MONTH_LABEL: Record<(typeof MONTHS)[number], string> = {
  1: "1 month",
  3: "3 months",
  6: "6 months",
};

function tone(n: number): string {
  if (n > 0) return styles.pos;
  if (n < 0) return styles.neg;
  return "";
}

function bpsPct(bps: number | null | undefined): string {
  if (bps == null || !Number.isFinite(bps)) return "n/a";
  return `${(bps / 100).toFixed(2)}%`;
}

function edgeText(n: number | null | undefined): string {
  if (n == null) return "n/a";
  if (!Number.isFinite(n)) return "no losses";
  return n.toFixed(2);
}

function pct(rate: number | null | undefined): string {
  if (rate == null || !Number.isFinite(rate)) return "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

function fixed(n: number | null | undefined, d = 2): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return n.toFixed(d);
}

function statusClass(status: CheckStatus): string {
  if (status === "pass") return styles.pass;
  if (status === "fail") return styles.fail;
  return styles.unscored;
}

const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayLabel(ts: number): string {
  const d = new Date(ts);
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

export default function BacktestPage() {
  const [months, setMonths] = useState<(typeof MONTHS)[number]>(1);
  const [pair, setPair] = useState(BOOK_PAIRS[0]!);
  const [pairs, setPairs] = useState(BOOK_PAIRS);
  const [data, setData] = useState<BacktestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/`, { cache: "no-store" })
      .then((res) => res.json())
      .then((body: { pairs?: string[] }) => {
        if (!alive || !Array.isArray(body.pairs) || body.pairs.length === 0) return;
        setPairs(body.pairs);
        setPair((current) => (body.pairs!.includes(current) ? current : body.pairs![0]!));
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 90_000);
    fetch(`${API_URL}/backtest?months=${months}&pair=${encodeURIComponent(pair)}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        const body = (await res.json()) as BacktestResult & { error?: string };
        if (!res.ok) throw new Error(body.error ?? "Backtest failed");
        if (alive) setData(body);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setData(null);
        setError(err instanceof Error ? err.message : "Backtest failed");
      })
      .finally(() => {
        clearTimeout(timer);
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
      ctrl.abort();
    };
  }, [months, pair]);

  const recovery =
    data?.score.recoveryBars == null
      ? "not recovered"
      : `${Math.round((data.score.recoveryBars * data.barSec) / 60)} min`;

  return (
    <div className="card">
      <header className={styles.top}>
        <div className={styles.title}>
          <h1>Backtest</h1>
          <span className={styles.sub}>
            {data
              ? `${data.pair} clip $${data.notionalUsd} stop ${data.stopLossBps ?? "-"} bps take profit ${data.takeProfitBps ?? "-"} bps`
              : "Strategy buys and sells against the oracle, then the scorecard."}
          </span>
        </div>
        <Link href="/paper" className={styles.back}>
          Coinbase
        </Link>
      </header>

      <div className={styles.scroll}>
        <div className={styles.windows}>
          {pairs.map((name) => (
            <button
              key={name}
              type="button"
              className={name === pair ? styles.windowOn : styles.window}
              aria-pressed={name === pair}
              onClick={() => setPair(name)}
            >
              {name.replace("-USD", "")}
            </button>
          ))}
        </div>

        <div className={styles.windows}>
          {MONTHS.map((m) => (
            <button
              key={m}
              type="button"
              className={m === months ? styles.windowOn : styles.window}
              aria-pressed={m === months}
              onClick={() => setMonths(m)}
            >
              {MONTH_LABEL[m]}
            </button>
          ))}
        </div>

        {loading && <p className={styles.empty}>Loading {pair} over {MONTH_LABEL[months]} of 5 minute candles.</p>}
        {error && <p className={styles.err}>{error}</p>}

        {data && !loading && (
          <>
            <section className={styles.stats}>
              <div className={styles.stat}>
                <b>Strategy</b>
                <span className={tone(data.strategy.returnUsd)}>{fmtUsd(data.strategy.returnUsd, 2)}</span>
              </div>
              <div className={styles.stat}>
                <b>Oracle</b>
                <span className={tone(data.oracle.returnUsd)}>{fmtUsd(data.oracle.returnUsd, 2)}</span>
              </div>
              <div className={styles.stat}>
                <b>One clip held</b>
                <span className={tone(data.holdUsd)}>{fmtUsd(data.holdUsd, 2)}</span>
              </div>
              <div className={styles.stat}>
                <b>Breakout</b>
                <span className={tone(data.breakout?.returnUsd ?? 0)}>{fmtUsd(data.breakout?.returnUsd ?? 0, 2)}</span>
              </div>
            </section>

            <TradeChart data={data} />

            <Comparison data={data} />

            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Area</th>
                  <th>Metric</th>
                  <th>Target</th>
                  <th>Result</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.score.checks.map((row) => (
                  <tr key={row.metric}>
                    <td>{row.area}</td>
                    <td>{row.metric}</td>
                    <td>{row.target}</td>
                    <td>{row.value}</td>
                    <td className={statusClass(row.status)}>{row.status === "unscored" ? "not scored" : row.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <section className={styles.cols}>
              <div className={styles.col}>
                <h2>Decision quality</h2>
                <Metric label="Hit rate, 1 hour" value={pct(data.score.hitRate1h)} />
                <Metric label="Hit rate, 4 hours" value={pct(data.score.hitRate4h)} />
                <Metric label="Predictions" value={String(data.score.predictions)} />
                <Metric label="Expectancy ratio" value={fixed(data.score.edgeRatio)} />
                <Metric label="Long win rate" value={pct(data.score.edgeWinRate)} />
                <Metric label="Fake break avoidance" value={pct(data.score.avoidance)} />
                <Metric
                  label="Fake breaks taken"
                  value={`${data.score.fakeBreakEntries} of ${data.score.breakoutSignals}`}
                />
              </div>
              <div className={styles.col}>
                <h2>Execution</h2>
                <Metric label="Gross" value={fmtUsd(data.score.grossUsd, 2)} />
                <Metric label="Net" value={fmtUsd(data.score.netUsd, 2)} />
                <Metric label="Net to gross" value={pct(data.score.netToGross)} />
                <Metric label="Maker fees" value={fmtUsd(data.score.makerFeesUsd, 2)} />
                <Metric label="Taker fees" value={fmtUsd(data.score.takerFeesUsd, 2)} />
                <Metric label="Maker fill rate" value="not scored" />
                <Metric label="Slippage vs target" value="not scored" />
              </div>
              <div className={styles.col}>
                <h2>Risk</h2>
                <Metric label="Sortino" value={fixed(data.score.sortino)} />
                <Metric label="Max drawdown" value={pct(data.score.maxDrawdown)} />
                <Metric label="Recovery" value={recovery} />
                <Metric label="SQN" value={fixed(data.score.sqn)} />
                <Metric label="Closed trades" value={String(data.score.trades)} />
                <Metric label="Strategy round trips" value={String(data.strategy.trades)} />
              </div>
            </section>

            <section className={styles.cols}>
              <div className={styles.col}>
                <h2>Opportunity</h2>
                <Metric
                  label="Closest setup"
                  value={
                    data.diagnostics.closestExpectedBps == null
                      ? "no yield check"
                      : `${bpsPct(data.diagnostics.closestExpectedBps)} expected, hurdle ${bpsPct(data.diagnostics.closestHurdleBps)}`
                  }
                />
                <Metric label="Shortfall" value={bpsPct(data.diagnostics.closestGapBps)} />
                <Metric label="Median shortfall" value={bpsPct(data.diagnostics.medianGapBps)} />
                <Metric label="Yield refusals" value={String(data.diagnostics.yieldRefusals)} />
                <Metric
                  label="Candidates per day"
                  value={`${data.diagnostics.candidatesPerDay.toFixed(1)} of which ${data.diagnostics.clearedPerDay.toFixed(1)} clear`}
                />
                <Metric label="Shadow trades" value={String(data.diagnostics.shadowTrades)} />
                <Metric label="Shadow gross" value={fmtUsd(data.diagnostics.shadowGrossUsd, 2)} />
                <Metric label="Shadow net" value={fmtUsd(data.diagnostics.shadowNetUsd, 2)} />
              </div>
              <div className={styles.col}>
                <h2>Fees and fills</h2>
                <Metric label="Net at 50 and 90" value={fmtUsd(data.score.netUsd, 2)} />
                <Metric label="Net at 10 and 10" value={fmtUsd(data.diagnostics.lowFeeNetUsd, 2)} />
                <Metric label="Breakeven round trip" value={bpsPct(data.diagnostics.breakevenRoundTripBps)} />
                {data.diagnostics.feeTiers.map((tier) => (
                  <Metric key={tier.name} label={tier.name} value={`${tier.cleared} clear`} />
                ))}
                <Metric label="Spread" value={data.diagnostics.spreadNote} />
                <Metric label="Queue" value={data.diagnostics.queueNote} />
                <Metric label="Adverse, next hour" value={pct(data.diagnostics.adverseSelection)} />
              </div>
              <div className={styles.col}>
                <h2>Holding period</h2>
                <Metric label="Hit rate, 10 seconds" value={pct(data.diagnostics.hitRate10s)} />
                <Metric label="Hit rate, 1 minute" value={pct(data.diagnostics.hitRate1m)} />
                <Metric label="Hit rate, 5 minutes" value={pct(data.diagnostics.hitRate5m)} />
                <Metric label="Hit rate, 1 hour" value={pct(data.score.hitRate1h)} />
                <Metric label="Expectancy, 10 seconds" value={edgeText(data.diagnostics.edge10s)} />
                <Metric label="Expectancy, 1 minute" value={edgeText(data.diagnostics.edge1m)} />
                <Metric label="Expectancy, 5 minutes" value={edgeText(data.diagnostics.edge5m)} />
                <Metric label="Expectancy, 1 hour" value={edgeText(data.diagnostics.edge1h)} />
              </div>
            </section>

            <div className={styles.note}>
              {data.assumptions.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Comparison({ data }: { data: BacktestResult }) {
  const b = data.breakout;
  const fixedWin = data.strategy.trades > 0 ? data.strategy.wins / data.strategy.trades : null;
  const trailWin = b && b.trades > 0 ? b.wins / b.trades : null;
  const rows: Array<{ label: string; fixed: string; trail: string }> = [
    { label: "Trades", fixed: String(data.score.trades), trail: b ? String(b.trades) : "n/a" },
    { label: "Missed entries", fixed: "n/a", trail: b ? String(b.missedEntries) : "n/a" },
    { label: "Win rate", fixed: pct(fixedWin), trail: pct(trailWin) },
    { label: "Average win", fixed: data.fixedAvgWinUsd == null ? "n/a" : fmtUsd(data.fixedAvgWinUsd, 2), trail: b?.avgWinUsd == null ? "n/a" : fmtUsd(b.avgWinUsd, 2) },
    { label: "Average loss", fixed: data.fixedAvgLossUsd == null ? "n/a" : fmtUsd(data.fixedAvgLossUsd, 2), trail: b?.avgLossUsd == null ? "n/a" : fmtUsd(b.avgLossUsd, 2) },
    { label: "Net at 50 and 90", fixed: fmtUsd(data.score.netUsd, 2), trail: b ? fmtUsd(b.returnUsd, 2) : "n/a" },
    { label: "Net at 10 and 10", fixed: fmtUsd(data.diagnostics.lowFeeNetUsd, 2), trail: b ? fmtUsd(b.lowFeeNetUsd, 2) : "n/a" },
    { label: "Max drawdown", fixed: pct(data.score.maxDrawdown), trail: pct(b?.maxDrawdown) },
    { label: "Longest hold", fixed: `${data.fixedMaxHoldHours.toFixed(1)} h`, trail: b ? `${b.maxHoldHours.toFixed(1)} h` : "n/a" },
  ];
  return (
    <table className={styles.table}>
      <thead>
        <tr>
          <th>Comparison</th>
          <th>Fixed target</th>
          <th>Trailing stop</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <td>{row.label}</td>
            <td>{row.fixed}</td>
            <td>{row.trail}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className={styles.row}>
      <span>{label}</span>
      <b>{value}</b>
    </div>
  );
}

function TradeChart({ data }: { data: BacktestResult }) {
  const w = 960;
  const h = 320;
  const padL = 56;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const prices = data.price;
  if (prices.length < 2) return <p className={styles.empty}>Not enough prices to draw.</p>;

  const breakout = data.breakout;
  const marks = [
    ...data.strategy.buys.map((m) => m.price),
    ...data.strategy.sells.map((m) => m.price),
    ...data.oracle.buys.map((m) => m.price),
    ...data.oracle.sells.map((m) => m.price),
    ...(breakout?.buys.map((m) => m.price) ?? []),
    ...(breakout?.sells.map((m) => m.price) ?? []),
    ...prices.map((p) => p.close),
  ];
  const min = Math.min(...marks);
  const max = Math.max(...marks);
  const span = max - min || 1;
  const t0 = prices[0]!.ts;
  const t1 = prices[prices.length - 1]!.ts;
  const xOf = (ts: number) => padL + ((ts - t0) / Math.max(1, t1 - t0)) * (w - padL - padR);
  const yOf = (px: number) => padT + ((max - px) / span) * (h - padT - padB);

  const step = Math.max(1, Math.ceil(prices.length / 600));
  const line = prices
    .filter((_, i) => i % step === 0 || i === prices.length - 1)
    .map((p, i) => `${i === 0 ? "M" : "L"}${xOf(p.ts).toFixed(1)},${yOf(p.close).toFixed(1)}`)
    .join(" ");

  const ticks = [0, 0.33, 0.66, 1].map((f) => prices[Math.min(prices.length - 1, Math.round(f * (prices.length - 1)))]!.ts);

  return (
    <div className={styles.chart}>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Price with strategy and oracle trades">
        {[0, 0.5, 1].map((f) => {
          const px = min + span * (1 - f);
          const y = yOf(px);
          return (
            <g key={f}>
              <line x1={padL} x2={w - padR} y1={y} y2={y} stroke="#E5E4DF" />
              <text x={4} y={y + 4} fill="#77776F" fontSize="11">
                {px.toFixed(2)}
              </text>
            </g>
          );
        })}
        <path d={line} fill="none" stroke="#0A0A0A" strokeWidth="1.4" />
        {data.oracle.buys.map((m) => (
          <circle key={`ob-${m.ts}`} cx={xOf(m.ts)} cy={yOf(m.price)} r="4" fill="none" stroke="#0FA968" strokeWidth="1.6" />
        ))}
        {data.oracle.sells.map((m) => (
          <circle key={`os-${m.ts}`} cx={xOf(m.ts)} cy={yOf(m.price)} r="4" fill="none" stroke="#E4573D" strokeWidth="1.6" />
        ))}
        {data.strategy.buys.map((m) => (
          <Triangle key={`sb-${m.ts}-${m.price}`} x={xOf(m.ts)} y={yOf(m.price)} up />
        ))}
        {data.strategy.sells.map((m) => (
          <Triangle key={`ss-${m.ts}-${m.price}`} x={xOf(m.ts)} y={yOf(m.price)} up={false} />
        ))}
        {breakout?.buys.map((m) => (
          <rect key={`bb-${m.ts}`} x={xOf(m.ts) - 3} y={yOf(m.price) - 3} width="6" height="6" fill="#0FA968" />
        ))}
        {breakout?.sells.map((m) => (
          <rect key={`bs-${m.ts}`} x={xOf(m.ts) - 3} y={yOf(m.price) - 3} width="6" height="6" fill="#E4573D" />
        ))}
        {ticks.map((ts) => (
          <text key={ts} x={xOf(ts)} y={h - 8} fill="#77776F" fontSize="11" textAnchor="middle">
            {dayLabel(ts)}
          </text>
        ))}
      </svg>
      <div className={styles.legend}>
        <span>
          <i className={`${styles.swatch} ${styles.line}`} /> Price
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.triUp}`} /> Strategy buy
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.triDown}`} /> Strategy sell
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.ringBuy}`} /> Oracle buy
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.ringSell}`} /> Oracle sell
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.sqBuy}`} /> Breakout buy
        </span>
        <span>
          <i className={`${styles.swatch} ${styles.sqSell}`} /> Breakout sell
        </span>
      </div>
    </div>
  );
}

function Triangle({ x, y, up }: { x: number; y: number; up: boolean }) {
  const s = 5;
  const points = up ? `${x},${y - s} ${x - s},${y + s} ${x + s},${y + s}` : `${x},${y + s} ${x - s},${y - s} ${x + s},${y - s}`;
  return <polygon points={points} fill={up ? "#0FA968" : "#E4573D"} />;
}
