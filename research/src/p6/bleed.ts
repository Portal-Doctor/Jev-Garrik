/**
 * Rolling-20 pause (1b). The trigger is still the last 20 net R summing to -5R
 * or worse. Resume is 20 minimum-size trades after the pause summing to at
 * least 0, or Brian's OK. A recovered window does not clear the pause by itself.
 */

import { rolling20Paused } from "../p5/guards";

export interface BleedState {
  paused: boolean;
  postPause: number[];
  brianOk: boolean;
}

export function freshBleed(): BleedState {
  return { paused: false, postPause: [], brianOk: false };
}

export function acceptBrianOk(state: BleedState): BleedState {
  return { paused: false, postPause: [], brianOk: true };
}

/**
 * `history` is the closed net R before this trade. `minSize` is true when the
 * trade's entry risk is at or below the paper minimum.
 */
export function stepBleed(state: BleedState, history: readonly number[], next: number, minSize: boolean): BleedState {
  if (state.brianOk) return { paused: false, postPause: [], brianOk: true };
  const values = [...history, next];
  if (!state.paused) {
    if (rolling20Paused(values)) return { paused: true, postPause: [], brianOk: false };
    return state;
  }
  const post = minSize ? [...state.postPause, next] : state.postPause;
  if (post.length >= 20 && post.slice(-20).reduce((sum, value) => sum + value, 0) >= 0) {
    return { paused: false, postPause: [], brianOk: false };
  }
  return { paused: true, postPause: post, brianOk: false };
}
