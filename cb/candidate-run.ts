/**
 * Backtest locked breakout 20/3/50 and HTF fixed-target on screened pairs.
 * Fees stay live 50/90. Knobs stay locked. Does not change CB_PAIRS.
 *
 *   bun run cb/candidate-run.ts
 */

import { scoreAdoption, type AdoptionPair } from "./adoption";
import { runBacktest, type ClosedTrade } from "./backtest";
import { runBreakout } from "./breakout";
import { findBook } from "./books";
import { config } from "./config";
import { monthlyNets } from "./feereplay";
import { scoreMonthlyGate } from "./monthgate";
import { closedTradeScore } from "./tradescore";
import { clipFromLiquidity, LIVE_PAIRS } from "./screen";
import { loadTape } from "./tape";

const DAY_MS = 86_400_000;
const usd = (n: number) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const pct = (n: number | null) => (n == null ? "-" : `${(n * 100).toFixed(2)}%`);

interface KeptFile {
  now: number;
  windowStartTs: number;
  arb30dUsd: number;
  uni30dUsd?: number;
  kept: Array<{ pair: string; volBps: number | null; notional30dUsd: number | null }>;
}

function tradeScore(trades: ClosedTrade[], wins: number, makerFeeBps: number, takerFeeBps: number) {
  return { ...closedTradeScore(trades, wins), roundTripBps: makerFeeBps + takerFeeBps };
}

const keptFile = (await Bun.file("docs/screen-kept.json").json()) as KeptFile;
const uniNotional = keptFile.uni30dUsd ?? keptFile.arb30dUsd * 2;

function riskFor(pair: string, volBps: number, notional30d: number, nPairs: number) {
  const live = findBook(pair);
  const sigma = live?.sigmaBps ?? Math.max(1, Math.round(volBps));
  const notionalUsd = live?.notionalUsd ?? clipFromLiquidity(notional30d, keptFile.arb30dUsd, Math.max(uniNotional, keptFile.arb30dUsd + 1));
  const stopLossBps = live?.stopLossBps ?? sigma;
  const takeProfitBps = live?.takeProfitBps ?? sigma * 4;
  return {
    notionalUsd,
    stopLossBps,
    takeProfitBps,
    bankrollUsd: config.bankrollUsd / nPairs,
    sigmaBps: sigma,
  };
}

const candidates = keptFile.kept.filter((k) => k.volBps != null && k.notional30dUsd != null);
const now = keptFile.now;
const windowStartTs = keptFile.windowStartTs;
const fetchFrom = windowStartTs - 10 * DAY_MS;

console.log(`Fees ${config.makerFeeBps}/${config.takerFeeBps}. Knobs ${config.breakoutBars}/${config.trailAtr}/${config.trendEmaBars}/${config.breakoutMaxHoldSec}s.`);
console.log(`Window ${new Date(windowStartTs).toISOString()} to ${new Date(now).toISOString()}`);
console.log(`Candidates ${candidates.length}`);

type PairOut = {
  pair: string;
  live: boolean;
  clip: number;
  sigmaBps: number;
  bankrollUsd: number;
  breakout: ReturnType<typeof tradeScore> & { netUsd: number; dd: number | null; missed: number; signals: number; vetoed: number; wins: number; months: ReturnType<typeof monthlyNets> };
  fixed: ReturnType<typeof tradeScore> & { netUsd: number; dd: number | null; wins: number; months: ReturnType<typeof monthlyNets> };
  adoption: AdoptionPair;
};

