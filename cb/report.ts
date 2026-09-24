import { Accounting } from "./accounting";
import { findBook } from "./books";
import { config, MEASURED_HORIZONS_SEC } from "./config";
import { Store, type FillRow } from "./db/store";
import { gateFromState } from "./gate";

/**
 * Measurement report: the point of the whole harness. Directional accuracy with a Wilson interval,
 * Brier score, calibration, edge per decision, realized P&L split into price/fees/inference, capture
 * rate, a maker-fee sensitivity grid, and the five promotion-gate booleans. Aggregated across runs
 * per pair, so restarts continue one campaign.
 *
 * Pure functions are exported for testing; buildReport ties them to the store.
 */

export interface HorizonMetrics {
  horizonSec: number;
  n: number;
  accuracy: number; // mean(correct)
  wilsonLower: number;
  wilsonUpper: number;
  brier: number;
  edgeBps: number; // mean signed move minus round-trip cost
}

export interface CalibrationBucket {
  bucket: number; // 0..9
  pMean: number; // mean predicted p_buy in the bucket
  freq: number; // realized up frequency
  n: number;
}

export interface PairReport {
  pair: string;
  horizons: HorizonMetrics[];
  calibration: Array<{ horizonSec: number; brier: number; n: number; buckets: CalibrationBucket[] }>;
  pnl: { grossUsd: number; feesUsd: number; inferenceUsd: number; netUsd: number; unrealizedUsd: number; oracleUsd: number; capture: number | null };
  takerFillShare: number;
  maxDrawdownPct: number;
  makerFeeSensitivity: Array<{ makerBps: number; netUsd: number }>;
  gate: {
    tradedHorizonSec: number;
    resolved200: boolean;
    accuracyLowerAbove52: boolean;
    netPnlPositive: boolean;
    drawdownUnder15: boolean;
    incidentsUnder1PerDay: boolean;
    passes: boolean;
    values: { n: number; wilsonLower: number; netUsd: number; maxDrawdownPct: number; incidentsPerDay: number };
  };
  diagnostics: PairDiagnostics;
}

export interface PairDiagnostics {
  decisions: number;
  approved: number;
  refused: {
    quiet: number;
    yield: number;
    toxic: number;
    stress: number;
    regime: number;
    bias: number;
    confidence: number;
    dust: number;
    grossCap: number;
  };
  fills: {
    entry: number;
    exitSignal: number;
    exitHorizon: number;
    stop: number;
    takeProfit: number;
  };
  holdMs: { p50: number | null; p90: number | null };
  makerFeesUsd: number;
  takerFeesUsd: number;
  netUsd: number;
  grossUsd: number;
  edgeRatio: number | null;
  stopRate: number;
  takeProfitRate: number;
  adverseNextHour: number | null;
  score: number;
  demote: boolean;
}

/** When the next outcome at a horizon becomes resolvable: oldest unresolved decision ts + horizon.
 *  `at` is null when no decision is awaiting that horizon (e.g. an empty database). */
export interface NextRead {
  horizonSec: number;
  at: number | null;
}

export interface Report {
  generatedAt: number;
  tradedHorizonSec: number;
  config: { makerFeeBps: number; takerFeeBps: number; fillHaircut: number; notionalUsd: number; bankrollUsd: number };
  nextReads: NextRead[];
  pairs: PairReport[];
}

const Z = 1.96; // 95%

/** Live campaign pairs: venue history intersected with the current config list. Drops MON-USDC. */
export function liveReportPairs(venuePairs: string[], configured: readonly string[]): string[] {
  const allow = new Set(configured);
  return venuePairs.filter((p) => p !== "MON-USDC" && allow.has(p));
}

/** Enabled books in config, plus any of those that already have history. */
export function campaignPairs(configured: readonly string[], historical: readonly string[]): string[] {
  const live = configured.filter((p) => findBook(p)?.enabled);
  const allow = new Set(live);
  const extra = historical.filter((p) => allow.has(p) && !live.includes(p));
  return [...live, ...extra];
}

const WEEK_MS = 7 * 86_400_000;

