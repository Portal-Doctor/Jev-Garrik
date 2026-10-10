/**
 * Public Coinbase 1-minute candles. No key, no order route.
 * Writes paperday/cache/candles/<pair>-1m.csv and a small coverage note.
 * Usage: bun run paperday/src/download-candles.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENABLED_PAIRS } from "./config";
import { fetchPublicCandles } from "./ingest";
import type { Candle } from "./bars";

const END_MS = Date.parse("2026-10-09T00:00:00.000Z");
const START_MS = Date.parse("2025-04-09T00:00:00.000Z");
const PHASE1_MS = Date.parse("2026-04-09T00:00:00.000Z");
const CHUNK_MS = 299 * 60_000;
const PAIRS = [...ENABLED_PAIRS, "BTC-USD"];
const cacheDir = join(import.meta.dir, "..", "cache", "candles");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let nextSlot = 0;
async function pace(): Promise<void> {
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + 90;
  if (slot > now) await sleep(slot - now);
}

async function fetchChunk(pair: string, fromMs: number, toMs: number): Promise<Candle[]> {
  for (let attempt = 0; attempt < 6; attempt++) {
    await pace();
    try {
      return await fetchPublicCandles(pair, fromMs, toMs, 60);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const wait = 500 * 2 ** attempt;
      console.error(`retry ${pair} ${new Date(fromMs).toISOString()} ${message} in ${wait}ms`);
      await sleep(wait);
    }
  }
  throw new Error(`candles failed ${pair} ${new Date(fromMs).toISOString()}`);
}

function chunkStarts(fromMs: number, toMs: number): number[] {
  const out: number[] = [];
  for (let cursor = fromMs; cursor < toMs; cursor += CHUNK_MS) out.push(cursor);
  return out;
}

function loadCsv(path: string): Map<number, Candle> {
  const out = new Map<number, Candle>();
  if (!existsSync(path)) return out;
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const [tsRaw, openRaw, highRaw, lowRaw, closeRaw, volRaw] = line.split(",");
    let ts = Number(tsRaw);
    if (ts > 0 && ts < 1e12) ts *= 1000;
    const close = Number(closeRaw);
    if (!Number.isFinite(ts) || !(close > 0)) continue;
    out.set(ts, {
      ts,
      open: Number(openRaw),
      high: Number(highRaw),
      low: Number(lowRaw),
      close,
      volume: Number(volRaw),
    });
  }
  return out;
}

function writeCsv(path: string, bars: Map<number, Candle>): void {
  const ordered = [...bars.values()].sort((a, b) => a.ts - b.ts);
  const lines = ordered.map((b) => `${b.ts},${b.open},${b.high},${b.low},${b.close},${b.volume}`);
  writeFileSync(path, `${lines.join("\n")}\n`);
}

async function fillPair(pair: string, fromMs: number, toMs: number): Promise<{ bars: number; first: string | null; last: string | null }> {
  const path = join(cacheDir, `${pair}-1m.csv`);
  const donePath = join(cacheDir, `${pair}.chunks.json`);
  const bars = loadCsv(path);
  const done = new Set<number>(existsSync(donePath) ? (JSON.parse(readFileSync(donePath, "utf8")) as number[]) : []);
  const starts = chunkStarts(fromMs, toMs).filter((start) => !done.has(start));
  let finished = 0;
  const pending: number[] = [];
  const queue = starts.slice();
  async function worker(): Promise<void> {
    for (;;) {
      const start = queue.shift();
      if (start == null) return;
      const end = Math.min(toMs, start + CHUNK_MS);
      const chunk = await fetchChunk(pair, start, end);
      for (const bar of chunk) {
        if (bar.ts >= fromMs && bar.ts < toMs) bars.set(bar.ts, bar);
      }
      pending.push(start);
      finished += 1;
      if (pending.length >= 40) {
        writeCsv(path, bars);
        for (const ts of pending) done.add(ts);
        pending.length = 0;
        writeFileSync(donePath, JSON.stringify([...done]));
        console.log(`${pair} chunks ${finished}/${starts.length} bars ${bars.size}`);
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  for (const ts of pending) done.add(ts);
  writeCsv(path, bars);
  writeFileSync(donePath, JSON.stringify([...done]));
  const ordered = [...bars.keys()].sort((a, b) => a - b);
  const first = ordered.find((ts) => ts >= fromMs);
  const last = ordered.filter((ts) => ts < toMs).pop();
  return {
    bars: ordered.filter((ts) => ts >= fromMs && ts < toMs).length,
    first: first == null ? null : new Date(first).toISOString(),
    last: last == null ? null : new Date(last).toISOString(),
  };
}

mkdirSync(cacheDir, { recursive: true });
const coverage: Record<string, { bars: number; first: string | null; last: string | null }> = {};
for (const pair of PAIRS) {
  console.log(`download ${pair}`, new Date().toISOString());
  coverage[pair] = await fillPair(pair, START_MS, END_MS);
  console.log(`done ${pair}`, JSON.stringify(coverage[pair]));
  writeFileSync(join(cacheDir, "coverage.json"), JSON.stringify({ start: new Date(START_MS).toISOString(), end: new Date(END_MS).toISOString(), phase1: new Date(PHASE1_MS).toISOString(), pairs: coverage }, null, 2));
}
console.log("download complete");
