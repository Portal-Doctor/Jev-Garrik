/**
 * Fee tier replay (profitability work order item 1).
 *
 * Replays two books over the same 6 month 5 minute Exchange tape at each published Coinbase
 * Advanced US spot tier, and measures the turnover those books actually generate so each tier
 * can be marked reachable or not.
 *
 * - Locked breakout: Donchian 20 / trail 3 ATR / EMA 50 / hold 14d, veto on.
 * - Official HTF fixed-target: 4 hour trend, maker take-profit, no toxic flatten.
 *
 * Fees are arguments here. Paper defaults are now the judged 40/80 row. This helper still
 * prices each published Coinbase tier independently.
 */

import { backtestRisk, runBacktest, type ClosedTrade } from "./backtest";
import { findBook } from "./books";
import { runBreakout } from "./breakout";
import { config } from "./config";
import { tierReached, type SpotFeeTier } from "./feetiers";
import { loadTape } from "./tape";

const DAY_MS = 86_400_000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

export interface PairNet {
  pair: string;
  netUsd: number;
  trades: number;
  filledNotionalUsd: number;
}

export interface MonthNet {
  /** UTC calendar month, `YYYY-MM`. */
  month: string;
  netUsd: number;
}

export interface Turnover {
  /** Entry plus exit notional across the whole tape. */
  totalUsd: number;
  /** Total scaled to 30 days by tape length. */
  scaledThirtyDayUsd: number;
  /** Heaviest actual 30 day window on the tape. */
  busiestThirtyDayUsd: number;
}

export interface TierBookResult {
  tier: SpotFeeTier;
  perPair: PairNet[];
  perMonth: MonthNet[];
  totalNetUsd: number;
  turnover: Turnover;
  /** Whether the measured turnover clears this tier's published cutoff. */
  reachable: boolean;
}

export interface FeeReplay {
  months: 6;
  fromTs: number;
  toTs: number;
  breakout: TierBookResult[];
  fixedTarget: TierBookResult[];
}

/** UTC calendar month key of an epoch ms timestamp. */
export function monthKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Net USD per UTC calendar month, booked to the month the trade closed in. Oldest first. */
export function monthlyNets(trades: readonly ClosedTrade[]): MonthNet[] {
  const byMonth = new Map<string, number>();
  for (const t of trades) {
    const key = monthKey(t.closedTs);
    byMonth.set(key, (byMonth.get(key) ?? 0) + t.netUsd);
  }
  return [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([month, netUsd]) => ({ month, netUsd }));
}

/** Filled notional: one entry and one exit per closed round trip. */
export function filledNotional(trades: readonly ClosedTrade[]): number {
  return trades.reduce((s, t) => s + t.entryNotionalUsd + t.exitNotionalUsd, 0);
}

/**
 * Turnover on the tape, plus the two 30 day readings a fee tier cutoff is judged against:
 * the whole tape scaled to 30 days, and the heaviest real 30 day window.
 */
export function turnover(trades: readonly ClosedTrade[], fromTs: number, toTs: number): Turnover {
  const events: Array<{ ts: number; usd: number }> = [];
  for (const t of trades) {
    events.push({ ts: t.openedTs, usd: t.entryNotionalUsd });
    events.push({ ts: t.closedTs, usd: t.exitNotionalUsd });
  }
  events.sort((a, b) => a.ts - b.ts);
  const totalUsd = events.reduce((s, e) => s + e.usd, 0);
  const spanMs = Math.max(1, toTs - fromTs);
  const scaledThirtyDayUsd = (totalUsd * THIRTY_DAYS_MS) / spanMs;

  let busiest = 0;
  let head = 0;
  let running = 0;
  for (let tail = 0; tail < events.length; tail++) {
    running += events[tail]!.usd;
    while (events[tail]!.ts - events[head]!.ts >= THIRTY_DAYS_MS) {
      running -= events[head]!.usd;
      head += 1;
    }
    busiest = Math.max(busiest, running);
  }
  return { totalUsd, scaledThirtyDayUsd, busiestThirtyDayUsd: busiest };
}

/** Roll per-pair trade logs into one tier row. */
export function summarizeTier(
  tier: SpotFeeTier,
  perPairTrades: ReadonlyArray<{ pair: string; trades: ClosedTrade[] }>,
  fromTs: number,
  toTs: number,
): TierBookResult {
  const perPair = perPairTrades.map(({ pair, trades }) => ({
    pair,
    netUsd: trades.reduce((s, t) => s + t.netUsd, 0),
    trades: trades.length,
    filledNotionalUsd: filledNotional(trades),
  }));
  const all = perPairTrades.flatMap((p) => p.trades);
  const t = turnover(all, fromTs, toTs);
  return {
    tier,
    perPair,
    perMonth: monthlyNets(all),
    totalNetUsd: perPair.reduce((s, p) => s + p.netUsd, 0),
    turnover: t,
    reachable: tierReached(tier, Math.max(t.scaledThirtyDayUsd, t.busiestThirtyDayUsd)),
  };
}

/**
 * Replay both books over the 6 month tape at every supplied tier.
 * The tape is fetched once per pair and reused, so tier count only costs CPU.
 */
export async function replayFeeTiers(tiers: readonly SpotFeeTier[], now = Date.now()): Promise<FeeReplay> {
  const pairs = config.pairs.filter((pair) => findBook(pair)?.enabled);
  const windowStartTs = now - 180 * DAY_MS;
  // Indicators need history before the scored window opens.
  const fetchFrom = windowStartTs - 10 * DAY_MS;

  const tapes = new Map<string, Awaited<ReturnType<typeof loadTape>>>();
  for (const pair of pairs) tapes.set(pair, await loadTape(pair, fetchFrom, now, 300));

  const breakout: TierBookResult[] = [];
  const fixedTarget: TierBookResult[] = [];

  for (const tier of tiers) {
    const breakoutTrades: Array<{ pair: string; trades: ClosedTrade[] }> = [];
    const fixedTrades: Array<{ pair: string; trades: ClosedTrade[] }> = [];
    for (const pair of pairs) {
      const candles = tapes.get(pair)!;
      const risk = backtestRisk(pair);
      const fixed = runBacktest(candles, {
        pair,
        months: 6,
        windowStartTs,
        barSec: 300,
        horizonSec: config.horizonSec,
        notionalUsd: risk.notionalUsd,
        bankrollUsd: risk.bankrollUsd,
        makerFeeBps: tier.makerBps,
        takerFeeBps: tier.takerBps,
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
      fixedTrades.push({ pair, trades: fixed.fixedTradeLog });

      const bo = runBreakout(candles, {
        pair,
        windowStartTs,
        barSec: 300,
        notionalUsd: risk.notionalUsd,
        bankrollUsd: risk.bankrollUsd,
        makerFeeBps: tier.makerBps,
        takerFeeBps: tier.takerBps,
        stopLossBps: risk.stopLossBps,
        minSizeUsd: config.minSizeUsd,
        breakoutBars: config.breakoutBars,
        trendEmaBars: config.trendEmaBars,
        atrBars: config.atrBars,
        trailAtr: config.trailAtr,
        maxHoldSec: config.breakoutMaxHoldSec,
      });
      breakoutTrades.push({ pair, trades: bo.tradeLog });
    }
    breakout.push(summarizeTier(tier, breakoutTrades, windowStartTs, now));
    fixedTarget.push(summarizeTier(tier, fixedTrades, windowStartTs, now));
  }

  return { months: 6, fromTs: windowStartTs, toTs: now, breakout, fixedTarget };
}
