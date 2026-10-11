/**
 * Historical fills. X1 is the only selectable entry for A, B, and C.
 * There is no historical X2 or X3 path.
 * If one 15m bar touches both stop and target, the stop fills first.
 * A bar that opens beyond the stop fills at the open.
 * Trails update on completed bars only.
 */

export interface Bar15 {
  open: number;
  high: number;
  low: number;
  close: number;
}

export type FillKind = "stop" | "target" | "none";

export function intrabarFill(bar: Bar15, stop: number, target: number): { kind: FillKind; price: number | null } {
  const openedThroughStop = bar.open <= stop;
  if (openedThroughStop) return { kind: "stop", price: bar.open };
  const hitStop = bar.low <= stop;
  const hitTarget = bar.high >= target;
  if (hitStop && hitTarget) return { kind: "stop", price: stop };
  if (hitStop) return { kind: "stop", price: stop };
  if (hitTarget) return { kind: "target", price: target };
  return { kind: "none", price: null };
}

/** Trail ratchets on a completed bar. It does not move on the bar being formed. */
export function trailAfterCompletedBar(trail: number, completedClose: number, atr: number): number {
  const next = completedClose - 3 * atr;
  return Math.max(trail, next);
}

export const HISTORICAL_ENTRY_MODES = ["X1"] as const;
