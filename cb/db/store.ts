import { SQL } from "bun";

/**
 * Postgres-only store for the paper-trading harness (Bun.sql).
 *
 * Organized by concern to avoid the single-giant-module anti-pattern: connection + schema apply,
 * then writes, then queries. All ids are uuids; timestamps are epoch ms (BIGINT); JSON columns are
 * JSONB. Fills are idempotent via UNIQUE(venue, external_id) so replays and reconnects never double
 * count.
 */

export interface RunRow {
  id: string;
  mode: "paper" | "live";
  model: string;
  pairs: string;
  config: unknown;
  git_sha: string | null;
  started_at: number;
  stopped_at: number | null;
  /** Coinbase paper campaign. */
  venue?: "paper";
}

export interface DecisionRow {
  id: string;
  run_id: string;
  pair: string;
  ts: number;
  action: "buy" | "sell";
  p_buy: number;
  p_sell: number;
  mid: number;
  spread_bps: number;
  state: unknown;
  latency_ms: number;
  input_tokens: number;
  inference_usd: number;
  traded: boolean;
}

export interface OutcomeRow {
  decision_id: string;
  horizon_sec: number;
  resolved_at: number;
  mid_then: number;
  mid_at_horizon: number;
  move_bps: number;
  correct: boolean;
}

export interface OrderRow {
  id: string;
  run_id: string;
  decision_id: string | null;
  pair: string;
  side: "buy" | "sell";
  purpose: "entry" | "exit" | "stop" | "take_profit";
  price: number;
  size_base: number;
  status: "open" | "filled" | "partial" | "canceled" | "converted_taker" | "expired";
  venue_order_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface FillRow {
  id: string;
  run_id: string;
  order_id: string | null;
  venue: "paper" | "coinbase";
  external_id: string;
  pair: string;
  side: "buy" | "sell";
  price: number;
  size_base: number;
  notional_usd: number;
  fee_usd: number;
  liquidity: "maker" | "taker";
  cost_basis_usd: number;
  proceeds_usd: number;
  source: "paper_sim" | "coinbase_sync";
  traded_at: number;
  recorded_at: number;
  raw?: unknown;
}

export interface SnapshotRow {
  id: string;
  run_id: string;
  pair: string;
  ts: number;
  mid: number | null;
  position_base: number;
  entry_price: number | null;
  realized_usd: number;
  unrealized_usd: number;
  fees_usd: number;
  inference_usd: number;
  equity_usd: number;
  gas_usd?: number;
}

export interface BarRow {
  pair: string;
  ts: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume_base: number;
}

const uuid = () => crypto.randomUUID();

export class Store {
  readonly sql: SQL;

  constructor(url: string) {
    this.sql = new SQL(url);
  }

  // --- connection + schema ---------------------------------------------------

  /** Connect and apply the schema (CREATE TABLE IF NOT EXISTS). Safe to call on every boot. */
  async init(): Promise<void> {
    await this.sql.connect();
    const ddl = await Bun.file(new URL("./schema.sql", import.meta.url)).text();
    await this.sql.unsafe(ddl).simple();
  }

  async close(): Promise<void> {
    await this.sql.close();
  }

  // --- writes ----------------------------------------------------------------

  async insertRun(r: Omit<RunRow, "stopped_at"> & { stopped_at?: number | null }): Promise<void> {
    await this.sql`
      INSERT INTO runs (id, mode, model, pairs, config, git_sha, started_at, stopped_at, venue)
      VALUES (${r.id}, ${r.mode}, ${r.model}, ${r.pairs}, ${JSON.stringify(r.config)}, ${r.git_sha ?? null}, ${r.started_at}, ${r.stopped_at ?? null}, ${r.venue ?? "paper"})
    `;
  }

  async stopRun(id: string, stoppedAt: number): Promise<void> {
    await this.sql`UPDATE runs SET stopped_at = ${stoppedAt} WHERE id = ${id}`;
  }

  /** Insert a decision. Returns the id (generated if not supplied). */
  async insertDecision(d: Omit<DecisionRow, "id"> & { id?: string }): Promise<string> {
    const id = d.id ?? uuid();
    await this.sql`
      INSERT INTO decisions (id, run_id, pair, ts, action, p_buy, p_sell, mid, spread_bps, state, latency_ms, input_tokens, inference_usd, traded)
      VALUES (${id}, ${d.run_id}, ${d.pair}, ${d.ts}, ${d.action}, ${d.p_buy}, ${d.p_sell}, ${d.mid}, ${d.spread_bps}, ${JSON.stringify(d.state)}, ${d.latency_ms}, ${d.input_tokens}, ${d.inference_usd}, ${d.traded})
    `;
    return id;
  }

