/**
 * Three-book Jul/Aug/Sep 2026 replay at live 40/80.
 *   bun run cb/pool-run.ts
 */

import { runBacktest, type ClosedTrade, type EquityPoint } from "./backtest";
import { runBreakout } from "./breakout";
import { findBook, LIVE_PAIRS } from "./books";
import { config } from "./config";
import { monthlyNets } from "./feereplay";
import { maxDrawdown } from "./metrics";
import { scoreMonthlyGate } from "./monthgate";
import { MAX_CONCURRENT, POOL_DD, POOL_USD } from "./pool";
import { runPooledBreakout } from "./poolbacktest";
import { loadTape } from "./tape";
import { closedTradeScore } from "./tradescore";

const DAY_MS = 86_400_000;
const GATE_MONTHS = ["2026-07", "2026-08", "2026-09"] as const;
const windowStartTs = Date.UTC(2026, 6, 1);
const windowEndTs = Date.UTC(2026, 9, 1);
const fetchFrom = windowStartTs - 10 * DAY_MS;

const usd = (n: number) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const pct = (n: number | null) => (n == null ? "-" : `${(n * 100).toFixed(2)}%`);

function mergeEquity(paths: EquityPoint[][]): EquityPoint[] {
  const stamps = new Set<number>();
  for (const p of paths) for (const e of p) stamps.add(e.ts);
  const idx = paths.map(() => 0);
  const last = paths.map((p) => p[0]?.equity ?? 0);
  const out: EquityPoint[] = [];
  for (const ts of [...stamps].sort((a, b) => a - b)) {
    paths.forEach((p, i) => {
      while (idx[i]! < p.length && p[idx[i]!]!.ts <= ts) {
        last[i] = p[idx[i]!]!.equity;
        idx[i] += 1;
      }
    });
    out.push({ ts, equity: last.reduce((s, n) => s + n, 0) });
  }
  return out;
}

function scoreBook(name: string, trades: ClosedTrade[], wins: number, feesUsd: number, equity: EquityPoint[]) {
  const inGate = trades.filter((t) => {
    const key = `${new Date(t.closedTs).getUTCFullYear()}-${String(new Date(t.closedTs).getUTCMonth() + 1).padStart(2, "0")}`;
    return (GATE_MONTHS as readonly string[]).includes(key);
  });
  const months = monthlyNets(inGate);
  const gate = scoreMonthlyGate(months, [...GATE_MONTHS]);
  const harness = closedTradeScore(inGate, inGate.filter((t) => t.netUsd > 0).length);
  const dd = maxDrawdown(equity.map((p) => p.equity)).maxDrawdown;
  const net = inGate.reduce((s, t) => s + t.netUsd, 0);
  return { name, trades: inGate.length, wins, feesUsd, net, months, gate, harness, dd, allTrades: trades.length };
}

console.log(`Fees ${config.makerFeeBps}/${config.takerFeeBps}. Book knobs ${config.breakoutBars}/${config.trailAtr}/${config.trendEmaBars}.`);
console.log(`Window ${new Date(windowStartTs).toISOString()} to ${new Date(windowEndTs).toISOString()}`);

const tapes = new Map<string, Awaited<ReturnType<typeof loadTape>>>();
for (const pair of LIVE_PAIRS) {
  console.log(`tape ${pair}`);
  tapes.set(pair, await loadTape(pair, fetchFrom, windowEndTs, 300));
}

const n = LIVE_PAIRS.length;
const slice = POOL_USD / n;
const htfEquity: EquityPoint[][] = [];
const boEquity: EquityPoint[][] = [];
const htfTrades: ClosedTrade[] = [];
const boTrades: ClosedTrade[] = [];
let htfFees = 0;
let boFees = 0;
let htfWins = 0;
let boWins = 0;

