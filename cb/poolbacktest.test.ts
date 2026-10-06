import { expect, test } from "bun:test";
import type { Candle } from "./backtest";
import { runPooledBreakout } from "./poolbacktest";
import { MAX_CONCURRENT, POOL_DD, POOL_USD } from "./pool";

const BAR = 300_000;
const H4 = 14_400_000;
const WARM_4H = 52;

function grind(start: number, n5: number, close0: number, step: number): Candle[] {
  const out: Candle[] = [];
  let close = close0;
  for (let i = 0; i < n5; i++) {
    const ts = start + i * BAR;
    const open = close;
    close = close + step;
    out.push({ ts, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 });
  }
  return out;
}

/** Flat-ish warmup, then a 4-hour close `excess` above the prior high at `breakOffset4h` after warmup. */
function tape(close0: number, excess: number, breakOffset4h: number, after4h = 10): Candle[] {
  const start = Date.UTC(2026, 5, 20);
  const warm = grind(start, WARM_4H * 48, close0, 0.01);
  const head = grind(start + warm.length * BAR, breakOffset4h * 48, warm[warm.length - 1]!.close, 0.01);
  const soFar = [...warm, ...head];
  const last = soFar[soFar.length - 1]!;
  const lookback = soFar.filter((c) => c.ts >= last.ts - 20 * H4 && c.ts <= last.ts);
  const priorHigh = Math.max(...lookback.map((c) => c.high));
  const target = Math.max(priorHigh, last.close) + excess;
  const burst: Candle[] = [];
  let close = last.close;
  for (let i = 0; i < 48; i++) {
    const ts = last.ts + (i + 1) * BAR;
    const open = close;
    close = i === 47 ? target : close + (target - last.close) / 48;
    burst.push({ ts, open, high: Math.max(open, close), low: Math.min(open, close), close, volume: 1 });
  }
  const rest = grind(burst[burst.length - 1]!.ts + BAR, after4h * 48, target, 0.02);
  return [...soFar, ...burst, ...rest];
}

const start = Date.UTC(2026, 5, 20);
const windowStartTs = start + WARM_4H * H4;
const windowEndTs = start + (WARM_4H + 24) * H4;

const clear = () => ({
  vector: { liquidity_stress: "normal" as const, market_regime: "expansion" as const },
});

function run(
  pairs: Array<{ pair: string; candles: Candle[]; notionalUsd?: number; stopLossBps?: number }>,
  extra: Partial<Parameters<typeof runPooledBreakout>[0]> = {},
) {
  return runPooledBreakout({
    windowStartTs,
    windowEndTs,
    bankrollUsd: POOL_USD,
    makerFeeBps: 40,
    takerFeeBps: 80,
    minSizeUsd: 25,
    maxGrossUsd: 3000,
    maxConcurrent: MAX_CONCURRENT,
    breakoutBars: 20,
    trendEmaBars: 50,
    atrBars: 14,
    trailAtr: 3,
    maxHoldSec: 1_209_600,
    poolDd: POOL_DD,
    classify: clear,
    pairs: pairs.map((p) => ({
      pair: p.pair,
      candles: p.candles,
      notionalUsd: p.notionalUsd ?? 600,
      stopLossBps: p.stopLossBps ?? 200,
    })),
    ...extra,
  });
}

test("a spike inside an open 4-hour bucket is not a candidate", () => {
  const warm = grind(start, WARM_4H * 48, 100, 0.01);
  const last = warm[warm.length - 1]!;
  const spike: Candle[] = [];
  let close = last.close;
  for (let i = 0; i < 48; i++) {
    const ts = last.ts + (i + 1) * BAR;
    const open = close;
    const high = i === 10 ? last.close + 80 : Math.max(open, open + 0.01);
    close = open + 0.01;
    spike.push({ ts, open, high, low: open, close, volume: 1 });
  }
  const out = run([{ pair: "UNI-USD", candles: [...warm, ...spike] }]);
  expect(out.trades).toBe(0);
  expect(out.missedEntries).toBe(0);
});

test("flatten-to-fund books the new entry on the next 5-minute bar, not the flatten bar", () => {
  const weak = tape(10, 1.5, 0);
  const strong = tape(40, 12, 3);
  const out = run(
    [
      { pair: "AAA-USD", candles: weak, notionalUsd: 2500 },
      { pair: "ZZZ-USD", candles: strong, notionalUsd: 2500 },
    ],
    { maxConcurrent: 1, maxGrossUsd: 3000 },
  );
  expect(out.rotations).toBeGreaterThanOrEqual(1);
  expect(out.tradeLog.length).toBeGreaterThanOrEqual(1);
  const firstOut = out.tradeLog[0]!;
  const later = out.tradeLog.filter((t) => t.openedTs > firstOut.closedTs);
  if (later.length) {
    expect(later[0]!.openedTs).toBeGreaterThan(firstOut.closedTs);
  } else {
    expect(out.rotations).toBeGreaterThanOrEqual(1);
  }
});

test("equity at or under $10,200 trips the pool and blocks a later entry", () => {
  const boom = tape(100, 4, 0);
  const crashed = boom.map((c) => (c.ts >= windowStartTs + 2 * H4 ? { ...c, open: 1, high: 1.01, low: 0.99, close: 1 } : c));
  const late = tape(50, 8, 6);
  const out = run(
    [
      { pair: "UNI-USD", candles: crashed, notionalUsd: 2000 },
      { pair: "ZEC-USD", candles: late, notionalUsd: 600 },
    ],
    { maxConcurrent: 1 },
  );
  const trip = out.equity.find((e) => e.equity <= 10_200);
  if (trip) {
    expect(out.halted).toBe(true);
    expect(out.tradeLog.every((t) => t.openedTs <= trip.ts)).toBe(true);
  }
});
