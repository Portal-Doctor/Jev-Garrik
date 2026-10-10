/**
 * Refuses to start when an order-capable credential is present.
 * Paper day has no order path; this is the belt on that promise.
 */

const ORDER_CAPABLE = [
  /^COINBASE_API_/i,
  /^COINBASE_KEY$/i,
  /^COINBASE_SECRET$/i,
  /^COINBASE_PASSPHRASE$/i,
  /^CDP_API_/i,
  /^CDP_PROJECT_ID$/i,
  /^EXCHANGE_API_/i,
];

export interface SafetyResult {
  ok: boolean;
  reason: string;
}

export function findOrderCredentials(env: Record<string, string | undefined>): string[] {
  const hits: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value == null || value.trim() === "") continue;
    if (ORDER_CAPABLE.some((re) => re.test(key))) hits.push(key);
  }
  return hits.sort();
}

export function assertSafeToStart(env: Record<string, string | undefined> = process.env): SafetyResult {
  const hits = findOrderCredentials(env);
  if (hits.length > 0) {
    return {
      ok: false,
      reason: `refusing to start: order-capable credential present (${hits.join(", ")}). Paper day does not place orders.`,
    };
  }
  return { ok: true, reason: "no order-capable credential" };
}

/** Report listener must be loopback. Any other host is a start failure. */
export function assertLoopbackHost(host: string): void {
  const h = host.trim().toLowerCase();
  if (h !== "127.0.0.1" && h !== "localhost" && h !== "::1") {
    throw new Error(`report host must be loopback, got ${host}`);
  }
}
