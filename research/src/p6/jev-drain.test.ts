import { expect, test } from "bun:test";
import type { MarketState } from "../../../cb/state";
import { callBudgetMs, drainJevShadow, freshJevSkip, readJevAnswer, scheduleLiveJev, skipShareReport, type JevDrainHost } from "./jev-call";
import { JevTape } from "./jev-minute";
import { freshJevMeter } from "./jev-shadow";

const NOW = Date.parse("2026-10-14T18:00:00.000Z");

function state(): MarketState {
  return {
    pair: "ETH-USD",
    ts: NOW,
    horizonSec: 900,
    mid: 100,
    spreadBps: 1,
    spreadEmaBps: 1,
    imbalance5: 0,
    imbalance20: 0,
    volBps: 0,
    parkinsonBps: 0,
    emaGapBps: 0,
    emaCross: "flat",
    rsi: null,
    volumeDelta: 0,
    volumeGross: 0,
    returnsBps: { m5: 0, m30: 0, h1: 0, h4: 0, h24: 0 },
    feeBps: { maker: 0, taker: 0 },
    position: "flat",
  };
}

function host(): JevDrainHost & { calls: number } {
  const book = { jevPackets: 0, jevSkipped: 0, incidents: [] as string[], packets: [], positions: [{ productId: "ETH-USD" }] };
  const base: JevDrainHost & { calls: number } = {
    calls: 0,
    clock: () => NOW,
    kv: {},
    leaseToken: "held",
    jevMeter: freshJevMeter(),
    jevTape: new JevTape(),
    jevQueue: [],
    jevDone: new Set(),
    jevAnswers: [],
    jevSkip: freshJevSkip(),
    book,
  };
  base.jevSkip.byTier.major = { packets: 1, skipped: 0 };
  return base;
}

test("the drain is shadow only, idempotent, and priced before the call", async () => {
  const row = host();
  row.jevCaller = async () => {
    row.calls += 1;
    return { ok: true, answer: { market_regime: "balance", direction_bias: "flat", toxic_flow_risk: "low", liquidity_stress: "normal" }, costUsd: 0.01 };
  };
  row.jevQueue.push({ pair: "ETH-USD", barStartSec: 900, state: state(), minutes: [] });
  await drainJevShadow(row, NOW, NOW + 120_000);
  expect(row.calls).toBe(1);
  expect(row.jevMeter.cumulativeUsd).toBeCloseTo(0.01, 8);
  expect(row.jevMeter.calls).toBe(1);
  expect(row.jevMeter.todayUsd).toBeCloseTo(0.01, 8);
  expect(row.jevAnswers[0]?.reason).toBe("ok");
  expect(row.jevAnswers[0]?.answer?.liquidity_stress).toBe("normal");
  row.jevQueue.push({ pair: "ETH-USD", barStartSec: 900, state: state(), minutes: [] });
  await drainJevShadow(row, NOW, NOW + 120_000);
  expect(row.calls).toBe(1);
  const watcher = host();
  watcher.leaseToken = null;
  watcher.jevCaller = async () => {
    throw new Error("watcher must not call");
  };
  watcher.jevQueue.push({ pair: "ETH-USD", barStartSec: 900, state: state(), minutes: [] });
  await drainJevShadow(watcher, NOW, NOW + 120_000);
  expect(watcher.jevAnswers).toHaveLength(0);
});

test("timeout, not_called, call_error, and invalid_response are separate shares", async () => {
  expect(callBudgetMs(NOW, NOW + 60_000)).toBeLessThanOrEqual(0);
  const late = host();
  let called = false;
  late.jevCaller = async () => {
    called = true;
    return { ok: false, reason: "not_called" };
  };
  late.jevQueue.push({ pair: "ETH-USD", barStartSec: 1, state: state(), minutes: [] });
  await drainJevShadow(late, NOW, NOW + 60_000);
  expect(called).toBe(false);
  expect(late.book.jevSkipped).toBe(1);
  expect(late.jevAnswers[0]?.reason).toBe("timeout");

  const capped = host();
  capped.jevMeter = freshJevMeter(5);
  capped.jevCaller = async () => {
    throw new Error("cap must stop the call");
  };
  capped.jevQueue.push({ pair: "ETH-USD", barStartSec: 2, state: state(), minutes: [] });
  await drainJevShadow(capped, NOW, NOW + 120_000);
  expect(capped.jevAnswers[0]?.reason).toBe("not_called");

  const bad = host();
  bad.jevCaller = async () => {
    throw new Error("socket reset");
  };
  bad.jevQueue.push({ pair: "ETH-USD", barStartSec: 3, state: state(), minutes: [] });
  await drainJevShadow(bad, NOW, NOW + 120_000);
  expect(bad.jevAnswers[0]?.reason).toBe("call_error");
  expect(bad.book.incidents.join(" ")).not.toContain("socket reset");

  const invalid = host();
  invalid.jevCaller = async () => ({ ok: false, reason: "invalid_response" });
  invalid.jevQueue.push({ pair: "ETH-USD", barStartSec: 4, state: state(), minutes: [] });
  await drainJevShadow(invalid, NOW, NOW + 120_000);
  expect(invalid.jevMeter.cumulativeUsd).toBe(0);
  const shares = skipShareReport(invalid.jevSkip);
  expect(shares.byReason.invalid_response).toBe(1);
  expect(shares.byTier.major).toBe(1);
  expect(readJevAnswer({ market_regime: { choice: "trend" }, direction_bias: { choice: "flat" }, toxic_flow_risk: { choice: "low" }, liquidity_stress: { choice: "calm" } })).toBeNull();
  const unwired = host();
  unwired.jevCaller = undefined;
  unwired.jevQueue.push({ pair: "ETH-USD", barStartSec: 5, state: state(), minutes: [] });
  await drainJevShadow(unwired, NOW, NOW + 120_000);
  expect(unwired.jevAnswers[0]?.reason).toBe("not_called");
  expect(unwired.jevMeter.calls).toBe(0);
});

test("scheduling counts BTC even when the open pair is the only name with minutes", () => {
  const row = host();
  row.jevSkip = freshJevSkip();
  row.book.positions = [{ productId: "ETH-USD" }];
  const start = 1_700_000_040_000;
  row.clock = () => start + 15 * 60_000;
  for (let i = 0; i < 15; i += 1) {
    const at = start + i * 60_000 + 1_000;
    row.jevTape.heartbeat(at, ["ETH-USD"]);
    row.jevTape.onBook("ETH-USD", at + 500, { bids: new Map([["100", 2]]), asks: new Map([["101", 1]]) });
  }
  scheduleLiveJev(row, start / 1000);
  expect(row.book.jevPackets).toBe(2);
  expect(row.jevQueue.map((item) => item.pair)).toEqual(["ETH-USD"]);
  expect(row.book.incidents.some((line) => line.includes("no_1m_input BTC-USD") && line.includes("no_book_feed"))).toBe(true);
  const shares = skipShareReport(row.jevSkip);
  expect(shares.byReason.no_1m_input).toBe(0.5);
  expect(shares.byTier.btc).toBe(1);
  expect(shares.bySub.no_book_feed).toBe(0.5);
  expect(row.book.packets.every((packet) => packet.called === false)).toBe(true);
});
