/**
 * Completed-bar replay. Signals come from the P5 functions.
 * An incomplete day is not passed in.
 */

import type { DailyBar } from "../p3/classes";
import type { ClassBarInputs } from "../p3/bar-access";
import { collectA, weekSelection, type ASignal } from "../p5/run";

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

function barsToInputs(days: readonly DailyBar[]): ClassBarInputs {
  return {
    ema: [...days],
    ohlc: [...days],
    closeLookback: [...days],
    volume: [...days],
    classC: [],
    swing: [],
    bias: [],
    dHistoryStart: days[0]?.date ?? "",
    listingProxySource: "first-in-window-15m",
    listingProxyDate: days[0]?.date ?? null,
  };
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
}): { a: ASignal[]; weeks: { date: string; selected: string[]; held: string[] }[] } {
  const days = opts.days.filter((day) => day.complete);
  const a = collectA(
    opts.productId,
    barsToInputs(days),
    new Map(opts.atrByDate),
    opts.hour,
    opts.memberOn ?? (() => true),
    opts.young,
    opts.veto ?? (() => false),
  );
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