  async markDecisionTraded(id: string, traded = true): Promise<void> {
    await this.sql`UPDATE decisions SET traded = ${traded} WHERE id = ${id}`;
  }

  /** Idempotent: a second write for the same (decision_id, horizon_sec) is ignored. */
  async insertOutcome(o: OutcomeRow): Promise<void> {
    await this.sql`
      INSERT INTO outcomes (decision_id, horizon_sec, resolved_at, mid_then, mid_at_horizon, move_bps, correct)
      VALUES (${o.decision_id}, ${o.horizon_sec}, ${o.resolved_at}, ${o.mid_then}, ${o.mid_at_horizon}, ${o.move_bps}, ${o.correct})
      ON CONFLICT (decision_id, horizon_sec) DO NOTHING
    `;
  }

  async insertOrder(o: Omit<OrderRow, "id"> & { id?: string }): Promise<string> {
    const id = o.id ?? uuid();
    await this.sql`
      INSERT INTO orders (id, run_id, decision_id, pair, side, purpose, price, size_base, status, venue_order_id, created_at, updated_at)
      VALUES (${id}, ${o.run_id}, ${o.decision_id ?? null}, ${o.pair}, ${o.side}, ${o.purpose}, ${o.price}, ${o.size_base}, ${o.status}, ${o.venue_order_id ?? null}, ${o.created_at}, ${o.updated_at})
    `;
    return id;
  }

  /** Newest open or partial order per pair for one venue. Used to resume the book after a restart. */
  async openOrdersForVenue(venue: "paper"): Promise<OrderRow[]> {
    return this.sql<OrderRow[]>`
      SELECT DISTINCT ON (o.pair) o.*
      FROM orders o
      JOIN runs r ON r.id = o.run_id
      WHERE r.venue = ${venue}
        AND o.status IN (${"open"}, ${"partial"})
      ORDER BY o.pair, o.created_at DESC
    `;
  }

  async updateOrder(id: string, patch: Partial<Pick<OrderRow, "price" | "size_base" | "status" | "venue_order_id">>, updatedAt: number): Promise<void> {
    await this.sql`
      UPDATE orders SET
        price = COALESCE(${patch.price ?? null}, price),
        size_base = COALESCE(${patch.size_base ?? null}, size_base),
        status = COALESCE(${patch.status ?? null}, status),
        venue_order_id = COALESCE(${patch.venue_order_id ?? null}, venue_order_id),
        updated_at = ${updatedAt}
      WHERE id = ${id}
    `;
  }

  /** Idempotent on (venue, external_id). Returns true if a new row was written. */
  async upsertFill(f: Omit<FillRow, "id"> & { id?: string }): Promise<boolean> {
    const id = f.id ?? uuid();
    const rows = await this.sql<{ id: string }[]>`
      INSERT INTO fills (id, run_id, order_id, venue, external_id, pair, side, price, size_base, notional_usd, fee_usd, liquidity, cost_basis_usd, proceeds_usd, source, traded_at, recorded_at, raw)
      VALUES (${id}, ${f.run_id}, ${f.order_id ?? null}, ${f.venue}, ${f.external_id}, ${f.pair}, ${f.side}, ${f.price}, ${f.size_base}, ${f.notional_usd}, ${f.fee_usd}, ${f.liquidity}, ${f.cost_basis_usd}, ${f.proceeds_usd}, ${f.source}, ${f.traded_at}, ${f.recorded_at}, ${f.raw === undefined ? null : JSON.stringify(f.raw)})
      ON CONFLICT (venue, external_id) DO NOTHING
      RETURNING id
    `;
    return rows.length > 0;
  }

  async insertSnapshot(s: Omit<SnapshotRow, "id"> & { id?: string }): Promise<void> {
    const id = s.id ?? uuid();
    await this.sql`
      INSERT INTO snapshots (id, run_id, pair, ts, mid, position_base, entry_price, realized_usd, unrealized_usd, fees_usd, inference_usd, equity_usd, gas_usd)
      VALUES (${id}, ${s.run_id}, ${s.pair}, ${s.ts}, ${s.mid ?? null}, ${s.position_base}, ${s.entry_price ?? null}, ${s.realized_usd}, ${s.unrealized_usd}, ${s.fees_usd}, ${s.inference_usd}, ${s.equity_usd}, ${s.gas_usd ?? 0})
    `;
  }

