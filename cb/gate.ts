import { payoffLegs } from "./books";

/**
 * Deterministic entry hurdle and hard stop / take-profit guards.
 * Code owns this. The model does not set, widen, or cancel a guard.
 */

export type Regime = "expansion" | "balance" | "contraction";
export type DirectionBias = "long" | "flat";
export type ToxicFlow = "low" | "high";
export type LiquidityStress = "normal" | "stressed";

export interface DecisionVector {
  market_regime: Regime;
  direction_bias: DirectionBias;
  toxic_flow_risk: ToxicFlow;
  liquidity_stress: LiquidityStress;
  /** Probability of `long` on direction_bias. Not a number the model invents. */
  confidence: number;
}

export interface GateInput {
  position: "long" | "flat";
  vector: DecisionVector;
  horizonVolBps: number;
  spreadBps: number;
  makerFeeBps: number;
  takerFeeBps: number;
  feeBuffer: number;
  buyThreshold: number;
  sellThreshold: number;
  /** USD depth on levels 1 to 3 of the side a new entry would join. */
  depthUsd: number;
  notionalUsd: number;
  participation: number;
  minSizeUsd: number;
  /** Room under the book gross cap. Infinity means the cap is not in force. */
  remainingGrossUsd: number;
  halted: boolean;
  feedBlocked: boolean;
  /** Fast average versus slow average. A new long requires `above`. */
  emaCross: "above" | "below" | "flat";
  /** Close-to-close return over the last 4 hours, in bps. */
  h4ReturnBps: number;
  stopLossBps: number;
  takeProfitBps: number;
}

export interface GateResult {
  target: "long" | "flat";
  /** True only when a new long is approved. */
  approved: boolean;
  /** Why an entry was refused or a long was flattened. Null while a long is held. */
  reason: string | null;
  expectedYieldBps: number;
  hurdleBps: number;
  sizeUsd: number;
}

/**
 * Post-only round trip the entry must clear, in bps of mid.
 * Both legs are maker. Gas is zero on Coinbase. A stop still pays taker, outside this hurdle.
 */
export function hurdleBps(opts: {
  makerFeeBps: number;
  takerFeeBps: number;
  spreadBps: number;
  feeBuffer: number;
}): number {
  const halfSpread = Math.max(0, opts.spreadBps) / 2;
  const gasBps = 0;
  // takerFeeBps stays on the input so stops can be priced apart from this hurdle.
  void opts.takerFeeBps;
  return (opts.makerFeeBps + opts.makerFeeBps + halfSpread + gasBps) * opts.feeBuffer;
}

export function expectedYieldBps(horizonVolBps: number, confidence: number): number {
  const vol = Number.isFinite(horizonVolBps) ? Math.max(0, horizonVolBps) : 0;
  const edge = Math.max(0, 2 * confidence - 1);
  return vol * edge;
}

/**
 * Take-profit has to clear the same round trip an entry is charged.
 * A tighter target would close a winner and still book a fee loss.
 */
export function assertTakeProfitClearsFees(takeProfitBps: number, makerFeeBps: number, takerFeeBps: number): void {
  const floor = makerFeeBps + takerFeeBps;
  if (!(takeProfitBps > floor)) {
    throw new Error(`CB_TAKE_PROFIT_BPS ${takeProfitBps} must clear maker plus taker fees (${floor} bps)`);
  }
}

/**
 * Hard guards against the fee-inclusive entry. Stop has no fee floor.
 * Returns null when neither level is breached.
 */
export function guardTrip(
  entry: number,
  mid: number,
  stopLossBps: number,
  takeProfitBps: number,
): "stop" | "take_profit" | null {
  if (!(entry > 0) || !(mid > 0)) return null;
  const adverseBps = ((entry - mid) / entry) * 10_000;
  const favorableBps = ((mid - entry) / entry) * 10_000;
  if (adverseBps >= stopLossBps) return "stop";
  if (favorableBps >= takeProfitBps) return "take_profit";
  return null;
}

export function evaluateGate(input: GateInput): GateResult {
  const hurdle = hurdleBps(input);
  const yieldBps = expectedYieldBps(input.horizonVolBps, input.vector.confidence);
  const depthSized = Math.min(input.notionalUsd, Math.max(0, input.participation) * Math.max(0, input.depthUsd));
  const remaining = Number.isFinite(input.remainingGrossUsd) ? Math.max(0, input.remainingGrossUsd) : depthSized;
  const sized = Math.min(depthSized, remaining);

  const base = {
    expectedYieldBps: yieldBps,
    hurdleBps: hurdle,
    sizeUsd: sized,
    approved: false,
  };

  if (input.position === "long") {
    if (input.halted) return { ...base, target: "flat", reason: "halt", sizeUsd: 0 };
    if (input.vector.toxic_flow_risk === "high") return { ...base, target: "flat", reason: "toxic flow", sizeUsd: 0 };
    if (input.vector.market_regime === "contraction") return { ...base, target: "flat", reason: "regime", sizeUsd: 0 };
    return { ...base, target: "long", reason: null, sizeUsd: 0 };
  }

  const refuse = (reason: string): GateResult => ({ ...base, target: "flat", reason, sizeUsd: reason === "dust" ? sized : 0 });

  if (input.halted) return refuse("halt");
  if (input.feedBlocked) return refuse("feed");
  if (input.emaCross !== "above") return refuse("trend");
  if (input.vector.toxic_flow_risk === "high") return refuse("toxic flow");
  if (input.vector.liquidity_stress === "stressed") return refuse("liquidity stress");
  if (input.vector.market_regime === "contraction") return refuse("regime");
  if (input.h4ReturnBps > input.stopLossBps) return refuse("chase");
  const legs = payoffLegs(input.takeProfitBps, input.stopLossBps, input.makerFeeBps, input.takerFeeBps);
  if (!(legs.winnerBps >= 2 * legs.loserBps)) return refuse("payoff");
  if (Number.isFinite(input.remainingGrossUsd) && input.remainingGrossUsd < input.minSizeUsd) return refuse("gross cap");
  if (!(sized >= input.minSizeUsd)) return refuse("dust");

  return { ...base, target: "long", approved: true, reason: null, sizeUsd: sized };
}

/** Pull the gate off a stored decision so the API does not make the UI parse `state`. */
export function gateFromState(state: unknown): { approved: boolean | null; reason: string | null; hurdleBps: number | null } {
  const raw = typeof state === "string" ? parseState(state) : state;
  if (!raw || typeof raw !== "object") return { approved: null, reason: null, hurdleBps: null };
  const gate = (raw as { gate?: { approved?: unknown; reason?: unknown; hurdleBps?: unknown } }).gate;
  if (!gate || typeof gate !== "object") return { approved: null, reason: null, hurdleBps: null };
  return {
    approved: typeof gate.approved === "boolean" ? gate.approved : null,
    reason: typeof gate.reason === "string" ? gate.reason : null,
    hurdleBps: typeof gate.hurdleBps === "number" ? gate.hurdleBps : null,
  };
}

function parseState(state: string): unknown {
  try {
    return JSON.parse(state);
  } catch {
    return null;
  }
}
