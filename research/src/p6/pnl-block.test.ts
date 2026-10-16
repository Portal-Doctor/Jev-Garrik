import { expect, test } from "bun:test";
import { readP6Page } from "./dashboard-read";
import { captureHot, hotBytes, persistSplit } from "./hot-store";
import {
  EQ_FIRST_KEY,
  EQ_HOUR_MS,
  PNL_START_USD,
  buildPnlBlock,
  concentrationText,
  encodeHourTrades,
  encodePoint,
  eqKey,
  eqTradeKey,
  equityExtras,
  equitySeriesValueBytes,
  formatCt,
  hourStartSec,
  lastCompletedCloseMs,
  pnlMgetKeys,
  sinceText,
  wlText,
  type EqPoint,
  type EqTrade,
} from "./pnl-block";
import { startPaperHost } from "./paper-host";
import { LEASE_KEY, decodeLease, memoryKv, tryAcquire } from "./relay";

const HOUR = EQ_HOUR_MS;

function pointAt(ts: number, equity: number, realized: number, unrealized: number, fees = 0, spreadSlip = 0): EqPoint {
  return { hourStartSec: hourStartSec(ts), ts, equity, realized, unrealized, fees, spreadSlip };
}

function tradesCovering(fromMs: number, toMs: number, extra: Map<number, EqTrade[] | null> = new Map()): Map<number, EqTrade[] | null> {
  const out = new Map<number, EqTrade[] | null>();
  for (let hour = hourStartSec(fromMs); hour <= hourStartSec(toMs); hour += 3600) out.set(hour, extra.get(hour) ?? []);
  for (const [hour, list] of extra) out.set(hour, list);
  return out;
}

function blockAt(opts: {
  nowMs: number;
  points: EqPoint[];
  first?: EqPoint | null;
  equityNow: number;
  realizedNow: number;
  unrealizedNow: number;
  feesNow?: number;
  spreadNow?: number;
  lastEndMs?: number | null;
  openPositions?: number;
  trades?: Map<number, EqTrade[] | null>;
}) {
  const first = opts.first === undefined ? (opts.points[0] ?? null) : opts.first;
  const end = lastCompletedCloseMs(opts.nowMs);
  const from = first ? Math.min(first.ts, end - 30 * 24 * HOUR) : end - 30 * 24 * HOUR;
  return buildPnlBlock({
    nowMs: opts.nowMs,
    lastEndMs: opts.lastEndMs === undefined ? opts.nowMs : opts.lastEndMs,
    equityNow: opts.equityNow,
    realizedNow: opts.realizedNow,
    unrealizedNow: opts.unrealizedNow,
    feesNow: opts.feesNow ?? 0,
    spreadNow: opts.spreadNow ?? 0,
    openPositions: opts.openPositions ?? 2,
    first,
    points: opts.points,
    trades: opts.trades ?? tradesCovering(from, end),
  });
}

test("the percent base is $8,000 and the headline is realized plus the unrealized change", () => {
  expect(PNL_START_USD).toBe(8000);
  const origin = Date.UTC(2026, 9, 6, 18, 0, 0);
  const hours = 10 * 24;
  const points: EqPoint[] = [];
  for (let step = 0; step <= hours; step += 1) {
    const ts = origin + step * HOUR;
    points.push(pointAt(ts, 8000 + step, step * 0.4, step * 0.6, step * 0.01, step * 0.02));
  }
  const now = origin + hours * HOUR;
  const built = blockAt({
    nowMs: now,
    points,
    equityNow: 8000 + hours,
    realizedNow: hours * 0.4,
    unrealizedNow: hours * 0.6,
    feesNow: hours * 0.01,
    spreadNow: hours * 0.02,
    openPositions: 3,
  });
  expect(built.tiles.map((tile) => tile.id)).toEqual(["8h", "24h", "7d", "30d"]);
  for (const tile of built.tiles) {
    expect(tile.status).toBe("ok");
    expect(tile.totalUsd).toBeCloseTo((tile.realizedUsd ?? 0) + (tile.unrealizedDelta ?? 0), 8);
    expect(tile.totalPct).toBeCloseTo(((tile.totalUsd ?? 0) / 8000) * 100, 8);
    expect(tile.realizedPct).toBeCloseTo(((tile.realizedUsd ?? 0) / 8000) * 100, 8);
  }
  const day = built.tiles.find((tile) => tile.id === "8h")!;
  expect(day.totalUsd).toBeCloseTo(8, 8);
  expect(day.totalPct).toBeCloseTo(0.1, 8);
  expect(day.totalPct).not.toBeCloseTo((8 / (8000 + hours - 8)) * 100, 4);
  expect(day.feesUsd).toBeCloseTo(0.08, 8);
  expect(day.spreadSlipUsd).toBeCloseTo(0.16, 8);
  expect(built.openPositions).toBe(3);
  expect(built.openUnrealized).toBeCloseTo(hours * 0.6, 8);
  const month = built.tiles.find((tile) => tile.id === "30d")!;
  expect(month.since).toBe(sinceText(now - origin, "30d"));
  expect(month.totalUsd).toBeCloseTo(hours, 6);
  expect(month.totalUsd).not.toBeCloseTo(hours * (30 / 10), 0);
});

