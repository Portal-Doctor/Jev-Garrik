import { test, expect, beforeAll, afterAll } from "bun:test";
import { Store } from "./store";
import { config } from "../config";

// Runs against the Docker Postgres (compose.yml). Start it with `docker compose up -d`.
const store = new Store(config.databaseUrl);
const runId = `test-${crypto.randomUUID()}`;

beforeAll(async () => {
  await store.init();
  await store.insertRun({
    id: runId,
    mode: "paper",
    model: "mock",
    pairs: "SOL-USD",
    config: { test: true },
    git_sha: null,
    started_at: Date.now(),
  });
});

afterAll(async () => {
  // Clean up rows this run created; other rows (e.g. from a live run) are left alone.
  await store.sql`DELETE FROM fills WHERE run_id = ${runId}`;
  await store.sql`DELETE FROM outcomes WHERE decision_id IN (SELECT id FROM decisions WHERE run_id = ${runId})`;
  await store.sql`DELETE FROM decisions WHERE run_id = ${runId}`;
  await store.sql`DELETE FROM bars WHERE pair = ${"TEST-USD"}`;
  await store.sql`DELETE FROM runs WHERE id = ${runId}`;
  await store.close();
});

test("schema apply is idempotent and the run row round-trips", async () => {
  await store.init(); // second apply must not throw
  const rows = await store.sql<{ id: string; pairs: string }[]>`SELECT id, pairs FROM runs WHERE id = ${runId}`;
  expect(rows.length).toBe(1);
  expect(rows[0]!.pairs).toBe("SOL-USD");
});

test("fills are idempotent on (venue, external_id)", async () => {
  const fill = {
    run_id: runId,
    order_id: null,
    venue: "paper" as const,
    external_id: `paper-${runId}-1`,
    pair: "SOL-USD",
    side: "buy" as const,
    price: 100,
    size_base: 10,
    notional_usd: 1000,
    fee_usd: 5,
    liquidity: "maker" as const,
    cost_basis_usd: 1005,
    proceeds_usd: 0,
    source: "paper_sim" as const,
    traded_at: Date.now(),
    recorded_at: Date.now(),
  };
  const first = await store.upsertFill(fill);
  const second = await store.upsertFill(fill); // replay
  expect(first).toBe(true);
  expect(second).toBe(false);
  const rows = await store.sql<{ n: number }[]>`SELECT COUNT(*)::int AS n FROM fills WHERE run_id = ${runId}`;
  expect(rows[0]!.n).toBe(1);
});

test("minute bar upsert aggregates high/low/close/volume", async () => {
  const ts = 60_000;
  await store.upsertBar({ pair: "TEST-USD", ts, open: 10, high: 11, low: 9, close: 10.5, volume_base: 100 });
  await store.upsertBar({ pair: "TEST-USD", ts, open: 10, high: 12, low: 8, close: 10.2, volume_base: 50 });
  const rows = await store.sql<{ high: number; low: number; close: number; volume_base: number }[]>`SELECT high, low, close, volume_base FROM bars WHERE pair = ${"TEST-USD"} AND ts = ${ts}`;
  expect(Number(rows[0]!.high)).toBe(12);
  expect(Number(rows[0]!.low)).toBe(8);
  expect(Number(rows[0]!.close)).toBeCloseTo(10.2, 9);
  expect(Number(rows[0]!.volume_base)).toBe(150);
});

test("decisionsDueForResolve returns due horizons lacking an outcome", async () => {
  const ts = Date.now() - 2 * 3600 * 1000; // two hours ago
  const id = await store.insertDecision({
    run_id: runId,
    pair: "SOL-USD",
    ts,
    action: "buy",
    p_buy: 0.6,
    p_sell: 0.4,
    mid: 100,
    spread_bps: 5,
    state: { pair: "SOL-USD" },
    latency_ms: 150,
    input_tokens: 200,
    inference_usd: 0,
    traded: true,
  });
  const due = await store.decisionsDueForResolve(Date.now(), [3600, 14400, 86400]);
  const mine = due.filter((d) => d.id === id).map((d) => Number(d.horizon_sec)).sort((a, b) => a - b);
  expect(mine).toEqual([3600]); // 1h has passed, 4h and 24h have not

  await store.insertOutcome({ decision_id: id, horizon_sec: 3600, resolved_at: Date.now(), mid_then: 100, mid_at_horizon: 101, move_bps: 100, correct: true });
  const after = await store.decisionsDueForResolve(Date.now(), [3600, 14400, 86400]);
  expect(after.some((d) => d.id === id && Number(d.horizon_sec) === 3600)).toBe(false); // resolved, no longer due
});

test("pairsWithDataForVenue hides the other venue", async () => {
  const kuruId = `test-kuru-pairs-${crypto.randomUUID()}`;
  const paperId = `test-paper-pairs-${crypto.randomUUID()}`;
  await store.insertRun({
    id: kuruId,
    mode: "paper",
    model: "mock",
    pairs: "MON-USDC",
    config: { test: true },
    git_sha: null,
    started_at: Date.now(),
    venue: "kuru",
  });
  await store.insertRun({
    id: paperId,
    mode: "paper",
    model: "mock",
    pairs: "SOL-USD",
    config: { test: true },
    git_sha: null,
    started_at: Date.now(),
    venue: "paper",
  });
  await store.insertDecision({
    run_id: kuruId,
    pair: "MON-USDC",
    ts: Date.now(),
    action: "buy",
    p_buy: 0.6,
    p_sell: 0.4,
    mid: 0.02,
    spread_bps: 5,
    state: {},
    latency_ms: 1,
    input_tokens: 0,
    inference_usd: 0,
    traded: false,
  });
  await store.insertDecision({
    run_id: paperId,
    pair: "SOL-USD",
    ts: Date.now(),
    action: "buy",
    p_buy: 0.6,
    p_sell: 0.4,
    mid: 100,
    spread_bps: 5,
    state: {},
    latency_ms: 1,
    input_tokens: 0,
    inference_usd: 0,
    traded: false,
  });
  const paper = await store.pairsWithDataForVenue("paper");
  const kuru = await store.pairsWithDataForVenue("kuru");
  expect(paper).toContain("SOL-USD");
  expect(paper).not.toContain("MON-USDC");
  expect(kuru).toContain("MON-USDC");
  await store.sql`DELETE FROM decisions WHERE run_id IN ${store.sql([kuruId, paperId])}`;
  await store.sql`DELETE FROM runs WHERE id IN ${store.sql([kuruId, paperId])}`;
});

test("resetVenue deletes only that venue", async () => {
  const kuruId = `test-kuru-${crypto.randomUUID()}`;
  const paperId = `test-paper-${crypto.randomUUID()}`;
  await store.insertRun({
    id: kuruId,
    mode: "paper",
    model: "mock",
    pairs: "MON-USDC",
    config: { test: true },
    git_sha: null,
    started_at: Date.now(),
    venue: "kuru",
  });
  await store.insertRun({
    id: paperId,
    mode: "paper",
    model: "mock",
    pairs: "SOL-USD",
    config: { test: true },
    git_sha: null,
    started_at: Date.now(),
    venue: "paper",
  });
  await store.resetVenue("kuru");
  const rows = await store.sql<{ id: string }[]>`SELECT id FROM runs WHERE id IN ${store.sql([kuruId, paperId])}`;
  expect(rows.map((r) => r.id)).toEqual([paperId]);
  await store.sql`DELETE FROM runs WHERE id = ${paperId}`;
});