/** Same ratio as predictiveEdge: (avg win * win rate) / (avg loss * loss rate). */
export function edgeRatioFromMoves(movesBps: number[]): number | null {
  const wins: number[] = [];
  const losses: number[] = [];
  for (const m of movesBps) {
    if (m > 0) wins.push(m);
    else losses.push(-m);
  }
  const n = wins.length + losses.length;
  if (n === 0) return null;
  const winRate = wins.length / n;
  const lossRate = losses.length / n;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const den = avgLoss * lossRate;
  if (!(den > 0)) return wins.length > 0 ? Number.POSITIVE_INFINITY : null;
  return (avgWin * winRate) / den;
}

export function weeklyPairScore(input: {
  netUsd: number;
  edgeRatio: number | null;
  stopRate: number;
  takerFillShare: number;
  quiet: number;
  refusals: number;
  entries: number;
  maxDrawdownPct: number;
  mature: boolean;
}): { score: number; demote: boolean } {
  let score = 0;
  if (input.netUsd > 0) score += 2;
  if (input.edgeRatio != null && input.edgeRatio > 1.3) score += 1;
  if (input.stopRate < 0.35) score += 1;
  if (input.takerFillShare < 0.25) score += 1;
  const quietMajority = input.refusals > 0 && input.quiet * 2 > input.refusals;
  if (!quietMajority) score += 1;
  if (input.netUsd < 0 && input.entries >= 20) score -= 2;
  if (input.maxDrawdownPct > 15) score -= 2;
  return { score, demote: input.mature && input.entries >= 20 && score <= 0 };
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i]!;
}

function refuseKey(reason: string | null): keyof PairDiagnostics["refused"] | null {
  switch (reason) {
    case "quiet":
      return "quiet";
    case "yield":
      return "yield";
    case "toxic flow":
      return "toxic";
    case "liquidity stress":
      return "stress";
    case "regime":
      return "regime";
    case "bias":
      return "bias";
    case "confidence":
      return "confidence";
    case "dust":
      return "dust";
    case "gross cap":
      return "grossCap";
    default:
      return null;
  }
}

export function buildPairDiagnostics(input: {
  decisions: Array<{ ts: number; state: unknown }>;
  fills: Array<{ purpose: string | null; decision_id: string | null; liquidity: string; fee_usd: number; side: string; traded_at: number }>;
  moves: Array<{ action: "buy" | "sell"; traded: boolean; horizon_sec: number; move_bps: number }>;
  tradedHorizonSec: number;
  netUsd: number;
  grossUsd: number;
  takerFillShare: number;
  maxDrawdownPct: number;
  now?: number;
}): PairDiagnostics {
  const refused = { quiet: 0, yield: 0, toxic: 0, stress: 0, regime: 0, bias: 0, confidence: 0, dust: 0, grossCap: 0 };
  let approved = 0;
  for (const d of input.decisions) {
    const gate = gateFromState(d.state);
    if (gate.approved) approved += 1;
    const key = refuseKey(gate.reason);
    if (key) refused[key] += 1;
  }
  const fills = { entry: 0, exitSignal: 0, exitHorizon: 0, stop: 0, takeProfit: 0 };
  let makerFeesUsd = 0;
  let takerFeesUsd = 0;
  const holds: number[] = [];
  let openAt: number | null = null;
  for (const f of input.fills) {
    if (f.liquidity === "taker") takerFeesUsd += Number(f.fee_usd);
    else makerFeesUsd += Number(f.fee_usd);
    if (f.purpose === "entry") {
      fills.entry += 1;
      if (openAt == null) openAt = Number(f.traded_at);
    } else if (f.purpose === "stop") fills.stop += 1;
    else if (f.purpose === "take_profit") fills.takeProfit += 1;
    else if (f.purpose === "exit") {
      if (f.decision_id) fills.exitSignal += 1;
      else fills.exitHorizon += 1;
    }
    if (f.side === "sell" && openAt != null && (f.purpose === "exit" || f.purpose === "stop" || f.purpose === "take_profit")) {
      holds.push(Number(f.traded_at) - openAt);
      openAt = null;
    }
  }
  holds.sort((a, b) => a - b);
  const hour = input.moves.filter((m) => m.traded && m.action === "buy" && Number(m.horizon_sec) === 3600);
  const tradedMoves = input.moves
    .filter((m) => m.traded && m.action === "buy" && Number(m.horizon_sec) === input.tradedHorizonSec)
    .map((m) => Number(m.move_bps));
  const edgeRatio = edgeRatioFromMoves(tradedMoves);
  const entries = fills.entry;
  const stopRate = entries > 0 ? fills.stop / entries : 0;
  const takeProfitRate = entries > 0 ? fills.takeProfit / entries : 0;
  const refusals = Object.values(refused).reduce((s, n) => s + n, 0);
  const firstTs = input.decisions.length ? Number(input.decisions[0]!.ts) : null;
  const now = input.now ?? Date.now();
  const mature = firstTs != null && now - firstTs >= WEEK_MS;
  const scored = weeklyPairScore({
    netUsd: input.netUsd,
    edgeRatio,
    stopRate,
    takerFillShare: input.takerFillShare,
    quiet: refused.quiet,
    refusals,
    entries,
    maxDrawdownPct: input.maxDrawdownPct,
    mature,
  });
  return {
    decisions: input.decisions.length,
    approved,
    refused,
    fills,
    holdMs: { p50: percentile(holds, 50), p90: percentile(holds, 90) },
    makerFeesUsd,
    takerFeesUsd,
    netUsd: input.netUsd,
    grossUsd: input.grossUsd,
    edgeRatio,
    stopRate,
    takeProfitRate,
    adverseNextHour: hour.length ? hour.filter((m) => Number(m.move_bps) < 0).length / hour.length : null,
    score: scored.score,
    demote: scored.demote,
  };
}