test("the 7d window slides across UTC midnight by the close, not by a day", () => {
  const midnight = Date.UTC(2026, 9, 16, 0, 0, 0);
  const origin = midnight - 8 * 24 * HOUR;
  const points: EqPoint[] = [];
  for (let step = 0; step <= 8 * 24 + 2; step += 1) {
    const ts = origin + step * HOUR;
    points.push(pointAt(ts, 8000 + step, step * 0.4, step * 0.6));
  }
  const at = (nowMs: number) => {
    const end = lastCompletedCloseMs(nowMs);
    const step = (end - origin) / HOUR;
    return blockAt({
      nowMs,
      points,
      equityNow: 8000 + step,
      realizedNow: step * 0.4,
      unrealizedNow: step * 0.6,
    }).tiles.find((tile) => tile.id === "7d")!;
  };
  const before = at(midnight - 60_000);
  const after = at(midnight + 60_000);
  expect(after.windowStartMs - before.windowStartMs).toBe(15 * 60 * 1000);
  expect(Math.abs((after.totalUsd ?? 0) - (before.totalUsd ?? 0))).toBeLessThan(1);
  expect(Math.abs((after.totalUsd ?? 0) - 168)).toBeLessThan(2);
  expect(Math.abs((before.totalUsd ?? 0) - 168)).toBeLessThan(2);
});

test("a missing hour is tolerated and an unknown trade hour stays partial", () => {
  const origin = Date.UTC(2026, 9, 16, 9, 0, 0);
  const points = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((step) => pointAt(origin + step * HOUR, 8000 + step * 10, step, 0));
  const now = origin + 9 * HOUR;
  const start = lastCompletedCloseMs(now) - 8 * HOUR;
  const missing = points.filter((row) => row.ts !== start);
  const tolerated = blockAt({
    nowMs: now,
    points: missing,
    equityNow: 8090,
    realizedNow: 9,
    unrealizedNow: 0,
  });
  const tile = tolerated.tiles.find((row) => row.id === "8h")!;
  expect(tile.status).toBe("ok");
  expect(tile.totalUsd).toBeCloseTo(90, 6);
  expect(tile.anchorTs).toBe(origin);
  expect(tile.partial).toBe(false);

  const trades = tradesCovering(origin, now);
  trades.set(hourStartSec(origin + 4 * HOUR), null);
  const unknown = blockAt({
    nowMs: now,
    points,
    equityNow: 8090,
    realizedNow: 9,
    unrealizedNow: 0,
    trades,
  });
  const flagged = unknown.tiles.find((row) => row.id === "8h")!;
  expect(flagged.partial).toBe(true);
  expect(flagged.closedN).toBe(0);
  expect(flagged.totalUsd).toBeCloseTo(80, 6);
});

