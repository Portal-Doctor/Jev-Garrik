import { expect, test } from "bun:test";
import { readP6Page } from "./dashboard-read";
import { captureHot, hotBytes, persistSplit } from "./hot-store";
import {
  ANCHOR_GREY_MS,
  EQ_FIRST_KEY,
  EQ_HOUR_MS,
  EQ_TRADE_CAP,
  EQ_TTL_MS,
  N_MIN,
  N_NOTE,
  PNL_START_USD,
  anchorAgeLabel,
  buildPnlBlock,
  closedNote,
  concentrationText,
  drawdownText,
  encodeHourAgg,
  encodePoint,
  endIsStale,
  eqKey,
  eqTradeKey,
  equityExtras,
  equitySeriesValueBytes,
  formatCt,
  hourStartSec,
  lastCompletedCloseMs,
  parseHourAgg,
  pnlMgetKeys,
  pnlPageReplyBytes,
  signedUsd,
  sinceText,
  wlText,
  type EqPoint,
  type HourAgg,
} from "./pnl-block";
import { startPaperHost } from "./paper-host";
import { LEASE_KEY, decodeLease, memoryKv, tryAcquire } from "./relay";

const HOUR = EQ_HOUR_MS;

function pointAt(ts: number, equity: number, realized: number, unrealized: number, fees = 0, spreadSlip = 0): EqPoint {
  return { hourStartSec: hourStartSec(ts), ts, equity, realized, unrealized, fees, spreadSlip };
}

const ZERO_AGG: HourAgg = { n: 0, wins: 0, losses: 0, flat: 0, largestNet: 0, realizedSum: 0 };

function aggOf(nets: number[]): HourAgg {
  let wins = 0;
  let losses = 0;
  let flat = 0;
  let largest = 0;
  let seen = false;
  let sum = 0;
  for (const net of nets) {
    if (net > 0) wins += 1;
    else if (net < 0) losses += 1;
    else flat += 1;
    if (!seen || net > largest) {
      largest = net;
      seen = true;
    }
    sum += net;
  }
  return { n: nets.length, wins, losses, flat, largestNet: seen ? largest : 0, realizedSum: sum };
}

