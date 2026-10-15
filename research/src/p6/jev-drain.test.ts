import { expect, test } from "bun:test";
import type { MarketState } from "../../../cb/state";
import { callBudgetMs, drainJevShadow, freshJevSkip, readJevAnswer, scheduleClosedJevBar, scheduleLiveJev, skipShareReport, type JevCallOutcome, type JevDrainHost } from "./jev-call";
import { captureHot, loadSplit } from "./hot-store";
import { JevTape } from "./jev-minute";
import { capturePaperState, installPaperState, startPaperHost } from "./paper-host";
import { HOT_KEY, memoryKv } from "./relay";
import { freshJevMeter, JEV_CALL_RESERVE_USD, noteJevSpend, type JevMeter } from "./jev-shadow";

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

const ANSWER = { market_regime: "balance", direction_bias: "flat", toxic_flow_risk: "low", liquidity_stress: "normal" } as const;

/** Cumulative room for exactly one reserve. A second hold does not fit. */
function roomForOneReserve(): JevMeter {
  const month = "2026-10";
  let meter: JevMeter = { ...freshJevMeter(0), month, monthUsd: 0 };
  for (;;) {
    const once = noteJevSpend(meter, JEV_CALL_RESERVE_USD, month);
    try {
      noteJevSpend(once, JEV_CALL_RESERVE_USD, month);
      meter = once;
    } catch {
      return { ...meter, calls: 0, today: "", todayUsd: 0 };
    }
  }
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
    return { ok: true, answer: ANSWER, costUsd: 0.01 };
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
  expect(late.jevMeter.cumulativeUsd).toBe(0);

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
  expect(bad.jevAnswers[0]?.costUsd).toBe(0);
  expect(bad.jevMeter.cumulativeUsd).toBe(0);
  expect(bad.jevMeter.calls).toBe(0);
  expect(bad.book.incidents.join(" ")).not.toContain("socket reset");

  const invalid = host();
  invalid.jevCaller = async () => ({ ok: false, reason: "invalid_response" });
  invalid.jevQueue.push({ pair: "ETH-USD", barStartSec: 4, state: state(), minutes: [] });
  await drainJevShadow(invalid, NOW, NOW + 120_000);
  expect(invalid.jevMeter.cumulativeUsd).toBeCloseTo(JEV_CALL_RESERVE_USD, 8);
  expect(invalid.jevMeter.calls).toBe(0);
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

test("a not_called caller refunds the hold and leaves the cap intact", async () => {
  const previous = process.env.TYPESAFE_AI_API_KEY;
  delete process.env.TYPESAFE_AI_API_KEY;
  try {
    const row = host();
    row.jevCaller = async () => {
      if (!process.env.TYPESAFE_AI_API_KEY) return { ok: false, reason: "not_called" };
      throw new Error("the key must stay unset");
    };
    for (let i = 0; i < 120; i += 1) {
      row.jevQueue.push({ pair: "ETH-USD", barStartSec: 100 + i, state: state(), minutes: [] });
    }
    for (let i = 0; i < 120; i += 1) await drainJevShadow(row, NOW, NOW + 120_000);
    expect(row.jevSkip.byReason.not_called).toBe(120);
    expect(row.book.jevSkipped).toBe(120);
    expect(row.jevAnswers.every((item) => item.reason === "not_called" && item.costUsd === 0)).toBe(true);
    expect(row.jevMeter.cumulativeUsd).toBe(0);
    expect(row.jevMeter.calls).toBe(0);
    row.jevCaller = async () => ({ ok: true, answer: ANSWER, costUsd: 0.01 });
    row.jevQueue.push({ pair: "ETH-USD", barStartSec: 300, state: state(), minutes: [] });
    await drainJevShadow(row, NOW, NOW + 120_000);
    expect(row.jevAnswers[row.jevAnswers.length - 1]?.reason).toBe("ok");
    expect(row.jevMeter.calls).toBe(1);
    expect(row.jevMeter.cumulativeUsd).toBeCloseTo(0.01, 8);
    expect(row.jevMeter.capUsd - row.jevMeter.cumulativeUsd).toBeGreaterThan(4);
  } finally {
    if (previous === undefined) delete process.env.TYPESAFE_AI_API_KEY;
    else process.env.TYPESAFE_AI_API_KEY = previous;
  }
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

test("a priced failure settles to its cost and an unpriced timeout keeps the hold", async () => {
  const priced = host();
  priced.jevCaller = async () => ({ ok: false, reason: "invalid_response", costUsd: 0.02 });
  priced.jevQueue.push({ pair: "ETH-USD", barStartSec: 6, state: state(), minutes: [] });
  await drainJevShadow(priced, NOW, NOW + 120_000);
  expect(priced.jevMeter.cumulativeUsd).toBeCloseTo(0.02, 8);
  expect(priced.jevMeter.calls).toBe(0);
  expect(priced.jevAnswers[0]?.costUsd).toBeCloseTo(0.02, 8);

  const hung = host();
  hung.jevCaller = () => new Promise<JevCallOutcome>(() => {});
  hung.jevQueue.push({ pair: "ETH-USD", barStartSec: 7, state: state(), minutes: [] });
  await drainJevShadow(hung, NOW, NOW + 60_000 + 30);
  expect(hung.jevAnswers[0]?.reason).toBe("timeout");
  expect(hung.jevMeter.cumulativeUsd).toBeCloseTo(JEV_CALL_RESERVE_USD, 8);
  expect(hung.jevMeter.calls).toBe(0);
});

test("two drains cannot both pass the cap, and a kept hold blocks the next call", async () => {
  const tight = host();
  tight.jevMeter = roomForOneReserve();
  let started = 0;
  let release: (value: JevCallOutcome) => void = () => {};
  tight.jevCaller = () => {
    started += 1;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  tight.jevQueue.push({ pair: "ETH-USD", barStartSec: 8, state: state(), minutes: [] });
  tight.jevQueue.push({ pair: "ETH-USD", barStartSec: 9, state: state(), minutes: [] });
  const first = drainJevShadow(tight, NOW, NOW + 120_000);
  const second = drainJevShadow(tight, NOW, NOW + 120_000);
  await Promise.resolve();
  expect(started).toBe(1);
  expect(tight.jevAnswers.some((row) => row.reason === "not_called")).toBe(true);
  release({ ok: true, answer: ANSWER, costUsd: 0.01 });
  await first;
  await second;
  expect(started).toBe(1);
  expect(tight.jevMeter.calls).toBe(1);

  const over = host();
  over.jevMeter = roomForOneReserve();
  over.jevCaller = async () => ({ ok: true, answer: ANSWER, costUsd: JEV_CALL_RESERVE_USD + 1 });
  over.jevQueue.push({ pair: "ETH-USD", barStartSec: 10, state: state(), minutes: [] });
  over.jevQueue.push({ pair: "ETH-USD", barStartSec: 11, state: state(), minutes: [] });
  await drainJevShadow(over, NOW, NOW + 120_000);
  expect(over.jevAnswers[0]?.reason).toBe("call_error");
  expect(over.jevMeter.calls).toBe(0);
  const before = over.jevMeter.cumulativeUsd;
  await drainJevShadow(over, NOW, NOW + 120_000);
  expect(over.jevAnswers[1]?.reason).toBe("not_called");
  expect(over.jevMeter.cumulativeUsd).toBeCloseTo(before, 8);
});

test("overlapping calls each settle to the real cost", async () => {
  const row = host();
  const waiting: Array<(value: JevCallOutcome) => void> = [];
  row.jevCaller = () => new Promise((resolve) => waiting.push(resolve));
  row.jevQueue.push({ pair: "ETH-USD", barStartSec: 12, state: state(), minutes: [] });
  row.jevQueue.push({ pair: "ETH-USD", barStartSec: 13, state: state(), minutes: [] });
  const first = drainJevShadow(row, NOW, NOW + 120_000);
  const second = drainJevShadow(row, NOW, NOW + 120_000);
  await Promise.resolve();
  expect(waiting).toHaveLength(2);
  expect(row.jevMeter.cumulativeUsd).toBeCloseTo(JEV_CALL_RESERVE_USD * 2, 8);
  for (const go of waiting) go({ ok: true, answer: ANSWER, costUsd: 0.01 });
  await first;
  await second;
  expect(row.jevMeter.cumulativeUsd).toBeCloseTo(0.02, 8);
  expect(row.jevMeter.calls).toBe(2);
  expect(row.jevMeter.todayUsd).toBeCloseTo(0.02, 8);
});

test("a queued packet survives handover and a late bar is only the latest completed window", async () => {
  const bar = 1_700_000_100;
  const late = (bar + 900 + 500) * 1000;
  expect(scheduleClosedJevBar(bar, late)).toBe(true);
  expect(scheduleClosedJevBar(bar - 900, late)).toBe(false);
  expect(scheduleClosedJevBar(bar, bar * 1000)).toBe(false);

  const host = startPaperHost(["ETH-USD"], {});
  host.clock = () => NOW;
  host.kv = memoryKv();
  host.leaseToken = "held";
  host.jevCaller = async () => ({ ok: true, answer: ANSWER, costUsd: 0.01 });
  for (const barStartSec of [21, 22, 23]) {
    host.jevQueue.push({ pair: "ETH-USD", barStartSec, state: state(), minutes: [] });
  }
  await drainJevShadow(host, NOW, NOW + 120_000);
  expect(host.jevAnswers).toHaveLength(1);
  expect(host.jevQueue).toHaveLength(2);

  const next = startPaperHost(["ETH-USD"], {});
  next.clock = () => NOW;
  next.kv = memoryKv();
  next.leaseToken = "held";
  next.jevCaller = async () => ({ ok: true, answer: ANSWER, costUsd: 0.01 });
  installPaperState(next, capturePaperState(host));
  expect(next.jevQueue.map((row) => row.barStartSec)).toEqual([22, 23]);
  expect(next.jevDone.has("ETH-USD:21")).toBe(true);
  expect(next.jevTape.assess("ETH-USD", NOW).ok).toBe(false);

  const kv = memoryKv();
  await kv.set(HOT_KEY, JSON.stringify(captureHot(host)));
  const again = startPaperHost(["ETH-USD"], {});
  again.clock = () => NOW;
  const loaded = await loadSplit(kv, again);
  installPaperState(again, loaded!);
  expect(again.jevQueue.map((row) => row.barStartSec)).toEqual([22, 23]);
  again.kv = memoryKv();
  again.leaseToken = "held";
  again.jevCaller = async () => ({ ok: true, answer: ANSWER, costUsd: 0.01 });
  await drainJevShadow(again, NOW, NOW + 120_000);
  await drainJevShadow(again, NOW, NOW + 120_000);
  expect(again.jevQueue).toHaveLength(0);
  expect(again.jevAnswers.map((row) => row.barStartSec).sort((a, b) => a - b)).toEqual([21, 22, 23]);
  expect(again.jevAnswers.every((row) => row.reason === "ok")).toBe(true);
});
