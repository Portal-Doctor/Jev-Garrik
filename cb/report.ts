import { config, MEASURED_HORIZONS_SEC } from "./config";
import { Store, type FillRow } from "./db/store";

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
  pnl: { grossUsd: number; feesUsd: number; inferenceUsd: number; netUsd: number; oracleUsd: number; capture: number | null };
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
}

export interface Report {
  generatedAt: number;
  tradedHorizonSec: number;
  config: { makerFeeBps: number; takerFeeBps: number; fillHaircut: number; notionalUsd: number; bankrollUsd: number };
  pairs: PairReport[];
}

const Z = 1.96; // 95%

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

/** Realized P&L split from the fills ledger. gross is pre-fee price P&L; net subtracts fees and inference. */
export function pnlFromFills(fills: FillRow[], inferenceUsd: number): { grossUsd: number; feesUsd: number; inferenceUsd: number; netUsd: number } {
  const fees = fills.reduce((s, f) => s + f.fee_usd, 0);
  const realizedNet = fills.reduce((s, f) => s + f.proceeds_usd - f.cost_basis_usd, 0); // fee-inclusive
  return { grossUsd: realizedNet + fees, feesUsd: fees, inferenceUsd, netUsd: realizedNet - inferenceUsd };
}

export async function buildReport(store: Store, opts: { incidentsPerDay?: number } = {}): Promise<Report> {
  const tradedHorizonSec = config.horizonSec;
  const roundTripBps = config.makerFeeBps + config.takerFeeBps;
  const perPairBankroll = config.bankrollUsd / (config.pairs.length || 1);
  const pairs = await store.pairsWithData();

  const pairReports: PairReport[] = [];
  for (const pair of pairs) {
    const resolved = await store.resolvedForReport(pair);
    const fills = await store.fillsAll(pair);
    const inference = await store.inferenceUsdTotal(pair);
    const snaps = await store.snapshotSeries({ pair });

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

    const pnlSplit = pnlFromFills(fills, inference);
    // Oracle: what traded decisions resolved at the traded horizon would earn if every call were correct.
    const tradedRows = resolved.filter((r) => r.traded && Number(r.horizon_sec) === tradedHorizonSec);
    const oracleUsd = tradedRows.reduce((s, r) => s + (Math.abs(Number(r.move_bps)) / 10_000) * config.notionalUsd, 0);
    const capture = oracleUsd > 0 ? pnlSplit.grossUsd / oracleUsd : null;
    const dd = maxDrawdownPct(snaps.map((s) => Number(s.equity_usd)), perPairBankroll);

    const traded = horizons.find((h) => h.horizonSec === tradedHorizonSec)!;
    const incidentsPerDay = opts.incidentsPerDay ?? 0;
    const gate = {
      tradedHorizonSec,
      resolved200: traded.n >= 200,
      accuracyLowerAbove52: traded.wilsonLower > 0.52,
      netPnlPositive: pnlSplit.netUsd > 0,
      drawdownUnder15: dd < 15,
      incidentsUnder1PerDay: incidentsPerDay < 1,
      passes: false,
      values: { n: traded.n, wilsonLower: traded.wilsonLower, netUsd: pnlSplit.netUsd, maxDrawdownPct: dd, incidentsPerDay },
    };
    gate.passes = gate.resolved200 && gate.accuracyLowerAbove52 && gate.netPnlPositive && gate.drawdownUnder15 && gate.incidentsUnder1PerDay;

    pairReports.push({
      pair,
      horizons,
      calibration: cal,
      pnl: { ...pnlSplit, oracleUsd, capture },
      maxDrawdownPct: dd,
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
    pairs: pairReports,
  };
}

// `bun run cb:report` prints the report as a readable table.
if (import.meta.main) {
  const store = new Store(config.databaseUrl);
  await store.init();
  const report = await buildReport(store);
  const th = report.tradedHorizonSec;
  console.log(`\nReport (traded horizon ${th / 3600}h, fees ${report.config.makerFeeBps}/${report.config.takerFeeBps} bps, haircut ${report.config.fillHaircut})\n`);
  for (const p of report.pairs) {
    const t = p.horizons.find((h) => h.horizonSec === th)!;
    console.log(`${p.pair}`);
    console.table(
      p.horizons.map((h) => ({
        horizon: `${h.horizonSec / 3600}h`,
        n: h.n,
        accuracy: `${(h.accuracy * 100).toFixed(1)}%`,
        wilson95: `${(h.wilsonLower * 100).toFixed(1)}-${(h.wilsonUpper * 100).toFixed(1)}%`,
        brier: h.brier.toFixed(4),
        edgeBps: h.edgeBps.toFixed(1),
      })),
    );
    console.log(
      `  pnl net $${p.pnl.netUsd.toFixed(2)} (gross $${p.pnl.grossUsd.toFixed(2)}, fees $${p.pnl.feesUsd.toFixed(2)}, inference $${p.pnl.inferenceUsd.toFixed(4)}) | capture ${p.pnl.capture == null ? "n/a" : (p.pnl.capture * 100).toFixed(1) + "%"} | maxDD ${p.maxDrawdownPct.toFixed(1)}%`,
    );
    console.log(`  gate ${p.gate.passes ? "PASS" : "FAIL"}: n>=200 ${p.gate.resolved200} | lower>52% ${p.gate.accuracyLowerAbove52} | net>0 ${p.gate.netPnlPositive} | dd<15% ${p.gate.drawdownUnder15} | incidents<1/day ${p.gate.incidentsUnder1PerDay}\n`);
  }
  await store.close();
}
