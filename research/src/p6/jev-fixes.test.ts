import { expect, test } from "bun:test";
import type { MarketState } from "../../../cb/state";
import {
  boundJevDone,
  drainJevShadow,
  freshJevSkip,
  guardEffectScore,
  noteLatency,
  JEV_DONE_BARS,
  JEV_EXPIRY_SEC,
  JEV_PACKET_TTL_MS,
  jevAnswerKey,
  packetExpired,
  skipShareReport,
  type JevCallOutcome,
} from "./jev-call";
import { captureHot, HOT_MAX_BYTES, HOT_WARN_BYTES, hotSnapshot, persistSplit } from "./hot-store";
import { handoverMinuteOk, JEV_MINUTE_MS, JEV_SCHEMA, JevTape, type StoredJevMinute } from "./jev-minute";
import { capturePaperState, installPaperState, startPaperHost, type PaperHost } from "./paper-host";
import { LEASE_KEY, memoryKv } from "./relay";

const NOW = Date.parse("2026-10-16T12:00:00.000Z");
const T = NOW;
const ANSWER = { market_regime: "balance", direction_bias: "flat", toxic_flow_risk: "low", liquidity_stress: "normal" } as const;

function state(mid = 100): MarketState {
  return {
    pair: "NEAR-USD",
    ts: NOW,
    horizonSec: 900,
    mid,
    spreadBps: 1,
    spreadEmaBps: 1,
    imbalance5: 0,
    imbalance20: 0,
    volBps: 1,
    parkinsonBps: 1,
    emaGapBps: 0,
    emaCross: 0,
    rsi: 50,
    volumeDelta: 0,
    volumeGross: 1,
    returnsBps: { m5: 0, m30: 0, h1: 0, h4: 0 },
    position: "flat",
    feeBps: { maker: 0, taker: 0 },
  } as unknown as MarketState;
}

function row(over: Partial<StoredJevMinute> = {}): StoredJevMinute {
  return {
    productId: "NEAR-USD",
    ts: T,
    takerBuyUsd: 1,
    takerSellUsd: 0,
    trades: 1,
    midClose: 50,
    midHigh: 51,
    midLow: 49,
    spreadBps: 2,
    imbalance5: 0.1,
    imbalance20: 0.2,
    carried: false,
    live: true,
    schema: JEV_SCHEMA,
    src: "live",
    holder: "holder-a",
    sealedAtMs: T + JEV_MINUTE_MS,
    leaseFromMs: T - 1_000,
    leaseUntilMs: T + JEV_MINUTE_MS,
    ...over,
  };
}

function hold(host: PaperHost, token = "token-a", holder = "holder-a"): void {
  host.leaseToken = token;
  host.holderId = holder;
  host.leaseFromMs = T - 60_000;
  host.leaseUntilMs = NOW + 600_000;
}

async function plantLease(kv: ReturnType<typeof memoryKv>, token: string, holder: string): Promise<void> {
  await kv.set(LEASE_KEY, JSON.stringify({ holder, untilMs: NOW + 600_000, token, release: "none", acquiredAtMs: T - 60_000 }));
}

test("a handover minute that meets every condition is present", () => {
  const tape = new JevTape();
  const imported = tape.importMinutes([row()]);
  expect(imported).toBe(1);
  expect(tape.handoverMinutes).toBe(1);
  const window = tape.assess("NEAR-USD", T);
  expect(window.minutes).toHaveLength(1);
  expect(tape.exportMinutes()[0]?.src).toBe("handover");
  expect(tape.exportMinutes()[0]?.live).toBe(true);
  expect(tape.exportMinutes()[0]?.holder).toBe("holder-a");
});