for (const pair of LIVE_PAIRS) {
  const book = findBook(pair)!;
  const candles = tapes.get(pair)!;
  console.log(`htf+breakout ${pair}`);
  const fixed = runBacktest(candles, {
    pair,
    months: 3,
    windowStartTs,
    barSec: 300,
    horizonSec: config.horizonSec,
    notionalUsd: book.notionalUsd,
    bankrollUsd: slice,
    makerFeeBps: config.makerFeeBps,
    takerFeeBps: config.takerFeeBps,
    feeBuffer: config.feeBuffer,
    buyThreshold: config.buyThreshold,
    sellThreshold: config.sellThreshold,
    stopLossBps: book.stopLossBps,
    takeProfitBps: book.takeProfitBps,
    depthParticipation: config.depthParticipation,
    minSizeUsd: config.minSizeUsd,
    assumedSpreadBps: 2,
    skipOracle: true,
  });
  const bo = runBreakout(candles, {
    pair,
    windowStartTs,
    barSec: 300,
    notionalUsd: book.notionalUsd,
    bankrollUsd: slice,
    makerFeeBps: config.makerFeeBps,
    takerFeeBps: config.takerFeeBps,
    stopLossBps: book.stopLossBps,
    minSizeUsd: config.minSizeUsd,
    breakoutBars: config.breakoutBars,
    trendEmaBars: config.trendEmaBars,
    atrBars: config.atrBars,
    trailAtr: config.trailAtr,
    maxHoldSec: config.breakoutMaxHoldSec,
  });
  htfEquity.push(fixed.strategy.equity);
  boEquity.push(bo.equity);
  htfTrades.push(...fixed.fixedTradeLog);
  boTrades.push(...bo.tradeLog);
  htfFees += fixed.strategy.feesUsd;
  boFees += bo.feesUsd;
  htfWins += fixed.strategy.wins;
  boWins += bo.wins;
}

console.log("pooled rotation");
const pooled = runPooledBreakout({
  windowStartTs,
  windowEndTs,
  bankrollUsd: POOL_USD,
  makerFeeBps: config.makerFeeBps,
  takerFeeBps: config.takerFeeBps,
  minSizeUsd: config.minSizeUsd,
  maxGrossUsd: config.maxGrossUsd,
  maxConcurrent: MAX_CONCURRENT,
  breakoutBars: config.breakoutBars,
  trendEmaBars: config.trendEmaBars,
  atrBars: config.atrBars,
  trailAtr: config.trailAtr,
  maxHoldSec: config.breakoutMaxHoldSec,
  poolDd: POOL_DD,
  pairs: LIVE_PAIRS.map((pair) => {
    const book = findBook(pair)!;
    return { pair, candles: tapes.get(pair)!, notionalUsd: book.notionalUsd, stopLossBps: book.stopLossBps };
  }),
});

const a = scoreBook("split-clip HTF", htfTrades, htfWins, htfFees, mergeEquity(htfEquity));
const b = scoreBook("split-clip breakout", boTrades, boWins, boFees, mergeEquity(boEquity));
const c = scoreBook("pooled rotation breakout", pooled.tradeLog, pooled.wins, pooled.feesUsd, pooled.equity);

function print(s: ReturnType<typeof scoreBook>) {
  const w = s.harness.wilson95;
  console.log(`\n## ${s.name}`);
  console.log(`trades ${s.trades} (tape ${s.allTrades}) fees ${usd(s.feesUsd)} net ${usd(s.net)} portfolio DD ${pct(s.dd)}`);
  console.log(s.gate.detail);
  console.log(
    `n ${s.harness.n} accuracy ${pct(s.harness.accuracy)} wilson ${w ? `${pct(w.lower)} to ${pct(w.upper)}` : "-"} brier ${s.harness.brier == null ? "-" : s.harness.brier.toFixed(4)} edge ${s.harness.edgeBps == null ? "-" : s.harness.edgeBps.toFixed(1)} bps`,
  );
  for (const m of GATE_MONTHS) {
    const row = s.months.find((x) => x.month === m);
    console.log(`  ${m} ${usd(row?.netUsd ?? 0)}`);
  }
}

print(a);
print(b);
print(c);
console.log(`\npooled rotations ${pooled.rotations} missed ${pooled.missedEntries} vetoed ${pooled.vetoedEntries} halted ${pooled.halted}`);

await Bun.write(
  "data/pooled-capital-run.json",
  JSON.stringify({ a, b, c, pooled: { rotations: pooled.rotations, missed: pooled.missedEntries, vetoed: pooled.vetoedEntries, halted: pooled.halted } }, null, 2),
);
