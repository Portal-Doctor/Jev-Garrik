import { afterAll, beforeAll, expect, test } from "bun:test";
import { config } from "./config";
import { Store } from "./db/store";
import { mergeSeedSamples } from "./engine";
import { PairVetoes, VETO_RING_MS, VETO_WARM_SAMPLES } from "./vetoes";

// Runs against the Docker Postgres (compose.yml). Start it with `docker compose up -d`.
// A synthetic pair keeps this off the live campaign's rows.
const store = new Store(config.databaseUrl);
const PAIR = `SEED-TEST-${crypto.randomUUID().slice(0, 8)}`;
const runId = `test-${crypto.randomUUID()}`;
const base = Date.now() - 3 * 86_400_000;

const decisionState = (i: number) => ({
  vector: { toxicPHigh: i / (VETO_WARM_SAMPLES - 1), stressPStressed: 1 - i / (VETO_WARM_SAMPLES - 1) },
});

beforeAll(async () => {
  await store.init();
  await store.insertRun({
    id: runId,
    mode: "paper",
    model: "mock",
    pairs: PAIR,
    config: { test: true },
    git_sha: null,
    started_at: base,
  });
  for (let i = 0; i < VETO_WARM_SAMPLES; i++) {
    const ts = base + i * 1_000;
    await store.insertDecision({
      run_id: runId,
      pair: PAIR,
      ts,
      action: "sell",
      p_buy: 0.5,
      p_sell: 0.5,
      mid: 100,
      spread_bps: 2,
      state: decisionState(i),
      latency_ms: 1,
      input_tokens: 0,
      inference_usd: 0,
      traded: false,
    });
    await store.insertVetoSample({
      pair: PAIR,
      ts,
      toxicPHigh: i / (VETO_WARM_SAMPLES - 1),
      stressPStressed: 1 - i / (VETO_WARM_SAMPLES - 1),
    });
  }
});

afterAll(async () => {
  await store.sql`DELETE FROM decisions WHERE run_id = ${runId}`;
  await store.sql`DELETE FROM runs WHERE id = ${runId}`;
  await store.sql`DELETE FROM veto_samples WHERE pair = ${PAIR}`;
  await store.close();
});

/** What `Engine.seedVetoes` does for one pair, with the same two reads. */
async function seedOnePair(): Promise<PairVetoes> {
  const since = Date.now() - VETO_RING_MS;
  const [decisions, samples] = await Promise.all([
    store.vetoRingForPair(PAIR, since),
    store.vetoSamplesForPair(PAIR, since),
  ]);
  const v = new PairVetoes();
  v.seed(mergeSeedSamples(decisions, samples));
  return v;
}

const firstDecide = (v: PairVetoes) =>
  v.decide({ ts: Date.now(), toxicPHigh: 0.99, stressPStressed: 0.99, ruleToxic: false, ruleStress: false });

test("the boot seed read is not scoped to a run, so a restart keeps the ring", async () => {
  // `vetoRingForPair` takes no run id, which is what makes a new runId harmless.
  expect(store.vetoRingForPair.length).toBe(2);
  const rows = await store.vetoRingForPair(PAIR, 0);
  expect(rows.length).toBe(VETO_WARM_SAMPLES);
});

test("a restart with 200 persisted samples decides from Jev on the first call", async () => {
  const v = await seedOnePair();
  expect(v.size()).toBe(VETO_WARM_SAMPLES);
  const out = firstDecide(v);
  expect(out.toxicSource).toBe("jev");
  expect(out.toxicVeto).toBe(true);
});

test("the two sources dedupe by timestamp rather than double counting", async () => {
  const since = Date.now() - VETO_RING_MS;
  const decisions = await store.vetoRingForPair(PAIR, since);
  const samples = await store.vetoSamplesForPair(PAIR, since);
  expect(decisions.length).toBe(VETO_WARM_SAMPLES);
  expect(samples.length).toBe(VETO_WARM_SAMPLES);
  expect(mergeSeedSamples(decisions, samples).length).toBe(VETO_WARM_SAMPLES);
});

test("a paper reset wipes the decisions but the ring still seeds warm from veto_samples", async () => {
  // Exactly what `resetVenue` does to this pair's rows. It is run directly rather than through
  // `resetVenue` so the live campaign's data is not touched by a test.
  await store.sql`DELETE FROM decisions WHERE run_id = ${runId}`;
  expect((await store.vetoRingForPair(PAIR, 0)).length).toBe(0);

  const v = await seedOnePair();
  expect(v.size()).toBe(VETO_WARM_SAMPLES);
  const out = firstDecide(v);
  expect(out.toxicSource).toBe("jev");
  expect(out.toxicSource).not.toBe("rule");
});

test("reset does not name veto_samples, so the seed tape cannot be wiped by it", () => {
  // A string check on the two reset paths. Cheap, and it fails loudly if the table is ever added.
  expect(Store.prototype.resetVenue.toString()).not.toContain("veto_samples");
  expect(Store.prototype.resetAll.toString()).not.toContain("veto_samples");
});

test("samples older than the 7 day window are pruned and stop warming the ring", async () => {
  const stale = Date.now() - 30 * 86_400_000;
  await store.insertVetoSample({ pair: PAIR, ts: stale, toxicPHigh: 0.5, stressPStressed: 0.5 });
  expect((await store.vetoSamplesForPair(PAIR, 0)).some((s) => s.ts === stale)).toBe(true);
  await store.pruneVetoSamples(Date.now() - VETO_RING_MS);
  expect((await store.vetoSamplesForPair(PAIR, 0)).some((s) => s.ts === stale)).toBe(false);
});
