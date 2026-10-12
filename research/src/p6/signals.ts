/**
 * Strategy bars are completed REST 15-minute candles. A bar that is still
 * forming, or that started before the entry, cannot stop or exit a position.
 */

export const STRATEGY_BAR_SEC = 900;

export function strategyBarClosed(startSec: number, nowSec: number): boolean {
  return startSec % STRATEGY_BAR_SEC === 0 && nowSec >= startSec + STRATEGY_BAR_SEC;
}

export function barBeginsAtOrAfterEntry(startSec: number, entryTsMs: number): boolean {
  return startSec * 1000 >= entryTsMs;
}

/** A strategy bar may move a stop or an exit only when both checks pass. */
export function strategyBarActionable(startSec: number, nowSec: number, entryTsMs: number): boolean {
  return strategyBarClosed(startSec, nowSec) && barBeginsAtOrAfterEntry(startSec, entryTsMs);
}