/** Wilson score interval for a binomial proportion. */
export function wilson(successes: number, n: number, z = Z): { p: number; lower: number; upper: number } {
  if (n === 0) return { p: 0, lower: 0, upper: 0 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { p, lower: Math.max(0, (center - margin) / denom), upper: Math.min(1, (center + margin) / denom) };
}

/** Brier score: mean squared error of p_buy against the realized up indicator. */
export function brier(points: Array<{ pBuy: number; up: number }>): number {
  if (points.length === 0) return 0;
  return points.reduce((s, x) => s + (x.pBuy - x.up) ** 2, 0) / points.length;
}

/** Decile calibration: predicted p_buy vs realized up frequency. */
export function calibration(points: Array<{ pBuy: number; up: number }>, buckets = 10): CalibrationBucket[] {
  const acc = Array.from({ length: buckets }, () => ({ pSum: 0, upSum: 0, n: 0 }));
  for (const { pBuy, up } of points) {
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor(pBuy * buckets)));
    acc[idx]!.pSum += pBuy;
    acc[idx]!.upSum += up;
    acc[idx]!.n++;
  }
  return acc.map((b, i) => ({ bucket: i, pMean: b.n ? b.pSum / b.n : (i + 0.5) / buckets, freq: b.n ? b.upSum / b.n : 0, n: b.n }));
}

/** Mean move signed by the call, minus the round-trip cost, in bps. */
export function edgeBps(rows: Array<{ action: "buy" | "sell"; moveBps: number }>, roundTripBps: number): number {
  if (rows.length === 0) return 0;
  const mean = rows.reduce((s, r) => s + (r.action === "buy" ? r.moveBps : -r.moveBps), 0) / rows.length;
  return mean - roundTripBps;
}

/** Realized net P&L recomputed at alternative maker fee tiers (taker fills keep their fee). */
export function makerFeeSensitivity(fills: FillRow[], makerBpsList: number[], inferenceUsd: number): Array<{ makerBps: number; netUsd: number }> {
  const gross = fills.reduce((s, f) => s + (f.side === "sell" ? f.notional_usd : -f.notional_usd), 0);
  const takerFees = fills.filter((f) => f.liquidity === "taker").reduce((s, f) => s + f.fee_usd, 0);
  const makerNotional = fills.filter((f) => f.liquidity === "maker").reduce((s, f) => s + f.notional_usd, 0);
  return makerBpsList.map((makerBps) => {
    const makerFees = (makerNotional * makerBps) / 10_000;
    return { makerBps, netUsd: gross - takerFees - makerFees - inferenceUsd };
  });
}

