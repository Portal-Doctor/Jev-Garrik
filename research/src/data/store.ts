import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { MinuteRow } from "./candles";

export const WRITER_VERSION = "1" as const;

export interface PairMonthMeta {
  pair: string;
  month: string;
  windowStart: string;
  windowEnd: string;
  granularitySec: string;
  emptyPolicy: "recorded-not-filled";
  writerVersion: typeof WRITER_VERSION;
}

interface MetaRow {
  key: string;
  value: string;
}

interface SqlMinute {
  minute_ts: number;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: string | null;
  empty: number;
}

const MINUTE_DDL = `
  minute_ts INTEGER PRIMARY KEY,
  open TEXT,
  high TEXT,
  low TEXT,
  close TEXT,
  volume TEXT,
  empty INTEGER NOT NULL
`;

/** Rewrite a pair-month file. Same rows and meta always produce the same bytes. */
export function writePairMonth(path: string, meta: PairMonthMeta, rows: readonly MinuteRow[]): void {
  rmSync(path, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec("PRAGMA page_size = 4096;");
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("CREATE TABLE file_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.exec(`CREATE TABLE minutes (${MINUTE_DDL}, CHECK (
      (empty = 1 AND open IS NULL AND high IS NULL AND low IS NULL AND close IS NULL AND volume IS NULL)
      OR
      (empty = 0 AND open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL AND volume IS NOT NULL)
    ));`);
    const metaRows: [string, string][] = [
      ["empty_policy", meta.emptyPolicy],
      ["granularity_sec", meta.granularitySec],
      ["month", meta.month],
      ["pair", meta.pair],
      ["window_end", meta.windowEnd],
      ["window_start", meta.windowStart],
      ["writer_version", meta.writerVersion],
    ];
    const insMeta = db.prepare("INSERT INTO file_meta (key, value) VALUES (?, ?)");
    const ins = db.prepare(
      "INSERT INTO minutes (minute_ts, open, high, low, close, volume, empty) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    const ordered = rows.slice().sort((a, b) => a.minuteSec - b.minuteSec);
    const tx = db.transaction(() => {
      for (const [key, value] of metaRows) insMeta.run(key, value);
      for (const row of ordered) {
        if (row.empty) ins.run(row.minuteSec, null, null, null, null, null, 1);
        else ins.run(row.minuteSec, row.open, row.high, row.low, row.close, row.volume, 0);
      }
    });
    tx();
    db.exec("VACUUM");
  } finally {
    db.close();
  }
}

export function readPairMonth(path: string): { meta: PairMonthMeta; rows: MinuteRow[] } {
  const db = new Database(path, { readonly: true });
  try {
    const metaRows = db.query("SELECT key, value FROM file_meta ORDER BY key").all() as MetaRow[];
    const metaMap = new Map(metaRows.map((row) => [row.key, row.value]));
    const meta: PairMonthMeta = {
      pair: required(metaMap, "pair"),
      month: required(metaMap, "month"),
      windowStart: required(metaMap, "window_start"),
      windowEnd: required(metaMap, "window_end"),
      granularitySec: required(metaMap, "granularity_sec"),
      emptyPolicy: "recorded-not-filled",
      writerVersion: WRITER_VERSION,
    };
    if (metaMap.get("writer_version") !== WRITER_VERSION) {
      throw new Error(`unexpected writer_version at ${path}`);
    }
    const sqlRows = db.query("SELECT minute_ts, open, high, low, close, volume, empty FROM minutes ORDER BY minute_ts").all() as SqlMinute[];
    return { meta, rows: sqlRows.map(toMinute) };
  } finally {
    db.close();
  }
}

export function minuteCount(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.query("SELECT COUNT(*) AS n FROM minutes").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

export function sha256File(path: string): string {
  const hash = createHash("sha256");
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      hash.update(buf.subarray(0, n));
    }
  } finally {
    closeSync(fd);
  }
  return hash.digest("hex");
}

export function openPartial(path: string): Database {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = DELETE;");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  db.exec(`CREATE TABLE IF NOT EXISTS minutes (${MINUTE_DDL});`);
  db.exec("CREATE TABLE IF NOT EXISTS chunks (chunk_index INTEGER PRIMARY KEY);");
  return db;
}

export function partialHasChunk(db: Database, index: number): boolean {
  const row = db.query("SELECT chunk_index FROM chunks WHERE chunk_index = ?").get(index) as { chunk_index: number } | null;
  return row != null;
}

export function writePartialChunk(db: Database, index: number, rows: readonly MinuteRow[]): void {
  const ins = db.prepare(
    "INSERT INTO minutes (minute_ts, open, high, low, close, volume, empty) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const mark = db.prepare("INSERT INTO chunks (chunk_index) VALUES (?)");
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (row.empty) ins.run(row.minuteSec, null, null, null, null, null, 1);
      else ins.run(row.minuteSec, row.open, row.high, row.low, row.close, row.volume, 0);
    }
    mark.run(index);
  });
  tx();
}

export function readPartialMinutes(db: Database): MinuteRow[] {
  const sqlRows = db.query("SELECT minute_ts, open, high, low, close, volume, empty FROM minutes ORDER BY minute_ts").all() as SqlMinute[];
  return sqlRows.map(toMinute);
}

function toMinute(row: SqlMinute): MinuteRow {
  return {
    minuteSec: row.minute_ts,
    empty: row.empty === 1,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
  };
}

function required(meta: Map<string, string>, key: string): string {
  const value = meta.get(key);
  if (value == null) throw new Error(`file_meta missing ${key}`);
  return value;
}
