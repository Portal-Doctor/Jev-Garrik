import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactStamp } from "../manifest";
import { minutesForChunk, parseCandlePayload, type MinuteRow } from "./candles";
import { writeJson } from "./io";
import { buildDataManifest, scanCandleFiles, writeDataManifest } from "./manifest-file";
import { candleFile, partialFile, unavailableFile } from "./paths";
import { candlesUrl, publicHeaders, type FetchLike } from "./public";
import type { UsdSpotProduct } from "./products";
import {
  openPartial,
  partialHasChunk,
  readPairMonth,
  readPartialMinutes,
  sha256File,
  writePairMonth,
  writePartialChunk,
  WRITER_VERSION,
  type PairMonthMeta,
} from "./store";
import { chunksForWindow, isoFromSec, MINUTE_SEC, monthWindows, windowForProduct, type ChunkWindow } from "./time";

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const ATTEMPTS = 6;

export interface DownloadSummary {
  completedMonths: number;
  requests: number;
  stopped: "finished" | "max-chunks" | "stop-file";
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
}): Promise<DownloadSummary> {
  const fetchImpl: FetchLike = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const nowMs = opts.nowMs ?? Date.now;
  const pace = createPacer(opts.intervalMs ?? 150, nowMs, sleep);
  const log = opts.log ?? ((message) => console.log(message));
  const listingSec = opts.listingSec ?? (() => null);
  let requests = 0;
  let completedMonths = 0;
  let fetchedChunks = 0;
  let manifestCreatedAt = opts.manifestCreatedAt;
  const products = opts.products.slice().sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));

  for (const product of products) {
    if (opts.stopFile && existsSync(opts.stopFile)) {
      return { completedMonths, requests, stopped: "stop-file" };
    }
    const blocked = join(opts.dataDir, unavailableFile(product.productId));
    if (existsSync(blocked)) continue;
    if (opts.only && ![...opts.only].some((key) => key.startsWith(`${product.productId}/`))) continue;
    const window = windowForProduct(opts.now, listingSec(product));
    let leavePair = false;
    for (const month of monthWindows(window.startSec, window.endSec)) {
      if (opts.stopFile && existsSync(opts.stopFile)) {
        return { completedMonths, requests, stopped: "stop-file" };
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
          if (opts.stopFile && existsSync(opts.stopFile)) {
            stop = "stop-file";
            break;
          }
          if (opts.maxChunks != null && fetchedChunks >= opts.maxChunks) {
            stop = "max-chunks";
            break;
          }
          const result = await fetchChunk(product.productId, chunk, fetchImpl, pace, sleep, log);
          requests += result.attempts;
          fetchedChunks += 1;
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
          if (fetchedChunks % 25 === 0) log(`chunks ${fetchedChunks} requests ${requests} ${product.productId} ${month.month}`);
        }
        if (!leavePair && !stop && chunks.every((chunk) => partialHasChunk(db, chunk.index))) {
          const rows = readPartialMinutes(db);
          const expected = (bounds.endSec - bounds.startSec) / MINUTE_SEC;
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
      if (stop) return { completedMonths, requests, stopped: stop };
      if (!finalized) continue;
      const meta: PairMonthMeta = {
        pair: product.productId,
        month: month.month,
        windowStart: isoFromSec(bounds.startSec),
        windowEnd: isoFromSec(bounds.endSec),
        granularitySec: "60",
        emptyPolicy: "recorded-not-filled",
        writerVersion: WRITER_VERSION,
      };
      writePairMonth(abs, meta, finalized);
      rmSync(partialPath, { force: true });
      const written = buildDataManifest({
        stamp: { ...opts.stamp, createdAt: new Date(nowMs()).toISOString() },
        files: scanCandleFiles(opts.dataDir),
        createdAt: manifestCreatedAt,
      });
      manifestCreatedAt = written.createdAt;
      writeDataManifest(opts.dataDir, written);
      completedMonths += 1;
      log(`stored ${rel} ${sha256File(abs)} root ${written.dataRootHash}`);
    }
  }
  return { completedMonths, requests, stopped: "finished" };
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

async function fetchChunk(
  pair: string,
  chunk: ChunkWindow,
  fetchImpl: FetchLike,
  pace: () => Promise<void>,
  sleep: (ms: number) => Promise<void>,
  log: (message: string) => void,
): Promise<{ status: number; rows: MinuteRow[]; attempts: number }> {
  const apiEnd = chunk.endSec - MINUTE_SEC;
  const url = candlesUrl(pair, chunk.startSec, apiEnd);
  let attempts = 0;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    await pace();
    attempts += 1;
    try {
      const res = await fetchImpl(url, { headers: publicHeaders() });
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
    const stored = readPairMonth(path);
    return stored.rows.length === (endSec - startSec) / MINUTE_SEC;
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
