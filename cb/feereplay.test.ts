import { expect, test } from "bun:test";
import type { ClosedTrade } from "./backtest";
import { filledNotional, monthKey, monthlyNets, summarizeTier, turnover } from "./feereplay";
import type { SpotFeeTier } from "./feetiers";

const DAY = 86_400_000;
const utc = (iso: string) => Date.parse(iso);

const trade = (opened: string, closed: string, netUsd: number, entry = 600, exit = 600): ClosedTrade => ({
  openedTs: utc(opened),
  closedTs: utc(closed),
  netUsd,
  entryNotionalUsd: entry,
  exitNotionalUsd: exit,
});

test("a trade is booked to the UTC calendar month it closed in", () => {
  expect(monthKey(utc("2026-04-30T23:59:59Z"))).toBe("2026-04");
  expect(monthKey(utc("2026-05-01T00:00:00Z"))).toBe("2026-05");
  const nets = monthlyNets([
    trade("2026-04-28T00:00:00Z", "2026-05-02T00:00:00Z", 12),
    trade("2026-04-01T00:00:00Z", "2026-04-10T00:00:00Z", -5),
    trade("2026-05-20T00:00:00Z", "2026-05-25T00:00:00Z", 3),
  ]);
  expect(nets).toEqual([
    { month: "2026-04", netUsd: -5 },
    { month: "2026-05", netUsd: 15 },
  ]);
});

test("months with no closed trade are absent rather than zero-filled", () => {
  expect(monthlyNets([]).length).toBe(0);
});

test("filled notional counts both legs of every round trip", () => {
  expect(filledNotional([trade("2026-04-01T00:00:00Z", "2026-04-02T00:00:00Z", 1, 600, 640)])).toBeCloseTo(1_240);
});

test("turnover scales the tape to 30 days and finds the busiest real window", () => {
  // Two trades in one week, then nothing for the rest of a 180 day tape.
  const from = utc("2026-04-01T00:00:00Z");
  const to = from + 180 * DAY;
  const trades = [
    trade("2026-04-01T00:00:00Z", "2026-04-02T00:00:00Z", 1, 500, 500),
    trade("2026-04-03T00:00:00Z", "2026-04-05T00:00:00Z", 1, 500, 500),
  ];
  const t = turnover(trades, from, to);
  expect(t.totalUsd).toBeCloseTo(2_000);
  expect(t.scaledThirtyDayUsd).toBeCloseTo((2_000 * 30) / 180);
  // All four legs sit inside one 30 day window.
  expect(t.busiestThirtyDayUsd).toBeCloseTo(2_000);
});

test("turnover drops legs that fall out of the trailing 30 day window", () => {
  const from = utc("2026-01-01T00:00:00Z");
  const to = from + 180 * DAY;
  const trades = [
    trade("2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z", 1, 100, 100),
    trade("2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z", 1, 700, 700),
  ];
  const t = turnover(trades, from, to);
  expect(t.totalUsd).toBeCloseTo(1_600);
  expect(t.busiestThirtyDayUsd).toBeCloseTo(1_400);
});

test("a tier is marked unreachable when the book cannot generate its cutoff", () => {
  const tier: SpotFeeTier = { name: "Advanced 1", thirtyDayVolumeUsd: 25_000, makerBps: 25, takerBps: 50, source: "test" };
  const from = utc("2026-04-01T00:00:00Z");
  const to = from + 180 * DAY;
  const row = summarizeTier(
    tier,
    [
      { pair: "UNI-USD", trades: [trade("2026-04-01T00:00:00Z", "2026-04-05T00:00:00Z", -20, 600, 580)] },
      { pair: "NEAR-USD", trades: [trade("2026-05-01T00:00:00Z", "2026-05-05T00:00:00Z", 8, 300, 308)] },
    ],
    from,
    to,
  );
  expect(row.totalNetUsd).toBeCloseTo(-12);
  expect(row.perPair.map((p) => p.pair)).toEqual(["UNI-USD", "NEAR-USD"]);
  expect(row.perPair[0]!.filledNotionalUsd).toBeCloseTo(1_180);
  expect(row.perMonth).toEqual([
    { month: "2026-04", netUsd: -20 },
    { month: "2026-05", netUsd: 8 },
  ]);
  expect(row.reachable).toBe(false);
});

test("a tier is marked reachable once the busiest window clears the cutoff", () => {
  const tier: SpotFeeTier = { name: "Intro 2", thirtyDayVolumeUsd: 10_000, makerBps: 40, takerBps: 80, source: "test" };
  const from = utc("2026-04-01T00:00:00Z");
  const to = from + 180 * DAY;
  const trades = Array.from({ length: 10 }, (_, i) =>
    trade(`2026-04-0${(i % 9) + 1}T00:00:00Z`, `2026-04-0${(i % 9) + 1}T12:00:00Z`, 1, 600, 600),
  );
  const row = summarizeTier(tier, [{ pair: "UNI-USD", trades }], from, to);
  expect(row.turnover.busiestThirtyDayUsd).toBeCloseTo(12_000);
  expect(row.reachable).toBe(true);
});
