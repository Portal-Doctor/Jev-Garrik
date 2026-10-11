import { ema, wilderAtr } from "../p2/indicators";
import { classATrigger, classBScore, type DailyBar } from "./classes";
import { classBSelected } from "./design-rules";
import { classCEntry, classEFloorPasses, classETarget, type ClassCBar } from "./design-rules";
import { isOosDate } from "./schedule";

export interface StopSample {
  bps: number;
  atrMultiple: number;
}

export interface ClassCounts {
  signals: number;
  oosSignals: number;
  stops: StopSample[];
  vetoed: number;
  oldClause: number;
  caution: number;
  dates: string[];
}

export function emptyCounts(): ClassCounts {
  return { signals: 0, oosSignals: 0, stops: [], vetoed: 0, oldClause: 0, caution: 0, dates: [] };
}

export interface BtcDay {
  date: string;
  close: number;
  ema50: number | null;
  /** Prior-day move. Kept off this name so a scan document cannot pick up a banned token. */
  dailyMove: number | null;
  below4hEma: boolean;
}

export function btcVeto(day: BtcDay | undefined): boolean {
  if (!day || day.ema50 == null || day.dailyMove == null) return false;
  return day.close < day.ema50 && day.dailyMove <= -0.03;
}

export function btcOldClause(day: BtcDay | undefined): boolean {
  if (!day || day.dailyMove == null) return false;
  return day.below4hEma && day.dailyMove < 0;
}

export function btcCaution(day: BtcDay | undefined): boolean {
  return day?.below4hEma === true;
}

function note(counts: ClassCounts, date: string, btc: BtcDay | undefined, stop: StopSample | null, vetoClass: boolean): void {
  counts.signals += 1;
  counts.dates.push(date);
  if (isOosDate(date)) counts.oosSignals += 1;
  if (stop) counts.stops.push(stop);
  if (vetoClass && btcVeto(btc)) counts.vetoed += 1;
  if (btcOldClause(btc)) counts.oldClause += 1;
  if (btcCaution(btc)) counts.caution += 1;
}

export const CLASS_A_STOP_K = [2, 2.5, 3] as const;

export interface ClassACounts {
  L20: ClassCounts;
  L55: ClassCounts;
  /** Stop width in bps for each lookback and each k. The trigger itself does not depend on k. */
  stopBpsByK: {
    L20: Record<(typeof CLASS_A_STOP_K)[number], number[]>;
    L55: Record<(typeof CLASS_A_STOP_K)[number], number[]>;
  };
}

function emptyStopGrid(): Record<(typeof CLASS_A_STOP_K)[number], number[]> {
  return { 2: [], 2.5: [], 3: [] };
}

export function countClassA(
  bars: readonly DailyBar[],
  memberOn: (date: string) => boolean,
  atr: readonly (number | null)[],
  btcByDate: ReadonlyMap<string, BtcDay>,
  shortHistory: boolean,
  signalCloseFrom?: string,
  emaBars?: readonly DailyBar[],
): ClassACounts {
  const out: ClassACounts = { L20: emptyCounts(), L55: emptyCounts(), stopBpsByK: { L20: emptyStopGrid(), L55: emptyStopGrid() } };
  const emaByDate = new Map<string, { e50: number | null; e200: number | null; e50TenAgo: number | null; index: number }>();
  if (emaBars) {
    const ema50 = ema(emaBars.map((row) => row.close), 50);
    const ema200 = ema(emaBars.map((row) => row.close), 200);
    for (let i = 0; i < emaBars.length; i += 1) {
      emaByDate.set(emaBars[i]!.date, {
        e50: ema50[i] ?? null,
        e200: ema200[i] ?? null,
        e50TenAgo: i >= 10 ? (ema50[i - 10] ?? null) : null,
        index: i,
      });
    }
  }
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    if (!memberOn(bar.date)) continue;
    const dailyAtr = atr[i];
    const emaPoint = emaBars ? emaByDate.get(bar.date) : undefined;
    if (emaBars && !emaPoint) continue;
    for (const lookback of [20, 55] as const) {
      if (!classATrigger(bars, i, lookback, shortHistory, signalCloseFrom, emaPoint)) continue;
      const bucket = lookback === 20 ? out.L20 : out.L55;
      const grid = lookback === 20 ? out.stopBpsByK.L20 : out.stopBpsByK.L55;
      const stop = dailyAtr != null && bar.close > 0 ? { bps: (2.5 * dailyAtr / bar.close) * 10_000, atrMultiple: 2.5 } : null;
      note(bucket, bar.date, btcByDate.get(bar.date), stop, true);
      if (dailyAtr != null && bar.close > 0) {
        for (const k of CLASS_A_STOP_K) grid[k].push((k * dailyAtr / bar.close) * 10_000);
      }
    }
  }
  return out;
}

