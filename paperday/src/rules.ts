/**
 * Rule engine. Bias gate, setups A/B/C, sentiment veto.
 * Setups are the conservative reading of an unspecified day-trade card:
 * long only, completed 5-minute bars, no entry from sentiment itself.
 *
 * A — pullback to EMA20 while above session VWAP. Allowed when sentiment is unknown.
 * B — VWAP reclaim with participation. Requires a clear sentiment read.
 * C — 5-minute Donchian break of the prior 20 highs while the completed 4-hour
 *     close is through its prior 20-bar Donchian. Requires a clear sentiment read.
 */

import type { StrategyId } from "./config";

export type SetupId = "A" | "B" | "C";
export type Sentiment = "clear" | "veto" | "unknown";

export interface DecisionSnapshot {
  pair: string;
  barTs: number;
  close: number;
  low: number;
  high: number;
  prevClose: number | null;
  prevVwap: number | null;
  vwap: number | null;
  ema9: number | null;
  ema20: number | null;
  ema50: number | null;
  ema200: number | null;
  rsi: number | null;
  macd: number | null;
  macdSignal: number | null;
  atr: number | null;
  volume: number;
  volSma20: number | null;
  recentLow3: number;
  donchian5mPriorHigh: number | null;
  close4h: number | null;
  donchian4hPriorHigh: number | null;
  biasKnown: boolean;
  biasUp: boolean;
}

export interface Candidate {
  id: string;
  pair: string;
  setup: SetupId;
  barTs: number;
  side: "long";
  entry: number;
  stop: number;
  signalClose: number;
  atr: number;
  rsi: number | null;
  /** True only if a caller tried to manufacture an entry from sentiment. Rules never set this. */
  originatedFromSentiment: boolean;
}

export function candidateId(pair: string, setup: SetupId, barTs: number): string {
  return `${pair}|${setup}|${barTs}`;
}

function warmed(s: DecisionSnapshot): boolean {
  return (
    s.biasKnown &&
    s.vwap != null &&
    s.ema9 != null &&
    s.ema20 != null &&
    s.ema50 != null &&
    s.ema200 != null &&
    s.rsi != null &&
    s.macd != null &&
    s.macdSignal != null &&
    s.atr != null &&
    s.atr > 0 &&
    s.volSma20 != null &&
    s.close > 0
  );
}

function stopBelow(close: number, structural: number): number | null {
  if (!(structural > 0) || !(structural < close)) return null;
  return structural;
}

function setupA(s: DecisionSnapshot): Candidate | null {
  if (s.vwap == null || s.ema9 == null || s.ema20 == null || s.ema50 == null || s.rsi == null) return null;
  if (s.macd == null || s.macdSignal == null) return null;
  if (!(s.close > s.vwap)) return null;
  if (!(s.ema9 > s.ema20)) return null;
  if (!(s.close > s.ema50)) return null;
  if (!(s.low <= s.ema20 && s.close > s.ema20)) return null;
  if (!(s.rsi >= 35 && s.rsi <= 65)) return null;
  if (!(s.macd >= s.macdSignal)) return null;
  const stop = stopBelow(s.close, s.recentLow3);
  if (stop == null || s.atr == null) return null;
  return {
    id: candidateId(s.pair, "A", s.barTs),
    pair: s.pair,
    setup: "A",
    barTs: s.barTs,
    side: "long",
    entry: s.close,
    stop,
    signalClose: s.close,
    atr: s.atr,
    rsi: s.rsi,
    originatedFromSentiment: false,
  };
}

function setupB(s: DecisionSnapshot): Candidate | null {
  if (s.vwap == null || s.prevVwap == null || s.prevClose == null) return null;
  if (s.ema9 == null || s.ema20 == null || s.rsi == null || s.macd == null || s.macdSignal == null) return null;
  if (s.volSma20 == null || s.atr == null) return null;
  if (!(s.prevClose < s.prevVwap && s.close > s.vwap)) return null;
  if (!(s.ema9 > s.ema20)) return null;
  if (!(s.rsi >= 40 && s.rsi <= 70)) return null;
  if (!(s.macd > s.macdSignal)) return null;
  if (!(s.volume > s.volSma20)) return null;
  const structural = Math.min(s.recentLow3, s.low);
  const stop = stopBelow(s.close, structural);
  if (stop == null) return null;
  return {
    id: candidateId(s.pair, "B", s.barTs),
    pair: s.pair,
    setup: "B",
    barTs: s.barTs,
    side: "long",
    entry: s.close,
    stop,
    signalClose: s.close,
    atr: s.atr,
    rsi: s.rsi,
    originatedFromSentiment: false,
  };
}

function setupC(s: DecisionSnapshot): Candidate | null {
  if (s.donchian5mPriorHigh == null || s.donchian4hPriorHigh == null || s.close4h == null) return null;
  if (s.ema20 == null || s.rsi == null || s.volSma20 == null || s.atr == null) return null;
  if (!(s.close > s.donchian5mPriorHigh)) return null;
  if (!(s.close4h > s.donchian4hPriorHigh)) return null;
  if (!(s.close > s.ema20)) return null;
  if (!(s.rsi < 70)) return null;
  if (!(s.volume > s.volSma20)) return null;
  const stop = stopBelow(s.close, s.recentLow3);
  if (stop == null) return null;
  return {
    id: candidateId(s.pair, "C", s.barTs),
    pair: s.pair,
    setup: "C",
    barTs: s.barTs,
    side: "long",
    entry: s.close,
    stop,
    signalClose: s.close,
    atr: s.atr,
    rsi: s.rsi,
    originatedFromSentiment: false,
  };
}

export function findSetups(s: DecisionSnapshot, sentiment: Sentiment, strategy: StrategyId = "combined"): Candidate[] {
  if (!warmed(s) || !s.biasUp) return [];
  if (sentiment === "veto") return [];
  const out: Candidate[] = [];
  const allow = (id: SetupId) => strategy === "combined" || strategy === id;
  if (allow("A")) {
    const a = setupA(s);
    if (a) out.push(a);
  }
  if (sentiment === "clear") {
    if (allow("B")) {
      const b = setupB(s);
      if (b) out.push(b);
    }
    if (allow("C")) {
      const c = setupC(s);
      if (c) out.push(c);
    }
  }
  return out;
}

/** Stable rules order used when Jev is off, at stage 0, or unavailable. */
export function rulesOrder(a: Candidate, b: Candidate): number {
  if (a.barTs !== b.barTs) return a.barTs - b.barTs;
  if (a.pair !== b.pair) return a.pair < b.pair ? -1 : 1;
  return a.setup < b.setup ? -1 : a.setup > b.setup ? 1 : 0;
}
