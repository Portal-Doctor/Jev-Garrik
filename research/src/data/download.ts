import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStamp } from "../manifest";
import { minutesForChunk, parseCandlePayload, type MinuteRow } from "./candles";
import type { HashedFile } from "./hash";
import { writeJson } from "./io";
import { buildDataManifest, scanCandleFiles, writeDataManifest, type DataManifest } from "./manifest-file";
import { candleFile, partialFile, unavailableFile } from "./paths";
import { candlesUrl, publicHeaders, type FetchLike } from "./public";
import type { UsdSpotProduct } from "./products";
import {
  openPartial,
  partialHasChunk,
  minuteCount,
  readPartialMinutes,
  sha256File,
  writePairMonth,
  writePartialChunk,
  WRITER_VERSION,
  type PairMonthMeta,
} from "./store";
import { BAR_SEC, chunksForWindow, isoFromSec, monthWindows, windowForProduct, type ChunkWindow } from "./time";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const ATTEMPTS = 6;

export interface DownloadSummary {
  completedMonths: number;
  requests: number;
  stopped: "finished" | "max-chunks" | "stop-file" | "deadline";
}

export async function downloadUsdSpot(opts: {
  products: readonly UsdSpotProduct[];
  dataDir: string;
  now: Date;
  stamp: ArtifactStamp;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  intervalMs?: number;
  maxChunks?: number;
  /** When set, only these `productId/YYYY-MM` keys are fetched. */
  only?: ReadonlySet<string>;
  /** Exact windows for a revision re-download. Keys are `productId/YYYY-MM`. */
  ranges?: ReadonlyMap<string, { startSec: number; endSec: number }>;
  listingSec?: (product: UsdSpotProduct) => number | null;
  stopFile?: string;
  log?: (message: string) => void;
  manifestCreatedAt?: string;
  /** In-flight candle requests. The shared pacer still caps the start rate. */
  concurrency?: number;
  requestTimeoutMs?: number;
  deadlineMs?: number;
  snapshotLift?: DataManifest["snapshotLift"];
}): Promise<DownloadSummary> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowMs = opts.nowMs ?? Date.now;
  const intervalMs = opts.intervalMs ?? 100;
  const pace = createPacer(intervalMs, nowMs, sleep);
  const log = opts.log ?? ((message) => console.log(message));
  const listingSec = opts.listingSec ?? (() => null);
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  const timeoutMs = opts.requestTimeoutMs ?? 20_000;
  const state = {
    requests: 0,
    completedMonths: 0,
    fetchedChunks: 0,
    stop: null as DownloadSummary["stopped"] | null,
    manifestCreatedAt: opts.manifestCreatedAt,
  };
  const files = new Map<string, HashedFile>();
  for (const file of scanCandleFiles(opts.dataDir)) files.set(file.path, file);
  const products = opts.products.slice().sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
  const remainingChunks = countRemainingChunks(products, opts, listingSec);
  log(`resume products ${products.length} intervalMs ${intervalMs} concurrency ${concurrency} remainingChunks ${remainingChunks}`);

  await runPool(products, concurrency, async (product) => {
    if (state.stop) return;
    if (opts.stopFile && existsSync(opts.stopFile)) {
      state.stop = "stop-file";
      return;
    }
    const blocked = join(opts.dataDir, unavailableFile(product.productId));
    if (existsSync(blocked)) return;
    if (opts.only && ![...opts.only].some((key) => key.startsWith(`${product.productId}/`))) return;
    const window = windowForProduct(opts.now, listingSec(product));
    let leavePair = false;
    for (const month of monthWindows(window.startSec, window.endSec)) {
      if (state.stop) return;
      if (opts.stopFile && existsSync(opts.stopFile)) {
        state.stop = "stop-file";
        return;
      }
      const key = `${product.productId}/${month.month}`;
      if (opts.only && !opts.only.has(key)) continue;
      const bounds = opts.ranges?.get(key) ?? { startSec: month.startSec, endSec: month.endSec };
      const rel = candleFile(product.productId, month.month);
      const abs = join(opts.dataDir, rel);
      const partialPath = join(opts.dataDir, partialFile(product.productId, month.month));
      if (canonicalComplete(abs, bounds.startSec, bounds.endSec)) {
        rmSync(partialPath, { force: true });
        continue;
      }
      const db = openPartial(partialPath);
      let finalized: MinuteRow[] | null = null;
      let stop: DownloadSummary["stopped"] | null = null;
      try {
        const chunks = chunksForWindow(bounds.startSec, bounds.endSec);
        for (const chunk of chunks) {
          if (partialHasChunk(db, chunk.index)) continue;
          if (state.stop) {
            stop = state.stop;
            break;
          }
          if (opts.stopFile && existsSync(opts.stopFile)) {
            state.stop = "stop-file";
            stop = "stop-file";
            break;
          }
          if (opts.deadlineMs != null && Date.now() >= opts.deadlineMs) {
            state.stop = "deadline";
            stop = "deadline";
            break;
          }
          if (opts.maxChunks != null && state.fetchedChunks >= opts.maxChunks) {
            state.stop = "max-chunks";
            stop = "max-chunks";
            break;
          }
          state.fetchedChunks += 1;
          const chunkNo = state.fetchedChunks;
          const result = await fetchChunk(product.productId, chunk, fetchImpl, pace, sleep, log, timeoutMs);
          state.requests += result.attempts;
          if (result.status === 404) {
            writeJson(blocked, {
              productId: product.productId,
              httpStatus: 404,
              month: month.month,
              at: new Date(nowMs()).toISOString(),
            });
            leavePair = true;
            log(`unavailable ${product.productId} 404 at ${month.month}`);
            break;
          }
          writePartialChunk(db, chunk.index, result.rows);
          if (chunkNo % 25 === 0) log(`chunks ${chunkNo} requests ${state.requests} ${product.productId} ${month.month}`);
        }
        if (!leavePair && !stop && chunks.every((chunk) => partialHasChunk(db, chunk.index))) {
          const rows = readPartialMinutes(db);
          const expected = (bounds.endSec - bounds.startSec) / BAR_SEC;
          if (rows.length !== expected) throw new Error(`${rel} has ${rows.length} minutes, expected ${expected}`);
          finalized = rows;
        }
      } finally {
        db.close();
      }
      if (leavePair) {
        rmSync(partialPath, { force: true });
        break;
      }
      if (stop) return;
      if (!finalized) continue;
      const meta: PairMonthMeta = {
        pair: product.productId,
        month: month.month,
        windowStart: isoFromSec(bounds.startSec),
        windowEnd: isoFromSec(bounds.endSec),
        granularitySec: String(BAR_SEC),
        emptyPolicy: "recorded-not-filled",
        writerVersion: WRITER_VERSION,
      };
      writePairMonth(abs, meta, finalized);
      rmSync(partialPath, { force: true });
      const hashed: HashedFile = { path: rel, sha256: sha256File(abs), bytes: statSync(abs).size };
      files.set(rel, hashed);
      const written = buildDataManifest({
        stamp: { ...opts.stamp, createdAt: new Date(nowMs()).toISOString() },
        files: [...files.values()],
        createdAt: state.manifestCreatedAt,
        barSec: BAR_SEC,
        snapshotLift: opts.snapshotLift,
      });
      state.manifestCreatedAt = written.createdAt;
      writeDataManifest(opts.dataDir, written);
      state.completedMonths += 1;
      log(`stored ${rel} ${hashed.sha256} root ${written.dataRootHash}`);
    }
  });
  return { completedMonths: state.completedMonths, requests: state.requests, stopped: state.stop ?? "finished" };
}