async function runPair(pair: string, volBps: number, notional30d: number, nPairs: number, live: boolean): Promise<PairOut> {
  const risk = riskFor(pair, volBps, notional30d, nPairs);
  console.log(`tape ${pair} clip $${risk.notionalUsd} stop ${risk.stopLossBps} tp ${risk.takeProfitBps}`);
  const candles = await loadTape(pair, fetchFrom, now, 300);
  const fixed = runBacktest(candles, {
    pair,
    months: 6,
    windowStartTs,
    barSec: 300,
    horizonSec: config.horizonSec,
    notionalUsd: risk.notionalUsd,
    bankrollUsd: risk.bankrollUsd,
    makerFeeBps: config.makerFeeBps,
    takerFeeBps: config.takerFeeBps,
    feeBuffer: config.feeBuffer,
    buyThreshold: config.buyThreshold,
    sellThreshold: config.sellThreshold,
    stopLossBps: risk.stopLossBps,
    takeProfitBps: risk.takeProfitBps,
    depthParticipation: config.depthParticipation,
    minSizeUsd: config.minSizeUsd,
    assumedSpreadBps: 2,
    skipOracle: true,
  });
  const bo = runBreakout(candles, {
    pair,
    windowStartTs,
    barSec: 300,
    notionalUsd: risk.notionalUsd,
    bankrollUsd: risk.bankrollUsd,
    makerFeeBps: config.makerFeeBps,
    takerFeeBps: config.takerFeeBps,
    stopLossBps: risk.stopLossBps,
    minSizeUsd: config.minSizeUsd,
    breakoutBars: config.breakoutBars,
    trendEmaBars: config.trendEmaBars,
    atrBars: config.atrBars,
    trailAtr: config.trailAtr,
    maxHoldSec: config.breakoutMaxHoldSec,
  });
  const adoption: AdoptionPair = {
    pair,
    bankrollUsd: risk.bankrollUsd,
    fixedTrades: fixed.score.trades,
    fixedWinRate: fixed.score.trades > 0 ? fixed.strategy.wins / fixed.score.trades : null,
    fixedNetUsd: fixed.score.netUsd,
    fixedMaxDrawdown: fixed.score.maxDrawdown,
    breakoutTrades: bo.trades,
    breakoutWinRate: bo.trades > 0 ? bo.wins / bo.trades : null,
    breakoutNetUsd: bo.returnUsd,
    breakoutMaxDrawdown: bo.maxDrawdown,
    missedEntries: bo.missedEntries,
    vetoedEntries: bo.vetoedEntries,
    signals: bo.buys.length + bo.missedEntries,
  };
  return {
    pair,
    live,
    clip: risk.notionalUsd,
    sigmaBps: risk.sigmaBps,
    bankrollUsd: risk.bankrollUsd,
    breakout: {
      ...tradeScore(bo.tradeLog, bo.wins, config.makerFeeBps, config.takerFeeBps),
      netUsd: bo.returnUsd,
      dd: bo.maxDrawdown,
      missed: bo.missedEntries,
      signals: bo.buys.length + bo.missedEntries,
      vetoed: bo.vetoedEntries,
      wins: bo.wins,
      months: monthlyNets(bo.tradeLog),
    },
    fixed: {
      ...tradeScore(fixed.fixedTradeLog, fixed.strategy.wins, config.makerFeeBps, config.takerFeeBps),
      netUsd: fixed.score.netUsd,
      dd: fixed.score.maxDrawdown,
      wins: fixed.strategy.wins,
      months: monthlyNets(fixed.fixedTradeLog),
    },
    adoption,
  };
}

const liveOut: PairOut[] = [];
for (const pair of LIVE_PAIRS) {
  const book = findBook(pair)!;
  liveOut.push(await runPair(pair, book.sigmaBps, keptFile.arb30dUsd, LIVE_PAIRS.length, true));
}

const candOut: PairOut[] = [];
for (const k of candidates) {
  candOut.push(await runPair(k.pair, k.volBps!, k.notional30dUsd!, LIVE_PAIRS.length, false));
}

const passingNew = candOut.filter((p) => (p.breakout.dd ?? 1) < 0.15);
const combined = [...liveOut.map((p) => p.adoption), ...passingNew.map((p) => p.adoption)];
const combinedScore = scoreAdoption(combined);
const combinedBoTrades = [...liveOut, ...passingNew].flatMap((p) =>
  p.breakout.months.map((m) => ({ month: m.month, netUsd: m.netUsd, pair: p.pair })),
);
const byMonth = new Map<string, number>();
for (const p of [...liveOut, ...passingNew]) {
  for (const m of p.breakout.months) byMonth.set(m.month, (byMonth.get(m.month) ?? 0) + m.netUsd);
}
const monthNets = [...byMonth.entries()].sort().map(([month, netUsd]) => ({ month, netUsd }));
const gateMonths = ["2026-07", "2026-08", "2026-09"];
const gate = scoreMonthlyGate(monthNets, gateMonths);

