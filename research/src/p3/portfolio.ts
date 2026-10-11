/** Sizing, slots, tie order, and the rule that a Jev outage adds no trade. */

export const SLOT_CAPS = { A: 3, B: 4, C: 2, D: 1, E: 1 } as const;
export const TIE_ORDER = ["A", "C", "B", "D", "E"] as const;
export const MAX_POSITIONS = 8;
export const RISK_USD = 60;
export const NOTIONAL_CAP_USD = 1500;

export type ClassId = "A" | "B" | "C" | "D" | "E";

export function notionalUsd(stopBps: number, costBps: number, riskUsd = RISK_USD): number {
  const load = stopBps + costBps;
  if (!(load > 0)) throw new Error("stop plus cost must be positive");
  return Math.min(NOTIONAL_CAP_USD, riskUsd / (load / 10_000));
}

export function tieRank(classId: ClassId): number {
  return TIE_ORDER.indexOf(classId);
}

export interface EntryAttempt {
  classId: ClassId;
  pair: string;
  jevAvailable: boolean;
}

/** An outage, timeout, or budget miss never adds a trade. */
export function jevAllowsEntry(attempt: EntryAttempt, mode: "off" | "required"): boolean {
  if (mode === "off") return true;
  return attempt.jevAvailable;
}
