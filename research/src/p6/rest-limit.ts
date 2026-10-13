/**
 * One lane for every public Coinbase REST call.
 * Token bucket: 4 requests/second, burst 4. A 429 pauses the whole bucket.
 */

export const REST_RATE_PER_SEC = 4;
export const REST_BURST = 4;
export const REST_MAX_ATTEMPTS = 5;
export const REST_HARD_CAP = 400;
export const REST_DEADLINE_MARGIN_MS = 90_000;
export const REST_JITTER_CAP_MS = 8_000;

export interface RestStats {
  n: number;
  r429: number;
  waitedMs: number;
}

export interface RestLimitDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Unit interval. Full jitter draws rand() * cap. */
  rand: () => number;
  fetch: (url: string) => Promise<Response>;
  deadlineMs: () => number;
}

const defaults: RestLimitDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  rand: () => Math.random(),
  fetch: (url) => fetch(url),
  deadlineMs: () => Number.POSITIVE_INFINITY,
};

let deps: RestLimitDeps = defaults;
let pauseUntil = 0;
let lane: Promise<void> = Promise.resolve();
let stats: RestStats = { n: 0, r429: 0, waitedMs: 0 };
const cold = new Set<string>();
const sentAt: number[] = [];

export function resetRestLimit(next?: Partial<RestLimitDeps>): void {
  deps = { ...defaults, ...next };
  pauseUntil = 0;
  lane = Promise.resolve();
  stats = { n: 0, r429: 0, waitedMs: 0 };
  cold.clear();
  sentAt.length = 0;
}

export function beginRestRun(deadlineMs: number): void {
  resetRestLimit({ deadlineMs: () => deadlineMs });
}

export function restStats(): RestStats {
  return { ...stats };
}

export function restSentAt(): readonly number[] {
  return sentAt;
}

export function restLogLine(): string {
  return `rest n=${stats.n}, 429=${stats.r429}, waited_ms=${stats.waitedMs}`;
}

export function markCold(productId: string): void {
  if (productId) cold.add(productId);
}

export function isCold(productId: string): boolean {
  return cold.has(productId);
}

export function coldProducts(): string[] {
  return [...cold].sort();
}

export function productIdFromUrl(url: string): string | null {
  const match = url.match(/\/products\/([^/?]+)/);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function retryAfterMs(header: string | null): number | null {
  if (header == null || header === "") return null;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.round(seconds * 1000);
}

/** Full jitter: uniform from 0 through min(8s, 0.5s * 2^n). */
export function fullJitterMs(attempt: number, rand: () => number): number {
  const cap = Math.min(REST_JITTER_CAP_MS, 500 * 2 ** attempt);
  return Math.floor(rand() * (cap + 1));
}

async function pause(ms: number): Promise<void> {
  if (!(ms > 0)) return;
  pauseUntil = Math.max(pauseUntil, deps.now() + ms);
  stats.waitedMs += ms;
  await deps.sleep(ms);
}

/** At most `burst` sends in any 1s window. Burst 4 at 4/s, so the window never holds a fifth. */
async function takeToken(): Promise<void> {
  for (;;) {
    const now = deps.now();
    if (pauseUntil > now) {
      await pause(pauseUntil - now);
      continue;
    }
    const recent = sentAt.filter((sent) => now - sent < 1_000);
    if (recent.length < REST_BURST) return;
    const oldest = recent[0] ?? now;
    await pause(Math.max(1, 1_000 - (now - oldest)));
  }
}

async function once(url: string): Promise<Response> {
  const product = productIdFromUrl(url);
  let last: Response | null = null;
  for (let attempt = 0; attempt < REST_MAX_ATTEMPTS; attempt += 1) {
    const now = deps.now();
    if (now >= deps.deadlineMs() - REST_DEADLINE_MARGIN_MS) break;
    if (stats.n >= REST_HARD_CAP) {
      if (product) markCold(product);
      return last ?? new Response("", { status: 429 });
    }
    await takeToken();
    stats.n += 1;
    sentAt.push(deps.now());
    let response: Response;
    try {
      response = await deps.fetch(url);
    } catch {
      last = new Response("", { status: 599 });
      await pause(fullJitterMs(attempt, deps.rand));
      continue;
    }
    if (response.ok && response.status !== 429) return response;
    last = response;
    if (response.status === 429) {
      stats.r429 += 1;
      const honored = retryAfterMs(response.headers.get("retry-after"));
      await pause(honored ?? fullJitterMs(attempt, deps.rand));
      continue;
    }
    await pause(fullJitterMs(attempt, deps.rand));
  }
  if (product) markCold(product);
  return last ?? new Response("", { status: 429 });
}

/** Serial. Every Coinbase REST call goes through here. */
export function limited(url: string): Promise<Response> {
  const run = lane.then(() => once(url));
  lane = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Default transport for the six public market-data call sites. */
export function coinbaseGet(url: string): Promise<Response> {
  return limited(url);
}
