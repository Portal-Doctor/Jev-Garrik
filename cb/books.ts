/**
 * Per-pair risk table. Stop is 1.0 times the measured 4-hour sigma.
 * Take-profit is 4.0 times that sigma, so a winner pays at least twice a loser after fees.
 * Notional follows last-day depth. `enabled: false` drops a book on the next process start.
 */
export interface PairBook {
  pair: string;
  /** 14-day 4h close-to-close sigma, in bps. Refresh weekly from candles. */
  sigmaBps: number;
  stopLossBps: number;
  takeProfitBps: number;
  notionalUsd: number;
  maxOpen: 1;
  enabled: boolean;
}

export const PAIR_BOOKS: readonly PairBook[] = [
  { pair: "UNI-USD", sigmaBps: 295, stopLossBps: 295, takeProfitBps: 1180, notionalUsd: 600, maxOpen: 1, enabled: true },
  { pair: "NEAR-USD", sigmaBps: 331, stopLossBps: 331, takeProfitBps: 1324, notionalUsd: 600, maxOpen: 1, enabled: true },
  { pair: "BCH-USD", sigmaBps: 242, stopLossBps: 242, takeProfitBps: 968, notionalUsd: 500, maxOpen: 1, enabled: true },
  { pair: "SUI-USD", sigmaBps: 219, stopLossBps: 219, takeProfitBps: 876, notionalUsd: 400, maxOpen: 1, enabled: true },
  { pair: "AVAX-USD", sigmaBps: 227, stopLossBps: 227, takeProfitBps: 908, notionalUsd: 400, maxOpen: 1, enabled: true },
  { pair: "ARB-USD", sigmaBps: 390, stopLossBps: 390, takeProfitBps: 1560, notionalUsd: 300, maxOpen: 1, enabled: true },
];

const BY_PAIR = new Map(PAIR_BOOKS.map((b) => [b.pair, b]));

export function findBook(pair: string): PairBook | undefined {
  return BY_PAIR.get(pair);
}

export function bookFor(pair: string): PairBook {
  const book = findBook(pair);
  if (!book) throw new Error(`no book for ${pair}`);
  return book;
}

/** Configured pairs that are still enabled. Missing names are rejected by `assertPairBooks`. */
export function activePairs(configured: readonly string[]): string[] {
  return configured.filter((p) => findBook(p)?.enabled);
}

/**
 * Vol the tape must already have before a call at `buyThreshold` can clear the hurdle.
 * Below this, the gate refuses `quiet` and does not wait on a higher confidence.
 */
export function minHorizonVolBps(hurdle: number, buyThreshold: number): number {
  const edge = Math.max(0, 2 * buyThreshold - 1);
  if (!(edge > 0) || !Number.isFinite(hurdle)) return Number.POSITIVE_INFINITY;
  return hurdle / edge;
}

/** Entry hurdle at a 2 bp spread. A tighter stop recreates the SOL failure mode. */
export function hurdleAtAssumedSpread(makerFeeBps: number, feeBuffer: number, spreadBps = 2): number {
  const halfSpread = Math.max(0, spreadBps) / 2;
  return (makerFeeBps + makerFeeBps + halfSpread) * feeBuffer;
}

/**
 * After-fee payoff of one take-profit and one stop.
 * Winner is the target minus maker in and taker out. Loser is the stop plus those same fees.
 * A book boots only when the winner is at least twice the loser.
 */
export function payoffLegs(
  takeProfitBps: number,
  stopLossBps: number,
  makerFeeBps: number,
  takerFeeBps: number,
): { winnerBps: number; loserBps: number } {
  const fees = makerFeeBps + takerFeeBps;
  return { winnerBps: takeProfitBps - fees, loserBps: stopLossBps + fees };
}

export function assertPairBooks(
  pairs: readonly string[],
  opts: { makerFeeBps: number; takerFeeBps: number; feeBuffer: number },
  table: readonly PairBook[] = PAIR_BOOKS,
): void {
  const hurdle = hurdleAtAssumedSpread(opts.makerFeeBps, opts.feeBuffer, 2);
  const byPair = new Map(table.map((b) => [b.pair, b]));
  for (const pair of pairs) {
    const book = byPair.get(pair);
    if (!book) throw new Error(`CB_PAIRS includes ${pair}, which has no book`);
    const feeFloor = opts.makerFeeBps + opts.takerFeeBps;
    if (!(book.takeProfitBps > feeFloor)) {
      throw new Error(`${pair} take-profit ${book.takeProfitBps} bps must clear maker plus taker fees (${feeFloor} bps)`);
    }
    const { winnerBps, loserBps } = payoffLegs(book.takeProfitBps, book.stopLossBps, opts.makerFeeBps, opts.takerFeeBps);
    if (!(winnerBps >= 2 * loserBps)) {
      throw new Error(`${pair} after-fee winner ${winnerBps} bps is under twice the after-fee loser (${loserBps} bps)`);
    }
    if (!(book.stopLossBps >= hurdle)) {
      throw new Error(`${pair} stop ${book.stopLossBps} bps is below the entry hurdle (${hurdle} bps)`);
    }
    if (book.maxOpen !== 1) throw new Error(`${pair} maxOpen must be 1`);
    if (!(book.notionalUsd > 0)) throw new Error(`${pair} notional must be positive`);
  }
}
