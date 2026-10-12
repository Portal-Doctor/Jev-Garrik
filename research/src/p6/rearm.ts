/**
 * Confirmed 1c pause, amendment 2, Brian at 2026-10-12T01:23:00Z.
 * The 10R pause re-fires only on a new trough below the prior one, or on a 10R
 * drawdown from a new peak. The 20R kill is measured from the original peak.
 *
 * The original peak is the running maximum until the first pause, then it stays
 * put. A later high does not move the kill. Resume is still a 5R recovery from
 * the trough of the current pause. This is the forward rule. guards.stepRCurve
 * stays the historical helper and the forward book does not call it.
 */

import { CLASS_R_KILL } from "../p5/risk";

export const REARM_RULE =
  "the 10R pause re-fires only on a new trough below the prior one, or on a 10R drawdown from a new peak; the 20R kill is measured from the original peak.";

export const PAUSE_R = 10;
export const RESUME_R = 5;

export interface ClassPause {
  peak: number;
  originalPeak: number;
  originalFrozen: boolean;
  trough: number;
  priorTrough: number | null;
  resumePeak: number | null;
  paused: boolean;
  killed: boolean;
}

export function freshClassPause(): ClassPause {
  return {
    peak: 0,
    originalPeak: 0,
    originalFrozen: false,
    trough: 0,
    priorTrough: null,
    resumePeak: null,
    paused: false,
    killed: false,
  };
}

/** One step of the closed-trade cumulative net R curve. */
export function stepClassPause(state: ClassPause, cumR: number): ClassPause {
  if (state.killed) return { ...state, paused: true, killed: true };
  const peak = Math.max(state.peak, cumR);
  const originalPeak = state.originalFrozen ? state.originalPeak : peak;
  if (originalPeak - cumR >= CLASS_R_KILL) {
    return {
      ...state,
      peak,
      originalPeak,
      originalFrozen: true,
      trough: Math.min(state.trough, cumR),
      paused: true,
      killed: true,
    };
  }
  if (!state.paused) {
    const firstPause = state.priorTrough == null && peak - cumR >= PAUSE_R;
    const newTrough = state.priorTrough != null && cumR < state.priorTrough;
    const newPeakPause = state.resumePeak != null && peak > state.resumePeak && peak - cumR >= PAUSE_R;
    if (firstPause || newTrough || newPeakPause) {
      const priorTrough = state.priorTrough == null ? cumR : Math.min(state.priorTrough, cumR);
      return {
        ...state,
        peak,
        originalPeak,
        originalFrozen: true,
        trough: cumR,
        priorTrough,
        resumePeak: state.resumePeak,
        paused: true,
        killed: false,
      };
    }
    return { ...state, peak, originalPeak, paused: false, killed: false };
  }
  const trough = Math.min(state.trough, cumR);
  const priorTrough = Math.min(state.priorTrough ?? trough, trough);
  if (cumR - trough >= RESUME_R) {
    return {
      ...state,
      peak,
      originalPeak,
      originalFrozen: true,
      trough,
      priorTrough,
      resumePeak: peak,
      paused: false,
      killed: false,
    };
  }
  return {
    ...state,
    peak,
    originalPeak,
    originalFrozen: true,
    trough,
    priorTrough,
    paused: true,
    killed: false,
  };
}
