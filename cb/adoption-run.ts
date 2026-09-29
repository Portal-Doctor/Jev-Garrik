/**
 * Re-score the five breakout adoption rules over the 6 month six-pair tape at live 50/90.
 * Not a fee-tier sweep: fees come straight from config.
 *
 *   bun run cb/adoption-run.ts
 */

import { scoreAdoption, type AdoptionPair } from "./adoption";
import { backtestRisk, runBacktest, type ClosedTrade } from "./backtest";
import { findBook } from "./books";
import { runBreakout } from "./breakout";
import { config } from "./config";
import { monthlyNets } from "./feereplay";
import { loadTape } from "./tape";

const DAY_MS = 86_400_000;
const usd = (n: number) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
const pct = (n: number | null) => (n == null ? "-" : `${(n * 100).toFixed(2)}%`);

const now = Date.now();
const windowStartTs = now - 180 * DAY_MS;
const fetchFrom = windowStartTs - 10 * DAY_MS;
const pairs = config.pairs.filter((p) => findBook(p)?.enabled);

console.log(`Fees ${config.makerFeeBps}/${config.takerFeeBps} bps. Knobs ${config.breakoutBars}/${config.trailAtr}/${config.trendEmaBars}/${config.breakoutMaxHoldSec}s.`);
console.log(`Window ${new Date(windowStartTs).toISOString()} to ${new Date(now).toISOString()}`);
console.log(`Clips: ${pairs.map((p) => `${p} $${findBook(p)!.notionalUsd}`).join(", ")}\n`);

const rows: AdoptionPair[] = [];
const breakoutTradesAll: ClosedTrade[] = [];
const fixedTradesAll: ClosedTrade[] = [];
for (const pair of pairs) {
  const candles = await loadTape(pair, fetchFrom, now, 300);
  const risk = backtestRisk(pair);
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
  breakoutTradesAll.push(...bo.tradeLog);
  fixedTradesAll.push(...fixed.fixedTradeLog);
  rows.push({
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
  });
}

const score = scoreAdoption(rows);

console.log("| Pair | Bankroll | Fixed trades | Fixed win | Fixed net | Fixed DD | Trail trades | Trail win | Trail net | Trail DD | Missed | Signals | Miss rate | Vetoed |");
console.log("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
for (const r of rows) {
  console.log(
    `| ${r.pair} | $${r.bankrollUsd} | ${r.fixedTrades} | ${pct(r.fixedWinRate)} | ${usd(r.fixedNetUsd)} | ${pct(r.fixedMaxDrawdown)} | ${r.breakoutTrades} | ${pct(r.breakoutWinRate)} | ${usd(r.breakoutNetUsd)} | ${pct(r.breakoutMaxDrawdown)} | ${r.missedEntries} | ${r.signals} | ${r.signals ? pct(r.missedEntries / r.signals) : "-"} | ${r.vetoedEntries} |`,
  );
}
console.log(
  `| Six books | | ${rows.reduce((s, r) => s + r.fixedTrades, 0)} | | ${usd(score.combinedFixedNetUsd)} | | ${score.totalBreakoutTrades} | | ${usd(score.combinedBreakoutNetUsd)} | | ${score.totalMissed} | ${score.totalSignals} | ${score.totalSignals ? pct(score.totalMissed / score.totalSignals) : "-"} | ${rows.reduce((s, r) => s + r.vetoedEntries, 0)} |`,
);

console.log("\nAdoption:\n");
for (const r of score.rules) console.log(`${r.n}. ${r.passes ? "Pass" : "Fail"}. ${r.detail}`);
console.log(`\nAll five rules: ${score.passes ? "PASS" : "FAIL"}`);

console.log("\nNet USD per UTC calendar month, six pairs combined. Closed trades only.\n");
const boMonths = monthlyNets(breakoutTradesAll);
const fxMonths = monthlyNets(fixedTradesAll);
const months = [...new Set([...boMonths, ...fxMonths].map((m) => m.month))].sort();
const boBy = new Map(boMonths.map((m) => [m.month, m.netUsd]));
const fxBy = new Map(fxMonths.map((m) => [m.month, m.netUsd]));
console.log(`| Book | ${months.join(" | ")} |`);
console.log(`|---|${months.map(() => "---:").join("|")}|`);
console.log(`| Breakout | ${months.map((m) => usd(boBy.get(m) ?? 0)).join(" | ")} |`);
console.log(`| Fixed target | ${months.map((m) => usd(fxBy.get(m) ?? 0)).join(" | ")} |`);

const last3 = months.slice(-3);
const gate = (by: Map<string, number>) => last3.filter((m) => (by.get(m) ?? 0) >= 300).length;
console.log(
  `\n$300/mo gate on ${last3.join(", ")}: breakout clears ${gate(boBy)} of 3, fixed target clears ${gate(fxBy)} of 3.`,
);