/** Fraction of fills that were taker (PL-REVENUE-REVIEW.md 3.4): every taker fallback is roughly the whole per-trade edge. */
export function takerFillShare(fills: FillRow[]): number {
  if (fills.length === 0) return 0;
  return fills.filter((f) => f.liquidity === "taker").length / fills.length;
}

/** Max drawdown as a fraction of bankroll, from an equity series. */
export function maxDrawdownPct(equity: number[], bankroll: number): number {
  if (equity.length === 0 || bankroll <= 0) return 0;
  let peak = equity[0]!;
  let maxDd = 0;
  for (const e of equity) {
    if (e > peak) peak = e;
    maxDd = Math.max(maxDd, peak - e);
  }
  return (maxDd / bankroll) * 100;
}

/**
 * Realized + mark-to-market P&L split, replayed from the fills ledger through the same
 * fee-inclusive Accounting used live (PL-REVENUE-REVIEW.md 2.2, 3.5). This fixes the prior
 * defect where an open position (or inventory stranded by a restarted run) was summed as a pure
 * cash outflow, overstating losses: open inventory is now marked at `lastMid` instead of
 * expensed. Pass `lastMid = null` (no known price) to value open inventory at exactly zero
 * gain/loss rather than guessing - still strictly more honest than the old behavior.
 */
export function pnlFromFills(
  fills: FillRow[],
  inferenceUsd: number,
  lastMid: number | null = null,
): { grossUsd: number; feesUsd: number; inferenceUsd: number; netUsd: number; unrealizedUsd: number } {
  const acct = new Accounting(0);
  for (const f of fills) {
    acct.apply({ side: f.side, sizeBase: Number(f.size_base), notionalUsd: Number(f.notional_usd), feeUsd: Number(f.fee_usd) });
  }
  const unrealizedUsd = lastMid != null ? acct.unrealized(lastMid) : 0;
  return {
    grossUsd: acct.realizedUsd + acct.feesUsd,
    feesUsd: acct.feesUsd,
    inferenceUsd,
    netUsd: acct.realizedUsd + unrealizedUsd - inferenceUsd,
    unrealizedUsd,
  };
}

