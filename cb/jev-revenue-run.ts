/**
 * Locked Jev revenue review: split breakout 20/3/50, $1,200 per pair,
 * telemetry-only labels, Jul/Aug/Sep 2026, at both 40/80 and honest 50/90.
 *
 * Run: bun run cb/jev-revenue-run.ts
 */
import { runBreakout } from "./breakout";
import { LIVE_PAIRS, bookFor } from "./books";
import { config } from "./config";
import { monthlyNets } from "./feereplay";
import { scoreMonthlyGate } from "./monthgate";
import { loadTape } from "./tape";

const DAY_MS = 86_400_000;
const windowStartTs = Date.UTC(2026, 6, 1);
const windowEndTs = Date.UTC(2026, 9, 1);
const fetchFrom = windowStartTs - 10 * DAY_MS;
const gateMonths = ["2026-07", "2026-08", "2026-09"];
const pairBankrollUsd = 1_200;
const tiers = [
  { name: "40/80 sensitivity", makerFeeBps: 40, takerFeeBps: 80 },
  { name: "50/90 Intro", makerFeeBps: 50, takerFeeBps: 90 },
];

const tapes = new Map<string, Awaited<ReturnType<typeof loadTape>>>();
for (const pair of LIVE_PAIRS) {
  console.log(`tape ${pair}`);
  tapes.set(pair, await loadTape(pair, fetchFrom, windowEndTs, 300));
}

const results = [];
for (const tier of tiers) {
  const perPair = [];
  const allTrades = [];
  let feesUsd = 0;
  let missedEntries = 0;
  let stopExits = 0;
  let maxHoldExits = 0;
  for (const pair of LIVE_PAIRS) {
    const book = bookFor(pair);
    const result = runBreakout(tapes.get(pair)!, {
      pair,
      windowStartTs,
      barSec: 300,
      notionalUsd: book.notionalUsd,
      bankrollUsd: pairBankrollUsd,
      makerFeeBps: tier.makerFeeBps,
      takerFeeBps: tier.takerFeeBps,
      stopLossBps: book.stopLossBps,
      minSizeUsd: config.minSizeUsd,
      breakoutBars: config.breakoutBars,
      trendEmaBars: config.trendEmaBars,
      atrBars: config.atrBars,
      trailAtr: config.trailAtr,
      maxHoldSec: config.breakoutMaxHoldSec,
    });
    const netUsd = result.tradeLog.reduce((sum, trade) => sum + trade.netUsd, 0);
    perPair.push({
      pair,
      clipUsd: book.notionalUsd,
      grossUsd: netUsd + result.feesUsd,
      feesUsd: result.feesUsd,
      netUsd,
      trades: result.trades,
      missedEntries: result.missedEntries,
      maxDrawdown: result.maxDrawdown,
      exits: result.exitReasons,
    });
    allTrades.push(...result.tradeLog);
    feesUsd += result.feesUsd;
    missedEntries += result.missedEntries;
    stopExits += result.exitReasons.stop;
    maxHoldExits += result.exitReasons.maxHold;
  }
  const netUsd = allTrades.reduce((sum, trade) => sum + trade.netUsd, 0);
  const grossUsd = netUsd + feesUsd;
  const months = monthlyNets(allTrades);
  const gate = scoreMonthlyGate(months, gateMonths);
  const filledNotionalUsd = allTrades.reduce(
    (sum, trade) => sum + trade.entryNotionalUsd + trade.exitNotionalUsd,
    0,
  );
  results.push({
    ...tier,
    grossUsd,
    feesUsd,
    netUsd,
    feeDrag: grossUsd > 0 ? feesUsd / grossUsd : null,
    trades: allTrades.length,
    missedEntries,
    exits: { stop: stopExits, maxHold: maxHoldExits },
    filledNotionalUsd,
    monthlyTurnoverUsd: filledNotionalUsd / 3,
    worstPairDrawdown: Math.max(...perPair.map((row) => row.maxDrawdown ?? 0)),
    months,
    gate,
    perPair,
  });
}

for (const result of results) {
  console.log(`\n${result.name}`);
  console.log(
    `gross $${result.grossUsd.toFixed(2)} fees $${result.feesUsd.toFixed(2)} net $${result.netUsd.toFixed(2)} trades ${result.trades} missed ${result.missedEntries} DD ${(result.worstPairDrawdown * 100).toFixed(2)}%`,
  );
  console.log(result.gate.detail);
}

await Bun.write("data/jev-revenue-review.json", JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2));
