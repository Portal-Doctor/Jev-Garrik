/** UTC windows. Buckets are multiples of the bar size from the Unix epoch, so local DST does not apply. */

export const HISTORY_START_ISO = "2023-10-01T00:00:00.000Z";
export const HISTORY_START_SEC = Date.parse(HISTORY_START_ISO) / 1000;
export const MINUTE_SEC = 60;
/** Owner decision: 900-second bars. Five-minute (300) projected past two hours. */
export const BAR_SEC = 900;
export const HISTORY_DAYS = 365;
export const HOUR_SEC = 3600;
export const FOUR_HOUR_SEC = 4 * 3600;
export const DAY_SEC = 86400;
/** Inclusive candle requests stay at or under the exchange 300-aggregation cap. */
export const CHUNK_BARS = 299;

export function isoFromSec(sec: number): string {
  return new Date(sec * 1000).toISOString();
}

/** Exclusive end of the latest completed UTC day: 00:00 UTC of the day that contains `now`. */
export function latestCompletedDayEndSec(now: Date): number {
  const day = now.toISOString().slice(0, 10);
  return Date.parse(`${day}T00:00:00.000Z`) / 1000;
}

export function windowForProduct(now: Date, listingSec: number | null): { startSec: number; endSec: number } {
  const endSec = latestCompletedDayEndSec(now);
  let startSec = endSec - HISTORY_DAYS * DAY_SEC;
  if (listingSec != null) {
    const aligned = Math.floor(listingSec / BAR_SEC) * BAR_SEC;
    if (aligned > startSec) startSec = aligned;
  }
  if (startSec >= endSec) return { startSec: endSec, endSec };
  return { startSec, endSec };
}

export interface MonthWindow {
  month: string;
  startSec: number;
  endSec: number;
}

export function monthWindows(startSec: number, endSec: number): MonthWindow[] {
  const out: MonthWindow[] = [];
  if (startSec >= endSec) return out;
  let cursor = startOfMonthSec(startSec);
  while (cursor < endSec) {
    const next = nextMonthSec(cursor);
    const windowStart = Math.max(startSec, cursor);
    const windowEnd = Math.min(endSec, next);
    if (windowStart < windowEnd) {
      out.push({ month: monthId(cursor), startSec: windowStart, endSec: windowEnd });
    }
    cursor = next;
  }
  return out;
}

export interface ChunkWindow {
  index: number;
  startSec: number;
  endSec: number;
}

export function chunksForWindow(startSec: number, endSec: number, barSec: number = BAR_SEC): ChunkWindow[] {
  const span = CHUNK_BARS * barSec;
  const out: ChunkWindow[] = [];
  let index = 0;
  for (let cursor = startSec; cursor < endSec; cursor += span) {
    out.push({ index, startSec: cursor, endSec: Math.min(endSec, cursor + span) });
    index += 1;
  }
  return out;
}

function startOfMonthSec(sec: number): number {
  const d = new Date(sec * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000;
}

function nextMonthSec(monthStartSec: number): number {
  const d = new Date(monthStartSec * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) / 1000;
}

function monthId(monthStartSec: number): string {
  const d = new Date(monthStartSec * 1000);
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${d.getUTCFullYear()}-${month}`;
}