test("short history labels and a single point are no data yet", () => {
  const first = pointAt(Date.UTC(2026, 9, 16, 12, 0, 0), 8000, 0, 0);
  const second = pointAt(first.ts + 3 * HOUR, 8030, 12, 18);
  const now = second.ts;
  const young = blockAt({
    nowMs: now,
    points: [first, second],
    equityNow: 8030,
    realizedNow: 12,
    unrealizedNow: 18,
  });
  expect(young.pointCount).toBe(2);
  expect(young.paperStartMs).toBe(first.ts);
  const month = young.tiles.find((tile) => tile.id === "30d")!;
  expect(month.since).toBe("since start: 0d 3h of 30d");
  expect(month.totalUsd).toBeCloseTo(30, 6);
  const beforeStart = new Map<number, EqTrade[] | null>([
    [hourStartSec(first.ts - HOUR), [{ id: "old", exitTs: first.ts - 1, net: 99 }]],
  ]);
  const hidden = blockAt({
    nowMs: now,
    points: [first, second],
    equityNow: 8030,
    realizedNow: 12,
    unrealizedNow: 18,
    trades: beforeStart,
  });
  expect(hidden.tiles.every((tile) => tile.closedN === 0)).toBe(true);
  expect(month.status).toBe("ok");
  const alone = blockAt({
    nowMs: now,
    points: [first],
    first,
    equityNow: 8010,
    realizedNow: 4,
    unrealizedNow: 6,
  });
  expect(alone.pointCount).toBe(1);
  for (const tile of alone.tiles) {
    expect(tile.status).toBe("no-data");
    expect(tile.since).toBe("no data yet");
    expect(tile.totalUsd).toBeNull();
  }
});

test("stale follows the lastRun timestamp and 20 minutes is not stale", () => {
  const ts = Date.UTC(2026, 9, 16, 18, 0, 0);
  const points = [pointAt(ts - HOUR, 8000, 0, 0), pointAt(ts, 8010, 4, 6)];
  const base = { nowMs: ts, points, equityNow: 8010, realizedNow: 4, unrealizedNow: 6 };
  expect(blockAt({ ...base, lastEndMs: ts - 20 * 60 * 1000 }).stale).toBe(false);
  expect(blockAt({ ...base, lastEndMs: ts - 20 * 60 * 1000 - 1 }).stale).toBe(true);
  expect(blockAt({ ...base, lastEndMs: null }).stale).toBe(true);
  expect(formatCt(ts, false)).toBe("13:00 CT");
});

test("no closes, W-L counts, the n<30 note, and concentration n/a", () => {
  const origin = Date.UTC(2026, 9, 16, 8, 0, 0);
  const points = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((step) => pointAt(origin + step * HOUR, 9000 + step, 100 + step, 0, 2, 1));
  const now = origin + 8 * HOUR;
  const quiet = blockAt({ nowMs: now, points, equityNow: 9080, realizedNow: 180, unrealizedNow: 0, feesNow: 5, spreadNow: 4 });
  const eight = quiet.tiles.find((tile) => tile.id === "8h")!;
  expect(eight.closedN).toBe(0);
  expect(eight.wins).toBe(0);
  expect(eight.losses).toBe(0);
  expect(wlText(eight.wins, eight.losses)).toBe("0W-0L");
  expect(eight.closedN < 30).toBe(true);
  expect(eight.concentrationPct).toBeNull();
  expect(concentrationText(eight.concentrationPct)).toBe("n/a");
  expect(eight.totalUsd).toBeCloseTo(80, 6);
  expect(eight.totalPct).toBeCloseTo(1, 6);
  expect(eight.totalPct).not.toBeCloseTo((80 / 9000) * 100, 4);

  const wins = [10, 20, 30, 5].map((net, index) => ({ id: `w${index}`, exitTs: origin + HOUR + index, net }));
  const losses = [-1, -2, -3, -4, -5, -6, -7].map((net, index) => ({ id: `l${index}`, exitTs: origin + 2 * HOUR + index, net }));
  const flat = { id: "z", exitTs: origin + 3 * HOUR, net: 0 };
  const listed = new Map<number, EqTrade[] | null>([
    [hourStartSec(origin + HOUR), wins],
    [hourStartSec(origin + 2 * HOUR), losses],
    [hourStartSec(origin + 3 * HOUR), [flat]],
  ]);
  const counted = blockAt({
    nowMs: now,
    points,
    equityNow: 9080,
    realizedNow: 180,
    unrealizedNow: 0,
    trades: listed,
  });
  const row = counted.tiles.find((tile) => tile.id === "8h")!;
  expect(row.wins).toBe(4);
  expect(row.losses).toBe(7);
  expect(wlText(row.wins, row.losses)).toBe("4W-7L");
  expect(row.closedN).toBe(12);
  expect(row.closedN < 30).toBe(true);
  expect(row.concentrationPct).toBeCloseTo(30 / row.realizedUsd! * 100, 6);

  const few = blockAt({
    nowMs: now,
    points,
    equityNow: 9080,
    realizedNow: 180,
    unrealizedNow: 0,
    trades: new Map([[hourStartSec(origin + HOUR), wins.slice(0, 2)]]),
  });
  expect(few.tiles.find((tile) => tile.id === "8h")!.concentrationPct).toBeNull();

  const flatBook = blockAt({
    nowMs: now,
    points: points.map((row) => ({ ...row, realized: 0 })),
    equityNow: 9080,
    realizedNow: 0,
    unrealizedNow: 80,
    trades: listed,
  });
  expect(flatBook.tiles.find((tile) => tile.id === "8h")!.concentrationPct).toBeNull();
  expect(concentrationText(null)).toBe("n/a");
});

