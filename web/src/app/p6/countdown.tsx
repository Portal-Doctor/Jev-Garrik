"use client";

import { useEffect, useState } from "react";
import { nextCronMs } from "../../../../research/src/p6/dashboard-format";
import styles from "./p6.module.css";

/** Countdown to the next :01/:16/:31/:46 cron. The page decides stale. */
export function RunClock({ overdue }: { overdue: boolean }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (overdue) return <span className={styles.clock}>Run overdue</span>;
  if (now == null) return <span className={styles.clock}>Next run</span>;
  const next = nextCronMs(now);
  const remaining = Math.max(0, Math.ceil((next - now) / 1000));
  const span = 15 * 60;
  const pct = Math.min(100, Math.max(0, ((span - remaining) / span) * 100));
  const mm = Math.floor(remaining / 60);
  const label = `${mm}:${String(remaining % 60).padStart(2, "0")}`;
  return (
    <span className={styles.clock}>
      Next run in {label}
      <span className={styles.clockBar}>
        <span className={styles.clockFill} style={{ width: `${pct}%` }} />
      </span>
    </span>
  );
}