export function createPacer(intervalMs: number, now: () => number, sleep: (ms: number) => Promise<void>): () => Promise<void> {
  let next = 0;
  return async () => {
    const t = now();
    const slot = Math.max(t, next);
    next = slot + intervalMs;
    if (slot > t) await sleep(slot - t);
  };
}

async function runPool<T>(items: readonly T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const width = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(
    Array.from({ length: width }, async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        const item = items[index];
        if (item === undefined) return;
        await worker(item);
      }
    }),
  );
}

function countRemainingChunks(
  products: readonly UsdSpotProduct[],
  opts: {
    dataDir: string;
    now: Date;
    only?: ReadonlySet<string>;
    ranges?: ReadonlyMap<string, { startSec: number; endSec: number }>;
  },
  listingSec: (product: UsdSpotProduct) => number | null,
): number {
  let remaining = 0;
  for (const product of products) {
    if (existsSync(join(opts.dataDir, unavailableFile(product.productId)))) continue;
    if (opts.only && ![...opts.only].some((key) => key.startsWith(`${product.productId}/`))) continue;
    const window = windowForProduct(opts.now, listingSec(product));
    for (const month of monthWindows(window.startSec, window.endSec)) {
      const key = `${product.productId}/${month.month}`;
      if (opts.only && !opts.only.has(key)) continue;
      const bounds = opts.ranges?.get(key) ?? { startSec: month.startSec, endSec: month.endSec };
      const abs = join(opts.dataDir, candleFile(product.productId, month.month));
      if (canonicalComplete(abs, bounds.startSec, bounds.endSec)) continue;
      remaining += chunksForWindow(bounds.startSec, bounds.endSec).length;
    }
  }
  return remaining;
}

async function fetchChunk(
  pair: string,
  chunk: ChunkWindow,
  fetchImpl: FetchLike,
  pace: () => Promise<void>,
  sleep: (ms: number) => Promise<void>,
  log: (message: string) => void,
  timeoutMs: number,
): Promise<{ status: number; rows: MinuteRow[]; attempts: number }> {
  const apiEnd = chunk.endSec - BAR_SEC;
  const url = candlesUrl(pair, chunk.startSec, apiEnd);
  let attempts = 0;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    await pace();
    attempts += 1;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetchImpl(url, { headers: publicHeaders(), signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 404) return { status: 404, rows: [], attempts };
      if (RETRYABLE.has(res.status)) {
        const wait = 500 * 2 ** attempt;
        log(`retry ${pair} ${res.status} in ${wait}ms`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`candles ${res.status}`);
      const candles = parseCandlePayload(await res.text());
      return { status: 200, rows: minutesForChunk(chunk.startSec, chunk.endSec, candles), attempts };
    } catch (err) {
      if (attempt === ATTEMPTS - 1) throw err;
      const wait = 500 * 2 ** attempt;
      const message = err instanceof Error ? err.message : String(err);
      log(`retry ${pair} ${message} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error(`candles failed ${pair} ${isoFromSec(chunk.startSec)}`);
}

function canonicalComplete(path: string, startSec: number, endSec: number): boolean {
  if (!existsSync(path)) return false;
  try {
    return minuteCount(path) === (endSec - startSec) / BAR_SEC;
  } catch {
    rmSync(path, { force: true });
    return false;
  }
}

export function readUnavailable(dataDir: string, pair: string): { httpStatus: number; month: string } | null {
  const path = join(dataDir, unavailableFile(pair));
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as { httpStatus: number; month: string };
}
