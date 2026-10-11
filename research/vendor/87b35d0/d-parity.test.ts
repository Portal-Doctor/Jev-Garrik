/**
 * Calls 87b35d0 runSwing4h (geometry only, 1.5× ATR) on the same bars as classDCandidates.
 * The vendored file stays byte-identical. A scratch copy adds one sink after `qualified += 1`.
 * targetR 4 must match. targetR 3 must not.
 */

import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { aggregate, type Candle } from "./bars.ts";
import { classDCandidates } from "../../src/p3/d-geometry.ts";

interface SinkRow {
  pair: string;
  barTs: number;
  setup: string;
  entry: number;
  stop: number;
  target: number;
}

function candles(): Candle[] {
  const out: Candle[] = [];
  const origin = Date.parse("2024-01-01T00:00:00.000Z");
  for (let day = 0; day < 260; day++) {
    for (let slot = 0; slot < 6; slot++) {
      const ts = origin + (day * 6 + slot) * 14_400_000;
      const accel = day > 200 ? (day - 200) * 0.08 : 0;
      const close = 100 + day * 0.02 + accel + Math.sin(slot / 1.5) * 0.8;
      out.push({ ts, open: close - 0.2, high: close + 0.4, low: close - 1.5, close, volume: 20 });
    }
  }
  return out;
}

test("runSwing4h at 4R matches class D, and 3R does not", async () => {
  const m1 = candles();
  const toMs = m1[m1.length - 1]!.ts + 5 * 86_400_000;
  const h4 = aggregate(m1, 14_400_000, toMs);
  const d1 = aggregate(m1, 86_400_000, toMs);
  const ours = classDCandidates("SYN-USD", h4, d1).map((row) => ({
    barTs: row.barTs,
    setup: row.setup,
    entry: row.entry,
    stop: row.stop,
    target: row.target,
  }));
  expect(ours.length).toBeGreaterThan(0);

  const beside = join(import.meta.dir, `swing4h.parity-sink-${process.pid}.ts`);
  const source = readFileSync(new URL("./swing4h.ts", import.meta.url), "utf8");
  const patched = source.replace(
    "qualified += 1;",
    "qualified += 1;\n      globalThis.__dParitySink?.push({ pair: series.pair, barTs: snap.barTs, setup: setup.setup, entry: setup.entry, stop: geom.stop, target: targetPx });",
  );
  if (patched === source) throw new Error("qualified += 1 anchor missing");
  writeFileSync(beside, patched);
  try {
    const loaded = await import(pathToFileURL(beside).href);
    const run = loaded.runSwing4h as (opts: Record<string, unknown>) => Promise<{ qualified: number }>;
    const base = {
      candles: { "SYN-USD": m1 },
      fromMs: 0,
      toMs,
      mode: "POOL",
      formula: "equal",
      strategy: "swing_4h",
      sentimentMode: "sentiment_blind",
      proxy: null,
      swingApproved: true,
      enabledPairs: ["SYN-USD"],
      variant: "jev_off",
      stopAtrMult: 1.5,
      geometryOnly: true,
    };
    const capture = async (targetR: number): Promise<SinkRow[]> => {
      const rows: SinkRow[] = [];
      (globalThis as { __dParitySink?: SinkRow[] }).__dParitySink = rows;
      const result = await run({ ...base, targetR });
      expect(result.qualified).toBe(rows.length);
      return rows;
    };
    const at4 = await capture(4);
    const at3 = await capture(3);
    const norm = (rows: readonly { barTs: number; setup: string; entry: number; stop: number; target: number }[], closeTs: boolean) =>
      rows
        .map((row) => ({
          barTs: closeTs ? row.barTs : row.barTs + 14_400_000,
          setup: row.setup,
          entry: row.entry,
          stop: row.stop,
          target: row.target,
        }))
        .sort((a, b) => a.barTs - b.barTs || (a.setup < b.setup ? -1 : 1));
    const left = norm(ours, true);
    const right = norm(at4, false);
    expect(right).toEqual(left);
    const three = norm(at3, false);
    expect(three).not.toEqual(left);
    expect(at4.length).toBe(ours.length);
    const sameTarget = three.filter((row) => left.some((item) => item.barTs === row.barTs && item.setup === row.setup && item.entry === row.entry && item.stop === row.stop && item.target === row.target)).length;
    expect(sameTarget).toBe(0);
  } finally {
    rmSync(beside, { force: true });
  }
});
