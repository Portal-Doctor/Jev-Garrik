export type CheckStatus = "pass" | "fail" | "unscored";

export interface CheckRow {
  area: string;
  metric: string;
  target: string;
  value: string;
  status: CheckStatus;
}

export interface Mark {
  ts: number;
  price: number;
}

export interface SideSummary {
  returnUsd: number;
  returnPct: number;
  trades: number;
  wins: number;
  feesUsd: number;
  buys: Mark[];
  sells: Mark[];
}

export interface BacktestScore {
  predictions: number;
  hitRate1s: number | null;
  hitRate1h: number | null;
  hitRate4h: number | null;
  edgeRatio: number | null;
  edgeWinRate: number | null;
  avoidance: number | null;
  breakoutSignals: number;
  fakeBreakEntries: number;
  grossUsd: number;
  netUsd: number;
  makerFeesUsd: number;
  takerFeesUsd: number;
  netToGross: number | null;
  makerFillRate: number | null;
  slippageBps: number | null;
  sortino: number | null;
  maxDrawdown: number | null;
  recoveryBars: number | null;
  sqn: number | null;
  trades: number;
  checks: CheckRow[];
}

export interface BacktestResult {
  pair: string;
  months: 1 | 3 | 6;
  barSec: number;
  fromTs: number;
  toTs: number;
  bars: number;
  bankrollUsd: number;
  notionalUsd: number;
  stopLossBps?: number;
  takeProfitBps?: number;
  assumedSpreadBps: number;
  assumptions: string[];
  strategy: SideSummary;
  oracle: SideSummary;
  holdUsd: number;
  price: Array<{ ts: number; close: number }>;
  score: BacktestScore;
  diagnostics: Diagnostics;
  fixedAvgWinUsd: number | null;
  fixedAvgLossUsd: number | null;
  fixedMaxHoldHours: number;
  breakout?: BreakoutSummary;
}

export interface BreakoutSummary extends SideSummary {
  missedEntries: number;
  vetoedEntries: number;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  maxDrawdown: number | null;
  maxHoldHours: number;
  lowFeeNetUsd: number;
}

export interface FeeTierRow {
  name: string;
  makerBps: number;
  takerBps: number;
  buffer: number;
  cleared: number;
}

export interface Diagnostics {
  candidates: number;
  cleared: number;
  candidatesPerDay: number;
  clearedPerDay: number;
  closestExpectedBps: number | null;
  closestHurdleBps: number | null;
  closestGapBps: number | null;
  medianGapBps: number | null;
  yieldRefusals: number;
  shadowTrades: number;
  shadowNetUsd: number;
  shadowGrossUsd: number;
  adverseSelection: number | null;
  feeTiers: FeeTierRow[];
  breakevenRoundTripBps: number | null;
  hitRate10s: number | null;
  hitRate1m: number | null;
  hitRate5m: number | null;
  edge10s: number | null;
  edge1m: number | null;
  edge5m: number | null;
  edge1h: number | null;
  spreadNote: string;
  queueNote: string;
  lowFeeNetUsd: number;
}
