import { expect, test } from "bun:test";
import { btcCaution, btcOldClause, btcVeto, type BtcDay } from "./signals";
import {
  FEE_PROFILES,
  backstopTripped,
  betaAllows,
  classAChaseSkip,
  classAExit,
  classATenDayExit,
  classBDisasterStop,
  classBHeld,
  classBSelected,
  classCDayCap,
  classCEntry,
  classCHoldExpired,
  classEFloorPasses,
  classEHoldExpired,
  classEMoveToBreakEven,
  classETarget,
  classKill,
  clusterAllows,
  gap18Packet,
  grossNotionalAllows,
  haltTripped,
  kellyFraction,
  kellyRiskUsd,
  onePerPairAllows,
  openRiskAllows,
  reentryAllowed,
  section1CostBps,
  section1HurdleBps,
  stopFillPrice,
  stressRow,
  tradeThroughFill,
  x1FillPrice,
} from "./design-rules";

test("class A skips a 1h open above the signal close plus half an ATR, and exits on the prior 10 closes", () => {
  expect(classAChaseSkip(105, 100, 10)).toBe(false);
  expect(classAChaseSkip(105.01, 100, 10)).toBe(true);
  expect(classATenDayExit(9, Array(10).fill(10))).toBe(true);
  expect(classATenDayExit(10, Array(10).fill(10))).toBe(false);
  expect(classATenDayExit(9, Array(9).fill(10))).toBe(false);
  expect(classAExit(9, 10, 1, 2)).toBe(true);
  expect(classAExit(11, 10, 30, 0.9)).toBe(true);
  expect(classAExit(11, 10, 29, 0.9)).toBe(false);
});

test("class B takes the top fifth then at most four names, holds the top two fifths, and stops at 3 ATR", () => {
  const rows = [
    { id: "a", score: 5, member: true },
    { id: "b", score: 4, member: true },
    { id: "c", score: -1, member: true },
    { id: "d", score: -2, member: true },
    { id: "e", score: -3, member: true },
  ];
  expect(classBSelected(rows).map((row) => row.id)).toEqual(["a"]);
  expect(classBHeld(rows, "b")).toBe(true);
  expect(classBHeld(rows, "c")).toBe(false);
  const wide = Array.from({ length: 25 }, (_, i) => ({ id: `n${String(i).padStart(2, "0")}`, score: 25 - i, member: true }));
  expect(classBSelected(wide)).toHaveLength(4);
  expect(classBSelected(wide).map((row) => row.id)).toEqual(["n00", "n01", "n02", "n03"]);
  expect(classBDisasterStop(100, 2)).toBe(94);
});

test("class C enters on the 4h close, skips a wide stop, applies the floor, and keeps three a day", () => {
  const event = { pair: "SYN-USD", eventTs: 0, eventLow: 90, eventHigh: 99, dailyAtr: 20, dropHigh: 160, dropLow: 100 };
  const missed = classCEntry(event, [{ ts: 10 * 3_600_000, high: 101, close: 99 }]);
  expect(missed).toBeNull();
  const late = classCEntry(event, [{ ts: 49 * 3_600_000, high: 130, close: 125 }]);
  expect(late).toBeNull();
  const wide = classCEntry(
    { ...event, eventLow: 50, dailyAtr: 10 },
    [{ ts: 4 * 3_600_000, high: 130, close: 100 }],
  );
  expect(wide).toBeNull();
  const thin = classCEntry(
    { ...event, eventLow: 99, dropHigh: 101, dropLow: 99 },
    [{ ts: 4 * 3_600_000, high: 130, close: 100 }],
  );
  expect(thin).toBeNull();
  const hit = classCEntry(event, [{ ts: 4 * 3_600_000, high: 130, close: 100 }]);
  expect(hit?.entry).toBe(100);
  expect(hit?.stop).toBe(85);
  expect(hit?.target).toBe(130);
  expect(classCHoldExpired(0, 72 * 3_600_000)).toBe(true);
  const day = Date.parse("2026-03-02T00:00:00.000Z");
  const capped = classCDayCap([
    { entryTs: day, pair: "a" },
    { entryTs: day + 1, pair: "b" },
    { entryTs: day + 2, pair: "c" },
    { entryTs: day + 3, pair: "d" },
  ]);
  expect(capped.map((row) => row.pair)).toEqual(["a", "b", "c"]);
});

test("class E targets the nearer of a 50% retrace and 2.5R, moves to break-even at 1R, holds 24h, and needs T of 685 bps at a 250 bp stop", () => {
  expect(classETarget(100, 90, 120, 100)).toBe(110);
  expect(classETarget(100, 90, 200, 100)).toBe(125);
  expect(classEMoveToBreakEven(90, 100, 111)).toBe(100);
  expect(classEMoveToBreakEven(90, 100, 105)).toBe(90);
  expect(classEHoldExpired(0, 24 * 3_600_000)).toBe(true);
  expect(classEHoldExpired(0, 24 * 3_600_000 - 1)).toBe(false);
  expect(classEFloorPasses(250, 685)).toBe(true);
  expect(classEFloorPasses(250, 684)).toBe(false);
});

