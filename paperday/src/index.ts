/**
 * Paper-day entry. Refuses to start when an order-capable credential is present.
 * Binds nothing except an optional loopback report. Does not place orders.
 */

import { defaultConfig } from "./config";
import { assertLoopbackHost, assertSafeToStart } from "./safety";
import { buildManifest } from "./manifest";
import { dailySummary, quarterTracker, scorecard } from "./reporter";

export function boot(env: Record<string, string | undefined> = process.env) {
  const safety = assertSafeToStart(env);
  if (!safety.ok) return safety;
  const cfg = defaultConfig();
  const manifest = buildManifest({
    jevStage: cfg.jevStage,
    mode: cfg.mode,
    formula: cfg.formula,
    strategy: cfg.strategy,
    variant: "jev_off",
  });
  return { ok: true as const, reason: safety.reason, manifest };
}

export function reportPayload(nowMs = Date.now()) {
  assertLoopbackHost("127.0.0.1");
  return {
    daily: dailySummary([], [], new Date(nowMs).toISOString().slice(0, 10)),
    quarters: quarterTracker([]),
    scorecard: scorecard({
      jevOnTrades: 0,
      jevOffTrades: 0,
      jevOnNetUsd: 0,
      jevOffNetUsd: 0,
      jevOnMaxDrawdownUsd: 0,
      jevOffMaxDrawdownUsd: 0,
    }),
  };
}

if (import.meta.main) {
  const started = boot();
  if (!started.ok) {
    console.error(started.reason);
    process.exit(1);
  }
  assertLoopbackHost(process.env.PAPERDAY_BIND ?? "127.0.0.1");
  console.log(JSON.stringify(started.manifest, null, 2));
}
