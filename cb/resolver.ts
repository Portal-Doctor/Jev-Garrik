import type { Store } from "./db/store";

/**
 * Scores decisions as their measured horizons pass. Every `intervalMs`, finds decisions whose
 * (ts + horizon) has passed but that lack an outcome for that horizon, looks up the mid at the
 * horizon from the persisted minute bars (nearest close at or before), and writes the outcome.
 *
 * Restart-safe by construction: bars are persisted, and `insertOutcome` is idempotent
 * (ON CONFLICT DO NOTHING), so resolving the same decision twice writes once.
 */
export class Resolver {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: Store,
    private readonly horizonsSec: readonly number[],
    private readonly intervalMs = 60_000,
    private readonly onResolved: (n: number) => void = () => {},
  ) {}

  start(): void {
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Resolve everything currently due. Returns the number of outcomes written. */
  async tick(now = Date.now()): Promise<number> {
    const due = await this.store.decisionsDueForResolve(now, this.horizonsSec);
    let n = 0;
    for (const d of due) {
      const horizonSec = Number(d.horizon_sec);
      const target = Number(d.ts) + horizonSec * 1000;
      const midAtHorizon = await this.store.barCloseAtOrBefore(d.pair, target);
      if (midAtHorizon == null) continue; // no bar yet; try again next tick
      const midThen = Number(d.mid);
      const moveBps = midThen > 0 ? ((midAtHorizon - midThen) / midThen) * 10_000 : 0;
      // A buy call is correct when the mid rose; a sell call is correct when it fell.
      const correct = d.action === "buy" ? moveBps > 0 : moveBps < 0;
      await this.store.insertOutcome({
        decision_id: d.id,
        horizon_sec: horizonSec,
        resolved_at: now,
        mid_then: midThen,
        mid_at_horizon: midAtHorizon,
        move_bps: moveBps,
        correct,
      });
      n++;
    }
    if (n) this.onResolved(n);
    return n;
  }
}
