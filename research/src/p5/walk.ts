/**
 * One long trade on 15m bars.
 * X1 buys the entry open plus s_bt and pays the taker fee.
 * A stop triggers at the stop price. The fill is one deduction below that price.
 * A 10-day rule exit sells the next open minus s_bt. A window-end mark sells the close.
 * The same bar never fills a target ahead of the stop: the target is absent.
 */

import { TAKER_FEE_BPS } from "../../vendor/87b35d0/config.ts";
import { intrabarFill } from "../p3/fills";
import { stopFillPrice, x1FillPrice } from "../p3/design-rules";

export interface PxBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface WalkLeg {
  reason: "stop" | "gap" | "rule" | "window";
  exitTs: number;
  rawEntry: number;
  rawExit: number;
  fillEntry: number;
  fillExit: number;
  entryFeeBps: number;
  exitFeeBps: number;
  spreadBps: number;
  grossBps: number;
  netBps: number;
}

export function grossBps(rawEntry: number, rawExit: number): number {
  return ((rawExit - rawEntry) / rawEntry) * 10_000;
}

export function netBps(fillEntry: number, fillExit: number, entryFeeBps: number, exitFeeBps: number): number {
  return ((fillExit - fillEntry) / fillEntry) * 10_000 - entryFeeBps - exitFeeBps;
}

/**
 * `entryTs` must be the open timestamp of a bar.
 * `endTs` is exclusive.
 * `ruleExitTs`, when set, is the open timestamp of the 15m bar that fills the rule exit.
 */
export function walkLong(opts: {
  bars: readonly PxBar[];
  entryTs: number;
  endTs: number;
  stop: number;
  sBtBps: number;
  atr1h: (ts: number) => number;
  ruleExitTs: number | null;
}): WalkLeg | null {
  const start = opts.bars.findIndex((bar) => bar.ts === opts.entryTs);
  if (start < 0) return null;
  const entry = opts.bars[start]!;
  if (!(entry.open > 0) || !(opts.stop > 0) || !(opts.stop < entry.open)) return null;
  const rawEntry = entry.open;
  const fillEntry = x1FillPrice(rawEntry, "buy", opts.sBtBps);
  let last: PxBar | null = null;
  for (let i = start; i < opts.bars.length; i += 1) {
    const bar = opts.bars[i]!;
    if (bar.ts >= opts.endTs) break;
    last = bar;
    const deduction = stopFillPrice(opts.stop, rawEntry, opts.sBtBps, opts.atr1h(bar.ts));
    const fill = intrabarFill(bar, opts.stop, Number.POSITIVE_INFINITY);
    if (fill.kind === "stop" && fill.price != null) {
      const gapped = bar.open <= opts.stop;
      const rawExit = gapped ? bar.open : opts.stop;
      const fillExit = gapped ? bar.open : deduction;
      return leg(gapped ? "gap" : "stop", bar.ts, rawEntry, rawExit, fillEntry, fillExit, opts.sBtBps);
    }
    if (opts.ruleExitTs != null && bar.ts === opts.ruleExitTs) {
      const fillExit = x1FillPrice(bar.open, "sell", opts.sBtBps);
      return leg("rule", bar.ts, rawEntry, bar.open, fillEntry, fillExit, opts.sBtBps);
    }
  }
  if (!last || !(last.close > 0)) return null;
  const fillExit = x1FillPrice(last.close, "sell", opts.sBtBps);
  const reason = opts.ruleExitTs != null ? "rule" : "window";
  return leg(reason, last.ts, rawEntry, last.close, fillEntry, fillExit, opts.sBtBps);
}

function leg(
  reason: WalkLeg["reason"],
  exitTs: number,
  rawEntry: number,
  rawExit: number,
  fillEntry: number,
  fillExit: number,
  spreadBps: number,
): WalkLeg {
  return {
    reason,
    exitTs,
    rawEntry,
    rawExit,
    fillEntry,
    fillExit,
    entryFeeBps: TAKER_FEE_BPS,
    exitFeeBps: TAKER_FEE_BPS,
    spreadBps,
    grossBps: grossBps(rawEntry, rawExit),
    netBps: netBps(fillEntry, fillExit, TAKER_FEE_BPS, TAKER_FEE_BPS),
  };
}
