import type { FeatureSnapshot } from "./features";
import { emptySnapshot } from "./features";

/**
 * Compact state handed to one Jev classification. Tick history stays inside the feature
 * accumulator and the feed's mid ring (the resolver still scores 1h, 4h, and 24h from that ring).
 */
export interface MarketState {
  pair: string;
  ts: number;
  horizonSec: number;
  mid: number;
  spreadBps: number;
  spreadEmaBps: number;
  imbalance5: number;
  imbalance20: number;
  volBps: number;
  parkinsonBps: number;
  emaGapBps: number;
  emaCross: "above" | "below" | "flat";
  rsi: number | null;
  volumeDelta: number;
  volumeGross: number;
  returnsBps: { m5: number; m30: number; h1: number; h4: number; h24: number };
  feeBps: { maker: number; taker: number };
  position: "long" | "flat";
}

export interface StateSource {
  book(pair: string): { mid(): number | null } | undefined;
  returnBps(pair: string, sec: number, now?: number): number;
  featureSnapshot(pair: string, horizonSec: number): FeatureSnapshot;
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export function buildState(
  feed: StateSource,
  pair: string,
  position: "long" | "flat",
  opts: { horizonSec: number; makerFeeBps: number; takerFeeBps: number },
  now = Date.now(),
): MarketState | null {
  const book = feed.book(pair);
  const mid = book?.mid();
  if (!book || mid == null) return null;

  const f = feed.featureSnapshot(pair, opts.horizonSec) ?? emptySnapshot();

  return {
    pair,
    ts: now,
    horizonSec: opts.horizonSec,
    mid: round(mid, 6),
    spreadBps: round(f.spreadBps, 3),
    spreadEmaBps: round(f.spreadEmaBps, 3),
    imbalance5: round(f.imbalance5, 4),
    imbalance20: round(f.imbalance20, 4),
    volBps: round(f.volBps, 2),
    parkinsonBps: round(f.parkinsonBps, 2),
    emaGapBps: round(f.emaGapBps, 2),
    emaCross: f.emaCross,
    rsi: f.rsi == null ? null : round(f.rsi, 2),
    volumeDelta: round(f.volumeDelta, 4),
    volumeGross: round(f.volumeGross, 4),
    returnsBps: {
      m5: round(feed.returnBps(pair, 300, now), 2),
      m30: round(feed.returnBps(pair, 1_800, now), 2),
      h1: round(feed.returnBps(pair, 3_600, now), 2),
      h4: round(feed.returnBps(pair, 14_400, now), 2),
      h24: round(feed.returnBps(pair, 86_400, now), 2),
    },
    feeBps: { maker: opts.makerFeeBps, taker: opts.takerFeeBps },
    position,
  };
}