  /** Upsert a minute bar; a later poll for the same minute updates high/low/close/volume. */
  async upsertBar(b: BarRow): Promise<void> {
    await this.sql`
      INSERT INTO bars (pair, ts, open, high, low, close, volume_base)
      VALUES (${b.pair}, ${b.ts}, ${b.open}, ${b.high}, ${b.low}, ${b.close}, ${b.volume_base})
      ON CONFLICT (pair, ts) DO UPDATE SET
        high = GREATEST(bars.high, EXCLUDED.high),
        low = LEAST(bars.low, EXCLUDED.low),
        close = EXCLUDED.close,
        volume_base = bars.volume_base + EXCLUDED.volume_base
    `;
  }

  // --- queries ---------------------------------------------------------------

  /** Nearest bar close at or before `ts` for a pair (used by the resolver). */
  async barCloseAtOrBefore(pair: string, ts: number): Promise<number | null> {
    const rows = await this.sql<{ close: number }[]>`
      SELECT close FROM bars WHERE pair = ${pair} AND ts <= ${ts} ORDER BY ts DESC LIMIT 1
    `;
    return rows.length ? Number(rows[0]!.close) : null;
  }

  /**
   * Decisions whose (ts + horizon) has passed but that lack an outcomes row for that horizon.
   * One returned row per (decision, due horizon). Restart-safe by construction.
   */
  async decisionsDueForResolve(
    now: number,
    horizonsSec: readonly number[],
    filter?: { pair?: string; runId?: string },
  ): Promise<Array<{ id: string; pair: string; ts: number; mid: number; action: "buy" | "sell"; horizon_sec: number }>> {
    const horizons = horizonsSec.map((h) => Number(h));
    const pair = filter?.pair;
    const runId = filter?.runId;
    if (pair && runId) {
      return this.sql`
        SELECT d.id, d.pair, d.ts, d.mid, d.action, h.horizon_sec
        FROM decisions d
        CROSS JOIN unnest(${this.sql.array(horizons, "INTEGER")}::int[]) AS h(horizon_sec)
        LEFT JOIN outcomes o ON o.decision_id = d.id AND o.horizon_sec = h.horizon_sec
        WHERE o.decision_id IS NULL
          AND d.ts + h.horizon_sec * 1000 <= ${now}
          AND d.pair = ${pair}
          AND d.run_id = ${runId}
        ORDER BY d.ts ASC
        LIMIT 5000
      `;
    }
    if (pair) {
      return this.sql`
        SELECT d.id, d.pair, d.ts, d.mid, d.action, h.horizon_sec
        FROM decisions d
        CROSS JOIN unnest(${this.sql.array(horizons, "INTEGER")}::int[]) AS h(horizon_sec)
        LEFT JOIN outcomes o ON o.decision_id = d.id AND o.horizon_sec = h.horizon_sec
        WHERE o.decision_id IS NULL
          AND d.ts + h.horizon_sec * 1000 <= ${now}
          AND d.pair = ${pair}
        ORDER BY d.ts ASC
        LIMIT 5000
      `;
    }
    if (runId) {
      return this.sql`
        SELECT d.id, d.pair, d.ts, d.mid, d.action, h.horizon_sec
        FROM decisions d
        CROSS JOIN unnest(${this.sql.array(horizons, "INTEGER")}::int[]) AS h(horizon_sec)
        LEFT JOIN outcomes o ON o.decision_id = d.id AND o.horizon_sec = h.horizon_sec
        WHERE o.decision_id IS NULL
          AND d.ts + h.horizon_sec * 1000 <= ${now}
          AND d.run_id = ${runId}
        ORDER BY d.ts ASC
        LIMIT 5000
      `;
    }
    return this.sql`
      SELECT d.id, d.pair, d.ts, d.mid, d.action, h.horizon_sec
      FROM decisions d
      CROSS JOIN unnest(${this.sql.array(horizons, "INTEGER")}::int[]) AS h(horizon_sec)
      LEFT JOIN outcomes o ON o.decision_id = d.id AND o.horizon_sec = h.horizon_sec
      WHERE o.decision_id IS NULL
        AND d.ts + h.horizon_sec * 1000 <= ${now}
      ORDER BY d.ts ASC
      LIMIT 5000
    `;
  }

