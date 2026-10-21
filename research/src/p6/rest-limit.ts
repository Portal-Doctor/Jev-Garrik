/**
 * One lane per invocation for every public Coinbase REST call.
 * Token bucket: 4 requests/second, burst 4. A 429 pauses that invocation's bucket.
 * Seed calls stop at 250 so 150 requests stay for live confirms and backfill.
 */

export const REST_RATE_PER_SEC = 4;
export const REST_BURST = 4;
export const REST_MAX_ATTEMPTS = 5;
export const REST_HARD_CAP = 400;
export const REST_RESERVE = 150;
export const SEED_BUDGET = REST_HARD_CAP - REST_RESERVE;
/** Live 15m confirms keep this many requests after every other call has stopped. */
export const LIVE_FLOOR = 50;
/** /trades and 1m candle backfill keep this many after books and catch-up stop. */
export const BACKFILL_RESERVE = 50;
export const BACKFILL_CAP = REST_HARD_CAP - LIVE_FLOOR;
/** Books, catch-up, and hour deltas stop here. Seed stops earlier, at SEED_BUDGET. */
export const OPERATING_CAP = BACKFILL_CAP - BACKFILL_RESERVE;
export const REST_DEADLINE_MARGIN_MS = 90_000;
export const REST_JITTER_CAP_MS = 8_000;
/**
 * One public candles call. Same 20s as the candle downloader.
 * It sits inside the 90s deadline margin, so a hung socket cannot hold the lane until the platform kills the run.
 */
export const REST_FETCH_TIMEOUT_MS = 20_000;

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

export interface RestRun {
  deps: RestLimitDeps;
  pauseUntil: number;
  lane: Promise<void>;
  stats: RestStats;
  cold: Map<string, string>;
  sentAt: number[];
  seedUsed: number;
  seedBudget: number;
  onCold?: (id: string, reason: string) => void;
  /** Runs before each attempt. The host renews its lease here. */
  beforeFetch?: () => Promise<void> | void;
  /** True when this run should not call the product again. */
  skipProduct?: (productId: string) => boolean;
  /** Records a timeout so later calls for that product can be skipped. */
  noteTimeout?: (productId: string) => void;
  /** True when the holder has stopped and this attempt should not be sent. */
  halted?: () => boolean;
}

/** Abort a hung public GET. Injected test transports are not wrapped. */
export function fetchWithTimeout(
  url: string,
  timeoutMs = REST_FETCH_TIMEOUT_MS,
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response> = globalThis.fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetchImpl(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
}

const defaults: RestLimitDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  rand: () => Math.random(),
  fetch: (url) => fetchWithTimeout(url),
  deadlineMs: () => Number.POSITIVE_INFINITY,
};

/** Test lane. Production passes the host's run and does not read this. */
let active: RestRun | null = null;

export function createRestRun(deadlineMs: number, partial?: Partial<RestLimitDeps>, onCold?: (id: string, reason: string) => void): RestRun {
  return {
    deps: { ...defaults, ...partial, deadlineMs: partial?.deadlineMs ?? (() => deadlineMs) },
    pauseUntil: 0,
    lane: Promise.resolve(),
    stats: { n: 0, r429: 0, waitedMs: 0 },
    cold: new Map(),
    sentAt: [],
    seedUsed: 0,
    seedBudget: SEED_BUDGET,
    ...(onCold ? { onCold } : {}),
  };
}

export function resetRestLimit(next?: Partial<RestLimitDeps>): RestRun {
  active = createRestRun(next?.deadlineMs?.() ?? Number.POSITIVE_INFINITY, next);
  return active;
}

export function beginRestRun(deadlineMs: number, onCold?: (id: string, reason: string) => void): RestRun {
  active = createRestRun(deadlineMs, undefined, onCold);
  return active;
}

function runOf(run?: RestRun): RestRun {
  if (run) return run;
  if (!active) active = createRestRun(Number.POSITIVE_INFINITY);
  return active;
}

export function restStats(run?: RestRun): RestStats {
  return { ...runOf(run).stats };
}

export function restSentAt(run?: RestRun): readonly number[] {
  return runOf(run).sentAt;
}

export function budgetStopLabel(headers: { get(name: string): string | null } | undefined): "budget-stop" | null {
  const kind = headers?.get("x-p6-budget");
  if (kind === "seed" || kind === "reserve" || kind === "hard") return "budget-stop";
  return null;
}

export function restLogLine(run?: RestRun, extra?: { warm: number; total: number; seedIdx: number; cold?: { id: string }[] }): string {
  const state = runOf(run);
  const ids = (extra?.cold ? extra.cold.map((row) => row.id) : [...state.cold.keys()]).sort();
  const tail = extra ? ` warm=${extra.warm}/${extra.total} seed_idx=${extra.seedIdx}` : "";
  return `rest n=${state.stats.n}, 429=${state.stats.r429}, waited_ms=${state.stats.waitedMs}, cold=[${ids.join(",")}]${tail}`;
}

export function markCold(productId: string, run?: RestRun, reason = "cold"): void {
  if (!productId) return;
  const state = runOf(run);
  if (state.cold.has(productId)) return;
  state.cold.set(productId, reason);
  state.onCold?.(productId, reason);
}

export function isCold(productId: string, run?: RestRun): boolean {
  return runOf(run).cold.has(productId);
}

export function coldProducts(run?: RestRun): string[] {
  return [...runOf(run).cold.keys()].sort();
}

