import type { MinuteRow } from "./candles";
import { addDecimal, compareDecimal, formatDecimal, parseDecimal } from "./decimal";
import { BAR_SEC, DAY_SEC, FOUR_HOUR_SEC, HOUR_SEC } from "./time";

export type Timeframe = "1h" | "4h" | "1d";

export const TF_SEC: Record<Timeframe, number> = {
  "1h": HOUR_SEC,
  "4h": FOUR_HOUR_SEC,
  "1d": DAY_SEC,
};

export interface DerivedBar {
  openTs: number;
  endTs: number;
  timeframe: Timeframe;
  empty: boolean;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: string | null;
  nonemptyMinutes: number;
  emptyMinutes: number;
}

/**
 * Completed UTC buckets only. A bucket that ends at 00:00 belongs to the
 * previous period. Empty minutes do not create prices.
 */
export function deriveBars(
  minutes: readonly MinuteRow[],
  timeframe: Timeframe,
  windowStart: number,
  windowEnd: number,
): DerivedBar[] {
  const step = TF_SEC[timeframe];
  const byMinute = new Map(minutes.map((row) => [row.minuteSec, row]));
  const first = Math.ceil(windowStart / step) * step;
  const bars: DerivedBar[] = [];
  for (let open = first; open + step <= windowEnd; open += step) {
    bars.push(aggregate(byMinute, open, open + step, timeframe));
  }
  return bars;
}

export interface FoldBar {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Fold child bars into UTC buckets. A bucket is kept when any child traded.
 * A fully empty bucket is dropped. That is the same rule aggregate() uses for minutes.
 */
export function foldHours<T extends FoldBar>(bars: readonly T[], spanSec: number, childSec: number): T[] {
  const need = spanSec / childSec;
  if (!(need >= 1) || need !== Math.floor(need)) return [];
  const byTs = new Map<number, T>();
  for (const bar of bars) byTs.set(bar.ts, bar);
  const starts = [...new Set(bars.map((bar) => Math.floor(bar.ts / spanSec) * spanSec))].sort((a, b) => a - b);
  const out: T[] = [];
  for (const start of starts) {
    const filled: T[] = [];
    for (let ts = start; ts < start + spanSec; ts += childSec) {
      const row = byTs.get(ts);
      if (row) filled.push(row);
    }
    if (filled.length === 0) continue;
    filled.sort((a, b) => a.ts - b.ts);
    const first = filled[0]!;
    const last = filled[filled.length - 1]!;
    out.push({
      ...first,
      ts: start,
      open: first.open,
      high: Math.max(...filled.map((bar) => bar.high)),
      low: Math.min(...filled.map((bar) => bar.low)),
      close: last.close,
      volume: filled.reduce((sum, bar) => sum + bar.volume, 0),
    });
  }
  return out;
}

function aggregate(byMinute: Map<number, MinuteRow>, open: number, end: number, timeframe: Timeframe): DerivedBar {
  const filled: MinuteRow[] = [];
  let emptyMinutes = 0;
  for (let minuteSec = open; minuteSec < end; minuteSec += BAR_SEC) {
    const row = byMinute.get(minuteSec);
    if (!row) throw new Error(`missing minute ${minuteSec} in ${timeframe} bucket ${open}`);
    if (row.empty) emptyMinutes += 1;
    else filled.push(row);
  }
  if (filled.length === 0) {
    return {
      openTs: open,
      endTs: end,
      timeframe,
      empty: true,
      open: null,
      high: null,
      low: null,
      close: null,
      volume: null,
      nonemptyMinutes: 0,
      emptyMinutes,
    };
  }
  let high = filled[0]!.high!;
  let low = filled[0]!.low!;
  let volume = parseDecimal(filled[0]!.volume!);
  for (const row of filled.slice(1)) {
    if (compareDecimal(parseDecimal(row.high!), parseDecimal(high)) > 0) high = row.high!;
    if (compareDecimal(parseDecimal(row.low!), parseDecimal(low)) < 0) low = row.low!;
    volume = addDecimal(volume, parseDecimal(row.volume!));
  }
  const last = filled[filled.length - 1]!;
  return {
    openTs: open,
    endTs: end,
    timeframe,
    empty: false,
    open: formatDecimal(parseDecimal(filled[0]!.open!)),
    high: formatDecimal(parseDecimal(high)),
    low: formatDecimal(parseDecimal(low)),
    close: formatDecimal(parseDecimal(last.close!)),
    volume: formatDecimal(volume),
    nonemptyMinutes: filled.length,
    emptyMinutes,
  };
}
