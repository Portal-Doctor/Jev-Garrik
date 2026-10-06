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

/** Where each fired veto came from. `ruleDegenerate` is a warm but uncalibratable ring. */
export interface VetoSourceCounts {
  jev: number;
  rule: number;
  ruleDegenerate: number;
}

export interface HoldTrendForward {
  vetoedBps: number | null;
  clearBps: number | null;
  vetoedN: number;
  clearN: number;
}

/**
 * The one-line call hold-the-trend section 3 asks for. The burden of proof sits on the veto:
 * it is only `vetoed worse` when the mean forward move after a toxic veto is below the mean
 * after a clear decision at every horizon that has both sides. Anything else, including a
 * sample too small to tell, is `vetoed not worse`, which section 3 answers by deleting the veto.
 */
export type VetoCall = "vetoed worse" | "vetoed not worse" | "no sample";

/** A check that can honestly report "not enough data" instead of failing. */
export type CheckVerdict = "pass" | "fail" | "no sample";

/** Longest gap between a completing entry fill and its resting take-profit ask. One 1 second tick. */
export const TP_TICK_MS = 1_000;
/** Take-profit fills needed before the maker share means anything. */
export const TP_FILL_SAMPLE_MIN = 5;
/** Share of take-profit fills that must be maker once the sample exists. */
export const TP_MAKER_SHARE_MIN = 0.8;

/** Section 8 check 2, 24 hour half: every filled long carries a resting post-only ask. */
export interface RestingAskCheck {
  filledLongs: number;
  withAskWithinOneTick: number;
  maxLagMs: number | null;
  verdict: CheckVerdict;
}

/** Section 8 check 2, 7 day half: at least 80% of take-profit fills are maker, given 5 fills. */
export interface TakeProfitMakerCheck {
  fills: number;
  makerFills: number;
  makerShare: number | null;
  verdict: CheckVerdict;
}

/**
 * A long counts as covered when a take-profit ask was created within one tick of the fill that
 * completed its entry. No filled longs is no sample, not a pass: there is nothing to check.
 */
export function scoreRestingAsk(
  completingFills: Array<{ pair: string; at: number }>,
  askCreatedAt: Array<{ pair: string; at: number }>,
): RestingAskCheck {
  const byPair = new Map<string, number[]>();
  for (const a of askCreatedAt) byPair.set(a.pair, [...(byPair.get(a.pair) ?? []), a.at]);
  let covered = 0;
  let maxLagMs: number | null = null;
  for (const fill of completingFills) {
    const lags = (byPair.get(fill.pair) ?? [])
      .map((at) => at - fill.at)
      .filter((lag) => lag >= 0 && lag <= TP_TICK_MS);
    if (lags.length === 0) continue;
    covered += 1;
    const lag = Math.min(...lags);
    maxLagMs = maxLagMs == null ? lag : Math.max(maxLagMs, lag);
  }
  return {
    filledLongs: completingFills.length,
    withAskWithinOneTick: covered,
    maxLagMs,
    verdict: completingFills.length === 0 ? "no sample" : covered === completingFills.length ? "pass" : "fail",
  };
}

/** Under `TP_FILL_SAMPLE_MIN` fills there is no denominator, so the answer is no sample, not fail. */
export function scoreTakeProfitMakerShare(fills: Array<{ liquidity: string }>): TakeProfitMakerCheck {
  const makerFills = fills.filter((f) => f.liquidity === "maker").length;
  const makerShare = fills.length > 0 ? makerFills / fills.length : null;
  const verdict: CheckVerdict =
    fills.length < TP_FILL_SAMPLE_MIN ? "no sample" : makerShare! >= TP_MAKER_SHARE_MIN ? "pass" : "fail";
  return { fills: fills.length, makerFills, makerShare, verdict };
}

export function toxicVetoCall(h1: HoldTrendForward, h4: HoldTrendForward): VetoCall {
  const scored = [h1, h4].filter((f) => f.vetoedN > 0 && f.clearN > 0 && f.vetoedBps != null && f.clearBps != null);
  if (scored.length === 0) return "no sample";
  return scored.every((f) => f.vetoedBps! < f.clearBps!) ? "vetoed worse" : "vetoed not worse";
}