export async function buildReport(store: Store, opts: { incidentsPerDay?: number; runId?: string } = {}): Promise<Report> {
  const tradedHorizonSec = config.horizonSec;
  const roundTripBps = config.makerFeeBps + config.takerFeeBps;
  const perPairBankroll = config.bankrollUsd / (config.pairs.length || 1);
  const pairs = campaignPairs(config.pairs, liveReportPairs(await store.pairsWithDataForVenue("paper"), config.pairs));
  const unresolved = await store.earliestUnresolvedTsForVenue("paper", MEASURED_HORIZONS_SEC, pairs);
  const nextReads: NextRead[] = unresolved.map((r) => ({
    horizonSec: Number(r.horizon_sec),
    at: r.ts != null ? Number(r.ts) + Number(r.horizon_sec) * 1000 : null,
  }));

  const pairReports: PairReport[] = [];
  for (const pair of pairs) {
    const resolved = await store.resolvedForReport(pair);
    const fills = await store.fillsAll(pair);
    const inference = await store.inferenceUsdTotal(pair);
    const snaps = await store.snapshotSeries({ pair });
    const lastMid = snaps.length ? ((s) => (s.mid != null ? Number(s.mid) : null))(snaps[snaps.length - 1]!) : null;

    const horizons: HorizonMetrics[] = MEASURED_HORIZONS_SEC.map((h) => {
      const rows = resolved.filter((r) => Number(r.horizon_sec) === h);
      const n = rows.length;
      const correct = rows.filter((r) => r.correct).length;
      const w = wilson(correct, n);
      const pts = rows.map((r) => ({ pBuy: Number(r.p_buy), up: Number(r.move_bps) > 0 ? 1 : 0 }));
      return {
        horizonSec: h,
        n,
        accuracy: w.p,
        wilsonLower: w.lower,
        wilsonUpper: w.upper,
        brier: brier(pts),
        edgeBps: edgeBps(rows.map((r) => ({ action: r.action, moveBps: Number(r.move_bps) })), roundTripBps),
      };
    });

    const cal = MEASURED_HORIZONS_SEC.map((h) => {
      const rows = resolved.filter((r) => Number(r.horizon_sec) === h);
      const pts = rows.map((r) => ({ pBuy: Number(r.p_buy), up: Number(r.move_bps) > 0 ? 1 : 0 }));
      return { horizonSec: h, brier: brier(pts), n: pts.length, buckets: calibration(pts) };
    });

    // Lifetime, mark-to-market P&L across the whole campaign (2.2): the number to report externally.
    const pnlSplit = pnlFromFills(fills, inference, lastMid);
    // The promotion gate is scoped to the current run only (3.5): otherwise inventory stranded by
    // a prior restarted run keeps the gate from ever passing, or misreports it as a live loss.
    const runFills = opts.runId ? fills.filter((f) => f.run_id === opts.runId) : fills;
    const runInference = opts.runId ? await store.inferenceUsdTotal(pair, opts.runId) : inference;
    const gatePnl = opts.runId ? pnlFromFills(runFills, runInference, lastMid) : pnlSplit;
    // Oracle: what traded decisions resolved at the traded horizon would earn if every call were correct.
    const bookNotional = findBook(pair)?.notionalUsd ?? config.notionalUsd;
    const tradedRows = resolved.filter((r) => r.traded && Number(r.horizon_sec) === tradedHorizonSec);
    const oracleUsd = tradedRows.reduce((s, r) => s + (Math.abs(Number(r.move_bps)) / 10_000) * bookNotional, 0);
    const capture = oracleUsd > 0 ? pnlSplit.grossUsd / oracleUsd : null;
    const dd = maxDrawdownPct(snaps.map((s) => Number(s.equity_usd)), perPairBankroll);

    const traded = horizons.find((h) => h.horizonSec === tradedHorizonSec)!;
    const incidentsPerDay = opts.incidentsPerDay ?? 0;
    const gate = {
      tradedHorizonSec,
      resolved200: traded.n >= 200,
      accuracyLowerAbove52: traded.wilsonLower > 0.52,
      netPnlPositive: gatePnl.netUsd > 0,
      drawdownUnder15: dd < 15,
      incidentsUnder1PerDay: incidentsPerDay < 1,
      passes: false,
      values: { n: traded.n, wilsonLower: traded.wilsonLower, netUsd: gatePnl.netUsd, maxDrawdownPct: dd, incidentsPerDay },
    };
    gate.passes = gate.resolved200 && gate.accuracyLowerAbove52 && gate.netPnlPositive && gate.drawdownUnder15 && gate.incidentsUnder1PerDay;

    const [decisionRows, purposeFills] = await Promise.all([store.decisionsForPair(pair), store.fillsWithPurpose(pair)]);
    const share = takerFillShare(fills);
    const diagnostics = buildPairDiagnostics({
      decisions: decisionRows,
      fills: purposeFills,
      moves: resolved,
      tradedHorizonSec,
      netUsd: pnlSplit.netUsd,
      grossUsd: pnlSplit.grossUsd,
      takerFillShare: share,
      maxDrawdownPct: dd,
    });

    pairReports.push({
      pair,
      horizons,
      calibration: cal,
      pnl: { ...pnlSplit, oracleUsd, capture },
      takerFillShare: share,
      maxDrawdownPct: dd,
      diagnostics,
      makerFeeSensitivity: makerFeeSensitivity(fills, [50, 25, 10, 0], inference),
      gate,
    });
  }

  return {
    generatedAt: Date.now(),
    tradedHorizonSec,
    config: {
      makerFeeBps: config.makerFeeBps,
      takerFeeBps: config.takerFeeBps,
      fillHaircut: config.fillHaircut,
      notionalUsd: config.notionalUsd,
      bankrollUsd: config.bankrollUsd,
    },
    nextReads,
    pairs: pairReports,
  };
}