  /**
   * Earliest decision ts still lacking an outcome, per horizon (null when nothing is pending).
   * Drives the report's "next 4h/24h read" countdown: the next read lands at ts + horizon.
   */
  async earliestUnresolvedTsForRun(runId: string, horizonsSec: readonly number[]): Promise<Array<{ horizon_sec: number; ts: number | null }>> {
    const horizons = horizonsSec.map((h) => Number(h));
    return this.sql`
      SELECT h.horizon_sec, MIN(d.ts) AS ts
      FROM unnest(${this.sql.array(horizons, "INTEGER")}::int[]) AS h(horizon_sec)
      LEFT JOIN decisions d
        ON d.run_id = ${runId}
        AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.decision_id = d.id AND o.horizon_sec = h.horizon_sec)
      GROUP BY h.horizon_sec
      ORDER BY h.horizon_sec
    `;
  }

  async resolvedForRun(runId: string): Promise<Array<{ pair: string; action: "buy" | "sell"; p_buy: number; traded: boolean; horizon_sec: number; move_bps: number; correct: boolean }>> {
    return this.sql`SELECT d.pair, d.action, d.p_buy, d.traded, o.horizon_sec, o.move_bps, o.correct FROM outcomes o JOIN decisions d ON d.id = o.decision_id WHERE d.run_id = ${runId}`;
  }

  async pairsForRun(runId: string): Promise<string[]> {
    const rows = await this.sql<{ pair: string }[]>`SELECT DISTINCT pair FROM decisions WHERE run_id = ${runId} ORDER BY pair`;
    return rows.map((r) => r.pair);
  }

  async earliestUnresolvedTs(horizonsSec: readonly number[]): Promise<Array<{ horizon_sec: number; ts: number | null }>> {
    const horizons = horizonsSec.map((h) => Number(h));
    return this.sql`
      SELECT h.horizon_sec, MIN(d.ts) AS ts
      FROM unnest(${this.sql.array(horizons, "INTEGER")}::int[]) AS h(horizon_sec)
      LEFT JOIN decisions d
        ON NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.decision_id = d.id AND o.horizon_sec = h.horizon_sec)
      GROUP BY h.horizon_sec
      ORDER BY h.horizon_sec
    `;
  }

  async recentDecisions(opts: { pair?: string; limit?: number; venue?: "paper" } = {}): Promise<Array<DecisionRow & { outcomes: OutcomeRow[] }>> {
    const limit = opts.limit ?? 100;
    const venue = opts.venue;
    const pair = opts.pair;
    const rows = venue && pair
      ? await this.sql<DecisionRow[]>`SELECT d.* FROM decisions d JOIN runs r ON r.id = d.run_id WHERE r.venue = ${venue} AND d.pair = ${pair} ORDER BY d.ts DESC LIMIT ${limit}`
      : venue
        ? await this.sql<DecisionRow[]>`SELECT d.* FROM decisions d JOIN runs r ON r.id = d.run_id WHERE r.venue = ${venue} ORDER BY d.ts DESC LIMIT ${limit}`
        : pair
          ? await this.sql<DecisionRow[]>`SELECT * FROM decisions WHERE pair = ${pair} ORDER BY ts DESC LIMIT ${limit}`
          : await this.sql<DecisionRow[]>`SELECT * FROM decisions ORDER BY ts DESC LIMIT ${limit}`;
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const outcomes = await this.sql<OutcomeRow[]>`SELECT * FROM outcomes WHERE decision_id IN ${this.sql(ids)}`;
    const byId = new Map<string, OutcomeRow[]>();
    for (const o of outcomes) byId.set(o.decision_id, [...(byId.get(o.decision_id) ?? []), o]);
    return rows.map((r) => ({ ...r, outcomes: byId.get(r.id) ?? [] }));
  }

  async resolvedForReport(pair?: string): Promise<Array<{ pair: string; action: "buy" | "sell"; p_buy: number; traded: boolean; horizon_sec: number; move_bps: number; correct: boolean }>> {
    return pair
      ? this.sql`SELECT d.pair, d.action, d.p_buy, d.traded, o.horizon_sec, o.move_bps, o.correct FROM outcomes o JOIN decisions d ON d.id = o.decision_id WHERE d.pair = ${pair}`
      : this.sql`SELECT d.pair, d.action, d.p_buy, d.traded, o.horizon_sec, o.move_bps, o.correct FROM outcomes o JOIN decisions d ON d.id = o.decision_id`;
  }