test("X1 pays s_bt, the stop model deducts the larger of s_bt and 0.1 ATR, and trade-through needs one tick", () => {
  expect(x1FillPrice(100, "buy", 10)).toBeCloseTo(100.1, 8);
  expect(x1FillPrice(100, "sell", 10)).toBeCloseTo(99.9, 8);
  expect(stopFillPrice(90, 100, 10, 2)).toBeCloseTo(90 - 0.2, 8);
  expect(stopFillPrice(90, 100, 50, 0.1)).toBeCloseTo(90 - 0.5, 8);
  expect(tradeThroughFill(10, 9.9, 0.01, 4)).toEqual({ filled: true, volume: 2 });
  expect(tradeThroughFill(10, 9.995, 0.01, 4)?.filled).toBe(false);
});

test("section 1 costs, one name, 24h, and the dollar caps", () => {
  const row = stressRow(40);
  expect(row).toEqual({ baseBps: 15, stressBps: 30 });
  expect(FEE_PROFILES.map((profile) => profile.id)).toEqual(["zero", "10-10", "25-40", "kraken-40-80", "coinbase-at-brian-tier"]);
  expect(FEE_PROFILES.find((profile) => profile.id === "coinbase-at-brian-tier")).toEqual({ id: "coinbase-at-brian-tier", makerBps: 50, takerBps: 90 });
  expect(section1CostBps(0, 10)).toBe(150);
  expect(section1CostBps(1, 10)).toBe(100);
  expect(section1HurdleBps(100, 200)).toBe(130);
  expect(onePerPairAllows(["BTC-USD"], "ETH-USD")).toBe(true);
  expect(onePerPairAllows(["BTC-USD"], "BTC-USD")).toBe(false);
  expect(reentryAllowed(0, 24 * 3_600_000 - 1)).toBe(false);
  expect(reentryAllowed(0, 24 * 3_600_000)).toBe(true);
  expect(openRiskAllows(400, 80)).toBe(true);
  expect(openRiskAllows(400, 81)).toBe(false);
  expect(grossNotionalAllows(5_000, 1_000)).toBe(true);
  expect(grossNotionalAllows(5_500, 600)).toBe(false);
});

test("clusters, beta, halts, backstops, Kelly, and class kills", () => {
  expect(clusterAllows(2)).toBe(true);
  expect(clusterAllows(3)).toBe(false);
  expect(betaAllows(6_000)).toBe(true);
  expect(betaAllows(6_001)).toBe(false);
  expect(haltTripped(240, 0, 0)).toBe(true);
  expect(haltTripped(0, 480, 0)).toBe(true);
  expect(haltTripped(0, 0, 1_600)).toBe(true);
  expect(haltTripped(239, 479, 1_599)).toBe(false);
  expect(backstopTripped(900, 0, 0)).toBe(true);
  expect(backstopTripped(0, 500, 0)).toBe(true);
  expect(backstopTripped(0, 0, 8_000)).toBe(true);
  expect(kellyFraction(0.2, 1)).toBeCloseTo(0.0075, 8);
  expect(kellyFraction(0.01, 1)).toBeCloseTo(0.005, 8);
  expect(kellyFraction(0, 1)).toBeNull();
  expect(kellyRiskUsd(60, null, 10_000)).toBe(20);
  expect(kellyRiskUsd(60, 0.005, 1_000)).toBe(5);
  expect(kellyRiskUsd(60, 0.005, 0)).toBe(0);
  expect(classKill({ n: 10, meanGrossBps: -1, upper80Bps: -1, hurdleBps: 1 })).toBe("insufficient");
  expect(classKill({ n: 30, meanGrossBps: -1, upper80Bps: 0, hurdleBps: 1 })).toBe("kill");
  expect(classKill({ n: 30, meanGrossBps: 1, upper80Bps: 2, hurdleBps: 1 })).toBe("keep");
});

test("BTC veto, the old clause, and caution", () => {
  const veto: BtcDay = { date: "2026-03-02", close: 90, ema50: 100, dailyMove: -0.04, below4hEma: true };
  expect(btcVeto(veto)).toBe(true);
  expect(btcOldClause(veto)).toBe(true);
  expect(btcCaution(veto)).toBe(true);
  expect(btcVeto({ ...veto, dailyMove: -0.02 })).toBe(false);
  expect(btcOldClause({ ...veto, below4hEma: false })).toBe(false);
  expect(btcCaution({ ...veto, below4hEma: false })).toBe(false);
});

test("the gap-18 packet builder rejects a bar after asOf", () => {
  const input = {
    asOf: 1_000,
    pair: "SYNTHETIC-USD",
    setup: "A",
    barTs: 900,
    candidateId: "SYNTHETIC-USD|A|900",
    biasUp: true,
    close: 10,
    stop: 9,
    atr: 1,
    rsi: 50,
    vwap: 10,
    sentiment: "clear",
    barTsList: [900],
  };
  expect(gap18Packet(input).pair).toBe("SYNTHETIC-USD");
  expect(() => gap18Packet({ ...input, barTsList: [1_001] })).toThrow("lookahead");
});
