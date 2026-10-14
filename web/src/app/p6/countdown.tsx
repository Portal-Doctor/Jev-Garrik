"use client";

import { useEffect, useState } from "react";
import { healthStale, nextCronMs } from "../../../../research/src/p6/dashboard-format";
import styles from "../paper/paper.module.css";

/** Countdown to the next :01/:16/:31/:46 cron. Health flips stale after 20 minutes. */
export function RunClock({ lastEnd }: { lastEnd: number | null }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  if (now == null) return <span className={styles.countdown}>next …</span>;
  const next = nextCronMs(now);
  const remaining = Math.max(0, Math.ceil((next - now) / 1000));
  const span = 15 * 60;
  const pct = Math.min(100, Math.max(0, ((span - remaining) / span) * 100));
  const mm = Math.floor(remaining / 60);
  const label = `${mm}:${String(remaining % 60).padStart(2, "0")}`;
  const stale = healthStale(lastEnd, now);
  return (
    <span className={styles.meta}>
      <span className={`${styles.chip} ${stale ? styles.chipDown : styles.chipOk}`}>
        <i />
        {stale ? "stale" : "ok"}
      </span>
      <span className={styles.countdown}>
        next {label}
        <span className={styles.countdownBar}>
          <span className={styles.countdownFill} style={{ width: `${pct}%` }} />
        </span>
      </span>
    </span>
  );
}
