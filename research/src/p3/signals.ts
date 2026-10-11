import { wilderAtr } from "../p2/indicators";
import { classATrigger, classBScore, type DailyBar } from "./classes";
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
}

export function emptyCounts(): ClassCounts {
  return { signals: 0, oosSignals: 0, stops: [], vetoed: 0, oldClause: 0, caution: 0 };
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
): ClassACounts {
  const out: ClassACounts = { L20: emptyCounts(), L55: emptyCounts(), stopBpsByK: { L20: emptyStopGrid(), L55: emptyStopGrid() } };
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    if (!memberOn(bar.date)) continue;
    const dailyAtr = atr[i];
    for (const lookback of [20, 55] as const) {
      if (!classATrigger(bars, i, lookback, shortHistory)) continue;
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

export function countClassC(
  bars: readonly DailyBar[],
  memberOn: (date: string) => boolean,
  atr: readonly (number | null)[],
): ClassCounts {
  const counts = emptyCounts();
  const changes: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1]!.close;
    const bar = bars[i]!;
    const change = prev > 0 ? (bar.close - prev) / prev : 0;
    const prior = changes.slice(-30);
    changes.push(change);
    if (!memberOn(bar.date)) continue;
    const mean = prior.length === 30 ? prior.reduce((s, v) => s + v, 0) / 30 : null;
    let z: number | null = null;
    if (mean != null) {
      const variance = prior.reduce((s, v) => s + (v - mean) ** 2, 0) / 30;
      const sd = Math.sqrt(variance);
      if (sd > 0) z = (change - mean) / sd;
    }
    const dailyAtr = atr[i];
    const volWindow = bars.slice(Math.max(0, i - 20), i);
    const volAvg = volWindow.length === 20 ? volWindow.reduce((s, row) => s + row.volume, 0) / 20 : null;
    const range = bar.high - bar.low;
    const crash =
      dailyAtr != null &&
      volAvg != null &&
      range > 3 * dailyAtr &&
      bar.volume > 3 * volAvg &&
      range > 0 &&
      (bar.close - bar.low) / range <= 1 / 3;
    if (z != null && z <= -2.5 || crash) {
      const stopDist = dailyAtr == null ? null : 0.25 * dailyAtr;
      const stop = stopDist != null && bar.close > 0 ? { bps: (stopDist / bar.close) * 10_000, atrMultiple: 0.25 } : null;
      note(counts, bar.date, undefined, stop, false);
    }
  }
  return counts;
}

export interface BarOHLC {
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** Class E: 1h event, then a 15m close above anchored VWAP and the latest 15m swing high within 6h. */
export function countClassE(hour: readonly BarOHLC[], quarter: readonly BarOHLC[], memberOn: (date: string) => boolean): ClassCounts {
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
    const stopPrice = bar.low - 0.2 * a;
    const stopBps = bar.close > stopPrice && bar.close > 0 ? ((bar.close - stopPrice) / bar.close) * 10_000 : 0;
    if (stopBps < 250) continue;
    const end = bar.ts + 6 * 3600;
    let pv = 0;
    let vol = 0;
    let swing: number | null = null;
    let prev: BarOHLC | null = null;
    let triggered = false;
    for (const q of quarter) {
      if (q.ts < bar.ts || q.ts >= end) continue;
      const typical = (q.high + q.low + q.close) / 3;
      pv += typical * q.volume;
      vol += q.volume;
      const vwap = vol > 0 ? pv / vol : q.close;
      if (prev && q.high < prev.high) swing = prev.high;
      if (swing != null && q.close > vwap && q.close > swing) {
        triggered = true;
        break;
      }
      prev = q;
    }
    if (!triggered) continue;
    note(counts, date, undefined, { bps: stopBps, atrMultiple: 0.2 }, false);
  }
  return counts;
}

export function countClassB(dates: readonly { date: string; score: number; member: boolean }[], btcByDate: ReadonlyMap<string, BtcDay>): ClassCounts {
  const counts = emptyCounts();
  const byDate = new Map<string, { date: string; score: number; member: boolean }[]>();
  for (const row of dates) {
    const list = byDate.get(row.date) ?? [];
    list.push(row);
    byDate.set(row.date, list);
  }
  for (const [date, rows] of byDate) {
    const eligible = rows.filter((row) => row.member && row.score > 0).sort((a, b) => b.score - a.score);
    const keep = Math.max(1, Math.ceil(eligible.length * 0.2));
    if (eligible.length === 0) continue;
    for (const _row of eligible.slice(0, keep)) note(counts, date, btcByDate.get(date), null, true);
  }
  return counts;
}

export { classBScore };
