import { headers } from "next/headers";
import { dashboardAccess, monthCommands, commandBudget, openDashboardKv, projectionTone, readP6Page, summaryFreshness } from "../../../../research/src/p6/dashboard-read";
import {
  closedNote,
  concentrationText,
  drawdownText,
  formatCt,
  PNL_START_USD,
  signedPct,
  signedUsd,
  wlText,
  type PnlTile,
} from "../../../../research/src/p6/pnl-block";
import {
  ageText,
  BOOK_DRAWDOWN_HALT_USD,
  CASH_LABEL,
  classDollarWord,
  ENTRY_FEE_NOTE,
  formatUsd,
  gateBannerLines,
  limitWord,
  MARK_FALLBACK,
  OPEN_RISK_CAP_USD,
  POSITIONS_IDENTITY,
  riskTone,
  positionsFooter,
  positionsSectionCopy,
  STABLECOIN_NOTE,
  type PositionLine,
  type PositionSnap,
  type PositionsView,
} from "../../../../research/src/p6/positions-view";
import { parseSummaryWindow, SUMMARY_WINDOWS } from "../../../../research/src/p6/window-query";
import { RunClock } from "./countdown";
import styles from "./p6.module.css";

export const dynamic = "force-dynamic";

const CLASS_IDS = ["A", "B", "C", "D", "E"] as const;

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function moneyOrDash(value: number | null | undefined, signed = false): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return signed ? signedUsd(value) : formatUsd(value);
}

function hero(value: number | null): { text: string; kind: "pos" | "neg" | "flat" } {
  if (value == null || !Number.isFinite(value)) return { text: "—", kind: "flat" };
  const cents = Math.round(value * 100) / 100;
  if (cents > 0) return { text: `▲ ${signedUsd(cents)}`, kind: "pos" };
  if (cents < 0) return { text: `▼ ${signedUsd(cents)}`, kind: "neg" };
  return { text: signedUsd(0), kind: "flat" };
}

function tone(kind: "pos" | "neg" | "flat", big = false): string {
  const color = kind === "pos" ? styles.pos : kind === "neg" ? styles.neg : "";
  return [big ? styles.big : "", color].filter(Boolean).join(" ");
}

function usedPct(used: number, limit: number): number {
  if (!(limit > 0) || !Number.isFinite(used)) return 0;
  return Math.max(0, Math.min(100, (used / limit) * 100));
}

/** Chip only for a short history, a stale anchor, or unknown trades. Nothing else. */
function partialChip(tile: PnlTile): { label: string; title: string } | null {
  if (tile.status === "no-data") return null;
  const title: string[] = [];
  if (tile.since) title.push(tile.since);
  if (tile.anchorLabel) title.push(tile.anchorLabel);
  if (tile.tradesUnknown) title.push("trades unknown");
  if (title.length === 0) return null;
  const label = tile.since ? "Partial · since start" : tile.anchorLabel ? `Partial · ${tile.anchorLabel}` : "Partial · trades unknown";
  return { label, title: title.join("; ") };
}

function jevUsd(value: unknown): string {
  const n = finite(value);
  if (n == null) return "—";
  return `$${n.toFixed(4)}`;
}

function qtyText(units: number): string {
  if (!Number.isFinite(units)) return "—";
  return units.toLocaleString("en-US", { maximumFractionDigits: 8 });
}

function rText(value: number | null): { text: string; kind: "pos" | "neg" | "flat" } {
  if (value == null || !Number.isFinite(value)) return { text: "—", kind: "flat" };
  const rounded = Math.round(value * 100) / 100;
  if (rounded > 0) return { text: `+${rounded.toFixed(2)}`, kind: "pos" };
  if (rounded < 0) return { text: rounded.toFixed(2), kind: "neg" };
  return { text: "0.00", kind: "flat" };
}