const line = (p: PairOut, book: "breakout" | "fixed") => {
  const s = p[book];
  const w = s.wilson95;
  return `| ${p.pair} | ${s.n} | ${pct(s.accuracy)} | ${w ? `${(w.lower * 100).toFixed(1)}-${(w.upper * 100).toFixed(1)}%` : "-"} | ${s.brier == null ? "-" : s.brier.toFixed(4)} | ${s.edgeBps == null ? "-" : s.edgeBps.toFixed(1)} | ${usd(s.netUsd)} | ${pct(s.dd)} |`;
};

const md: string[] = [];
md.push("# Candidate breakout backtest");
md.push("");
md.push("Locked breakout 20/3/50, live fees 50/90. HTF fixed-target is comparison only. Live path stays breakout. The running 24h window was not given these pairs.");
md.push("New pairs that fail adoption rule 3 (drawdown at or above 15%) are not added to the combined book.");
md.push("");
md.push("## New candidates, breakout");
md.push("");
md.push("| Pair | n | Accuracy | Wilson 95% | Brier | Edge bps | Net | DD |");
md.push("|---|---:|---:|---|---:|---:|---:|---:|");
for (const p of candOut) md.push(line(p, "breakout"));
md.push("");
md.push("## New candidates, HTF fixed target");
md.push("");
md.push("| Pair | n | Accuracy | Wilson 95% | Brier | Edge bps | Net | DD |");
md.push("|---|---:|---:|---|---:|---:|---:|---:|");
for (const p of candOut) md.push(line(p, "fixed"));
md.push("");
md.push("## Per-pair adoption (new)");
md.push("");
md.push("| Pair | Clip | Rule1 net>0 | Beats HTF | Rule3 DD<15% | Miss rate | Trades |");
md.push("|---|---:|---|---|---|---:|---:|");
for (const p of candOut) {
  const a = p.adoption;
  const miss = a.signals > 0 ? a.missedEntries / a.signals : 0;
  md.push(
    `| ${p.pair} | $${p.clip} | ${a.breakoutNetUsd > 0 ? "yes" : "no"} | ${a.breakoutNetUsd > a.fixedNetUsd ? "yes" : "no"} | ${(a.breakoutMaxDrawdown ?? 1) < 0.15 ? "yes" : "NO"} | ${pct(miss)} | ${a.breakoutTrades} |`,
  );
}
md.push("");
md.push(`Passing rule 3: ${passingNew.map((p) => p.pair).join(", ") || "(none)"}.`);
md.push("");
md.push("## Combined book (original six plus rule-3 passers)");
md.push("");
for (const r of combinedScore.rules) md.push(`${r.n}. ${r.passes ? "Pass" : "Fail"}. ${r.detail}`);
md.push(`All five: ${combinedScore.passes ? "PASS" : "FAIL"}`);
md.push("");
md.push("### Monthly nets, combined breakout");
md.push("");
md.push(`| Month | Net |`);
md.push(`|---|---:|`);
for (const m of monthNets) md.push(`| ${m.month} | ${usd(m.netUsd)} |`);
md.push("");
md.push(`$300/mo gate Jul/Aug/Sep, two miss months per year allowed: ${gate.passes ? "PASS" : "FAIL"}. ${gate.detail}`);
md.push("");

await Bun.write("docs/HIGH-VOL-PAIR-BACKTEST.md", md.join("\n"));
await Bun.write(
  "docs/candidate-backtest.json",
  JSON.stringify({ combinedScore, gate, passingNew: passingNew.map((p) => p.pair), candOut, liveOut }, null, 2),
);
console.log(md.join("\n"));