test("an imported minute stays absent when any one condition fails", () => {
  const cases: Partial<StoredJevMinute>[] = [
    { schema: "jev-1m-v2.1" },
    { productId: "SUI-USD" },
    { ts: T + 1 },
    { sealedAtMs: T + JEV_MINUTE_MS - 1 },
    { sealedAtMs: T + JEV_MINUTE_MS + 5_000, leaseUntilMs: T + JEV_MINUTE_MS + 1 },
    { leaseFromMs: T + 1 },
    { holder: "" },
    { backfilled: true },
    { src: "backfill" },
    { src: "gap" },
  ];
  for (const over of cases) {
    const tape = new JevTape();
    const sample = row(over);
    expect(handoverMinuteOk(sample, over.productId === "SUI-USD" ? "NEAR-USD" : undefined)).toBe(false);
    const n = tape.importMinutes([sample], over.productId === "SUI-USD" ? { productId: "NEAR-USD" } : undefined);
    expect(n).toBe(0);
    expect(tape.assess("NEAR-USD", T).minutes).toHaveLength(0);
    expect(tape.exportMinutes().every((item) => item.live === false)).toBe(true);
  }
});

test("when both holders have a row for T, the holder who covered the minute wins once", () => {
  const tape = new JevTape();
  tape.importMinutes([row({ holder: "holder-a" })]);
  const again = tape.importMinutes([row({ holder: "holder-b", leaseFromMs: T + 10 })]);
  expect(again).toBe(0);
  expect(tape.exportMinutes()).toHaveLength(1);
  expect(tape.exportMinutes()[0]?.holder).toBe("holder-a");

  const replaced = new JevTape();
  replaced.importMinutes([row({ holder: "early", leaseFromMs: T + 5_000, schema: "nope" })]);
  const won = replaced.importMinutes([row({ holder: "holder-b" })]);
  expect(won).toBe(1);
  expect(replaced.exportMinutes()).toHaveLength(1);
  expect(replaced.exportMinutes()[0]?.holder).toBe("holder-b");
  expect(replaced.assess("NEAR-USD", T).minutes).toHaveLength(1);
});

test("a queued packet crosses holders once and a stored answer is not called again", async () => {
  let calls = 0;
  const caller = async (): Promise<JevCallOutcome> => {
    calls += 1;
    return { ok: true, answer: ANSWER, costUsd: 0.01, tokens: 12 };
  };
  const bar = Math.floor(NOW / 1000) - 1_000;
  const a = startPaperHost(["NEAR-USD"], {});
  a.clock = () => NOW;
  hold(a);
  a.kv = memoryKv(() => NOW);
  await plantLease(a.kv, "token-a", "holder-a");
  a.jevCaller = caller;
  a.jevQueue.push({ pair: "NEAR-USD", barStartSec: bar, state: state(), minutes: [] });
  await persistSplit(a.kv, a);
  const stored = JSON.parse((await a.kv.get("p6:hot")) ?? "{}") as { jevQueue?: { barStartSec: number }[] };
  expect(stored.jevQueue?.map((item) => item.barStartSec)).toEqual([bar]);

  const b = startPaperHost(["NEAR-USD"], {});
  b.clock = () => NOW;
  hold(b, "token-a", "holder-b");
  b.kv = a.kv;
  const saved = capturePaperState(a);
  installPaperState(b, saved);
  b.jevCaller = caller;
  await drainJevShadow(b, NOW, NOW + 120_000);
  expect(calls).toBe(1);
  await drainJevShadow(b, NOW, NOW + 120_000);
  expect(calls).toBe(1);
  expect(b.jevDone.has(`NEAR-USD:${bar}`)).toBe(true);

  const again = startPaperHost(["NEAR-USD"], {});
  again.clock = () => NOW;
  hold(again, "token-a", "holder-c");
  again.kv = a.kv;
  await persistSplit(b.kv!, b);
  const loaded = captureHot(b);
  await again.kv.set("p6:hot", JSON.stringify(loaded));
  again.jevCaller = caller;
  again.jevQueue.push({ pair: "NEAR-USD", barStartSec: bar, state: state(), minutes: [] });
  await drainJevShadow(again, NOW, NOW + 120_000);
  expect(calls).toBe(1);
  expect(await again.kv.get(jevAnswerKey("NEAR-USD", bar))).not.toBeNull();
});

