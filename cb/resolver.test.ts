import { test, expect, beforeAll, afterAll } from "bun:test";
import { Store } from "./db/store";
import { Resolver } from "./resolver";
import { config } from "./config";

const store = new Store(config.databaseUrl);
const runId = `test-${crypto.randomUUID()}`;
const pair = "RESOLVE-USD";

beforeAll(async () => {
  await store.init();
  await store.insertRun({ id: runId, mode: "paper", model: "mock", pairs: pair, config: {}, git_sha: null, started_at: Date.now() });
});

afterAll(async () => {
  await store.sql`DELETE FROM outcomes WHERE decision_id IN (SELECT id FROM decisions WHERE run_id = ${runId})`;
  await store.sql`DELETE FROM decisions WHERE run_id = ${runId}`;
  await store.sql`DELETE FROM bars WHERE pair = ${pair}`;
  await store.sql`DELETE FROM runs WHERE id = ${runId}`;
  await store.close();
});

test("resolves due horizons with correct move sign, and is idempotent across a restart", async () => {
  const t0 = Date.now() - 2 * 3600 * 1000; // decided two hours ago at mid 100
  const buyId = await store.insertDecision({ run_id: runId, pair, ts: t0, action: "buy", p_buy: 0.7, p_sell: 0.3, mid: 100, spread_bps: 5, state: {}, latency_ms: 150, input_tokens: 100, inference_usd: 0, traded: true });
  const sellId = await store.insertDecision({ run_id: runId, pair, ts: t0, action: "sell", p_buy: 0.3, p_sell: 0.7, mid: 100, spread_bps: 5, state: {}, latency_ms: 150, input_tokens: 100, inference_usd: 0, traded: false });

  // Bar at the 1h horizon: mid rose to 105 (+500 bps).
  const barTs = Math.floor((t0 + 3600 * 1000) / 60_000) * 60_000;
  await store.upsertBar({ pair, ts: barTs, open: 105, high: 105, low: 105, close: 105, volume_base: 10 });

  const resolver = new Resolver(store, [3600, 14400, 86400]);
  const now = t0 + 3600 * 1000 + 60_000; // just past the 1h horizon

  const first = await resolver.tick(now);
  expect(first).toBe(2); // one row each for the buy and sell decision at the 1h horizon

  const outcomes = await store.sql<{ decision_id: string; move_bps: number; correct: boolean }[]>`
    SELECT decision_id, move_bps, correct FROM outcomes WHERE horizon_sec = 3600 AND decision_id IN ${store.sql([buyId, sellId])}
  `;
  const byId = new Map(outcomes.map((o) => [o.decision_id, o]));
  expect(Number(byId.get(buyId)!.move_bps)).toBeCloseTo(500, 6);
  expect(byId.get(buyId)!.correct).toBe(true); // buy call, price rose
  expect(byId.get(sellId)!.correct).toBe(false); // sell call, price rose

  const second = await resolver.tick(now); // restart / re-run
  expect(second).toBe(0); // already resolved, nothing rewritten

  const count = await store.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM outcomes WHERE horizon_sec = 3600 AND decision_id IN ${store.sql([buyId, sellId])}`;
  expect(count[0]!.n).toBe(2);
});