function Badge({ kind, text }: { kind: "ok" | "bad" | "warn"; text: string }) {
  const cls = kind === "ok" ? styles.badgeOk : kind === "bad" ? styles.badgeBad : styles.badgeWarn;
  const mark = kind === "ok" ? "✓" : kind === "bad" ? "✗" : "!";
  return (
    <span className={`${styles.badge} ${cls}`}>
      <span className={styles.badgeMark} aria-hidden="true">
        {mark}
      </span>
      {text}
    </span>
  );
}

function Fold({
  title,
  note,
  badge,
  children,
  open,
  id,
}: {
  title: string;
  note?: string;
  badge?: { kind: "ok" | "bad" | "warn"; text: string };
  children: React.ReactNode;
  open?: boolean;
  id?: string;
}) {
  return (
    <details className={styles.fold} id={id} {...(open ? { open: true } : {})}>
      <summary>
        {title}
        {badge ? <Badge kind={badge.kind} text={badge.text} /> : null}
        {note ? <span className={styles.note}>{note}</span> : null}
      </summary>
      <div className={styles.foldBody}>{children}</div>
    </details>
  );
}

function Kv({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.kv}>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function reconBadge(view: PositionsView): { kind: "ok" | "bad" | "warn"; text: string } {
  if (!view.reported) return { kind: "warn", text: "checks skipped" };
  if (view.omitted > 0 || view.skipped > 0) return { kind: "warn", text: "checks incomplete" };
  if (view.reconciled && view.unrealizedMatch && view.problems.length === 0) return { kind: "ok", text: "Reconciled" };
  if (!view.reconciled) return { kind: "bad", text: `Not reconciled by ${formatUsd(Math.abs(view.gapUsd))}` };
  return { kind: "bad", text: "Not reconciled" };
}

function projectionWord(toneName: "green" | "amber" | "red"): "OK" | "Near limit" | "Over" {
  if (toneName === "red") return "Over";
  if (toneName === "amber") return "Near limit";
  return "OK";
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
      <main className={styles.page}>
        <h1 className={styles.title}>P6 paper</h1>
        <p>Unauthorized.</p>
      </main>
    );
  }
  const url = process.env.REDIS_URL;
  if (!url) {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>P6 paper</h1>
        <p className={styles.sub}>No snapshot on this instance.</p>
      </main>
    );
  }
  const now = Date.now();
  let loaded: Awaited<ReturnType<typeof readP6Page>>;
  try {
    loaded = await readP6Page(openDashboardKv(url), now);
  } catch {
    return (
      <main className={styles.page}>
        <h1 className={styles.title}>Paper (P6) · Summary</h1>
        <div className={styles.alert} role="alert">
          <strong>Can&apos;t read the latest run.</strong>
          <span>Nothing is shown rather than old numbers. Reload to retry.</span>
        </div>
      </main>
    );
  }
  const picked = parseSummaryWindow(query.w);
  const { view, block } = loaded;
  const last = view.lastRun;
  const pnl = (last?.pnl ?? null) as {
    equityUsd?: number;
    realizedUsd?: number;
    unrealizedUsd?: number;
    feesUsd?: number;
    spreadSlipUsd?: number;
    startingUsd?: number;
    arrivalDelayBps?: number | null;
    feeBps?: { maker?: number; taker?: number };
    book?: { hwmUsd?: number; drawdownUsd?: number; haltUsd?: number; roomUsd?: number };
    classes?: Record<string, { cumR?: number; drawdownR?: number; drawdownUsd?: number; paused?: boolean; killed?: boolean; sizingUsd?: number | null }>;
    pairs?: { productId: string; classId: string; side: string; entry: number | null; stop: number | null; unrealizedUsd: number; realizedUsd: number; feesUsd: number; latched: boolean; roomUsd: number }[];
    classBackstopUsd?: number;
    pairBackstopUsd?: number;
  } | null;
  const reported = Array.isArray(last?.positions);
  const snaps = reported ? (last?.positions as PositionSnap[]) : null;
  const equityUsd = typeof pnl?.equityUsd === "number" ? pnl.equityUsd : 0;
  const realizedUsd = typeof pnl?.realizedUsd === "number" ? pnl.realizedUsd : 0;
  const startingUsd = typeof pnl?.startingUsd === "number" ? pnl.startingUsd : PNL_START_USD;
  const flushMs = block.lastUpdatedMs;
  const omitted = typeof last?.positionsOmitted === "number" ? last.positionsOmitted : 0;
  const skipped = typeof last?.positionsSkipped === "number" ? last.positionsSkipped : 0;
  const positionView = positionsFooter({
    snaps,
    nowMs: now,
    markTs: flushMs,
    equityUsd,
    realizedUsd,
    unrealizedUsd: block.openUnrealized ?? 0,
    startingUsd,
    omitted,
    skipped,
  });
  const copy = positionsSectionCopy(positionView);
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
  const bookDd = typeof pnl?.book?.drawdownUsd === "number" ? pnl.book.drawdownUsd : 0;
  const classCap = finite(pnl?.classBackstopUsd);
  const healthEnd = typeof completed?.end === "number" ? completed.end : null;
  const gaps24 = view.gaps.filter((gap) => healthEnd == null || healthEnd - gap.endMs < 24 * 60 * 60 * 1000);
  const equity = finite(pnl?.equityUsd);
  const delta = equity == null ? null : equity - PNL_START_USD;
  const deltaPct = delta == null ? null : (delta / PNL_START_USD) * 100;
  const deltaHero = hero(delta);
  const start = PNL_START_USD.toLocaleString("en-US");
  const toneWords = riskTone(positionView.riskUsd, bookDd);
  const openRiskWord = positionView.reported ? toneWords.openRisk : "checks skipped";
  const bookWord = toneWords.drawdown;
  const fresh = summaryFreshness({ hasLastRun: last != null, flushMs, nowMs: now });
  const health = fresh.health;
  const dotClass = health === "Error" ? styles.dotErr : health === "Stale" ? styles.dotStale : styles.dot;
  const gateLines = gateBannerLines({ killSwitch: view.killSwitch, classes: pnl?.classes, drawdownUsd: bookDd });
  const tile = block.tiles.find((row) => row.id === picked.id) ?? block.tiles[0];
  const paused = CLASS_IDS.filter((id) => pnl?.classes?.[id]?.paused || pnl?.classes?.[id]?.killed);
  const badge = reconBadge(positionView);

  return (
    <main className={styles.page}>
      {view.unreadable ? (
        <div className={styles.alert} role="alert">
          <strong>Hot unreadable.</strong>
          <span>The snapshot could not be read. This is not an empty book.</span>
        </div>
      ) : null}
      {gateLines.length > 0 ? (
        <div className={styles.alert} role="alert">
          <strong>Gate tripped:</strong>
          <span>{gateLines.join(" ")}</span>
        </div>
      ) : null}
      {fresh.banner ? (
        <div className={`${styles.alert} ${fresh.banner.staleClass ? styles.alertStale : ""}`} role="status">
          <strong>Data is stale.</strong>
          <span>{fresh.banner.text}</span>
        </div>
      ) : null}

      <div className={styles.head}>
        <div>
          <h1 className={styles.title}>Paper (P6) · Summary</h1>
          <p className={styles.crumb}>Paper books / Paper (P6) / Summary</p>
        </div>
        <div className={styles.equity}>
          <div className={styles.equityLabel}>Equity</div>
          <div className={styles.equityValue}>{equity == null ? "—" : formatUsd(equity)}</div>
          <div className={styles.equityDelta}>
            <span className={tone(deltaHero.kind)}>{deltaHero.text}</span>
            {deltaPct == null ? "" : ` (${signedPct(deltaPct)})`} vs ${start} start
          </div>
        </div>
      </div>

      <div className={`${styles.card} ${styles.strip}`} role="status">
        <span className={styles.chip}>PAPER - no capital at risk</span>
        <span>{block.paperStartMs == null ? "Paper start —" : `Paper start ${formatCt(block.paperStartMs, true)}`}</span>
        <span>Last updated {fresh.lastUpdatedText}</span>
        <span className={styles.right}>
          <span className={styles.health}>
            <span className={`${styles.dot} ${dotClass}`} aria-hidden="true" />
            {health}
          </span>
          <RunClock overdue={fresh.stale} />
        </span>
      </div>

      <div className={`${styles.card} ${styles.risk}`} aria-label="Risk status">
        <span className={styles.riskItem}>
          <span>
            Open risk (initial) <b>{positionView.reported ? formatUsd(positionView.riskUsd) : "—"}</b> of {formatUsd(OPEN_RISK_CAP_USD)} cap
          </span>
          <span className={styles.meter} role="img" aria-label="Open risk used">
            <i className={styles.meterFill} style={{ width: `${usedPct(positionView.riskUsd, OPEN_RISK_CAP_USD)}%` }} />
          </span>
          <span className={styles.state}>{openRiskWord}</span>
        </span>
        <span className={styles.riskItem}>
          <span>
            Book drawdown (from high-water mark) <b>{formatUsd(bookDd)}</b> of {formatUsd(BOOK_DRAWDOWN_HALT_USD)} halt
          </span>
          <span className={styles.meter} role="img" aria-label="Book drawdown used">
            <i className={styles.meterFill} style={{ width: `${usedPct(bookDd, BOOK_DRAWDOWN_HALT_USD)}%` }} />
          </span>
          <span className={styles.state}>{bookWord}</span>
        </span>
      </div>

      <div className={styles.grid} role="group" aria-label="Profit and loss by window">
        {block.tiles.map((row) => {
          const chip = partialChip(row);
          const total = hero(row.totalUsd);
          return (
            <div key={row.id} className={styles.card}>
              <div className={styles.win}>{row.id}</div>
              {row.status === "no-data" ? (
                <>
                  <div className={styles.big}>—</div>
                  <div className={styles.pct}>No data yet</div>
                </>
              ) : (
                <>
                  <div className={tone(total.kind, true)}>{total.text}</div>
                  <div className={styles.pct} title={`of $${start} start`}>
                    {row.totalPct == null ? "—" : signedPct(row.totalPct)}
                  </div>
                </>
              )}
              {chip ? (
                <span className={styles.pchip} title={chip.title}>
                  {chip.label}
                </span>
              ) : (
                <span className={`${styles.pchip} ${styles.pchipGhost}`} aria-hidden="true">
                  .
                </span>
              )}
            </div>
          );
        })}
      </div>

      <section className={styles.card} id="positions" aria-labelledby="pos-h">
        <div className={styles.cardHead}>
          <h2 id="pos-h">{positionView.reported ? `Open positions (${positionView.rows.length})` : "Open positions"}</h2>
          <span className={styles.sub}>
            as of last run {fresh.lastUpdatedText} · {ENTRY_FEE_NOTE}
          </span>
        </div>
        {!positionView.reported ? (
          <p className={styles.empty}>
            Waiting for the next run
            <br />
            <span className={styles.hint}>{copy.body}</span>
          </p>
        ) : positionView.empty ? (
          <p className={styles.empty}>{copy.body}</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {["Pair", "Entry", "Mark", "Unrealized $", "Unrealized %", "Distance to stop %"].map((label) => (
                    <th key={label} scope="col">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positionView.rows.map((row) => (
                  <PositionRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Fold title="More columns" note="Class, qty, age, notional, initial risk, net R, stop, target">
          {positionView.rows.length === 0 ? (
            <p className={styles.empty}>{copy.body}</p>
          ) : (
            <div className={`${styles.tableWrap} ${styles.foldBody}`}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    {["Pair", "Class", "Qty", "Age", "Notional", "Initial risk", "Net R", "Stop", "Target"].map((label) => (
                      <th key={label} scope="col">
                        {label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {positionView.rows.map((row) => {
                    const net = rText(row.netR);
                    return (
                      <tr key={row.id}>
                        <th scope="row">{row.product}</th>
                        <td data-label="Class">{row.classId}</td>
                        <td data-label="Qty">{qtyText(row.units)}</td>
                        <td data-label="Age">{ageText(row.ageMs)}</td>
                        <td data-label="Notional">{formatUsd(row.notional)}</td>
                        <td data-label="Initial risk">{formatUsd(row.risk)}</td>
                        <td data-label="Net R" className={tone(net.kind)}>
                          {net.text}
                        </td>
                        <td data-label="Stop">{formatUsd(row.stop)}</td>
                        <td data-label="Target">{row.target == null ? "—" : formatUsd(row.target)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Fold>
        <Fold title="Reconciliation" badge={badge} note="cash + active investment - est. exit costs = equity">
          <dl className={styles.kvs}>
            <Kv label="Total active investment">{copy.active}</Kv>
            <Kv label="At cost">{copy.atCost}</Kv>
            <Kv label="Est. exit costs">
              {copy.exit}
              <span className={styles.hint}>already deducted in unrealized</span>
            </Kv>
            <Kv label={`cash balance, ${CASH_LABEL}`}>{copy.cash}</Kv>
            <Kv label="= equity">{copy.equity}</Kv>
            <Kv label="Checks">{copy.check}</Kv>
            <Kv label="Open risk (initial)">
              {positionView.reported ? `${formatUsd(positionView.riskUsd)} of ${formatUsd(OPEN_RISK_CAP_USD)} cap` : "—"}
              <span className={styles.hint}>sum of initial risk</span>
            </Kv>
            <Kv label="Same-cluster limit">{positionView.clusters.map((cluster) => cluster.text).join(" · ") || "—"}</Kv>
            <Kv label="Holdings">{STABLECOIN_NOTE}</Kv>
          </dl>
          {copy.omittedNote ? <p className={styles.sub}>{copy.omittedNote}</p> : null}
          <p className={styles.hint}>{POSITIONS_IDENTITY}</p>
        </Fold>
      </section>

      <nav className={styles.selRow} id="breakdown" aria-label="Window for the breakdown below">
        <span className={styles.selLabel}>Breakdown for</span>
        <span className={styles.segGroup}>
          {SUMMARY_WINDOWS.map((id) => (
            <a key={id} className={styles.seg} href={`?w=${id}#breakdown`} aria-current={picked.id === id ? "true" : undefined}>
              {id}
            </a>
          ))}
        </span>
        <span className={styles.hint}>Choose one window. The four cards above always show all windows.</span>
      </nav>
      {tile ? (
        <Fold
          id="breakdown-panel"
          title={`Breakdown, ${picked.id}`}
          note={`realized ${moneyOrDash(tile.realizedUsd, true)}, unrealized ${moneyOrDash(tile.unrealizedDelta, true)}`}
          open={picked.open}
        >
          <Breakdown tile={tile} />
        </Fold>
      ) : null}

      <Fold
        id="gates"
        title="Risk and gates"
        badge={
          gateLines.length === 0
            ? { kind: "ok", text: "Gates clear" }
            : { kind: "warn", text: gateLines.length === 1 ? "1 gate tripped" : `${gateLines.length} gates tripped` }
        }
        note={`Book drawdown ${formatUsd(bookDd)} of ${formatUsd(BOOK_DRAWDOWN_HALT_USD)} halt · ${paused.length === 0 ? "no class paused" : paused.map((id) => `Class ${id} ${pnl?.classes?.[id]?.killed ? "killed" : "paused"}`).join(", ")}`}
      >
        <p>Daily and weekly halt status is not reported yet</p>
        <dl className={styles.kvs}>
          <Kv label="Kill switch">{view.killSwitch ? "on" : "off"}</Kv>
          <Kv label="Book halt">
            {formatUsd(bookDd)} / {formatUsd(BOOK_DRAWDOWN_HALT_USD)}
            <span className={styles.hint}>drawdown from high-water mark · {bookWord}</span>
          </Kv>
          <Kv label="Realized">{moneyOrDash(finite(pnl?.realizedUsd), true)}</Kv>
          <Kv label="Unrealized">{moneyOrDash(finite(pnl?.unrealizedUsd), true)}</Kv>
          <Kv label="Fees">{moneyOrDash(finite(pnl?.feesUsd))}</Kv>
          <Kv label="Spread + slippage">{moneyOrDash(finite(pnl?.spreadSlipUsd))}</Kv>
          <Kv label="Arrival delay bps">{pnl?.arrivalDelayBps == null ? "—" : pnl.arrivalDelayBps.toFixed(2)}</Kv>
          <Kv label="Fee bps">{`${pnl?.feeBps?.maker ?? "—"} / ${pnl?.feeBps?.taker ?? "—"}`}</Kv>
          {CLASS_IDS.map((id) => {
            const row = pnl?.classes?.[id];
            const dd = row?.drawdownR ?? 0;
            const cap = id === "A" || id === "B" ? 10 : 5;
            const word = id === "A" || id === "B" ? limitWord(dd, 10, 7) : dd < 5 ? "OK" : "Over";
            return (
              <Kv key={id} label={`${id} drawdown R`}>
                {dd.toFixed(2)}R / {cap}R · {word}
                <span className={styles.hint}>
                  cum {row?.cumR == null ? "—" : `${row.cumR.toFixed(2)}R`} · {row?.killed ? "killed" : row?.paused ? "paused" : "active"}
                  {row?.sizingUsd == null ? "" : ` · sizing ${formatUsd(row.sizingUsd)}`}
                </span>
              </Kv>
            );
          })}
          {CLASS_IDS.map((id) => {
            const dd = pnl?.classes?.[id]?.drawdownR ?? 0;
            return (
              <Kv key={`${id}-kill`} label={`${id} kill R`}>
                {dd.toFixed(2)} / 20R · {limitWord(dd, 20, 10)}
              </Kv>
            );
          })}
          {(["A", "B"] as const).map((id) => {
            const usdDd = pnl?.classes?.[id]?.drawdownUsd ?? 0;
            const cap = classCap;
            const word = classDollarWord(usdDd, cap);
            return (
              <Kv key={`${id}-usd`} label={`${id} $ backstop`}>
                {formatUsd(usdDd)} / {cap != null && cap > 0 ? formatUsd(cap) : "—"} · {word}
              </Kv>
            );
          })}
        </dl>
      </Fold>

      <Fold
        id="jev"
        title="Jev shadow"
        note={`Spend today ${jevUsd(jev?.todayUsd)} of ${jevUsd(jev?.capUsd)} cap · skip gate: ${jev?.skipLabel ?? "insufficient data (days 0/7, scheduled 0)"}`}
      >
        <dl className={styles.kvs}>
          <Kv label="Jev spend">{jevUsd(jev?.totalUsd)}</Kv>
          <Kv label="Jev today">{jevUsd(jev?.todayUsd)}</Kv>
          <Kv label="Jev calls">{String(jev?.calls ?? 0)}</Kv>
          <Kv label="Jev cap">{jevUsd(jev?.capUsd)}</Kv>
          <Kv label="no_1m_input">{String(jev?.byReason?.no_1m_input ?? 0)}</Kv>
          <Kv label="not_called">{String(jev?.byReason?.not_called ?? 0)}</Kv>
          <Kv label="timeout">{String(jev?.byReason?.timeout ?? 0)}</Kv>
          <Kv label="call_error">{String(jev?.byReason?.call_error ?? 0)}</Kv>
          <Kv label="invalid_response">{String(jev?.byReason?.invalid_response ?? 0)}</Kv>
          <Kv label="latency &lt;=60s">{String(jev?.latency?.le60 ?? 0)}</Kv>
          <Kv label="latency &lt;=300s">{String(jev?.latency?.le300 ?? 0)}</Kv>
          <Kv label="latency &lt;=600s">{String(jev?.latency?.le600 ?? 0)}</Kv>
          <Kv label="latency late">{String(jev?.latency?.late ?? 0)}</Kv>
          <Kv label="catch-up 7d">{String(jev?.catchUp ?? 0)}</Kv>
          <Kv label="catch-up 7d share">{(jev?.catchUpShare ?? 0).toFixed(3)}</Kv>
          <Kv label="catch-up 7d flag">{jev?.catchUpFlag ? "yes" : "no"}</Kv>
          <Kv label="skip gate">{jev?.skipLabel ?? "insufficient data (days 0/7, scheduled 0)"}</Kv>
          <Kv label="skip share 7d">{(jev?.skipShare ?? 0).toFixed(3)}</Kv>
          <Kv label="skip days">{`${jev?.skipDays ?? 0}/7`}</Kv>
          <Kv label="skip scheduled">{String(jev?.skipScheduled ?? 0)}</Kv>
          <Kv label="legacy, excluded">{`${jev?.legacySkipped ?? 0} skipped / ${jev?.legacyPackets ?? 0} packets`}</Kv>
        </dl>
      </Fold>

      <Fold
        id="health"
        title="Relay and health"
        badge={{ kind: health === "Healthy" ? "ok" : "warn", text: health === "Healthy" ? "OK" : health }}
        note={`Last run ${healthEnd != null && typeof last?.start === "number" ? `${Math.max(0, healthEnd - last.start)} ms` : "—"} · warm ${warm}/50 · gaps ${gaps24.length} in 24h · REST ${rest.n ?? 0} / 400`}
      >
        <dl className={styles.kvs}>
          <Kv label="Hot">{view.unreadable ? "unreadable" : "ok"}</Kv>
          <Kv label="Holder">
            {view.lease?.holder ?? "none"}
            {view.lease ? ` until ${new Date(view.lease.untilMs).toISOString()}` : ""}
          </Kv>
          <Kv label="Run outcome">
            {typeof last?.outcome === "string" ? last.outcome : "no run"}
            {typeof last?.start === "number" && typeof last?.end === "number" ? ` · ${Math.max(0, last.end - last.start)} ms` : ""}
          </Kv>
          <Kv label="Warm / cold / pending">
            {warm}/50 · cold {cold.length}
            {cold.length > 0 ? ` [${cold.map((row) => row.id).filter(Boolean).join(",")}]` : ""} · pending {pending}
          </Kv>
          <Kv label="Gaps (24h)">{String(gaps24.length)}</Kv>
          <Kv label="REST / 429">{`${rest.n ?? 0} / 400 · ${rest.r429 ?? 0}`}</Kv>
          <Kv label="Applied">{String(Array.isArray(last?.applied) ? last.applied.length : 0)}</Kv>
          <Kv label="Decisions">{String(last?.decisions ?? 0)}</Kv>
          <Kv label="Fills">{String(last?.fills ?? 0)}</Kv>
          <Kv label="Redis commands">{String(redis.cmds ?? 0)}</Kv>
          <Kv label="Redis commands (month)">
            {(month / 1_000_000).toFixed(2)}M / {(budget / 1_000_000).toFixed(0)}M · {projectionWord(proj)}
          </Kv>
          <Kv label="Max value">{String(redis.maxValueBytes ?? 0)}</Kv>
          {view.incidents.length > 0 ? <Kv label="Incidents">{view.incidents.slice(-20).join(" · ")}</Kv> : null}
        </dl>
      </Fold>

      <Fold id="trades" title="Recent trades and decisions" note={`Last ${Math.min(20, view.closed.length)} closed trades`}>
        <dl className={styles.kvs}>
          <Kv label="Decisions">{view.emitted.slice(-20).join(", ") || "—"}</Kv>
          {view.closed.slice(-20).map((row, index) => (
            <Kv key={`${row.productId ?? "trade"}-${index}`} label={`${row.productId ?? ""} · ${row.classId ?? ""}`}>
              {moneyOrDash(finite(row.netUsd), true)}
            </Kv>
          ))}
        </dl>
      </Fold>

      <Fold id="pairs" title="Pairs" note="Class, side, entry, stop, unrealized, realized, fees, backstop">
        {(pnl?.pairs ?? []).length === 0 ? (
          <p className={styles.empty}>No pairs in this run</p>
        ) : (
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {["Pair", "Class", "Side", "Entry", "Stop", "Unrealized", "Realized", "Fees", "Backstop"].map((label) => (
                    <th key={label} scope="col">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(pnl?.pairs ?? []).map((row) => (
                  <tr key={row.productId}>
                    <th scope="row">{row.productId}</th>
                    <td data-label="Class">{row.classId}</td>
                    <td data-label="Side">{row.side}</td>
                    <td data-label="Entry">{row.entry == null ? "—" : formatUsd(row.entry)}</td>
                    <td data-label="Stop">{row.stop == null ? "—" : formatUsd(row.stop)}</td>
                    <td data-label="Unrealized">{moneyOrDash(row.unrealizedUsd, true)}</td>
                    <td data-label="Realized">{moneyOrDash(row.realizedUsd, true)}</td>
                    <td data-label="Fees">{moneyOrDash(row.feesUsd)}</td>
                    <td data-label="Backstop">{row.latched ? "latched" : `armed ${formatUsd(row.roomUsd)}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Fold>
    </main>
  );
}

function PositionRow({ row }: { row: PositionLine }) {
  const unrealized = hero(row.unrealized);
  const pctKind = row.unrealizedPct == null || row.unrealizedPct === 0 ? "flat" : row.unrealizedPct > 0 ? "pos" : "neg";
  return (
    <tr>
      <th scope="row">{row.product}</th>
      <td data-label="Entry">{formatUsd(row.fill)}</td>
      <td data-label="Mark">
        {formatUsd(row.mark)}
        {row.markSrc === "entry" ? ` ${MARK_FALLBACK}` : ""}
      </td>
      <td data-label="Unrealized $" className={tone(unrealized.kind)}>
        {unrealized.text}
      </td>
      <td data-label="Unrealized %" className={tone(pctKind)}>
        {row.unrealizedPct == null ? "—" : signedPct(row.unrealizedPct)}
      </td>
      <td data-label="Distance to stop %">{row.stopDistancePct == null ? "—" : `${row.stopDistancePct.toFixed(2)}%`}</td>
    </tr>
  );
}

function Breakdown({ tile }: { tile: PnlTile }) {
  const realized = hero(tile.realizedUsd);
  const unrealized = hero(tile.unrealizedDelta);
  const draw = tile.drawdownUsd == null ? null : -Math.abs(tile.drawdownUsd);
  const drawHero = hero(draw);
  return (
    <>
      <dl className={styles.kvs}>
        <Kv label="Realized (closed trades)">
          <span className={tone(realized.kind)}>{realized.text}</span>
        </Kv>
        <Kv label="Unrealized change (open positions)">
          <span className={tone(unrealized.kind)}>{unrealized.text}</span>
        </Kv>
        <Kv label="Fees paid">
          {moneyOrDash(tile.feesUsd)}
          <span className={styles.hint}>already included in P/L</span>
        </Kv>
        <Kv label="Spread and slippage paid">
          {moneyOrDash(tile.spreadSlipUsd)}
          <span className={styles.hint}>already included in P/L</span>
        </Kv>
        <Kv label="Trades won / lost">
          {tile.tradesUnknown ? "trades unknown" : wlText(tile.wins, tile.losses)}
          {tile.tradesUnknown ? null : closedNote(tile.closedN) ? (
            <span className={styles.hint}>
              Not enough trades yet (need 30)
              <br />
              {closedNote(tile.closedN)}
            </span>
          ) : null}
        </Kv>
        <Kv label="Biggest trade">
          {tile.tradesUnknown ? "trades unknown" : concentrationText(tile.concentrationPct)}
          <span className={styles.hint}>largest trade = share of window realized</span>
        </Kv>
        <Kv label="hourly (may understate the intrahour low)">
          <span className={tone(drawHero.kind)}>{tile.drawdownUsd == null ? "—" : drawdownText(tile.drawdownUsd)}</span>
          <span className={styles.hint}>worst hourly drop in this window</span>
        </Kv>
      </dl>
      <ul className={styles.notes}>
        {tile.since ? <li>{tile.since}</li> : null}
        {tile.anchorLabel ? <li>{tile.anchorLabel}</li> : null}
        <li>{tile.hourNote ?? "counts complete hours only"}</li>
      </ul>
    </>
  );
}
