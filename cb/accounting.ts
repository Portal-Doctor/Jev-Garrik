/**
 * Position, fee-inclusive cost basis, and realized/unrealized P&L for one pair.
 *
 * Rules (from spec section 7, copied from Polytrage which got this right):
 * - Fee-inclusive cost basis, fee-net proceeds, single subtraction. A buy adds `notional + fee` to
 *   the cost basis; a sell realizes `proceeds - costOfClosed` where proceeds are `notional - fee`.
 *   Fees are therefore counted exactly once and never subtracted again.
 * - Spot, long/flat only: the position base is never negative. A sell only ever closes.
 * - Weighted-average entry from the open cost basis.
 * - Equity = bankroll + realized + unrealized - inference costs.
 */

export interface FillInput {
  side: "buy" | "sell";
  sizeBase: number;
  /** price * size, before fees. */
  notionalUsd: number;
  feeUsd: number;
}

export class Accounting {
  /** Open long size in base units (>= 0). */
  positionBase = 0;
  /** Fee-inclusive cost basis of the open position, in USD. */
  costBasisUsd = 0;
  realizedUsd = 0;
  feesUsd = 0;
  inferenceUsd = 0;

  constructor(private readonly bankrollUsd: number) {}

  apply(f: FillInput): void {
    if (f.sizeBase <= 0) return;
    this.feesUsd += f.feeUsd;
    if (f.side === "buy") {
      this.costBasisUsd += f.notionalUsd + f.feeUsd;
      this.positionBase += f.sizeBase;
      return;
    }
    // sell: closes against the open long (long/flat invariant, never oversell)
    const size = Math.min(f.sizeBase, this.positionBase);
    if (size <= 0) return;
    const avgCost = this.positionBase > 0 ? this.costBasisUsd / this.positionBase : 0;
    const closedCost = avgCost * size;
    // proceeds scale to the size actually closed, so a clamped oversell stays consistent
    const proceeds = (f.notionalUsd - f.feeUsd) * (size / f.sizeBase);
    this.realizedUsd += proceeds - closedCost;
    this.positionBase -= size;
    this.costBasisUsd -= closedCost;
    if (this.positionBase <= 1e-12) {
      this.positionBase = 0;
      this.costBasisUsd = 0;
    }
  }

  addInference(usd: number): void {
    this.inferenceUsd += usd;
  }

  entryPrice(): number | null {
    return this.positionBase > 0 ? this.costBasisUsd / this.positionBase : null;
  }

  /** Mark-to-market on the open position. Zero when flat. */
  unrealized(mid: number): number {
    return this.positionBase > 0 ? this.positionBase * mid - this.costBasisUsd : 0;
  }

  equity(mid: number): number {
    return this.bankrollUsd + this.realizedUsd + this.unrealized(mid) - this.inferenceUsd;
  }
}

/** Fee in USD for a fill of `notionalUsd` at a given bps rate. */
export const feeUsd = (notionalUsd: number, bps: number): number => (notionalUsd * bps) / 10_000;