function tradesCovering(fromMs: number, toMs: number, extra: Map<number, HourAgg | null> = new Map()): Map<number, HourAgg | null> {
  const out = new Map<number, HourAgg | null>();
  for (let hour = hourStartSec(fromMs); hour <= hourStartSec(toMs); hour += 3600) out.set(hour, extra.get(hour) ?? ZERO_AGG);
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
  trades?: Map<number, HourAgg | null>;
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
  const fullDay = built.tiles.find((tile) => tile.id === "24h")!;
  expect(fullDay.windowEndMs - fullDay.windowStartMs).toBe(24 * EQ_HOUR_MS);
  const day = built.tiles.find((tile) => tile.id === "8h")!;
  expect(day.totalUsd).toBeCloseTo(8, 8);
  expect(day.totalPct).toBeCloseTo(0.1, 8);
  expect(day.totalPct).not.toBeCloseTo((8 / (8000 + hours - 8)) * 100, 4);
  expect(day.feesUsd).toBeCloseTo(0.08, 8);
  expect(day.spreadSlipUsd).toBeCloseTo(0.16, 8);
  expect(built.openPositions).toBe(3);
  expect(built.openUnrealized).toBeCloseTo(hours * 0.6, 8);
  const month = built.tiles.find((tile) => tile.id === "30d")!;
  expect(month.windowEndMs - month.windowStartMs).toBe(30 * 24 * EQ_HOUR_MS);
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

test("a one-hour gap keeps the anchor and an unknown trade hour is not a count", () => {
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
  expect(tile.anchorLabel).toBeNull();
  expect(tile.tradesUnknown).toBe(false);

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
  expect(flagged.tradesUnknown).toBe(true);
  expect(flagged.closedN).toBe(0);
  expect(flagged.wins).toBe(0);
  expect(flagged.losses).toBe(0);
  expect(flagged.concentrationPct).toBeNull();
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
  const beforeStart = tradesCovering(first.ts, now, new Map([[hourStartSec(first.ts - HOUR), aggOf([99])]]));
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
  expect(endIsStale(ts, null)).toBe(true);
  expect(endIsStale(ts, undefined)).toBe(true);
  expect(formatCt(ts, false)).toBe("13:00 CT");
  expect(formatCt(Date.UTC(2026, 9, 17, 5, 5, 0), false)).toBe("00:05 CT");
  expect(formatCt(Date.UTC(2026, 9, 17, 5, 5, 0), false).includes("24:")).toBe(false);
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

  const wins = aggOf([10, 20, 30, 5]);
  const losses = aggOf([-1, -2, -3, -4, -5, -6, -7]);
  const flat = aggOf([0]);
  const listed = tradesCovering(
    origin,
    now,
    new Map([
      [hourStartSec(origin + HOUR), wins],
      [hourStartSec(origin + 2 * HOUR), losses],
      [hourStartSec(origin + 3 * HOUR), flat],
    ]),
  );
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
  expect(row.closedN < N_MIN).toBe(true);
  expect(N_MIN).toBe(30);
  expect(closedNote(29)).toBe(N_NOTE);
  expect(closedNote(30)).toBe("");
  expect(closedNote(row.closedN)).toBe(N_NOTE);
  expect(row.concentrationPct).toBeCloseTo(30 / row.realizedUsd! * 100, 6);

  const few = blockAt({
    nowMs: now,
    points,
    equityNow: 9080,
    realizedNow: 180,
    unrealizedNow: 0,
    trades: tradesCovering(origin, now, new Map([[hourStartSec(origin + HOUR), aggOf([10, 20])]])),
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
  const anchor = pointAt(origin - 5 * HOUR, 8100, 0, 0);
  const points = [
    early,
    anchor,
    pointAt(origin, 8100, 0, 0),
    pointAt(origin + HOUR, 8140, 0, 0),
    pointAt(origin + 2 * HOUR, 8090, 0, 0),
    pointAt(origin + 3 * HOUR, 8120, 0, 0),
  ];
  const built = blockAt({
    nowMs: origin + 3 * HOUR,
    points,
    first: anchor,
    equityNow: 8120,
    realizedNow: 0,
    unrealizedNow: 120,
  });
  const tile = built.tiles.find((row) => row.id === "8h")!;
  expect(tile.drawdownUsd).toBeCloseTo(50, 6);
  expect(tile.drawdownUsd).not.toBeCloseTo(1140, 0);
  expect(drawdownText(tile.drawdownUsd ?? 0)).toBe("$50.00");
  expect(drawdownText(41.27).includes("+")).toBe(false);
  expect(drawdownText(-2)).toBe("-$2.00");
  expect(signedUsd(-34.02)).toBe("-$34.02");
  expect(signedUsd(-0.004)).toBe("$0.00");
  expect(signedUsd(1.5)).toBe("+$1.50");
});

test("a multi-hour gap keeps the newest point at or before the window start", () => {
  const startBook = Date.UTC(2026, 8, 1, 0, 0, 0);
  const now = startBook + 35 * 24 * HOUR + 9 * HOUR;
  const end = lastCompletedCloseMs(now);
  const start = end - 8 * HOUR;
  const points: EqPoint[] = [];
  for (let ts = startBook; ts <= now; ts += HOUR) {
    const step = (ts - startBook) / HOUR;
    points.push(pointAt(ts, 8000 + step, step, 0));
  }
  const equityNow = 8000 + (now - startBook) / HOUR;
  const drop = new Set([start, start - HOUR]);
  const gapped = blockAt({
    nowMs: now,
    points: points.filter((row) => !drop.has(row.ts)),
    first: points[0]!,
    equityNow,
    realizedNow: (now - startBook) / HOUR,
    unrealizedNow: 0,
  });
  const tile = gapped.tiles.find((row) => row.id === "8h")!;
  expect(tile.totalUsd).toBeCloseTo(10, 6);
  expect(tile.totalUsd).not.toBeCloseTo(849, 0);
  expect(tile.anchorTs).toBe(start - 2 * HOUR);
  expect(tile.anchorLabel).toBe("anchor 2h 00m old");
  expect(tile.since).toBeNull();
  expect(ANCHOR_GREY_MS).toBe(EQ_HOUR_MS);

  const three = new Set([start, start - HOUR, start - 2 * HOUR]);
  const wider = blockAt({
    nowMs: now,
    points: points.filter((row) => !three.has(row.ts)),
    first: points[0]!,
    equityNow,
    realizedNow: (now - startBook) / HOUR,
    unrealizedNow: 0,
  });
  const far = wider.tiles.find((row) => row.id === "8h")!;
  expect(far.anchorTs).toBe(start - 3 * HOUR);
  expect(far.totalUsd).toBeCloseTo(11, 6);
  expect(far.anchorLabel).toBe(anchorAgeLabel(3 * HOUR));

  const aged = pointAt(start - 3 * HOUR - 5 * 60_000, 8000, 0, 0);
  const labelled = blockAt({
    nowMs: end,
    points: [aged, pointAt(end, 8010, 10, 0)],
    first: pointAt(start - 800 * HOUR, 7000, 0, 0),
    equityNow: 8010,
    realizedNow: 10,
    unrealizedNow: 0,
  });
  const grey = labelled.tiles.find((row) => row.id === "8h")!;
  expect(grey.totalUsd).toBeCloseTo(10, 6);
  expect(grey.anchorTs).toBe(aged.ts);
  expect(grey.anchorLabel).toBe("anchor 3h 05m old");
  expect(grey.since).toBeNull();

  const exact = blockAt({
    nowMs: end,
    points: [pointAt(start - HOUR, 8000, 0, 0), pointAt(end, 8010, 10, 0)],
    equityNow: 8010,
    realizedNow: 10,
    unrealizedNow: 0,
  });
  expect(exact.tiles.find((row) => row.id === "8h")!.anchorLabel).toBeNull();
});

test("largest close is by net, the cap is 501, and the hour start is included", () => {
  const origin = Date.UTC(2026, 9, 16, 8, 0, 0);
  const points = [0, 1, 2, 3, 4, 5, 6, 7, 8].map((step) => pointAt(origin + step * HOUR, 9000 + step, 100 + step, 0));
  const now = origin + 8 * HOUR;
  const hour = hourStartSec(origin + HOUR);
  const other = hourStartSec(origin + 2 * HOUR);
  const byNet = parseHourAgg(
    encodeHourAgg(
      [
        { exitTs: hour * 1000, netUsd: 10 },
        { exitTs: hour * 1000 + 1, netUsd: -50 },
        { exitTs: hour * 1000 + 2, netUsd: 20 },
      ],
      hour,
    ),
  );
  expect(byNet?.largestNet).toBe(20);
  const mixed = blockAt({
    nowMs: now,
    points,
    equityNow: 9080,
    realizedNow: 180,
    unrealizedNow: 0,
    trades: tradesCovering(
      origin,
      now,
      new Map([
        [hour, byNet],
        [other, parseHourAgg(encodeHourAgg([{ exitTs: other * 1000, netUsd: -50 }], other))],
      ]),
    ),
  });
  const tile = mixed.tiles.find((row) => row.id === "8h")!;
  expect(tile.concentrationPct).toBeCloseTo((20 / tile.realizedUsd!) * 100, 6);
  expect(tile.concentrationPct).not.toBeCloseTo((50 / tile.realizedUsd!) * 100, 1);

  const negative = blockAt({
    nowMs: now,
    points,
    equityNow: 9080,
    realizedNow: 180,
    unrealizedNow: 0,
    trades: tradesCovering(origin, now, new Map([[hour, aggOf([-1, -5, -2])]])),
  });
  expect(negative.tiles.find((row) => row.id === "8h")!.concentrationPct).toBeNull();

  const atCap = Array.from({ length: EQ_TRADE_CAP }, (_, index) => ({ exitTs: hour * 1000 + index, netUsd: 1 }));
  expect(parseHourAgg(encodeHourAgg(atCap, hour))?.n).toBe(EQ_TRADE_CAP);
  const over = [...atCap, { exitTs: hour * 1000 + EQ_TRADE_CAP, netUsd: 1 }];
  expect(parseHourAgg(encodeHourAgg(over, hour))).toBeNull();
  const unknown = blockAt({
    nowMs: now,
    points,
    equityNow: 9080,
    realizedNow: 180,
    unrealizedNow: 0,
    trades: tradesCovering(origin, now, new Map([[hour, null]])),
  });
  const blank = unknown.tiles.find((row) => row.id === "8h")!;
  expect(blank.tradesUnknown).toBe(true);
  expect(blank.wins).toBe(0);
  expect(blank.concentrationPct).toBeNull();

  const boundary = parseHourAgg(
    encodeHourAgg(
      [
        { exitTs: hour * 1000, netUsd: 4 },
        { exitTs: hour * 1000 + EQ_HOUR_MS, netUsd: 9 },
      ],
      hour,
    ),
  );
  expect(boundary).toEqual({ n: 1, wins: 1, losses: 0, flat: 0, largestNet: 4, realizedSum: 4 });
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
    [eqTradeKey(latest.hourStartSec), encodeHourAgg([{ exitTs: now - 1_000, netUsd: 8 }], latest.hourStartSec)],
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
  const end = lastCompletedCloseMs(now);
  const earliest = hourStartSec(end - EQ_TTL_MS);
  const latestHour = hourStartSec(end);
  expect(keys.filter((key) => key.startsWith("p6:eq:tr:")).length).toBe((latestHour - earliest) / 3600 + 1);
  expect(keys.includes(eqKey(earliest))).toBe(true);
  expect(keys.includes(eqKey(hourStartSec(end - 8 * EQ_HOUR_MS - 3 * EQ_HOUR_MS)))).toBe(true);
  const eight = block.tiles.find((tile) => tile.id === "8h")!;
  expect(eight.totalUsd).toBeCloseTo((eight.realizedUsd ?? 0) + (eight.unrealizedDelta ?? 0), 6);
  expect(eight.tradesUnknown).toBe(true);
  expect(block.openPositions).toBe(2);
  expect(block.stale).toBe(false);
  expect(equitySeriesValueBytes(20)).toBeLessThan(200_000);
  const reply = pnlPageReplyBytes(now, 20);
  expect(reply).toBeGreaterThan(20_000);
  expect(reply).toBeLessThan(120_000);
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
  const storedAgg = parseHourAgg(await kv.get(eqTradeKey(hour)));
  expect(storedAgg).toEqual({ n: 1, wins: 1, losses: 0, flat: 0, largestNet: 4, realizedSum: 4 });
  expect(await kv.get(eqTradeKey(hour))).not.toContain("t1");
  expect(await kv.get(eqKey(hour))).toBe(point);
  const sealed = hour;
  const writtenAt = now;
  now += HOUR;
  expect(await tryAcquire(kv, "K", now + 86_400_000, now)).toBe(true);
  host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
  await persistSplit(kv, host);
  expect(flushes).toBe(5);
  expect(await kv.get(eqKey(hourStartSec(now)))).not.toBeNull();
  expect(await kv.get(eqKey(sealed))).toBe(point);
  now = writtenAt + 30 * 24 * HOUR;
  expect(await kv.get(eqKey(sealed))).toBe(point);
  now = writtenAt + EQ_TTL_MS + 1;
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
