/**
 * Revenue gate and candle-cache loader for the 1/3/6-month matrix.
 * jev_veto and jev_select are not executed here: they need paid Jev reviews.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { BOOK_DRAWDOWN_HALT_USD, ENABLED_PAIRS, type AllocatorMode, type ShareFormula, type StrategyId } from "./config";
import type { Candle } from "./bars";
import { quarterKey } from "./clock";
import { runEngine, type EngineResult } from "./engine";

export const WINDOW_END_MS = Date.parse("2026-10-09T00:00:00.000Z");

export const WINDOWS = {
  "1m": { fromMs: Date.parse("2026-09-09T00:00:00.000Z"), toMs: WINDOW_END_MS, netUsd: 400 },
  "3m": { fromMs: Date.parse("2026-07-09T00:00:00.000Z"), toMs: WINDOW_END_MS, netUsd: 1_200 },
  "6m": { fromMs: Date.parse("2026-04-09T00:00:00.000Z"), toMs: WINDOW_END_MS, netUsd: 2_400 },
} as const;

export type WindowId = keyof typeof WINDOWS;

export interface GateResult {
  pass: boolean;
  reasons: string[];
}

/** Calendar quarters touched by [fromMs, toMs). A quarter with no closes counts as $0. */
export function quartersTouched(fromMs: number, toMs: number): string[] {
  const seen: string[] = [];
  const mark = (ts: number) => {
    const q = quarterKey(ts);
    if (!seen.includes(q)) seen.push(q);
  };
  if (toMs <= fromMs) return seen;
  for (let t = fromMs; t < toMs; t += 15 * 86_400_000) mark(t);
  mark(toMs - 1);
  return seen;
}

/**
 * Section 7. Every calendar quarter touched by the 6-month window, including
 * partial quarters and quarters with no closes, must clear $1,200.
 */
export function revenueGate(window: WindowId, result: Pick<EngineResult, "netUsd" | "maxDrawdownUsd" | "quarters">): GateResult {
  const reasons: string[] = [];
  const need = WINDOWS[window].netUsd;
  if (!(result.netUsd >= need)) reasons.push(`net ${result.netUsd.toFixed(2)} < ${need}`);
  if (!(result.maxDrawdownUsd <= BOOK_DRAWDOWN_HALT_USD)) {
    reasons.push(`max drawdown ${result.maxDrawdownUsd.toFixed(2)} > ${BOOK_DRAWDOWN_HALT_USD}`);
  }
  if (window === "6m") {
    const byQ = new Map(result.quarters.map((q) => [q.quarter, q.netUsd]));
    for (const quarter of quartersTouched(WINDOWS["6m"].fromMs, WINDOWS["6m"].toMs)) {
      const net = byQ.get(quarter) ?? 0;
      if (!(net >= 1_200)) reasons.push(`${quarter} net ${net.toFixed(2)} < 1200`);
    }
  }
  return { pass: reasons.length === 0, reasons };
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
  strategy: StrategyId;
  variant: "jev_off" | "jev_veto" | "jev_select";
  mode: AllocatorMode;
  formula: ShareFormula;
  window: WindowId;
  fromMs: number;
  toMs: number;
  netUsd: number | null;
  maxDrawdownUsd: number | null;
  quarters: EngineResult["quarters"];
  trades: number | null;
  ideas: number | null;
  rejects: Record<string, number>;
  exits: Record<string, number>;
  gatePass: boolean | null;
  reasons: string[];
  status: "pass" | "fail" | "not_run";
  note: string;
}

export async function runJevOffCell(opts: {
  candles: Record<string, Candle[]>;
  strategy: StrategyId;
  mode: AllocatorMode;
  formula: ShareFormula;
  window: WindowId;
}): Promise<MatrixRow> {
  const w = WINDOWS[opts.window];
  const result = await runEngine({
    candles: opts.candles,
    fromMs: w.fromMs,
    toMs: w.toMs,
    mode: opts.mode,
    formula: opts.formula,
    strategy: opts.strategy,
    sentiment: "unknown",
    enabledPairs: ENABLED_PAIRS,
    variant: "jev_off",
  });
  const gate = revenueGate(opts.window, result);
  return {
    strategy: opts.strategy,
    variant: "jev_off",
    mode: opts.mode,
    formula: opts.formula,
    window: opts.window,
    fromMs: w.fromMs,
    toMs: w.toMs,
    netUsd: result.netUsd,
    maxDrawdownUsd: result.maxDrawdownUsd,
    quarters: result.quarters,
    trades: result.trades,
    ideas: result.ideas,
    rejects: result.rejects,
    exits: result.exits,
    gatePass: gate.pass,
    reasons: gate.reasons,
    status: gate.pass ? "pass" : "fail",
    note: "sentiment unknown (no historical X read) so only setup A, caution cap 1",
  };
}

export function notRunRow(
  strategy: StrategyId,
  variant: "jev_veto" | "jev_select",
  mode: AllocatorMode,
  formula: ShareFormula,
  window: WindowId,
): MatrixRow {
  const w = WINDOWS[window];
  return {
    strategy,
    variant,
    mode,
    formula,
    window,
    fromMs: w.fromMs,
    toMs: w.toMs,
    netUsd: null,
    maxDrawdownUsd: null,
    quarters: [],
    trades: null,
    ideas: null,
    rejects: {},
    exits: {},
    gatePass: null,
    reasons: [],
    status: "not_run",
    note: "not run: needs paid Jev reviews",
  };
}