test("an uncalled packet at barStartSec+1500 is a counted timeout and a tight budget stays queued", async () => {
  const bar = Math.floor(NOW / 1000) - JEV_EXPIRY_SEC;
  expect(packetExpired(bar, NOW)).toBe(true);
  const host = startPaperHost(["NEAR-USD"], {});
  host.clock = () => NOW;
  hold(host);
  let calls = 0;
  host.jevCaller = async () => {
    calls += 1;
    return { ok: true, answer: ANSWER, costUsd: 0.01 };
  };
  host.jevQueue.push({ pair: "NEAR-USD", barStartSec: bar, state: state(), minutes: [] });
  host.jevSkip = freshJevSkip();
  host.jevSkip.byTier.other = { packets: 1, skipped: 0 };
  await drainJevShadow(host, NOW, NOW + 120_000);
  expect(calls).toBe(0);
  expect(host.jevQueue).toHaveLength(0);
  expect(host.jevAnswers[0]?.reason).toBe("timeout");
  expect(host.jevSkip.byReason.timeout).toBe(1);
  expect(skipShareReport(host.jevSkip).byReason.timeout).toBe(1);

  const held = startPaperHost(["NEAR-USD"], {});
  held.clock = () => NOW;
  hold(held);
  const live = Math.floor(NOW / 1000) - 1_000;
  held.jevCaller = async () => {
    calls += 1;
    return { ok: true, answer: ANSWER, costUsd: 0.01 };
  };
  held.jevQueue.push({ pair: "NEAR-USD", barStartSec: live, state: state(), minutes: [] });
  await drainJevShadow(held, NOW, NOW + 60_000);
  expect(calls).toBe(0);
  expect(held.jevQueue).toHaveLength(1);
  expect(held.jevAnswers).toHaveLength(0);
  held.kv = memoryKv(() => NOW);
  await plantLease(held.kv, "token-a", "holder-a");
  await persistSplit(held.kv, held);
  const hot = JSON.parse((await held.kv.get("p6:hot")) ?? "{}") as { jevQueue?: { barStartSec: number }[] };
  expect(hot.jevQueue?.map((item) => item.barStartSec)).toEqual([live]);
});

test("a stopped or stale holder does not read or write the queue", async () => {
  const kv = memoryKv(() => NOW);
  await plantLease(kv, "token-a", "holder-a");
  const queued = { pair: "NEAR-USD", barStartSec: Math.floor(NOW / 1000) - 1_000, state: state(), minutes: [] };
  await kv.set("p6:hot", JSON.stringify({ ...captureHot(startPaperHost(["NEAR-USD"], {})), jevQueue: [queued], positions: [] }));

  const stopped = startPaperHost(["NEAR-USD"], {});
  stopped.clock = () => NOW;
  stopped.kv = kv;
  stopped.stopped = true;
  hold(stopped);
  stopped.jevCaller = async () => {
    throw new Error("stopped must not call");
  };
  installPaperState(stopped, { jevQueue: [queued] });
  expect(stopped.jevQueue).toHaveLength(0);
  await drainJevShadow(stopped, NOW, NOW + 120_000);
  expect(stopped.jevAnswers).toHaveLength(0);

  const stale = startPaperHost(["NEAR-USD"], {});
  stale.clock = () => NOW;
  stale.kv = kv;
  hold(stale, "other-token");
  stale.jevQueue = [queued];
  stale.jevCaller = async () => {
    throw new Error("stale must not call");
  };
  await drainJevShadow(stale, NOW, NOW + 120_000);
  expect(stale.jevQueue).toHaveLength(1);
  expect(stale.jevAnswers).toHaveLength(0);
  await expect(persistSplit(stale.kv, stale)).rejects.toThrow("lease lost");
  expect(await kv.get(jevAnswerKey("NEAR-USD", queued.barStartSec))).toBeNull();
});