  /** All fills, optionally for one pair, oldest first (the authoritative money record). */
  async fillsAll(pair?: string): Promise<FillRow[]> {
    return pair
      ? this.sql<FillRow[]>`SELECT * FROM fills WHERE pair = ${pair} ORDER BY traded_at ASC`
      : this.sql<FillRow[]>`SELECT * FROM fills ORDER BY traded_at ASC`;
  }

  /** Coinbase paper fills, plus any row already tagged coinbase. */
  async fillsByVenue(venue: "paper"): Promise<FillRow[]> {
    void venue;
    return this.sql<FillRow[]>`SELECT * FROM fills WHERE venue IN (${"paper"}, ${"coinbase"}) ORDER BY traded_at ASC`;
  }

  async inferenceUsdForVenue(venue: "paper"): Promise<number> {
    const rows = await this.sql<{ s: number | null }[]>`
      SELECT SUM(d.inference_usd) AS s
      FROM decisions d
      JOIN runs r ON r.id = d.run_id
      WHERE r.venue = ${venue}
    `;
    return Number(rows[0]?.s ?? 0);
  }

  /** Latest cumulative gas per run, summed for the venue. */
  async lastGasUsdForVenue(venue: "paper"): Promise<number> {
    const rows = await this.sql<{ s: number | null }[]>`
      SELECT SUM(x.gas_usd) AS s FROM (
        SELECT DISTINCT ON (run_id) gas_usd
        FROM snapshots
        WHERE run_id IN (SELECT id FROM runs WHERE venue = ${venue})
        ORDER BY run_id, ts DESC
      ) x
    `;
    return Number(rows[0]?.s ?? 0);
  }

  /** Total inference cost across decisions, optionally scoped to one pair and/or one run. */
  async inferenceUsdTotal(pair?: string, runId?: string): Promise<number> {
    const rows = await this.sql<{ s: number | null }[]>`
      SELECT SUM(inference_usd) AS s FROM decisions
      WHERE (${pair ?? null}::text IS NULL OR pair = ${pair ?? null})
        AND (${runId ?? null}::text IS NULL OR run_id = ${runId ?? null})
    `;
    return Number(rows[0]?.s ?? 0);
  }

  /** Distinct pairs that have at least one decision. */
  async pairsWithData(): Promise<string[]> {
    const rows = await this.sql<{ pair: string }[]>`SELECT DISTINCT pair FROM decisions ORDER BY pair`;
    return rows.map((r) => r.pair);
  }

  /** Pairs that have a decision on the Coinbase paper book. */
  async pairsWithDataForVenue(venue: "paper"): Promise<string[]> {
    const rows = await this.sql<{ pair: string }[]>`
      SELECT DISTINCT d.pair
      FROM decisions d
      JOIN runs r ON r.id = d.run_id
      WHERE r.venue = ${venue}
      ORDER BY d.pair
    `;
    return rows.map((r) => r.pair);
  }

  async earliestUnresolvedTsForVenue(
    venue: "paper",
    horizonsSec: readonly number[],
    pairs?: readonly string[],
  ): Promise<Array<{ horizon_sec: number; ts: number | null }>> {
    const horizons = horizonsSec.map((h) => Number(h));
    if (pairs && pairs.length > 0) {
      const allowed = [...pairs];
      return this.sql`
        SELECT h.horizon_sec, MIN(d.ts) AS ts
        FROM unnest(${this.sql.array(horizons, "INTEGER")}::int[]) AS h(horizon_sec)
        LEFT JOIN decisions d
          ON d.run_id IN (SELECT id FROM runs WHERE venue = ${venue})
          AND d.pair IN ${this.sql(allowed)}
          AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.decision_id = d.id AND o.horizon_sec = h.horizon_sec)
        GROUP BY h.horizon_sec
        ORDER BY h.horizon_sec
      `;
    }
    return this.sql`
      SELECT h.horizon_sec, MIN(d.ts) AS ts
      FROM unnest(${this.sql.array(horizons, "INTEGER")}::int[]) AS h(horizon_sec)
      LEFT JOIN decisions d
        ON d.run_id IN (SELECT id FROM runs WHERE venue = ${venue})
        AND NOT EXISTS (SELECT 1 FROM outcomes o WHERE o.decision_id = d.id AND o.horizon_sec = h.horizon_sec)
      GROUP BY h.horizon_sec
      ORDER BY h.horizon_sec
    `;
  }

