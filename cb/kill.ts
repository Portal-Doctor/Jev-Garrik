import { existsSync } from "node:fs";
import { config } from "./config";

const KILL_FILE = "data/CB_KILL";

const utcDay = (ms = Date.now()) => new Date(ms).toISOString().slice(0, 10);

/**
 * Halt new Coinbase entries. Exits still flatten so a trip does not leave inventory.
 * Trips when CB_KILL=true, when data/CB_KILL is present, or when UTC-day realized P and L
 * (including fees) drops through CB_DAILY_LOSS_USD.
 */
export class KillSwitch {
  private day = utcDay();
  private dayPnlUsd = 0;

  recordUsd(delta: number, now = Date.now()): void {
    this.roll(now);
    this.dayPnlUsd += delta;
  }

  get dayPnl(): number {
    this.roll();
    return this.dayPnlUsd;
  }

  /** Why new entries must not go out, or null if they may. */
  blocked(now = Date.now()): string | null {
    if (config.kill) return "CB_KILL=true";
    if (existsSync(KILL_FILE)) return `${KILL_FILE} present`;
    this.roll(now);
    if (this.dayPnlUsd <= -config.dailyLossUsd) {
      return `daily loss $${this.dayPnlUsd.toFixed(2)} exceeds limit $${config.dailyLossUsd}`;
    }
    return null;
  }

  private roll(now = Date.now()): void {
    const d = utcDay(now);
    if (d === this.day) return;
    this.day = d;
    this.dayPnlUsd = 0;
  }
}

export const killSwitch = new KillSwitch();