export interface BarOHLC {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Class E: 1h event, then a 15m close above anchored VWAP and the latest 15m swing high. The scan starts at the close of the event bar. */
export function countClassE(
  hour: readonly BarOHLC[],
  quarter: readonly BarOHLC[],
  memberOn: (date: string) => boolean,
  blackout: readonly { releaseAt: string }[] = [],
): ClassCounts {
  const counts = emptyCounts();
  const atr = wilderAtr(hour.map((b) => b.high), hour.map((b) => b.low), hour.map((b) => b.close), 14);
  for (let i = 20; i < hour.length; i += 1) {
    const bar = hour[i]!;
    const date = new Date(bar.ts * 1000).toISOString().slice(0, 10);
    if (!memberOn(date)) continue;
    const a = atr[i];
    const volAvg = hour.slice(i - 20, i).reduce((s, row) => s + row.volume, 0) / 20;
    const range = bar.high - bar.low;
    if (a == null || !(range > 3 * a) || !(bar.volume > 3 * volAvg) || !(range > 0) || (bar.close - bar.low) / range > 1 / 3) continue;
    const eventClose = bar.ts + 3600;
    const end = eventClose + 6 * 3600;
    const stopPrice = bar.low - 0.2 * a;
    let pv = 0;
    let vol = 0;
    let swing: number | null = null;
    let prev: BarOHLC | null = null;
    let entry: BarOHLC | null = null;
    for (const q of quarter) {
      if (q.ts < eventClose || q.ts >= end) continue;
      const typical = (q.high + q.low + q.close) / 3;
      pv += typical * q.volume;
      vol += q.volume;
      const vwap = vol > 0 ? pv / vol : q.close;
      if (prev && q.high < prev.high) swing = prev.high;
      if (swing != null && q.close > vwap && q.close > swing) {
        entry = q;
        break;
      }
      prev = q;
    }
    if (!entry || !(entry.close > stopPrice) || !(entry.close > 0)) continue;
    const stopBps = ((entry.close - stopPrice) / entry.close) * 10_000;
    if (stopBps < 250) continue;
    const decisionTs = entry.ts + 900;
    if (entryInBlackout(decisionTs, blackout)) continue;
    let sixHigh = bar.high;
    for (const hourBar of hour) {
      if (hourBar.ts < bar.ts - 5 * 3600 || hourBar.ts > bar.ts) continue;
      if (hourBar.high > sixHigh) sixHigh = hourBar.high;
    }
    const target = classETarget(entry.close, stopPrice, sixHigh, bar.low);
    const targetBps = target == null ? null : ((target - entry.close) / entry.close) * 10_000;
    if (!classEFloorPasses(stopBps, targetBps)) continue;
    note(counts, date, undefined, { bps: stopBps, atrMultiple: 0.2 }, false);
  }
  return counts;
}

/** Inclusive window: 30 minutes before the release through 60 minutes after. `decisionTs` is unix seconds. */
export function entryInBlackout(decisionTs: number, events: readonly { releaseAt: string }[]): boolean {
  const atMs = decisionTs * 1000;
  for (const event of events) {
    const release = Date.parse(event.releaseAt);
    if (!Number.isFinite(release)) continue;
    if (atMs >= release - 30 * 60_000 && atMs <= release + 60 * 60_000) return true;
  }
  return false;
}

export function countClassB(
  dates: readonly { id: string; date: string; score: number; member: boolean }[],
  btcByDate: ReadonlyMap<string, BtcDay>,
): ClassCounts {
  const counts = emptyCounts();
  const byDate = new Map<string, { id: string; date: string; score: number; member: boolean }[]>();
  for (const row of dates) {
    const list = byDate.get(row.date) ?? [];
    list.push(row);
    byDate.set(row.date, list);
  }
  for (const [date, rows] of byDate) {
    const selected = classBSelected(rows);
    for (const _row of selected) note(counts, date, btcByDate.get(date), null, true);
  }
  return counts;
}

export interface ClassCSetup {
  pair: string;
  entryTs: number;
  date: string;
  stopBps: number;
  targetBps: number;
}

/** Class C entries: the 4h trigger, the 1.5 ATR skip, and the fee floor. The 3-per-day cap is applied by the caller. */
export function classCSetups(
  pair: string,
  bars: readonly DailyBar[],
  four: readonly BarOHLC[],
  memberOn: (date: string) => boolean,
  atr: readonly (number | null)[],
): ClassCSetup[] {
  const out: ClassCSetup[] = [];
  const seen = new Set<number>();
  const changes: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1]!.close;
    const bar = bars[i]!;
    const change = prev > 0 ? (bar.close - prev) / prev : 0;
    const prior = changes.slice(-30);
    changes.push(change);
    const mean = prior.length === 30 ? prior.reduce((s, v) => s + v, 0) / 30 : null;
    let z: number | null = null;
    if (mean != null) {
      const variance = prior.reduce((s, v) => s + (v - mean) ** 2, 0) / 30;
      const sd = Math.sqrt(variance);
      if (sd > 0) z = (change - mean) / sd;
    }
    const dailyAtr = atr[i];
    const volWindow = bars.slice(Math.max(0, i - 20), i);
    const volAvg =
      volWindow.length === 20 && volWindow.every((row) => Number.isFinite(row.volume))
        ? volWindow.reduce((s, row) => s + row.volume, 0) / 20
        : null;
    const range = bar.high - bar.low;
    const crash =
      dailyAtr != null &&
      volAvg != null &&
      range > 3 * dailyAtr &&
      bar.volume > 3 * volAvg &&
      range > 0 &&
      (bar.close - bar.low) / range <= 1 / 3;
    if (!(z != null && z <= -2.5) && !crash) continue;
    if (dailyAtr == null || !Number.isFinite(bar.volume)) continue;
    const dayStart = Date.parse(`${bar.date}T00:00:00.000Z`) / 1000;
    const onDay = four.filter((row) => row.ts >= dayStart && row.ts < dayStart + 86400);
    if (onDay.length === 0) continue;
    const eventCandle = onDay.reduce((best, row) => (row.low < best.low ? row : best));
    const drop = bars.slice(Math.max(0, i - 6), i + 1);
    if (drop.length < 7) continue;
    // The daily event is knowable at the 00:00 UTC close. A 4h trigger is its close, and the 48h window starts there.
    const eventCloseSec = dayStart + 86400;
    const h4Sec = 14400;
    const later: ClassCBar[] = four
      .filter((row) => {
        const closeSec = row.ts + h4Sec;
        return closeSec > eventCloseSec && closeSec <= eventCloseSec + 48 * 3600;
      })
      .map((row) => ({ ts: (row.ts + h4Sec) * 1000, high: row.high, close: row.close }));
    const entry = classCEntry(
      {
        pair,
        eventTs: eventCloseSec * 1000,
        eventLow: eventCandle.low,
        eventHigh: eventCandle.high,
        dailyAtr,
        dropHigh: Math.max(...drop.map((row) => row.high)),
        dropLow: Math.min(...drop.map((row) => row.low)),
      },
      later,
    );
    if (!entry || seen.has(entry.entryTs)) continue;
    const date = new Date(entry.entryTs).toISOString().slice(0, 10);
    if (!memberOn(date)) continue;
    seen.add(entry.entryTs);
    out.push({ pair, entryTs: entry.entryTs, date, stopBps: entry.stopBps, targetBps: entry.targetBps });
  }
  return out;
}

export { classBScore };