export interface HoldTrendWindow {
  decisions: number;
  toxicVetoRate: number | null;
  toxicSource: VetoSourceCounts;
  stressVetoRate: number | null;
  stressSource: VetoSourceCounts;
  /** Toxic-vetoed versus toxic-clear forward returns. The section 3 test. */
  forwardH1: HoldTrendForward;
  forwardH4: HoldTrendForward;
  /** The section 3 verdict for this window, read off the two rows above. */
  toxicCall: VetoCall;
  /** The same table for the stress veto, shown beside toxic because it is free. */
  stressForwardH1: HoldTrendForward;
  stressForwardH4: HoldTrendForward;
  /** Raw Jev labels remain telemetry and are scored without becoming execution gates. */
  labelForwardH1: Record<string, { n: number; meanBps: number | null }>;
  labelForwardH4: Record<string, { n: number; meanBps: number | null }>;
  /** Section 8 check 2, scored on this window. */
  restingAsk: RestingAskCheck;
  takeProfitMaker: TakeProfitMakerCheck;
  hold: { medianMs: number | null; maxMs: number | null; closedUnder15m: number };
  exits: {
    stop: number;
    takeProfitMaker: number;
    takeProfitTaker: number;
    trendDown: number;
    contraction: number;
    horizon: number;
    halt: number;
  };
  sizedVsClip: number | null;
}

export interface HoldTrendMix {
  run: HoldTrendWindow;
  last24h: HoldTrendWindow;
  /** Section 3 asks for a 7 day block. Before the tape is that long it is the whole tape. */
  last7d: HoldTrendWindow;
}

export interface PairReport {
  pair: string;
  horizons: HorizonMetrics[];
  calibration: Array<{ horizonSec: number; brier: number; n: number; buckets: CalibrationBucket[] }>;
  pnl: { grossUsd: number; feesUsd: number; inferenceUsd: number; netUsd: number; unrealizedUsd: number; oracleUsd: number; capture: number | null };
  takerFillShare: number;
  maxDrawdownPct: number;
  makerFeeSensitivity: Array<{ makerBps: number; netUsd: number }>;
  holdTrend: HoldTrendMix;
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

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((s, n) => s + n, 0) / values.length;
}

