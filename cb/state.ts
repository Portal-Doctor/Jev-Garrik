import type { Feed } from "./feed";

/**
 * What the model sees, per pair. Compact, relative, human-readable, and structurally close to the
 * demo's TradeState (src/model.ts) so the same decision layer transfers. Spot constraint (long/flat)
 * is part of the state; the fee hurdle the move must beat is stated explicitly.
 */
export interface MarketState {
  pair: string;
  ts: number;
  horizonSec: number;
  mid: number;
  spreadBps: number;
  bookImbalance: number; // -1 (all asks) .. 1 (all bids), within 1% of mid
  depth: { [band: string]: { bid: number; ask: number } }; // 10/25/50 bps, base units
  returnsBps: { m5: number; m30: number; h1: number; h4: number; h24: number };
  recentMids: string; // oldest..newest, sampled over the horizon, space separated
  trades: { count: number; buyBase: number; sellBase: number; cvdBase: number; vwap: number | null };
  feeBps: { maker: number; taker: number };
  position: "long" | "flat";
}

/** Recent taker flow is summarized over this window (seconds). */
const FLOW_WINDOW_SEC = 1_800;
/** Number of mid samples included in `recentMids`. */
const RECENT_MIDS = 60;

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export function buildState(
  feed: Feed,
  pair: string,
  position: "long" | "flat",
  opts: { horizonSec: number; makerFeeBps: number; takerFeeBps: number },
  now = Date.now(),
): MarketState | null {
  const book = feed.book(pair);
  const mid = book?.mid();
  if (!book || mid == null) return null;

  const depthRaw = book.depthBands();
  const depth: MarketState["depth"] = {};
  for (const [band, v] of Object.entries(depthRaw)) depth[band] = { bid: round(v.bid, 4), ask: round(v.ask, 4) };

  const tape = feed.tapeSummary(pair, FLOW_WINDOW_SEC, now);
  const mids = feed.recentMidsSample(pair, RECENT_MIDS, opts.horizonSec, now);

  return {
    pair,
    ts: now,
    horizonSec: opts.horizonSec,
    mid,
    spreadBps: round(book.spreadBps() ?? 0, 3),
    bookImbalance: round(book.imbalance(), 4),
    depth,
    returnsBps: {
      m5: round(feed.returnBps(pair, 300, now), 2),
      m30: round(feed.returnBps(pair, 1_800, now), 2),
      h1: round(feed.returnBps(pair, 3_600, now), 2),
      h4: round(feed.returnBps(pair, 14_400, now), 2),
      h24: round(feed.returnBps(pair, 86_400, now), 2),
    },
    recentMids: mids.map((m) => Number(m.toPrecision(6))).join(" "),
    trades: {
      count: tape.count,
      buyBase: round(tape.buyBase, 4),
      sellBase: round(tape.sellBase, 4),
      cvdBase: round(tape.cvdBase, 4),
      vwap: tape.vwap === null ? null : round(tape.vwap, 6),
    },
    feeBps: { maker: opts.makerFeeBps, taker: opts.takerFeeBps },
    position,
  };
}
