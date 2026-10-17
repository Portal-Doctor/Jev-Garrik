import { headers } from "next/headers";
import { dashboardAccess, monthCommands, commandBudget, openDashboardKv, projectionTone, readP6Page } from "../../../../research/src/p6/dashboard-read";
import { closedNote, concentrationText, drawdownText, formatCt, PNL_START_USD, signedPct, signedUsd, tileMarkedGrey, wlText, type PnlBlock } from "../../../../research/src/p6/pnl-block";
import {
  ageText,
  CASH_LABEL,
  ENTRY_FEE_NOTE,
  formatUsd,
  MARK_FALLBACK,
  positionsFooter,
  positionsSectionCopy,
  STABLECOIN_NOTE,
  type PositionSnap,
} from "../../../../research/src/p6/positions-view";
import { RunClock } from "./countdown";
import styles from "../paper/paper.module.css";

export const dynamic = "force-dynamic";

function usd(value: unknown): string {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return "-";
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}`;
}

function jevUsd(value: unknown): string {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n)) return "-";
  return `$${n.toFixed(4)}`;
}

function toneOf(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(n) || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

function Stat({ label, value, tone, big, muted }: { label: string; value: string; tone?: number; big?: boolean; muted?: boolean }) {
  const cls = muted ? styles.muted : tone === undefined ? "" : tone > 0 ? styles.pos : tone < 0 ? styles.neg : "";
  return (
    <div className={`${styles.stat} ${big ? styles.statBig : ""}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={`${styles.statValue} ${cls}`}>{value}</span>
    </div>
  );
}

function barColor(tone: "green" | "amber" | "yellow" | "red"): string {
  if (tone === "green") return "#4ade80";
  if (tone === "amber" || tone === "yellow") return "#fbbf24";
  return "#f87171";
}

function Meter({ label, text, pct, tone }: { label: string; text: string; pct: number; tone: "green" | "amber" | "yellow" | "red" }) {
  return (
    <div className={styles.stat}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{text}</span>
      <span className={styles.countdownBar} style={{ width: 120 }}>
        <span className={styles.countdownFill} style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: barColor(tone) }} />
      </span>
    </div>
  );
}

function classTone(id: string, drawdownR: number): "green" | "yellow" | "red" {
  if (id === "A" || id === "B") {
    if (drawdownR < 7) return "green";
    if (drawdownR < 10) return "yellow";
    return "red";
  }
  return drawdownR < 5 ? "green" : "red";
}