function median(sorted: number[]): number | null {
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function emptyHoldWindow(): HoldTrendWindow {
  return {
    decisions: 0,
    toxicVetoRate: null,
    toxicSource: { jev: 0, rule: 0, ruleDegenerate: 0 },
    stressVetoRate: null,
    stressSource: { jev: 0, rule: 0, ruleDegenerate: 0 },
    forwardH1: { vetoedBps: null, clearBps: null, vetoedN: 0, clearN: 0 },
    forwardH4: { vetoedBps: null, clearBps: null, vetoedN: 0, clearN: 0 },
    toxicCall: "no sample",
    stressForwardH1: { vetoedBps: null, clearBps: null, vetoedN: 0, clearN: 0 },
    stressForwardH4: { vetoedBps: null, clearBps: null, vetoedN: 0, clearN: 0 },
    labelForwardH1: {},
    labelForwardH4: {},
    restingAsk: { filledLongs: 0, withAskWithinOneTick: 0, maxLagMs: null, verdict: "no sample" },
    takeProfitMaker: { fills: 0, makerFills: 0, makerShare: null, verdict: "no sample" },
    hold: { medianMs: null, maxMs: null, closedUnder15m: 0 },
    exits: { stop: 0, takeProfitMaker: 0, takeProfitTaker: 0, trendDown: 0, contraction: 0, horizon: 0, halt: 0 },
    sizedVsClip: null,
  };
}

function exitReasonBucket(reason: string | null): "trendDown" | "contraction" | "horizon" | "halt" | null {
  if (reason === "trend down") return "trendDown";
  if (reason === "regime") return "contraction";
  if (reason === "halt") return "halt";
  if (reason === "horizon") return "horizon";
  return null;
}

function labelKeysFromState(state: unknown): string[] {
  let root = state;
  if (typeof root === "string") {
    try {
      root = JSON.parse(root);
    } catch {
      return [];
    }
  }
  if (!root || typeof root !== "object") return [];
  const vector = (root as { vector?: unknown }).vector;
  if (!vector || typeof vector !== "object") return [];
  const row = vector as Record<string, unknown>;
  return ["market_regime", "direction_bias", "liquidity_stress", "toxic_flow_risk"]
    .filter((key) => typeof row[key] === "string")
    .map((key) => `${key}=${row[key]}`);
}

export function buildHoldTrendWindow(input: {
  decisions: Array<{ id: string; run_id: string; ts: number; state: unknown }>;
  fills: Array<{ run_id: string; purpose: string | null; decision_id: string | null; order_id?: string | null; liquidity: string; side: string; traded_at: number }>;
  outcomes: Array<{ decision_id: string; horizon_sec: number; move_bps: number }>;
  /** Take-profit orders for this pair, for the section 8 resting-ask check. */
  takeProfitOrders?: Array<{ run_id: string; created_at: number }>;
  notionalUsd: number;
  fromTs?: number;
  runId?: string;
}): HoldTrendWindow {
  const out = emptyHoldWindow();
  const decisions = input.decisions.filter((d) => {
    if (input.runId && d.run_id !== input.runId) return false;
    if (input.fromTs != null && Number(d.ts) < input.fromTs) return false;
    return true;
  });
  out.decisions = decisions.length;
  const byId = new Map(decisions.map((d) => [d.id, d]));
  let toxicKnown = 0;
  let toxicFired = 0;
  let stressKnown = 0;
  let stressFired = 0;
  const sized: number[] = [];
  const h1Vetoed: number[] = [];
  const h1Clear: number[] = [];
  const h4Vetoed: number[] = [];
  const h4Clear: number[] = [];
  const h1StressVetoed: number[] = [];
  const h1StressClear: number[] = [];
  const h4StressVetoed: number[] = [];
  const h4StressClear: number[] = [];
  const h1Labels = new Map<string, number[]>();
  const h4Labels = new Map<string, number[]>();
  const moves = new Map<string, { h1?: number; h4?: number }>();
  for (const o of input.outcomes) {
    const row = moves.get(o.decision_id) ?? {};
    if (Number(o.horizon_sec) === 3600) row.h1 = Number(o.move_bps);
    if (Number(o.horizon_sec) === 14400) row.h4 = Number(o.move_bps);
    moves.set(o.decision_id, row);
  }
  for (const d of decisions) {
    const gate = gateFromState(d.state);
    const toxic = gate.toxicVeto ?? (gate.reason === "toxic flow" ? true : gate.reason != null ? false : null);
    const stress = gate.stressVeto ?? (gate.reason === "liquidity stress" ? true : gate.reason != null ? false : null);
    if (toxic != null) {
      toxicKnown += 1;
      if (toxic) {
        toxicFired += 1;
        if (gate.toxicSource === "jev") out.toxicSource.jev += 1;
        else if (gate.toxicSource === "rule") out.toxicSource.rule += 1;
        else if (gate.toxicSource === "rule_degenerate") out.toxicSource.ruleDegenerate += 1;
      }
    }
    if (stress != null) {
      stressKnown += 1;
      if (stress) {
        stressFired += 1;
        if (gate.stressSource === "jev") out.stressSource.jev += 1;
        else if (gate.stressSource === "rule") out.stressSource.rule += 1;
        else if (gate.stressSource === "rule_degenerate") out.stressSource.ruleDegenerate += 1;
      }
    }
    if (gate.approved && gate.sizeUsd != null && input.notionalUsd > 0) sized.push(gate.sizeUsd / input.notionalUsd);
    const fwd = moves.get(d.id);
    const labels = labelKeysFromState(d.state);
    for (const label of labels) {
      if (fwd?.h1 != null) h1Labels.set(label, [...(h1Labels.get(label) ?? []), fwd.h1]);
      if (fwd?.h4 != null) h4Labels.set(label, [...(h4Labels.get(label) ?? []), fwd.h4]);
    }
    // Section 3 isolates the toxic veto, so a stress veto does not make a decision toxic-vetoed.
    if (toxic != null) {
      if (fwd?.h1 != null) (toxic ? h1Vetoed : h1Clear).push(fwd.h1);
      if (fwd?.h4 != null) (toxic ? h4Vetoed : h4Clear).push(fwd.h4);
    }
    if (stress != null) {
      if (fwd?.h1 != null) (stress ? h1StressVetoed : h1StressClear).push(fwd.h1);
      if (fwd?.h4 != null) (stress ? h4StressVetoed : h4StressClear).push(fwd.h4);
    }
  }
  out.toxicVetoRate = toxicKnown > 0 ? toxicFired / toxicKnown : null;
  out.stressVetoRate = stressKnown > 0 ? stressFired / stressKnown : null;
  out.forwardH1 = { vetoedBps: mean(h1Vetoed), clearBps: mean(h1Clear), vetoedN: h1Vetoed.length, clearN: h1Clear.length };
  out.forwardH4 = { vetoedBps: mean(h4Vetoed), clearBps: mean(h4Clear), vetoedN: h4Vetoed.length, clearN: h4Clear.length };
  out.toxicCall = toxicVetoCall(out.forwardH1, out.forwardH4);
  out.stressForwardH1 = {
    vetoedBps: mean(h1StressVetoed),
    clearBps: mean(h1StressClear),
    vetoedN: h1StressVetoed.length,
    clearN: h1StressClear.length,
  };
  out.stressForwardH4 = {
    vetoedBps: mean(h4StressVetoed),
    clearBps: mean(h4StressClear),
    vetoedN: h4StressVetoed.length,
    clearN: h4StressClear.length,
  };
  out.labelForwardH1 = Object.fromEntries([...h1Labels].map(([label, values]) => [label, { n: values.length, meanBps: mean(values) }]));
  out.labelForwardH4 = Object.fromEntries([...h4Labels].map(([label, values]) => [label, { n: values.length, meanBps: mean(values) }]));
  sized.sort((a, b) => a - b);
  out.sizedVsClip = median(sized);

  const fills = input.fills.filter((f) => {
    if (input.runId && f.run_id !== input.runId) return false;
    if (input.fromTs != null && Number(f.traded_at) < input.fromTs) return false;
    return true;
  });
  const holds: number[] = [];
  let openAt: number | null = null;
  for (const f of fills) {
    if (f.purpose === "entry" && f.side === "buy") {
      if (openAt == null) openAt = Number(f.traded_at);
    }
    if (f.purpose === "stop") out.exits.stop += 1;
    if (f.purpose === "take_profit") {
      if (f.liquidity === "maker") out.exits.takeProfitMaker += 1;
      else out.exits.takeProfitTaker += 1;
    }
    if (f.purpose === "exit") {
      if (!f.decision_id) out.exits.horizon += 1;
      else {
        const dec = byId.get(f.decision_id);
        const bucket = exitReasonBucket(dec ? gateFromState(dec.state).reason : null);
        if (bucket) out.exits[bucket] += 1;
        else out.exits.horizon += 1;
      }
    }
    if (f.side === "sell" && openAt != null && (f.purpose === "exit" || f.purpose === "stop" || f.purpose === "take_profit")) {
      const hold = Number(f.traded_at) - openAt;
      holds.push(hold);
      if (hold < 15 * 60_000) out.hold.closedUnder15m += 1;
      openAt = null;
    }
  }
  holds.sort((a, b) => a - b);
  out.hold.medianMs = median(holds);
  out.hold.maxMs = holds.length ? holds[holds.length - 1]! : null;

  // Section 8 check 2. A long's entry can fill in legs, so the completing fill is the last one
  // on that entry order. Legs without an order id cannot be grouped and are each their own long.
  const completingByOrder = new Map<string, number>();
  const ungrouped: Array<{ pair: string; at: number }> = [];
  for (const f of fills) {
    if (f.purpose !== "entry" || f.side !== "buy") continue;
    const at = Number(f.traded_at);
    if (!f.order_id) ungrouped.push({ pair: "pair", at });
    else completingByOrder.set(f.order_id, Math.max(completingByOrder.get(f.order_id) ?? 0, at));
  }
  const completing = [...[...completingByOrder.values()].map((at) => ({ pair: "pair", at })), ...ungrouped];
  const asks = (input.takeProfitOrders ?? [])
    .filter((o) => {
      if (input.runId && o.run_id !== input.runId) return false;
      if (input.fromTs != null && Number(o.created_at) < input.fromTs) return false;
      return true;
    })
    .map((o) => ({ pair: "pair", at: Number(o.created_at) }));
  out.restingAsk = scoreRestingAsk(completing, asks);
  out.takeProfitMaker = scoreTakeProfitMakerShare(fills.filter((f) => f.purpose === "take_profit"));
  return out;
}

export function buildHoldTrendMix(input: {
  decisions: Array<{ id: string; run_id: string; ts: number; state: unknown }>;
  fills: Array<{ run_id: string; purpose: string | null; decision_id: string | null; order_id?: string | null; liquidity: string; side: string; traded_at: number }>;
  outcomes: Array<{ decision_id: string; horizon_sec: number; move_bps: number }>;
  takeProfitOrders?: Array<{ run_id: string; created_at: number }>;
  notionalUsd: number;
  runId?: string;
  now?: number;
}): HoldTrendMix {
  const now = input.now ?? Date.now();
  return {
    run: buildHoldTrendWindow({ ...input, runId: input.runId }),
    last24h: buildHoldTrendWindow({ ...input, fromTs: now - 86_400_000 }),
    last7d: buildHoldTrendWindow({ ...input, fromTs: now - 7 * 86_400_000 }),
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

    const [decisionRows, purposeFills, holdOutcomes, takeProfitOrders] = await Promise.all([
      store.decisionsForPair(pair),
      store.fillsWithPurpose(pair),
      store.holdTrendOutcomes(pair),
      store.takeProfitOrdersForPair(pair),
    ]);
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
    const holdTrend = buildHoldTrendMix({
      decisions: decisionRows,
      fills: purposeFills,
      outcomes: holdOutcomes,
      takeProfitOrders,
      notionalUsd: bookNotional,
      runId: opts.runId,
    });

    pairReports.push({
      pair,
      horizons,
      calibration: cal,
      pnl: { ...pnlSplit, oracleUsd, capture },
      takerFillShare: share,
      maxDrawdownPct: dd,
      diagnostics,
      holdTrend,
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
    console.log(`  score ${p.diagnostics.score}${p.diagnostics.demote ? " demote" : ""} | quiet ${p.diagnostics.refused.quiet} | stops ${p.diagnostics.fills.stop} | take profit ${p.diagnostics.fills.takeProfit}`);
    const ht = p.holdTrend.run;
    const pctOrDash = (n: number | null) => (n == null ? "-" : `${(n * 100).toFixed(1)}%`);
    console.log(
      `  hold-trend run: toxic ${pctOrDash(ht.toxicVetoRate)} stress ${pctOrDash(ht.stressVetoRate)} hold p50 ${ht.hold.medianMs == null ? "-" : `${Math.round(ht.hold.medianMs / 60_000)}m`} under 15m ${ht.hold.closedUnder15m} sized ${ht.sizedVsClip == null ? "-" : ht.sizedVsClip.toFixed(2)} | exits stop ${ht.exits.stop} tp maker ${ht.exits.takeProfitMaker} tp taker ${ht.exits.takeProfitTaker} trend ${ht.exits.trendDown} contraction ${ht.exits.contraction} horizon ${ht.exits.horizon} halt ${ht.exits.halt}`,
    );
    const fwd = (f: (typeof ht)["forwardH1"]) =>
      `${f.vetoedN}/${f.vetoedBps == null ? "-" : f.vetoedBps.toFixed(1)} vs ${f.clearN}/${f.clearBps == null ? "-" : f.clearBps.toFixed(1)}`;
    for (const [label, w] of [["run", p.holdTrend.run], ["24h", p.holdTrend.last24h], ["7d", p.holdTrend.last7d]] as const) {
      console.log(`  toxic forward ${label}: 1h ${fwd(w.forwardH1)} | 4h ${fwd(w.forwardH4)} | ${w.toxicCall}`);
    }
    const ask = p.holdTrend.last24h.restingAsk;
    const tp = p.holdTrend.last7d.takeProfitMaker;
    console.log(
      `  check 2: resting ask 24h ${ask.withAskWithinOneTick}/${ask.filledLongs} filled longs within one tick (${ask.verdict}) | tp maker share 7d ${tp.makerFills}/${tp.fills}${tp.makerShare == null ? "" : ` = ${(tp.makerShare * 100).toFixed(0)}%`} (${tp.verdict})`,
    );
    console.log(`  veto source run: toxic jev ${ht.toxicSource.jev} rule ${ht.toxicSource.rule} degenerate ${ht.toxicSource.ruleDegenerate} | stress jev ${ht.stressSource.jev} rule ${ht.stressSource.rule} degenerate ${ht.stressSource.ruleDegenerate}`);
    console.log("");
  }
  await store.close();
}