test("guard scoring uses the arrival mid and skips a trade already closed", () => {
  const open = guardEffectScore({ answeredAtMs: NOW, arrivalMid: 110, barCloseMid: 100, tradeClosedAtMs: null });
  expect(open.included).toBe(true);
  expect(open.mid).toBe(110);
  expect(open.mid).not.toBe(100);
  const closed = guardEffectScore({ answeredAtMs: NOW, arrivalMid: 110, barCloseMid: 100, tradeClosedAtMs: NOW - 1 });
  expect(closed.included).toBe(false);
  expect(closed.mid).toBeNull();

  const host = startPaperHost(["NEAR-USD"], {});
  host.clock = () => NOW;
  hold(host);
  host.book.closed.push({
    id: "c1",
    classId: "A",
    productId: "NEAR-USD",
    netR: 0,
    netUsd: 0,
    grossUsd: 0,
    costUsd: 0,
    riskUsd: 1,
    notionalUsd: 1,
    entryDate: "2026-10-16",
    exitTs: NOW - 1,
    exitKind: "time",
  });
  host.jevCaller = async () => ({ ok: true, answer: ANSWER, costUsd: 0.01, tokens: 4 });
  const bar = Math.floor(NOW / 1000) - 901;
  host.jevQueue.push({ pair: "NEAR-USD", barStartSec: bar, state: state(100), minutes: [] });
  host.jevTape.onBook("NEAR-USD", NOW, { bids: new Map([["109", 1]]), asks: new Map([["111", 1]]) });
  return drainJevShadow(host, NOW, NOW + 120_000).then(() => {
    const answer = host.jevAnswers[0];
    expect(answer?.guardIncluded).toBe(false);
    expect(answer?.scoreMid).toBeNull();
    expect(answer?.latencyMs).toBeGreaterThan(0);
    expect(host.jevSkip.byReason.timeout).toBe(0);
    expect(host.jevSkip.latency.le60).toBe(1);
    const shares = skipShareReport(host.jevSkip);
    expect(shares.latency.le60).toBe(1);
    expect(shares.holder).toBe("holder-a");
  });
});

test("latency buckets are exclusive at 60s, 300s, and 600s", () => {
  const ledger = freshJevSkip();
  ledger.byTier.other = { packets: 3, skipped: 0 };
  noteLatency(ledger, 60_000);
  noteLatency(ledger, 300_000);
  noteLatency(ledger, 600_000);
  noteLatency(ledger, 600_001);
  expect(ledger.latency).toEqual({ le60: 1, le300: 1, le600: 1, late: 1 });
  expect(skipShareReport(ledger).latency).toEqual({ le60: 1, le300: 1, le600: 1, late: 1 });
  const sum = ledger.latency.le60 + ledger.latency.le300 + ledger.latency.le600 + ledger.latency.late;
  expect(sum).toBe(4);
});