export function coldReasons(run?: RestRun): { id: string; reason: string }[] {
  return [...runOf(run).cold.entries()].map(([id, reason]) => ({ id, reason })).sort((a, b) => (a.id < b.id ? -1 : 1));
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

export function isAbortError(error: unknown): boolean {
  if (error == null || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  if (name === "AbortError") return true;
  const message = "message" in error ? String((error as { message?: unknown }).message ?? "") : "";
  return message.toLowerCase().includes("aborted");
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

async function pause(state: RestRun, ms: number): Promise<void> {
  if (!(ms > 0)) return;
  state.pauseUntil = Math.max(state.pauseUntil, state.deps.now() + ms);
  state.stats.waitedMs += ms;
  await state.deps.sleep(ms);
}

/** At most `burst` sends in any 1s window. Burst 4 at 4/s, so the window never holds a fifth. */
async function takeToken(state: RestRun): Promise<void> {
  for (;;) {
    const now = state.deps.now();
    if (state.pauseUntil > now) {
      await pause(state, state.pauseUntil - now);
      continue;
    }
    const recent = state.sentAt.filter((sent) => now - sent < 1_000);
    if (recent.length < REST_BURST) return;
    const oldest = recent[0] ?? now;
    await pause(state, Math.max(1, 1_000 - (now - oldest)));
  }
}

function seedStopped(): Response {
  return new Response("", { status: 429, headers: { "x-p6-budget": "seed" } });
}

export function seedBudgetStopped(response: Pick<Response, "headers">): boolean {
  return response.headers.get("x-p6-budget") === "seed";
}

function budgetStop(kind: "reserve" | "hard"): Response {
  return new Response("", { status: 429, headers: { "x-p6-budget": kind } });
}

async function once(state: RestRun, url: string, seed: boolean, mark: boolean, live: boolean, backfill: boolean): Promise<Response> {
  const product = productIdFromUrl(url);
  if (seed && state.seedUsed >= state.seedBudget) return seedStopped();
  let last: Response | null = null;
  let requested = false;
  for (let attempt = 0; attempt < REST_MAX_ATTEMPTS; attempt += 1) {
    const now = state.deps.now();
    if (now >= state.deps.deadlineMs() - REST_DEADLINE_MARGIN_MS) break;
    if (seed && (state.seedUsed >= state.seedBudget || state.stats.n >= state.seedBudget)) return seedStopped();
    if (!live && !backfill && state.stats.n >= OPERATING_CAP) return budgetStop("reserve");
    if (!live && state.stats.n >= BACKFILL_CAP) return budgetStop("reserve");
    if (state.stats.n >= REST_HARD_CAP) return budgetStop("hard");
    await state.beforeFetch?.();
    if (state.halted?.()) return last ?? new Response("", { status: 599 });
    if (product && state.skipProduct?.(product)) return new Response("", { status: 599 });
    await takeToken(state);
    state.stats.n += 1;
    if (seed) state.seedUsed += 1;
    state.sentAt.push(state.deps.now());
    requested = true;
    let response: Response;
    try {
      response = await state.deps.fetch(url);
    } catch (error) {
      last = new Response("", { status: 599 });
      // One abort is enough. Further attempts would each block for the fetch timeout.
      if (isAbortError(error)) {
        if (product) state.noteTimeout?.(product);
        if (mark && product && requested) markCold(product, state, "retries");
        return last;
      }
      await pause(state, fullJitterMs(attempt, state.deps.rand));
      continue;
    }
    if (response.ok && response.status !== 429) return response;
    last = response;
    if (response.status === 429) {
      state.stats.r429 += 1;
      const honored = retryAfterMs(response.headers.get("retry-after"));
      await pause(state, honored ?? fullJitterMs(attempt, state.deps.rand));
      continue;
    }
    if (response.status >= 400 && response.status < 500) {
      if (mark && product) markCold(product, state, `http-${response.status}`);
      return response;
    }
    await pause(state, fullJitterMs(attempt, state.deps.rand));
  }
  // A deadline break before any send is not this product's failure. `cold: false` (tape and 1m backfill) never marks cold.
  if (last?.status === 599 && product) state.noteTimeout?.(product);
  if (mark && product && requested) markCold(product, state, "retries");
  return last ?? new Response("", { status: 429 });
}

/** Public ticker GET for the dashboard mark. No key. The caller caches it. Not the candle bucket. */
export function publicTicker(url: string): Promise<Pick<Response, "ok" | "json">> {
  return globalThis.fetch(url);
}

/** Serial on this run. A second run has its own lane. `cold: false` returns a 4xx without retrying it, and does not mark cold after a failed retry. */
export function limited(url: string, run?: RestRun, opts?: { seed?: boolean; cold?: boolean; live?: boolean; backfill?: boolean }): Promise<Response> {
  const state = runOf(run);
  const seed = opts?.seed === true;
  const mark = opts?.cold !== false;
  const live = opts?.live === true;
  const backfill = opts?.backfill === true;
  const task = state.lane.then(() => once(state, url, seed, mark, live, backfill));
  state.lane = task.then(
    () => undefined,
    () => undefined,
  );
  return task;
}

/** Default transport for the public market-data call sites. Pass the host's run. */
export function coinbaseGet(url: string, run?: RestRun, opts?: { seed?: boolean; cold?: boolean; live?: boolean; backfill?: boolean }): Promise<Response> {
  return limited(url, run, opts);
}
