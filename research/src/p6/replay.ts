/**
 * Completed-bar replay through the D1 bar path.
 * The scan calls classATrigger on classBarInputs. It does not call collectA.
 */

import type { DailyBar } from "../p3/classes";
import { classATrigger, type ClassAEma } from "../p3/classes";
import { classAChaseSkip } from "../p3/design-rules";
import { classBarInputs, type ClassBarInputs, type GroupFlags, type SourceDay } from "../p3/bar-access";
import { ema } from "../p2/indicators";
import { OOS_END } from "../p2/universe";
import { addDays } from "../p5/stats";
import { weekSelection, x1EntryTs, type ASignal } from "../p5/run";

export interface ReplayDay extends DailyBar {
  complete: boolean;
}

export interface ReplayScore {
  id: string;
  date: string;
  score: number;
  member: boolean;
  complete: boolean;
}

export const IN_WINDOW_FLAGS: GroupFlags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };

function toSource(day: ReplayDay): SourceDay {
  return {
    date: day.date,
    ts: Date.parse(`${day.date}T00:00:00.000Z`) / 1000,
    open: day.close,
    high: day.high,
    low: day.low,
    close: day.close,
    volume: day.volume,
    empty: !day.complete,
  };
}

export function emaPoints(inputs: ClassBarInputs): Map<string, ClassAEma> {
  const ema50 = ema(inputs.ema.map((row) => row.close), 50);
  const ema200 = ema(inputs.ema.map((row) => row.close), 200);
  const out = new Map<string, ClassAEma>();
  inputs.ema.forEach((row, index) => {
    out.set(row.date, {
      e50: ema50[index] ?? null,
      e200: ema200[index] ?? null,
      e50TenAgo: index >= 10 ? (ema50[index - 10] ?? null) : null,
      index,
    });
  });
  return out;
}

/** Class A from the D1 inputs. The oracle is classATrigger, not collectA. */
export function scanForwardA(opts: {
  flags: GroupFlags;
  days: readonly ReplayDay[];
  firstD1Date: string;
  atrByDate: ReadonlyMap<string, number>;
  hour: readonly { ts: number; open: number }[];
  young: boolean;
  memberOn?: (date: string) => boolean;
  veto?: (date: string) => boolean;
}): ASignal[] {
  const inputs = classBarInputs(opts.flags, opts.days.map(toSource), opts.firstD1Date);
  const bars = inputs.closeLookback;
  const points = emaPoints(inputs);
  const hourOpen = new Map(opts.hour.map((bar) => [bar.ts, bar.open]));
  const memberOn = opts.memberOn ?? (() => true);
  const veto = opts.veto ?? (() => false);
  const out: ASignal[] = [];
  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i]!;
    if (!memberOn(bar.date) || veto(bar.date)) continue;
    const dailyAtr = opts.atrByDate.get(bar.date);
    if (dailyAtr == null || !(dailyAtr > 0)) continue;
    const point = points.get(bar.date);
    if (!point) continue;
    const entryTs = x1EntryTs(bar.date);
    const entryOpen = hourOpen.get(entryTs);
    if (entryOpen == null || !(entryOpen > 0)) continue;
    for (const lookback of [20, 55] as const) {
      if (!classATrigger(bars, i, lookback, opts.young, undefined, point)) continue;
      if (classAChaseSkip(entryOpen, bar.close, dailyAtr)) continue;
      const entryDate = addDays(bar.date, 1);
      if (entryDate > OOS_END) continue;
      out.push({ lookback, date: bar.date, entryDate, entryTs, atr: dailyAtr });
    }
  }
  return out;
}

export function replaySignals(opts: {
  productId: string;
  days: readonly ReplayDay[];
  atrByDate: ReadonlyMap<string, number>;
  hour: readonly { ts: number; open: number }[];
  young: boolean;
  memberOn?: (date: string) => boolean;
  veto?: (date: string) => boolean;
  scores?: readonly ReplayScore[];
  flags?: GroupFlags;
  firstD1Date?: string;
}): { a: ASignal[]; weeks: { date: string; selected: string[]; held: string[] }[] } {
  void opts.productId;
  const a = scanForwardA({
    flags: opts.flags ?? IN_WINDOW_FLAGS,
    days: opts.days,
    firstD1Date: opts.firstD1Date ?? opts.days.find((day) => day.complete)?.date ?? "",
    atrByDate: opts.atrByDate,
    hour: opts.hour,
    young: opts.young,
    memberOn: opts.memberOn,
    veto: opts.veto,
  });
  const byDate = new Map<string, { id: string; date: string; score: number; member: boolean }[]>();
  for (const row of opts.scores ?? []) {
    if (!row.complete) continue;
    const list = byDate.get(row.date) ?? [];
    list.push({ id: row.id, date: row.date, score: row.score, member: row.member });
    byDate.set(row.date, list);
  }
  const weeks = [...byDate.keys()].sort().map((date) => {
    const week = weekSelection(date, byDate.get(date)!);
    return { date, selected: [...week.selected].sort(), held: [...week.held].sort() };
  });
  return { a, weeks };
}