/** "in 38m", "in 20h 41m", "due now", or "none pending" for a next-read timestamp. */
export function fmtNextRead(at: number | null, now: number): string {
  if (at == null) return "none pending";
  const ms = at - now;
  if (ms <= 0) return "due now";
  const mins = Math.ceil(ms / 60_000);
  return mins < 60 ? `in ${mins}m` : `in ${Math.floor(mins / 60)}h ${mins % 60}m`;
}

/** Renders a horizon metric for the CLI table: "pending" when n=0, since 0/0.0000/0.0% otherwise
 *  reads as "the model is uniformly wrong" rather than "no outcomes have resolved yet"
 *  (SENIOR-DEV-REPORT-2026-09-19.md item 4, PL-REVENUE-REVIEW-FOLLOWUP.md section 4). */
export function fmtHorizonCell(n: number, value: string): string {
  return n === 0 ? "pending" : value;
}

// `bun run cb:report` prints the report as a readable table.
if (import.meta.main) {
  const store = new Store(config.databaseUrl);
  await store.init();
  const report = await buildReport(store);
  const th = report.tradedHorizonSec;
  console.log(`\nReport (traded horizon ${th / 3600}h, fees ${report.config.makerFeeBps}/${report.config.takerFeeBps} bps, haircut ${report.config.fillHaircut})`);
  console.log(`next reads: ${report.nextReads.map((r) => `${r.horizonSec / 3600}h ${fmtNextRead(r.at, report.generatedAt)}`).join(" | ")}\n`);
  for (const p of report.pairs) {
    const t = p.horizons.find((h) => h.horizonSec === th)!;
    console.log(`${p.pair}`);
    console.table(
      p.horizons.map((h) => ({
        horizon: h.horizonSec % 3600 === 0 ? `${h.horizonSec / 3600}h` : `${Math.round(h.horizonSec / 60)}m`,
        n: h.n === 0 ? "pending" : h.n,
        accuracy: fmtHorizonCell(h.n, `${(h.accuracy * 100).toFixed(1)}%`),
        wilson95: fmtHorizonCell(h.n, `${(h.wilsonLower * 100).toFixed(1)}-${(h.wilsonUpper * 100).toFixed(1)}%`),
        brier: fmtHorizonCell(h.n, h.brier.toFixed(4)),
        edgeBps: fmtHorizonCell(h.n, h.edgeBps.toFixed(1)),
      })),
    );
    console.log(
      `  pnl net $${p.pnl.netUsd.toFixed(2)} (gross $${p.pnl.grossUsd.toFixed(2)}, fees $${p.pnl.feesUsd.toFixed(2)}, unrealized $${p.pnl.unrealizedUsd.toFixed(2)}, inference $${p.pnl.inferenceUsd.toFixed(4)}) | capture ${p.pnl.capture == null ? "n/a" : (p.pnl.capture * 100).toFixed(1) + "%"} | taker fills ${(p.takerFillShare * 100).toFixed(0)}% | maxDD ${p.maxDrawdownPct.toFixed(1)}%`,
    );
    console.log(`  gate ${p.gate.passes ? "PASS" : "FAIL"}: n>=200 ${p.gate.resolved200} | lower>52% ${p.gate.accuracyLowerAbove52} | net>0 ${p.gate.netPnlPositive} | dd<15% ${p.gate.drawdownUnder15} | incidents<1/day ${p.gate.incidentsUnder1PerDay}`);
    console.log(`  score ${p.diagnostics.score}${p.diagnostics.demote ? " demote" : ""} | quiet ${p.diagnostics.refused.quiet} | stops ${p.diagnostics.fills.stop} | take profit ${p.diagnostics.fills.takeProfit}\n`);
  }
  await store.close();
}