function PnlStrip({ block }: { block: PnlBlock }) {
  const start = PNL_START_USD.toLocaleString("en-US");
  return (
    <section className={`${styles.pnlBlock} ${block.stale ? styles.pnlStale : ""}`}>
      <div className={styles.pnlHead}>
        <span className={styles.pnlTitle}>PAPER - no capital at risk</span>
        <span className={styles.sub}>{block.paperStartMs == null ? "paper start —" : `paper start ${formatCt(block.paperStartMs, true)}`}</span>
        <span className={styles.sub}>
          last updated {block.lastUpdatedMs == null ? "—" : formatCt(block.lastUpdatedMs, false)}
          {block.stale ? " · stale" : ""}
        </span>
      </div>
      <div className={styles.pnlGrid}>
        {block.tiles.map((tile) => (
          <div key={tile.id} className={`${styles.pnlTile} ${tileMarkedGrey(tile) ? styles.pnlTileGrey : ""}`}>
            <span className={styles.pnlWindow}>{tile.id}</span>
            {tile.status === "no-data" ? (
              <span className={styles.sub}>no data yet</span>
            ) : (
              <>
                <span className={toneClass(tile.totalUsd)}>
                  Total P/L {tile.totalUsd == null ? "-" : signedUsd(tile.totalUsd)} {tile.totalPct == null ? "" : signedPct(tile.totalPct)} of ${start} start
                </span>
                <span className={styles.sub}>
                  realized <span className={toneClass(tile.realizedUsd)}>{tile.realizedUsd == null ? "-" : signedUsd(tile.realizedUsd)}</span>
                  {tile.realizedPct == null ? "" : ` ${signedPct(tile.realizedPct)}`}
                  {" + unrealized "}
                  <span className={toneClass(tile.unrealizedDelta)}>{tile.unrealizedDelta == null ? "-" : signedUsd(tile.unrealizedDelta)}</span>
                </span>
                <span className={styles.sub}>
                  open now: {block.openPositions} positions, unrealized {block.openUnrealized == null ? "-" : signedUsd(block.openUnrealized)}
                </span>
                <span className={styles.sub}>
                  fees paid {tile.feesUsd == null ? "-" : signedUsd(tile.feesUsd)} · spread+slippage paid {tile.spreadSlipUsd == null ? "-" : signedUsd(tile.spreadSlipUsd)} · included above
                </span>
                {tile.tradesUnknown ? (
                  <span>trades unknown</span>
                ) : (
                  <span>
                    {wlText(tile.wins, tile.losses)}
                    {closedNote(tile.closedN) ? ` · ${closedNote(tile.closedN)}` : ""}
                    {tile.hourNote ? ` · ${tile.hourNote}` : ""}
                  </span>
                )}
                <span className={styles.sub}>hourly (may understate the intrahour low) {tile.drawdownUsd == null ? "-" : drawdownText(tile.drawdownUsd)}</span>
                <span className={styles.sub}>{tile.tradesUnknown ? "trades unknown" : concentrationText(tile.concentrationPct)}</span>
                {tile.since ? <span className={styles.sub}>{tile.since}</span> : null}
                {tile.anchorLabel ? <span className={styles.sub}>{tile.anchorLabel}</span> : null}
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function toneClass(value: number | null): string {
  if (value == null || value === 0) return "";
  return value > 0 ? styles.pos : styles.neg;
}

export function PositionsSection({
  last,
  nowMs,
  openUnrealized,
}: {
  last: Record<string, unknown> | null;
  nowMs: number;
  openUnrealized: number | null;
}) {
  const pnl = last && typeof last.pnl === "object" && last.pnl != null ? (last.pnl as { equityUsd?: number; realizedUsd?: number; startingUsd?: number }) : null;
  const reported = Array.isArray(last?.positions);
  const snaps = reported ? (last?.positions as PositionSnap[]) : null;
  const equityUsd = typeof pnl?.equityUsd === "number" ? pnl.equityUsd : 0;
  const realizedUsd = typeof pnl?.realizedUsd === "number" ? pnl.realizedUsd : 0;
  const startingUsd = typeof pnl?.startingUsd === "number" ? pnl.startingUsd : PNL_START_USD;
  const markTs = last && typeof last.end === "number" ? last.end : null;
  const omitted = typeof last?.positionsOmitted === "number" ? last.positionsOmitted : 0;
  const skipped = typeof last?.positionsSkipped === "number" ? last.positionsSkipped : 0;
  const view = positionsFooter({
    snaps,
    nowMs,
    markTs,
    equityUsd,
    realizedUsd,
    unrealizedUsd: openUnrealized ?? 0,
    startingUsd,
    omitted,
    skipped,
  });
  const copy = positionsSectionCopy(view);
  const bad = view.reported && (!view.reconciled || !view.unrealizedMatch || view.problems.length > 0);
  const grey = copy.grey;
  return (
    <section className={`${styles.pnlBlock} ${grey ? styles.pnlStale : ""}`}>
      <div className={styles.pnlHead}>
        <span className={styles.pnlTitle}>POSITIONS</span>
        <span className={styles.sub}>
          as of last run {view.markTs == null ? "—" : formatCt(view.markTs, false)}
          {view.stale ? " · stale" : ""}
        </span>
        <span className={styles.sub}>{ENTRY_FEE_NOTE}</span>
      </div>
      <table className={styles.posTable}>
        <thead>
          <tr>
            {["Pair", "Class", "Qty", "Entry", "Age", "Mark", "Notional", "Unrealized", "Unrealized %", "Initial risk", "Net R", "Stop", "Distance %", "Target"].map((label) => (
              <th key={label} className={styles.posHead}>
                {label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {!view.reported ? (
            <tr>
              <td colSpan={14} className={styles.posCell}>
                {copy.body}
              </td>
            </tr>
          ) : view.empty ? (
            <tr>
              <td colSpan={14} className={styles.posCell}>
                {copy.body}
              </td>
            </tr>
          ) : (
            view.rows.map((row) => (
              <tr key={row.id}>
                <td className={styles.posCell}>{row.product}</td>
                <td className={styles.posCell}>{row.classId}</td>
                <td className={styles.posCell}>{row.units}</td>
                <td className={styles.posCell}>{row.fill}</td>
                <td className={styles.posCell}>{ageText(row.ageMs)}</td>
                <td className={styles.posCell}>
                  {row.mark} {row.markSrc === "entry" ? MARK_FALLBACK : view.markTs == null ? "" : formatCt(view.markTs, false)}
                </td>
                <td className={styles.posCell}>{formatUsd(row.notional)}</td>
                <td className={styles.posCell}>{signedUsd(row.unrealized)}</td>
                <td className={styles.posCell}>{row.unrealizedPct == null ? "-" : signedPct(row.unrealizedPct)}</td>
                <td className={styles.posCell}>{formatUsd(row.risk)}</td>
                <td className={styles.posCell}>{row.netR == null ? "-" : row.netR.toFixed(2)}</td>
                <td className={styles.posCell}>{row.stop}</td>
                <td className={styles.posCell}>{row.stopDistancePct == null ? "-" : `${row.stopDistancePct.toFixed(2)}%`}</td>
                <td className={styles.posCell}>{row.target ?? "—"}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
      {copy.omittedNote ? <p className={styles.sub}>{copy.omittedNote}</p> : null}
      <p className={styles.sub}>
        total active investment {copy.active} · at cost {copy.atCost}
      </p>
      <p className={styles.sub}>est. exit costs {copy.exit} · already deducted in unrealized</p>
      <p className={styles.sub}>
        cash balance {CASH_LABEL} {copy.cash}
      </p>
      <p className={styles.sub}>= equity {copy.equity}</p>
      <p className={bad ? styles.neg : styles.sub}>{copy.check}</p>
      <p className={styles.sub}>{view.riskText}</p>
      {view.clusters.map((cluster) => (
        <p key={cluster.id} className={styles.sub}>
          {cluster.text}
        </p>
      ))}
      <p className={styles.sub}>{STABLECOIN_NOTE}</p>
    </section>
  );
}

/** Read-only. The view token is not the cron secret. Nothing on this page writes Redis. Open with GET /p6; see dashboardAccess. */
export default async function P6DashboardPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const headerList = await headers();
  const query = searchParams ? await searchParams : {};
  const rawToken = query.token;
  const tokenParam = rawToken == null ? null : Array.isArray(rawToken) ? (rawToken[0] ?? "") : rawToken;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (typeof value === "string") params.append(key, value);
    else if (Array.isArray(value)) for (const item of value) params.append(key, item);
  }
  const access = dashboardAccess({
    authorization: headerList.get("authorization"),
    cookieHeader: headerList.get("cookie"),
    tokenParam,
    searchParams: params,
    dashboardToken: process.env.DASHBOARD_TOKEN,
  });
  if (access.action !== "allow") {
    return (
      <main className={styles.top}>
        <h1>P6 paper</h1>
        <p>Unauthorized.</p>
      </main>
    );
  }
  const url = process.env.REDIS_URL;
  if (!url) {
    return (
      <main className={styles.top}>
        <div className={styles.title}>
          <h1>P6 paper</h1>
          <p className={styles.sub}>No snapshot on this instance.</p>
        </div>
      </main>
    );
  }
  const { view, block } = await readP6Page(openDashboardKv(url), Date.now());
  const last = view.lastRun;
  const pnl = (last?.pnl ?? null) as {
    equityUsd?: number;
    realizedUsd?: number;
    unrealizedUsd?: number;
    feesUsd?: number;
    spreadSlipUsd?: number;
    arrivalDelayBps?: number | null;
    feeBps?: { maker?: number; taker?: number };
    book?: { hwmUsd?: number; drawdownUsd?: number; haltUsd?: number; roomUsd?: number };
    classes?: Record<string, { cumR?: number; drawdownR?: number; drawdownUsd?: number; paused?: boolean; killed?: boolean; sizingUsd?: number | null }>;
    pairs?: { productId: string; classId: string; side: string; entry: number | null; stop: number | null; unrealizedUsd: number; realizedUsd: number; feesUsd: number; latched: boolean; roomUsd: number }[];
    classBackstopUsd?: number;
    pairBackstopUsd?: number;
  } | null;
  const rest = (last?.rest ?? {}) as { n?: number; r429?: number; waitedMs?: number };
  const jev = (last?.jev ?? null) as {
    totalUsd?: number;
    todayUsd?: number;
    calls?: number;
    capUsd?: number;
    byReason?: { no_1m_input?: number; not_called?: number; timeout?: number; call_error?: number; invalid_response?: number };
    latency?: { le60?: number; le300?: number; le600?: number; late?: number };
    catchUp?: number;
    catchUpShare?: number;
    catchUpFlag?: boolean;
    skipShare?: number;
    skipStatus?: string;
    skipDays?: number;
    skipScheduled?: number;
    skipLabel?: string;
    legacySkipped?: number;
    legacyPackets?: number;
  } | null;
  const redis = (last?.redis ?? {}) as { cmds?: number; bytes?: number; maxValueBytes?: number };
  const cold = Array.isArray(last?.cold) ? (last.cold as { id?: string; reason?: string }[]) : [];
  const warm = typeof last?.warm === "number" ? last.warm : 0;
  const pending = typeof last?.pending === "number" ? last.pending : 0;
  const completed = (last?.completed ?? null) as { end?: number; cmds?: number } | null;
  const month = monthCommands(typeof completed?.cmds === "number" ? completed.cmds : 0);
  const budget = commandBudget();
  const proj = projectionTone(month);
  const openIds = new Set(view.positions.map((row) => row.productId).filter((id): id is string => Boolean(id)));
  const bookDd = pnl?.book?.drawdownUsd ?? 0;
  const bookTone = bookDd < 800 ? "green" : bookDd < 1600 ? "amber" : "red";
  const healthEnd = typeof completed?.end === "number" ? completed.end : null;
  const gaps24 = view.gaps.filter((gap) => healthEnd == null || (healthEnd - gap.endMs) < 24 * 60 * 60 * 1000);

  return (
    <main>
      <PnlStrip block={block} />
      <PositionsSection last={last} nowMs={Date.now()} openUnrealized={block.openUnrealized} />
      <header className={styles.top}>
        <div className={styles.title}>
          <h1>
            P6 paper <span className={styles.safe}>no capital at risk</span>
          </h1>
          <p className={styles.sub}>
            holder {view.lease?.holder ?? "none"}
            {view.lease ? ` until ${new Date(view.lease.untilMs).toISOString()}` : ""}
            {" · "}
            {typeof last?.outcome === "string" ? last.outcome : "no run"}
            {typeof last?.start === "number" && typeof last?.end === "number" ? ` ${Math.max(0, last.end - last.start)}ms` : ""}
            {" · "}
            warm {warm}/50 · cold {cold.length}
            {cold.length > 0 ? ` [${cold.map((row) => row.id).filter(Boolean).join(",")}]` : ""}
            {" · "}
            pending {pending}
            {" · "}
            gaps {gaps24.length}
          </p>
        </div>
        <RunClock lastEnd={healthEnd} />
      </header>

      <section className={styles.equityStrip}>
        {view.killSwitch ? <span className={`${styles.chip} ${styles.chipDown}`}>kill-switch</span> : <span className={`${styles.chip} ${styles.chipOk}`}>gates clear</span>}
        {pnl?.classes
          ? (["A", "B", "C", "D", "E"] as const).flatMap((id) => {
              const row = pnl.classes?.[id];
              if (!row?.paused && !row?.killed) return [];
              return [
                <span key={id} className={`${styles.chip} ${styles.chipDown}`}>
                  {id} {row.killed ? "killed" : "paused"} ${row.sizingUsd ?? 20}
                </span>,
              ];
            })
          : null}
      </section>

      <section className={styles.equityStrip}>
        <Stat label="Equity" value={usd(pnl?.equityUsd)} tone={toneOf(pnl?.realizedUsd)} big />
        <Stat label="Realized" value={usd(pnl?.realizedUsd)} tone={toneOf(pnl?.realizedUsd)} />
        <Stat label="Unrealized" value={usd(pnl?.unrealizedUsd)} tone={toneOf(pnl?.unrealizedUsd)} />
        <Stat label="Fees" value={usd(pnl?.feesUsd)} />
        <Stat label="Spread + slippage" value={usd(pnl?.spreadSlipUsd)} />
        <Stat label="Arrival delay bps" value={pnl?.arrivalDelayBps == null ? "-" : pnl.arrivalDelayBps.toFixed(2)} muted />
        <Stat label="Fee bps" value={`${pnl?.feeBps?.maker ?? "-"} / ${pnl?.feeBps?.taker ?? "-"}`} />
      </section>

      <section className={styles.equityStrip}>
        <Meter
          label="Book halt"
          text={`$${bookDd.toFixed(0)} / $${pnl?.book?.haltUsd ?? 1600}`}
          pct={(bookDd / (pnl?.book?.haltUsd || 1600)) * 100}
          tone={bookTone}
        />
        {pnl?.classes
          ? (["A", "B", "C", "D", "E"] as const).map((id) => {
              const row = pnl.classes?.[id];
              const dd = row?.drawdownR ?? 0;
              const cap = id === "A" || id === "B" ? 10 : 5;
              return <Meter key={id} label={`${id} drawdown R`} text={`${dd.toFixed(2)}R / ${cap}R`} pct={(dd / cap) * 100} tone={classTone(id, dd)} />;
            })
          : null}
        {pnl?.classes
          ? (["A", "B", "C", "D", "E"] as const).map((id) => {
              const dd = pnl.classes?.[id]?.drawdownR ?? 0;
              const cap = 20;
              const tone = dd >= cap ? "red" : dd >= 10 ? "yellow" : "green";
              return <Meter key={`${id}-kill`} label={`${id} kill R`} text={`${dd.toFixed(2)} / ${cap}R`} pct={(dd / cap) * 100} tone={tone} />;
            })
          : null}
        {pnl?.classes
          ? (["A", "B"] as const).map((id) => {
              const usdDd = pnl.classes?.[id]?.drawdownUsd ?? 0;
              const cap = pnl.classBackstopUsd ?? 1200;
              return (
                <Meter
                  key={`${id}-usd`}
                  label={`${id} $ backstop`}
                  text={`$${usdDd.toFixed(0)} / $${cap}`}
                  pct={(usdDd / cap) * 100}
                  tone={usdDd >= cap ? "red" : usdDd >= cap * 0.7 ? "yellow" : "green"}
                />
              );
            })
          : null}
      </section>

      <section className={styles.equityStrip}>
        <Stat label="REST" value={`${rest.n ?? 0} / 400`} />
        <Stat label="429" value={String(rest.r429 ?? 0)} />
        <Stat label="Applied" value={String(Array.isArray(last?.applied) ? last.applied.length : 0)} />
        <Stat label="Decisions" value={String(last?.decisions ?? 0)} />
        <Stat label="Fills" value={String(last?.fills ?? 0)} />
        <Stat label="Redis cmds" value={String(redis.cmds ?? 0)} />
        <Stat label="Month" value={`${(month / 1_000_000).toFixed(2)}M / ${(budget / 1_000_000).toFixed(0)}M`} tone={proj === "red" ? -1 : proj === "amber" ? 0 : 1} />
        <Stat label="Max value" value={String(redis.maxValueBytes ?? 0)} />
      </section>

      <section className={styles.equityStrip}>
        <Stat label="Jev spend" value={jevUsd(jev?.totalUsd)} />
        <Stat label="Jev today" value={jevUsd(jev?.todayUsd)} />
        <Stat label="Jev calls" value={String(jev?.calls ?? 0)} />
        <Stat label="Jev cap" value={jevUsd(jev?.capUsd)} />
        <Stat label="no_1m_input" value={String(jev?.byReason?.no_1m_input ?? 0)} />
        <Stat label="not_called" value={String(jev?.byReason?.not_called ?? 0)} />
        <Stat label="timeout" value={String(jev?.byReason?.timeout ?? 0)} />
        <Stat label="call_error" value={String(jev?.byReason?.call_error ?? 0)} />
        <Stat label="invalid_response" value={String(jev?.byReason?.invalid_response ?? 0)} />
        <Stat label="latency <=60s" value={String(jev?.latency?.le60 ?? 0)} />
        <Stat label="latency <=300s" value={String(jev?.latency?.le300 ?? 0)} />
        <Stat label="latency <=600s" value={String(jev?.latency?.le600 ?? 0)} />
        <Stat label="latency late" value={String(jev?.latency?.late ?? 0)} />
        <Stat label="catch-up 7d" value={String(jev?.catchUp ?? 0)} />
        <Stat label="catch-up 7d share" value={(jev?.catchUpShare ?? 0).toFixed(3)} />
        <Stat label="catch-up 7d flag" value={jev?.catchUpFlag ? "yes" : "no"} />
        <Stat
          label="skip gate"
          value={jev?.skipLabel ?? "insufficient data (days 0/7, scheduled 0)"}
          tone={jev?.skipStatus === "FLAG" ? -1 : jev?.skipStatus === "PASS" ? 1 : 0}
        />
        <Stat label="skip share 7d" value={(jev?.skipShare ?? 0).toFixed(3)} />
        <Stat label="skip days" value={`${jev?.skipDays ?? 0}/7`} />
        <Stat label="skip scheduled" value={String(jev?.skipScheduled ?? 0)} />
        <Stat label="legacy, excluded" value={`${jev?.legacySkipped ?? 0} skipped / ${jev?.legacyPackets ?? 0} packets`} />
      </section>

      <section style={{ padding: "12px 24px" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr>
              {["Pair", "Class", "Side", "Entry", "Stop", "Unrealized", "Realized", "Fees", "Backstop"].map((label) => (
                <th key={label} style={{ textAlign: "left", padding: "6px 8px", color: "var(--muted)" }}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(pnl?.pairs ?? []).map((row) => {
              const open = row.side === "long" || openIds.has(row.productId);
              return (
                <tr key={row.productId} style={open ? { background: "rgba(74, 222, 128, 0.12)" } : undefined}>
                  <td style={{ padding: "6px 8px" }}>{row.productId}</td>
                  <td style={{ padding: "6px 8px" }}>{row.classId}</td>
                  <td style={{ padding: "6px 8px" }}>{row.side}</td>
                  <td style={{ padding: "6px 8px" }}>{row.entry ?? "-"}</td>
                  <td style={{ padding: "6px 8px" }}>{row.stop ?? "-"}</td>
                  <td style={{ padding: "6px 8px" }}>{usd(row.unrealizedUsd)}</td>
                  <td style={{ padding: "6px 8px" }}>{usd(row.realizedUsd)}</td>
                  <td style={{ padding: "6px 8px" }}>{usd(row.feesUsd)}</td>
                  <td style={{ padding: "6px 8px" }}>{row.latched ? "latched" : `armed $${row.roomUsd.toFixed(0)}`}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      <section className={styles.equityStrip}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Decisions</span>
          <span className={styles.statValue}>{view.emitted.slice(-20).join(", ") || "-"}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Fills</span>
          <span className={styles.statValue}>
            {view.closed
              .slice(-20)
              .map((row) => `${row.productId ?? ""} ${row.classId ?? ""} ${usd(row.netUsd)}`)
              .join(" · ") || "-"}
          </span>
        </div>
      </section>

      {view.incidents.length > 0 ? (
        <section style={{ padding: "0 24px 24px" }}>
          <p className={styles.sub}>{view.incidents.slice(-20).join(" · ")}</p>
        </section>
      ) : null}
    </main>
  );
}
