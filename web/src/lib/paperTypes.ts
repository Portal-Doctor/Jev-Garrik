/** Types for the cb (Coinbase paper trading) dashboard. Mirror the shapes cb/server.ts emits. */

export type ConnectionState = "connecting" | "live" | "reconnecting";
export type Side = "buy" | "sell";

export interface PairFeedState {
  pair: string;
  mid: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spreadBps: number | null;
  levels: number;
  synced: boolean;
  lastTradeTs: number | null;
}

export interface OpenOrder {
  side: Side;
  purpose: "entry" | "exit";
  price: number;
  remaining: number;
  ageMs: number;
}

export interface PaperPosition {
  pair: string;
  position: "long" | "flat";
  sizeBase: number;
  entryPrice: number | null;
  realizedUsd: number;
  unrealizedUsd: number;
  feesUsd: number;
  inferenceUsd: number;
  equityUsd: number;
  openOrder: OpenOrder | null;
}

export interface LastDecision {
  pair: string;
  action: Side;
  pBuy: number;
  mid: number;
}

export interface PaperMeta {
  runId: string;
  mode: "paper" | "live";
  model: string;
  pairs: string[];
  startedAt: number;
  /** Decision cadence in seconds; sizes the per-pair countdown. */
  decideSec: number;
}

export interface Snapshot {
  pairs: PairFeedState[];
  positions: PaperPosition[];
  decisions: LastDecision[];
  /** Wall-clock ms of the next scheduled decision per pair. */
  nextDecision?: Record<string, number | null>;
}

export interface DecisionEvent {
  id: string;
  pair: string;
  action: Side;
  pBuy: number;
  mid: number;
  ts: number;
  /** Wall-clock ms of the next scheduled decision for this pair. */
  nextTs?: number;
}

export interface FillEvent {
  pair: string;
  side: Side;
  purpose: "entry" | "exit";
  price: number;
  sizeBase: number;
  feeUsd: number;
  liquidity: "maker" | "taker";
  ts: number;
}

export interface Tick {
  pair: string;
  mid: number | null;
  spreadBps: number | null;
}

export interface PaperState {
  meta: PaperMeta | null;
  feed: Record<string, PairFeedState>;
  positions: Record<string, PaperPosition>;
  lastDecision: Record<string, LastDecision>;
  recentDecisions: DecisionEvent[];
  recentFills: FillEvent[];
  nextDecision: Record<string, number>;
  connection: ConnectionState;
}

// --- /report shape (cb/report.ts) ---

export interface HorizonMetrics {
  horizonSec: number;
  n: number;
  accuracy: number;
  wilsonLower: number;
  wilsonUpper: number;
  brier: number;
  edgeBps: number;
}

export interface PairReport {
  pair: string;
  horizons: HorizonMetrics[];
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
