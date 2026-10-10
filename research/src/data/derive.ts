import type { MinuteRow } from "./candles";
import { addDecimal, compareDecimal, formatDecimal, parseDecimal } from "./decimal";
import { DAY_SEC, FOUR_HOUR_SEC, HOUR_SEC, MINUTE_SEC } from "./time";

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

function aggregate(byMinute: Map<number, MinuteRow>, open: number, end: number, timeframe: Timeframe): DerivedBar {
  const filled: MinuteRow[] = [];
  let emptyMinutes = 0;
  for (let minuteSec = open; minuteSec < end; minuteSec += MINUTE_SEC) {
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