test("drawdown is peak to trough on the hourly points in the window", () => {
  const origin = Date.UTC(2026, 9, 16, 12, 0, 0);
  const early = pointAt(origin - 7 * HOUR, 7000, 0, 0);
  const points = [
    early,
    pointAt(origin, 8100, 0, 0),
    pointAt(origin + HOUR, 8140, 0, 0),
    pointAt(origin + 2 * HOUR, 8090, 0, 0),
    pointAt(origin + 3 * HOUR, 8120, 0, 0),
  ];
  const built = blockAt({
    nowMs: origin + 3 * HOUR,
    points,
    first: points[1]!,
    equityNow: 8120,
    realizedNow: 0,
    unrealizedNow: 120,
  });
  const tile = built.tiles.find((row) => row.id === "8h")!;
  expect(tile.drawdownUsd).toBeCloseTo(50, 6);
  expect(tile.drawdownUsd).not.toBeCloseTo(1140, 0);
});

test("the page read is two mgets and does not touch fills or the ledger", async () => {
  const now = Date.UTC(2026, 9, 16, 18, 0, 0);
  const first = pointAt(now - HOUR, 8000, 0, 0, 1, 1);
  const latest = pointAt(now, 8020, 8, 12, 2, 3);
  const cmds: string[] = [];
  const stored = new Map<string, string>([
    ["p6:lastRun", JSON.stringify({ end: now, pnl: { equityUsd: 8020, realizedUsd: 8, unrealizedUsd: 12, feesUsd: 2, spreadSlipUsd: 3 } })],
    ["p6:hot", JSON.stringify({ positions: [{ productId: "BTC-USD" }, { productId: "ETH-USD" }], incidents: [], gaps: [], closed: [], emitted: [] })],
    [EQ_FIRST_KEY, encodePoint(first)],
    [eqKey(first.hourStartSec), encodePoint(first)],
    [eqKey(latest.hourStartSec), encodePoint(latest)],
    [eqTradeKey(latest.hourStartSec), encodeHourTrades([{ id: "a", exitTs: now - 1_000, netUsd: 8 }], latest.hourStartSec)],
  ]);
  const kv = {
    async mget(keys: string[]) {
      cmds.push("mget");
      return keys.map((key) => stored.get(key) ?? null);
    },
    async get() {
      cmds.push("get");
      throw new Error("get");
    },
    async set() {
      cmds.push("set");
      throw new Error("set");
    },
    async del() {
      cmds.push("del");
      throw new Error("del");
    },
    async cas() {
      cmds.push("cas");
      throw new Error("cas");
    },
    async ownedSet() {
      cmds.push("ownedSet");
      throw new Error("ownedSet");
    },
    async ownedAppend() {
      cmds.push("ownedAppend");
      throw new Error("ownedAppend");
    },
    async ownedFlush() {
      cmds.push("ownedFlush");
      throw new Error("ownedFlush");
    },
    async readLists() {
      cmds.push("readLists");
      throw new Error("readLists");
    },
  };
  const { block } = await readP6Page(kv, now);
  expect(cmds).toEqual(["mget", "mget"]);
  const keys = pnlMgetKeys(now);
  expect(keys.includes("p6:fills") || keys.includes("p6:ledger")).toBe(false);
  expect(keys.includes(EQ_FIRST_KEY)).toBe(true);
  expect(keys.filter((key) => key.startsWith("p6:eq:tr:")).length).toBe(30 * 24 + 1);
  const eight = block.tiles.find((tile) => tile.id === "8h")!;
  expect(eight.totalUsd).toBeCloseTo((eight.realizedUsd ?? 0) + (eight.unrealizedDelta ?? 0), 6);
  expect(block.openPositions).toBe(2);
  expect(block.stale).toBe(false);
  expect(equitySeriesValueBytes(20)).toBeLessThan(1_048_576);
});

