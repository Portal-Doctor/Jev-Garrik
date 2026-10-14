/**
 * 1c pause. Amendment 2 (Brian, 2026-10-12T01:23:00Z) is the re-fire sentence.
 * Amendment 2a (Brian, 2026-10-12T01:49:00Z) replaces the kill reference:
 * the 20R kill uses the running high-water mark of cumulative closed-trade net R.
 * A pause or a resume does not move that mark down. Only a new high does.
 * Resume is still a 5R recovery from the trough of the current pause.
 * guards.stepRCurve stays the historical helper. The forward book does not call it.
 */

import { CLASS_R_KILL } from "../p5/risk";

/** Frozen amendment 2 sentence. The approved 2a record replaces the kill clause. */
export const REARM_RULE =
  "the 10R pause re-fires only on a new trough below the prior one, or on a 10R drawdown from a new peak; the 20R kill is measured from the original peak.";

export const AMENDMENT_2A_RULE =
  "The 20R kill and the $1,200 class backstop are measured from the running high-water mark of the class's cumulative closed-trade net R (net $ for the backstop). A pause or resume never resets it; only a new high does. 1c re-fires after a resume only on a new trough below the prior one, or on 10R drawdown from a new high.";

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

/**
 * One step of the closed-trade cumulative net R curve.
 * `peak` is the running high-water mark. Pause and resume leave it where it is.
 */
export function stepClassPause(state: ClassPause, cumR: number): ClassPause {
  if (state.killed) return { ...state, paused: true, killed: true };
  const peak = Math.max(state.peak, cumR);
  if (peak - cumR >= CLASS_R_KILL) {
    return {
      ...state,
      peak,
      originalPeak: peak,
      originalFrozen: false,
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
        originalPeak: peak,
        originalFrozen: false,
        trough: cumR,
        priorTrough,
        resumePeak: state.resumePeak,
        paused: true,
        killed: false,
      };
    }
    return { ...state, peak, originalPeak: peak, originalFrozen: false, paused: false, killed: false };
  }
  const trough = Math.min(state.trough, cumR);
  const priorTrough = Math.min(state.priorTrough ?? trough, trough);
  if (cumR - trough >= RESUME_R) {
    return {
      ...state,
      peak,
      originalPeak: peak,
      originalFrozen: false,
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
    originalPeak: peak,
    originalFrozen: false,
    trough,
    priorTrough,
    paused: true,
    killed: false,
  };
}
