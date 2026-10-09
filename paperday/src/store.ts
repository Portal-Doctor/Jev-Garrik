/**
 * Append-only idempotent store. Memory implementation is the test and backtest path.
 * Postgres is the home-PC database; see schema.sql. A second put of the same key is a no-op.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const TABLES = [
  "bars",
  "indicator_snapshots",
  "bias_checks",
  "sentiment_checks",
  "candidates",
  "jev_reviews",
  "override_checks",
  "allocations",
  "ideas",
  "paper_fills",
  "outcomes",
  "backtest_runs",
  "jev_scorecard",
  "daily_summary",
  "quarter_tracker",
  "run_manifest",
] as const;

export type TableName = (typeof TABLES)[number];

export interface PutResult {
  inserted: boolean;
}

export class MemoryStore {
  readonly rows = new Map<TableName, Array<Record<string, unknown>>>();
  private seen = new Set<string>();
  readonly jsonlPath: string | null;
  /** Backtests turn this off so rejected candidates do not accumulate rows. */
  retain = true;

  constructor(jsonlPath: string | null = null) {
    this.jsonlPath = jsonlPath;
    for (const t of TABLES) this.rows.set(t, []);
  }

  put(table: TableName, key: string, row: Record<string, unknown>): PutResult {
    if (!this.retain) return { inserted: true };
    const id = `${table}|${key}`;
    if (this.seen.has(id)) return { inserted: false };
    this.seen.add(id);
    const stored = { ...row, _key: key };
    this.rows.get(table)!.push(stored);
    if (this.jsonlPath) {
      mkdirSync(dirname(this.jsonlPath), { recursive: true });
      appendFileSync(this.jsonlPath, JSON.stringify({ table, key, row }) + "\n");
    }
    return { inserted: true };
  }

  count(table: TableName): number {
    return this.rows.get(table)!.length;
  }

  get(table: TableName, key: string): Record<string, unknown> | undefined {
    return this.rows.get(table)!.find((r) => r._key === key);
  }
}