test("the flush command count stays one and a successor does not move the hour point", async () => {
  let now = Date.UTC(2026, 9, 16, 15, 0, 0);
  const kv = memoryKv(() => now);
  expect(await tryAcquire(kv, "K", now + 86_400_000, now)).toBe(true);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => now;
  host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
  host.book.realizedUsd = 10;
  let flushes = 0;
  const payloads: string[] = [];
  const owned = kv.ownedFlush.bind(kv);
  kv.ownedFlush = async (leaseKey, token, nowMs, payload) => {
    flushes += 1;
    payloads.push(payload);
    return owned(leaseKey, token, nowMs, payload);
  };
  const beforeHot = hotBytes(host);
  await persistSplit(kv, host);
  expect(flushes).toBe(1);
  expect(hotBytes(host)).toBe(beforeHot);
  expect(JSON.stringify(captureHot(host))).not.toContain("p6:eq");
  expect(Object.keys(captureHot(host))).not.toContain("eqHourDone");
  const hour = hourStartSec(now);
  const point = await kv.get(eqKey(hour));
  const first = await kv.get(EQ_FIRST_KEY);
  expect(point).not.toBeNull();
  expect(first).toBe(point);
  expect(payloads[0]).toContain(eqKey(hour));
  expect(payloads[0]).toContain(EQ_FIRST_KEY);
  host.book.realizedUsd = 99;
  await persistSplit(kv, host);
  expect(flushes).toBe(2);
  expect(await kv.get(eqKey(hour))).toBe(point);
  expect(await kv.get(EQ_FIRST_KEY)).toBe(first);
  expect(payloads[1]?.includes(EQ_FIRST_KEY)).toBe(false);
  const successor = startPaperHost(["BTC-USD"], {});
  successor.clock = () => now;
  successor.leaseToken = host.leaseToken;
  successor.book.realizedUsd = 500;
  successor.book.closed = [
    {
      id: "kept",
      classId: "A",
      productId: "BTC-USD",
      netR: 1,
      netUsd: 4,
      grossUsd: 4,
      costUsd: 0,
      riskUsd: 1,
      notionalUsd: 1,
      entryDate: "2026-10-16",
      exitTs: now + 60_000,
      exitKind: "test",
    },
  ];
  await persistSplit(kv, successor);
  expect(await kv.get(eqKey(hour))).toBe(point);
  expect(await kv.get(EQ_FIRST_KEY)).toBe(first);
  host.book.closed.push({
    id: "t1",
    classId: "A",
    productId: "BTC-USD",
    netR: 1,
    netUsd: 4,
    grossUsd: 4,
    costUsd: 0,
    riskUsd: 1,
    notionalUsd: 1,
    entryDate: "2026-10-16",
    exitTs: now + 60_000,
    exitKind: "test",
  });
  await persistSplit(kv, host);
  expect(await kv.get(eqTradeKey(hour))).toContain("t1");
  expect(await kv.get(eqKey(hour))).toBe(point);
  const sealed = hour;
  now += HOUR;
  expect(await tryAcquire(kv, "K", now + 86_400_000, now)).toBe(true);
  host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
  await persistSplit(kv, host);
  expect(flushes).toBe(5);
  expect(await kv.get(eqKey(hourStartSec(now)))).not.toBeNull();
  expect(await kv.get(eqKey(sealed))).toBe(point);
  const aged = now + 32 * 24 * HOUR;
  now = aged;
  expect(await kv.get(eqKey(sealed))).toBeNull();
  expect(await kv.get(EQ_FIRST_KEY)).toBe(first);
  const again = equityExtras({
    nowMs: Date.UTC(2026, 9, 16, 15, 0, 0),
    eqHourDone: hourStartSec(Date.UTC(2026, 9, 16, 15, 0, 0)),
    pnl: { equityUsd: 1, realizedUsd: 1, unrealizedUsd: 0, feesUsd: 0, spreadSlipUsd: 0 },
    closed: [],
  });
  expect(again.some((row) => row.nx)).toBe(false);
});
