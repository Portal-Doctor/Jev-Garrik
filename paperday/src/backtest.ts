/**
 * Revenue gates and the jev_off matrix loader.
 * jev_veto and jev_select are not executed: they need a real gateway key.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { ENABLED_PAIRS, type AllocatorMode, type RunStrategy, type SentimentMode, type ShareFormula } from "./config";
import type { Candle } from "./bars";
import { classExpectancy, type ExpectancyReport } from "./expectancy";
import { runEngine, type EngineResult } from "./engine";
import { MIN_TRADES, requiredGate, TARGET_PACE_USD, targetGate, type SampleStatus, type WindowId } from "./gate";
import { prepareSwingPairs, runBreakoutPaper, runSwing, type SwingPair } from "./higher";
import { buildMarketProxy, proxyAt, type ProxyBook } from "./proxy";

export const WINDOW_END_MS = Date.parse("2026-10-09T00:00:00.000Z");

export const WINDOWS = {
  "1m": { fromMs: Date.parse("2026-09-09T00:00:00.000Z"), toMs: WINDOW_END_MS },
  "3m": { fromMs: Date.parse("2026-07-09T00:00:00.000Z"), toMs: WINDOW_END_MS },
  "6m": { fromMs: Date.parse("2026-04-09T00:00:00.000Z"), toMs: WINDOW_END_MS },
} as const;

export type { WindowId };
export { MIN_TRADES, requiredGate, targetGate };

export interface WidthStats {
  n: number;
  min: number | null;
  p25: number | null;
  p50: number | null;
  p75: number | null;
  max: number | null;
  mean: number | null;
}

export function widthStats(values: number[]): WidthStats {
  if (values.length === 0) return { n: 0, min: null, p25: null, p50: null, p75: null, max: null, mean: null };
  const xs = values.slice().sort((a, b) => a - b);
  const q = (p: number) => {
    const i = (xs.length - 1) * p;
    const lo = Math.floor(i);
    const hi = Math.ceil(i);
    if (lo === hi) return xs[lo]!;
    return xs[lo]! * (hi - i) + xs[hi]! * (i - lo);
  };
  return {
    n: xs.length,
    min: xs[0]!,
    p25: q(0.25),
    p50: q(0.5),
    p75: q(0.75),
    max: xs[xs.length - 1]!,
    mean: xs.reduce((s, x) => s + x, 0) / xs.length,
  };
}

export function loadCandleCsv(path: string): Candle[] {
  const text = readFileSync(path, "utf8");
  const out: Candle[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [tsRaw, openRaw, highRaw, lowRaw, closeRaw, volRaw] = line.split(",");
    let ts = Number(tsRaw);
    if (ts > 0 && ts < 1e12) ts *= 1000;
    const open = Number(openRaw);
    const high = Number(highRaw);
    const low = Number(lowRaw);
    const close = Number(closeRaw);
    const volume = Number(volRaw);
    if (!Number.isFinite(ts) || !(close > 0)) continue;
    out.push({ ts, open, high, low, close, volume });
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

export function hashCandles(candles: Record<string, Candle[]>): string {
  const hash = createHash("sha256");
  for (const pair of Object.keys(candles).sort()) {
    const bars = candles[pair] ?? [];
    hash.update(pair);
    hash.update(String(bars.length));
    const first = bars[0];
    const last = bars[bars.length - 1];
    if (first) hash.update(`${first.ts}:${first.close}`);
    if (last) hash.update(`${last.ts}:${last.close}`);
    let sum = 0;
    for (let i = 0; i < bars.length; i += 1000) sum += bars[i]!.close;
    hash.update(String(sum));
  }
  return hash.digest("hex");
}

export interface MatrixRow {
  strategy: RunStrategy;
  variant: "jev_off" | "jev_veto" | "jev_select";
  mode: AllocatorMode;
  formula: ShareFormula;
  window: WindowId;
  sentimentMode: SentimentMode;
  sentimentLabel: "upper bound" | "proxy";
  fromMs: number;
  toMs: number;
  netUsd: number | null;
  maxDrawdownUsd: number | null;
  trades: number | null;
  wins: number | null;
  winRate: number | null;
  avgR: number | null;
  eR: number | null;
  eBps: number | null;
  pStar: number | null;
  ideas: number | null;
  rejects: Record<string, number>;
  exits: Record<string, number>;
  stopWidth: Record<string, WidthStats>;
  sample: SampleStatus | "not_run";
  requiredPass: boolean | null;
  requiredReasons: string[];
  targetPass: boolean | null;
  targetReasons: string[];
  jevCalls: number;
  jevTokens: number;
  jevSpendUsd: number;
  status: "pass" | "fail" | "not_run" | "blocked";
  note: string;
}

function sentimentLabel(mode: SentimentMode): "upper bound" | "proxy" {
  return mode === "sentiment_blind" ? "upper bound" : "proxy";
}

function rowFromResult(
  strategy: RunStrategy,
  opts: { mode: AllocatorMode; formula: ShareFormula; window: WindowId; sentimentMode: SentimentMode },
  result: EngineResult,
  research: boolean,
): MatrixRow {
  const w = WINDOWS[opts.window];
  const exp: ExpectancyReport = classExpectancy(result.samples);
  const required = requiredGate({
    window: opts.window,
    netUsd: result.netUsd,
    maxDrawdownUsd: result.maxDrawdownUsd,
    trades: result.trades,
    expectancyPass: exp.pass,
    pairHaltBreached: result.pairHaltBreached,
    dailyHaltBreached: result.dailyHaltBreached,
    research,
  });
  const target = targetGate({
    paceUsd: TARGET_PACE_USD[opts.window],
    fromMs: w.fromMs,
    toMs: w.toMs,
    netUsd: result.netUsd,
    quarters: result.quarters,
  });
  const stopWidth: Record<string, WidthStats> = {};
  for (const [pair, widths] of Object.entries(result.stopsByPair)) stopWidth[pair] = widthStats(widths);
  return {
    strategy,
    variant: "jev_off",
    mode: opts.mode,
    formula: opts.formula,
    window: opts.window,
    sentimentMode: opts.sentimentMode,
    sentimentLabel: sentimentLabel(opts.sentimentMode),
    fromMs: w.fromMs,
    toMs: w.toMs,
    netUsd: result.netUsd,
    maxDrawdownUsd: result.maxDrawdownUsd,
    trades: result.trades,
    wins: result.wins,
    winRate: result.trades > 0 ? result.wins / result.trades : null,
    avgR: result.avgR,
    eR: exp.eR,
    eBps: exp.eBps,
    pStar: exp.pStar,
    ideas: result.ideas,
    rejects: result.rejects,
    exits: result.exits,
    stopWidth,
    sample: required.sample,
    requiredPass: required.pass,
    requiredReasons: required.reasons,
    targetPass: target.pass,
    targetReasons: target.reasons,
    jevCalls: 0,
    jevTokens: 0,
    jevSpendUsd: 0,
    status: required.pass ? "pass" : "fail",
    note: research
      ? "intraday research arm, excluded from the required gate"
      : opts.sentimentMode === "sentiment_blind"
        ? "sentiment-blind upper bound"
        : "market-proxy sentiment",
  };
}

export interface RunContext {
  candles: Record<string, Candle[]>;
  btc: Candle[];
  prepared: SwingPair[];
  proxy: ProxyBook;
}

export function buildRunContext(candles: Record<string, Candle[]>, btc: Candle[]): RunContext {
  return {
    candles,
    btc,
    prepared: prepareSwingPairs(candles, ENABLED_PAIRS, WINDOW_END_MS),
    proxy: buildMarketProxy(candles, btc, WINDOW_END_MS),
  };
}

export async function runJevOffCell(opts: {
  ctx: RunContext;
  strategy: RunStrategy;
  mode: AllocatorMode;
  formula: ShareFormula;
  window: WindowId;
  sentimentMode: SentimentMode;
}): Promise<MatrixRow> {
  const w = WINDOWS[opts.window];
  const common = {
    candles: opts.ctx.candles,
    fromMs: w.fromMs,
    toMs: w.toMs,
    mode: opts.mode,
    formula: opts.formula,
    strategy: opts.strategy,
    sentimentMode: opts.sentimentMode,
    proxy: opts.sentimentMode === "market_proxy" ? opts.ctx.proxy : null,
    swingApproved: true,
    enabledPairs: ENABLED_PAIRS,
    variant: "jev_off" as const,
    prepared: opts.ctx.prepared,
  };
  if (opts.strategy === "repo_breakout_4h") {
    const result = await runBreakoutPaper(common);
    return rowFromResult(opts.strategy, opts, result, false);
  }
  if (opts.strategy === "intraday_research") {
    const result = await runEngine({
      candles: opts.ctx.candles,
      fromMs: w.fromMs,
      toMs: w.toMs,
      mode: opts.mode,
      formula: opts.formula,
      strategy: "combined",
      sentiment: opts.sentimentMode === "sentiment_blind" ? "clear" : "clear",
      enabledPairs: ENABLED_PAIRS,
      variant: "jev_off",
      sentimentAt:
        opts.sentimentMode === "market_proxy"
          ? (pair, ts) => {
              const mark = proxyAt(opts.ctx.proxy, pair, ts);
              if (mark.veto) return "veto";
              if (mark.caution) return "caution";
              return "clear";
            }
          : undefined,
    });
    return rowFromResult(opts.strategy, opts, result, true);
  }
  const result = await runSwing(common);
  return rowFromResult(opts.strategy, opts, result, false);
}

export function blockedJevNote(): string {
  return "blocked: AI_GATEWAY_API_KEY not present";
}