  async snapshotSeries(opts: { pair?: string; fromTs?: number } = {}): Promise<SnapshotRow[]> {
    const pair = opts.pair ?? "TOTAL";
    const fromTs = opts.fromTs ?? 0;
    return this.sql<SnapshotRow[]>`SELECT * FROM snapshots WHERE pair = ${pair} AND ts >= ${fromTs} ORDER BY ts ASC`;
  }

  /** Decisions for one pair, oldest first, including the gate stored on `state`. */
  async decisionsForPair(pair: string): Promise<Array<{ ts: number; action: "buy" | "sell"; traded: boolean; mid: number; state: unknown }>> {
    return this.sql`
      SELECT ts, action, traded, mid, state FROM decisions WHERE pair = ${pair} ORDER BY ts ASC
    `;
  }

  /** Fills with the order purpose and the decision that placed the order, oldest first. */
  async fillsWithPurpose(pair: string): Promise<Array<FillRow & { purpose: string | null; decision_id: string | null }>> {
    return this.sql`
      SELECT f.*, o.purpose AS purpose, o.decision_id AS decision_id
      FROM fills f
      LEFT JOIN orders o ON o.id = f.order_id
      WHERE f.pair = ${pair}
      ORDER BY f.traded_at ASC
    `;
  }

  /** Recent Coinbase fills with the order purpose (entry, exit, stop, take_profit). */
  async recentFillsJoined(limit = 50): Promise<Array<FillRow & { purpose: string | null }>> {
    return this.sql`
      SELECT f.*, o.purpose AS purpose
      FROM fills f
      LEFT JOIN orders o ON o.id = f.order_id
      WHERE f.venue IN ('paper', 'coinbase')
      ORDER BY f.traded_at DESC
      LIMIT ${limit}
    `;
  }

  async recentFills(opts: { pair?: string; limit?: number; venue?: "paper" } = {}): Promise<FillRow[]> {
    const limit = opts.limit ?? 50;
    const pair = opts.pair;
    const venues = opts.venue === "paper" ? (["paper", "coinbase"] as const) : null;
    if (venues && pair) {
      return this.sql<FillRow[]>`SELECT * FROM fills WHERE venue IN ${this.sql(venues)} AND pair = ${pair} ORDER BY traded_at DESC LIMIT ${limit}`;
    }
    if (venues) {
      return this.sql<FillRow[]>`SELECT * FROM fills WHERE venue IN ${this.sql(venues)} ORDER BY traded_at DESC LIMIT ${limit}`;
    }
    return pair
      ? this.sql<FillRow[]>`SELECT * FROM fills WHERE pair = ${pair} ORDER BY traded_at DESC LIMIT ${limit}`
      : this.sql<FillRow[]>`SELECT * FROM fills ORDER BY traded_at DESC LIMIT ${limit}`;
  }

  /** Every fill for a run, oldest first (the authoritative money record for the report). */
  async fillsForRun(runId: string): Promise<FillRow[]> {
    return this.sql<FillRow[]>`SELECT * FROM fills WHERE run_id = ${runId} ORDER BY traded_at ASC`;
  }

  /**
   * Wipe every paper-trading record: runs, decisions, outcomes, orders, fills, snapshots. Used by
   * the admin "clear paper trades" control to start a fresh campaign. Deliberately leaves `bars`
   * alone: it is a market-data cache (OHLC from the public feed), not trading state, and refilling
   * it from scratch would just cost the resolver a warm-up period for no benefit.
   */
  async resetAll(): Promise<void> {
    await this.sql`TRUNCATE TABLE fills, orders, outcomes, decisions, snapshots, runs`;
  }

  /** Wipe one venue's trading state. Leaves the other venue and `bars` alone. */
  async resetVenue(venue: "paper"): Promise<void> {
    await this.sql`DELETE FROM fills WHERE run_id IN (SELECT id FROM runs WHERE venue = ${venue}) OR venue = ${venue}`;
    await this.sql`DELETE FROM orders WHERE run_id IN (SELECT id FROM runs WHERE venue = ${venue})`;
    await this.sql`DELETE FROM outcomes WHERE decision_id IN (SELECT d.id FROM decisions d JOIN runs r ON r.id = d.run_id WHERE r.venue = ${venue})`;
    await this.sql`DELETE FROM decisions WHERE run_id IN (SELECT id FROM runs WHERE venue = ${venue})`;
    await this.sql`DELETE FROM snapshots WHERE run_id IN (SELECT id FROM runs WHERE venue = ${venue})`;
    await this.sql`DELETE FROM runs WHERE venue = ${venue}`;
  }
}
