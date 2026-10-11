/**
 * Research entry. Refuses to start when an order-capable credential is present.
 * Does not sign requests or hold a wallet.
 */

import { assertSafeToStart, type SafetyResult } from "./safety";

export function boot(env: Record<string, string | undefined> = process.env): SafetyResult {
  return assertSafeToStart(env);
}

if (import.meta.main) {
  const started = boot();
  if (!started.ok) {
    console.error(started.reason);
    process.exit(1);
  }
  console.log(started.reason);
}
