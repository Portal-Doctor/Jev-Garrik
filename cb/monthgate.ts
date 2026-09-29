import type { MonthNet } from "./feereplay";

/** $300/mo gate: two miss months per UTC year are allowed. */
export const MONTHLY_TARGET_USD = 300;
export const MISS_MONTHS_PER_YEAR = 2;

export interface MonthGateScore {
  months: string[];
  nets: number[];
  hits: number;
  misses: number;
  allowedMisses: number;
  passes: boolean;
  detail: string;
}

export function scoreMonthlyGate(
  nets: MonthNet[],
  months: string[],
  targetUsd = MONTHLY_TARGET_USD,
  missPerYear = MISS_MONTHS_PER_YEAR,
): MonthGateScore {
  const by = new Map(nets.map((m) => [m.month, m.netUsd]));
  const values = months.map((m) => by.get(m) ?? 0);
  const hits = values.filter((n) => n >= targetUsd).length;
  const misses = months.length - hits;
  const allowedMisses = missPerYear;
  const passes = misses <= allowedMisses && hits >= 1;
  const usd = (n: number) => (n < 0 ? `-$${Math.abs(n).toFixed(2)}` : `$${n.toFixed(2)}`);
  return {
    months,
    nets: values,
    hits,
    misses,
    allowedMisses,
    passes,
    detail: `${hits} of ${months.length} months at or above $${targetUsd} (misses ${misses}, ${allowedMisses} allowed per year): ${months.map((m, i) => `${m} ${usd(values[i]!)}`).join(", ")}.`,
  };
}
