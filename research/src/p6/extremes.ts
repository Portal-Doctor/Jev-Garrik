/**
 * Running MFE/MAE on an open position. The series is not stored.
 * A restore cannot rebuild a gap, so the last flushed extremes are kept.
 */

export const HOT_REV = 6;

export const BID_BASIS = "bid1m" as const;
export const FALLBACK_BASIS = "mid-half-spread" as const;
export const MFE15_BASIS = "bar15-high" as const;
export const MAE15_BASIS = "bar15-low" as const;

export interface BidExtremes {
  /** Running max of the L2 best bid, one sample per UTC minute. */
  mfeBid1m: number | null;
  /** Running min of the L2 best bid, one sample per UTC minute. */
  maeBid1m: number | null;
  /** UTC minute (ms) that set mfeBid1m. */
  mfeTs: number | null;
  /** UTC minute (ms) that set maeBid1m. */
  maeTs: number | null;
  /** bid1m, or mid-half-spread when the bid was missing. */
  mfeBasis: typeof BID_BASIS | typeof FALLBACK_BASIS | null;
  maeBasis: typeof BID_BASIS | typeof FALLBACK_BASIS | null;
  /** Running max of closed 15m highs. Backtest-comparable basis. */
  mfe15: number | null;
  /** Running min of closed 15m lows. Backtest-comparable basis. */
  mae15: number | null;
  mfe15Basis: typeof MFE15_BASIS;
  mae15Basis: typeof MAE15_BASIS;
  /** V7 rev 6 restore/hold. The unobserved interval cannot be rebuilt. */
  mfeReconstructed?: boolean;
}

export function blankExtremes(): BidExtremes {
  return {
    mfeBid1m: null,
    maeBid1m: null,
    mfeTs: null,
    maeTs: null,
    mfeBasis: null,
    maeBasis: null,
    mfe15: null,
    mae15: null,
    mfe15Basis: MFE15_BASIS,
    mae15Basis: MAE15_BASIS,
  };
}

export function minuteBucket(tsMs: number): number {
  return Math.floor(tsMs / 60_000) * 60_000;
}

/** Best bid. Mid minus half the spread is only the flagged fallback. */
export function bidSample(
  bid: number,
  ask: number,
  fallback?: { mid: number; halfSpread: number },
): { px: number; basis: typeof BID_BASIS | typeof FALLBACK_BASIS } | null {
  if (bid > 0 && Number.isFinite(bid)) return { px: bid, basis: BID_BASIS };
  if (!fallback || !(fallback.mid > 0) || !(fallback.halfSpread >= 0) || !Number.isFinite(fallback.halfSpread)) return null;
  const px = fallback.mid - fallback.halfSpread;
  if (!(px > 0) || !Number.isFinite(px)) return null;
  return { px, basis: FALLBACK_BASIS };
}

export function noteBidExtreme(
  position: Partial<BidExtremes> & { entryTs?: number },
  bid: number,
  ask: number,
  tsMs: number,
  fallback?: { mid: number; halfSpread: number },
): void {
  if (position.entryTs != null && tsMs < position.entryTs) return;
  const sample = bidSample(bid, ask, fallback);
  if (!sample) return;
  const minute = minuteBucket(tsMs);
  if (position.mfeBid1m == null || sample.px > position.mfeBid1m) {
    position.mfeBid1m = sample.px;
    position.mfeTs = minute;
    position.mfeBasis = sample.basis;
  }
  if (position.maeBid1m == null || sample.px < position.maeBid1m) {
    position.maeBid1m = sample.px;
    position.maeTs = minute;
    position.maeBasis = sample.basis;
  }
}

/** Closed 15m bar. High is the favorable extreme, low the adverse. Idempotent. */
export function noteBar15Extreme(position: Partial<BidExtremes>, high: number, low: number): void {
  if (high > 0 && Number.isFinite(high) && (position.mfe15 == null || high > position.mfe15)) position.mfe15 = high;
  if (low > 0 && Number.isFinite(low) && (position.mae15 == null || low < position.mae15)) position.mae15 = low;
  position.mfe15Basis = MFE15_BASIS;
  position.mae15Basis = MAE15_BASIS;
}

/** (extreme − fill) × units / risk. Null when the extreme was never observed. */
export function extremeR(extreme: number | null | undefined, fillPrice: number, units: number, riskUsd: number): number | null {
  if (extreme == null || !Number.isFinite(extreme) || !(riskUsd > 0) || !Number.isFinite(fillPrice) || !Number.isFinite(units)) return null;
  return ((extreme - fillPrice) * units) / riskUsd;
}

/**
 * V7 rev 6 restore/hold. Keeps flushed extremes. Sets mfeReconstructed because
 * the interval since the flush is not in Redis and cannot be rebuilt.
 * A snapshot that never tracked the fields is marked the same way.
 */
export function restoreExtremes(position: Partial<BidExtremes>, hotRev: number | undefined): void {
  const tracked = "mfeBid1m" in position && (position.mfeBid1m === null || typeof position.mfeBid1m === "number");
  if (!tracked) Object.assign(position, blankExtremes());
  if (hotRev === HOT_REV || !tracked) position.mfeReconstructed = true;
}
