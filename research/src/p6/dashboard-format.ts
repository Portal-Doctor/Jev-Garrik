/** Cron clock and the monthly command projection. No Redis and no Node sockets. */

const MONTHLY_RUNS = 2_880;
const COMMAND_BUDGET = 10_000_000;

/** Next cron minute. Vercel uses :01, :16, :31, and :46 UTC. */
export function nextCronMs(now: number): number {
  const marks = [1, 16, 31, 46];
  const cursor = new Date(now);
  cursor.setUTCSeconds(0, 0);
  const minute = cursor.getUTCMinutes();
  const upcoming = marks.find((mark) => mark > minute);
  if (upcoming != null) {
    cursor.setUTCMinutes(upcoming);
    return cursor.getTime();
  }
  cursor.setUTCHours(cursor.getUTCHours() + 1, 1, 0, 0);
  return cursor.getTime();
}

export function monthCommands(cmdsPerRun: number): number {
  return cmdsPerRun * MONTHLY_RUNS;
}

export function commandBudget(): number {
  return COMMAND_BUDGET;
}

/** Green under 80%, amber under 100%, red at the budget. */
export function projectionTone(month: number): "green" | "amber" | "red" {
  if (month >= COMMAND_BUDGET) return "red";
  if (month >= COMMAND_BUDGET * 0.8) return "amber";
  return "green";
}

export function healthStale(endMs: number | null, now: number): boolean {
  if (endMs == null) return true;
  return now - endMs > 20 * 60 * 1000;
}