test("oversize sheds Jev first, writes the book, and stores the packet once", async () => {
  let now = NOW;
  const kv = memoryKv(() => now);
  await plantLease(kv, "token-a", "holder-a");
  const host = startPaperHost(["NEAR-USD", "BTC-USD"], {});
  host.clock = () => now;
  hold(host);
  host.kv = kv;
  host.book.realizedUsd = 12.34;
  host.book.positions = [{ productId: "NEAR-USD" } as PaperHost["book"]["positions"][number]];
  host.jevTape.importMinutes([row(), row({ productId: "DOGE-USD", ts: T + JEV_MINUTE_MS, sealedAtMs: T + 2 * JEV_MINUTE_MS, leaseUntilMs: T + 2 * JEV_MINUTE_MS })]);
  host.jevDone = new Set(Array.from({ length: 10 }, (_, i) => `NEAR-USD:${Math.floor(NOW / 1000) - i * 2_000}`));
  host.jevAnswers = Array.from({ length: 20 }, (_, i) => ({
    pair: "NEAR-USD",
    barStartSec: Math.floor(NOW / 1000) - 1_000 - i,
    answer: ANSWER,
    reason: "ok" as const,
    costUsd: 0.01,
    tokens: 3,
    answeredAtMs: NOW,
    latencyMs: 1_000,
    packetHash: "h".repeat(20_000),
  }));
  const before = Buffer.byteLength(JSON.stringify(captureHot(host)));
  expect(before).toBeGreaterThan(HOT_MAX_BYTES);
  const body = JSON.parse(hotSnapshot(host)) as {
    realizedUsd: number;
    positions: { productId: string }[];
    jevAnswers: unknown[];
    jevMinutes: unknown[];
    jevDone: string[];
  };
  expect(body.realizedUsd).toBe(12.34);
  expect(body.positions.map((item) => item.productId)).toEqual(["NEAR-USD"]);
  expect(body.jevAnswers).toEqual([]);
  expect(body.jevDone).toHaveLength(JEV_DONE_BARS);
  expect(JSON.stringify(body.jevMinutes)).not.toContain("DOGE-USD");
  expect(JSON.stringify(body.jevMinutes)).toContain("NEAR-USD");
  expect(host.book.incidents.some((item) => item.includes("75% of 256 KB"))).toBe(true);
  expect(host.book.incidents.some((item) => item.includes("exceeds 256 KB"))).toBe(false);

  const warn = startPaperHost(["BTC-USD"], {});
  warn.clock = () => NOW;
  warn.book.incidents.push("y".repeat(HOT_WARN_BYTES));
  hotSnapshot(warn);
  expect(warn.book.incidents.some((item) => item.includes("75% of 256 KB"))).toBe(true);

  const slim = startPaperHost(["BTC-USD"], {});
  slim.clock = () => NOW;
  hold(slim);
  const live = Math.floor(NOW / 1000) - 1_000;
  slim.jevCaller = async () => ({ ok: true, answer: ANSWER, costUsd: 0.01, tokens: 9 });
  slim.jevQueue.push({ pair: "BTC-USD", barStartSec: live, state: state(), minutes: [] });
  slim.kv = kv;
  await drainJevShadow(slim, NOW, NOW + 120_000);
  await persistSplit(kv, slim);
  const hot = JSON.parse((await kv.get("p6:hot")) ?? "{}") as { jevAnswers?: { packet?: unknown; tokens: number; packetHash: string }[]; jevMinutes?: unknown[] };
  expect(hot.jevAnswers?.[0]?.packet).toBeUndefined();
  expect(hot.jevAnswers?.[0]?.tokens).toBe(9);
  expect(hot.jevAnswers?.[0]?.packetHash).toHaveLength(64);
  const full = JSON.parse((await kv.get(jevAnswerKey("BTC-USD", live))) ?? "null") as { packet?: { pair?: string }; minutes?: unknown[] };
  expect(full.packet?.pair).toBe("NEAR-USD");
  const first = await kv.get(jevAnswerKey("BTC-USD", live));
  slim.jevPacketWrites.push({ key: jevAnswerKey("BTC-USD", live), value: JSON.stringify({ replaced: true }) });
  await persistSplit(kv, slim);
  expect(await kv.get(jevAnswerKey("BTC-USD", live))).toBe(first);
  now = NOW + JEV_PACKET_TTL_MS + 1;
  expect(await kv.get(jevAnswerKey("BTC-USD", live))).toBeNull();

  const done = boundJevDone(
    Array.from({ length: 10 }, (_, i) => `P:${10_000_000 - i * 2_000}`),
    10_000_000,
  );
  expect(done).toHaveLength(JEV_DONE_BARS);
  const unexpired = boundJevDone(
    Array.from({ length: 10 }, (_, i) => `P:${10_000_000 - i * 100}`),
    10_000_000,
  );
  expect(unexpired).toHaveLength(10);
});
