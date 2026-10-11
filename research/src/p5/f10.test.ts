import { expect, test } from "bun:test";
import { monthlyClusters, runBook, type BookPair } from "./book";
import { classAChaseSkip, classATenDayExit, openRiskAllows } from "../p3/design-rules";
import { expandingFolds, purgedAtBoundary, selectByFold } from "./stats";

function pair(productId: string, bars: BookPair["bars"], cluster = productId, daily?: BookPair["daily"], atr1h = 0): BookPair {
  return { productId, bars, daily: daily ?? new Map(), atr1h: () => atr1h, clusterOf: () => cluster };
}

function bar(ts: number, open: number, low = open - 1, close = open, high = Math.max(open, close) + 1) {
  return { ts, open, high, low, close };
}

const day = 86_400;

test("open risk, gross notional, and beta block the extra name", () => {
  const quiet = new Map([[0, bar(0, 100, 99, 100)]]);
  const ids = ["A", "B", "C", "D", "E"];
  const gross = runBook({
    pairs: ids.map((id) => pair(id, quiet)),
    candidates: ids.map((id) => ({ classId: "B" as const, productId: id, signalDate: "1970-01-01", entryTs: 0, stopDistance: 1 })),
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: 900,
  });
  expect(gross.taken).toBe(4);
  expect(gross.hits.grossNotional).toBe(1);
  expect(gross.hits.openRisk).toBe(0);
  expect(openRiskAllows(420, 60)).toBe(true);
  expect(openRiskAllows(480, 60)).toBe(false);

  const wide = runBook({
    pairs: ["A", "B", "C", "D", "E", "F", "G", "H", "I"].map((id) => pair(id, quiet)),
    candidates: ["A", "B", "C", "D", "E", "F", "G", "H", "I"].map((id) => ({ classId: "B" as const, productId: id, signalDate: "1970-01-01", entryTs: 0, stopDistance: 10 })),
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: 900,
  });
  expect(wide.hits.slotB).toBeGreaterThan(0);
  expect(wide.taken).toBeLessThanOrEqual(4);

  const beta = runBook({
    pairs: ["A", "B", "C"].map((id) => pair(id, quiet)),
    candidates: ["A", "B", "C"].map((id) => ({ classId: "B" as const, productId: id, signalDate: "1970-01-01", entryTs: 0, stopDistance: 10 })),
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: 900,
    betaOf: () => 4,
  });
  expect(beta.betaApplied).toBe(true);
  expect(beta.taken).toBe(2);
  expect(beta.hits.beta).toBe(1);
});

test("a missing beta does not block and is not applied as zero weight", () => {
  const quiet = new Map([[0, bar(0, 100, 99, 100)]]);
  const result = runBook({
    pairs: [pair("AAA", quiet)],
    candidates: [{ classId: "B", productId: "AAA", signalDate: "1970-01-01", entryTs: 0, stopDistance: 10 }],
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: 900,
    betaOf: () => null,
  });
  expect(result.taken).toBe(1);
  expect(result.hits.beta).toBe(0);
  expect(result.betaUnresolved).toBe(1);
});

test("equity halts, backstops, and the 20R kill block the next entry", () => {
  const held = new Map([
    [0, bar(0, 100, 99.5, 100)],
    [900, bar(900, 1, 0.5, 1)],
  ]);
  const later = new Map([[1_800, bar(1_800, 100, 99, 100)]]);
  const halted = runBook({
    pairs: [pair("AAA", held), pair("BBB", held), pair("CCC", later)],
    candidates: [
      { classId: "B", productId: "AAA", signalDate: "1970-01-01", entryTs: 0, stopDistance: 1 },
      { classId: "B", productId: "BBB", signalDate: "1970-01-01", entryTs: 0, stopDistance: 1 },
      { classId: "B", productId: "CCC", signalDate: "1970-01-01", entryTs: 1_800, stopDistance: 10 },
    ],
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: 2_700,
  });
  expect(halted.taken).toBe(2);
  expect(halted.trades.every((trade) => trade.reason === "gap")).toBe(true);
  expect(halted.trades.reduce((sum, trade) => sum + trade.netUsd, 0)).toBeLessThan(-1_600);
  expect(halted.hits.dailyHalt).toBe(1);
  expect(halted.hits.weeklyHalt).toBe(1);
  expect(halted.hits.bookHalt).toBe(1);
  expect(halted.hits.dailyBackstop).toBe(1);
  expect(halted.hits.classRKill).toBe(1);
});

test("a 24h re-entry is blocked and the same name is allowed once 24h have passed", () => {
  const exitAt = 900;
  const tooSoon = exitAt + day - 900;
  const allowed = exitAt + day;
  const bars = new Map([
    [0, bar(0, 100, 99, 100)],
    [exitAt, bar(exitAt, 80, 79, 80)],
    [tooSoon, bar(tooSoon, 100, 99, 100)],
    [allowed, bar(allowed, 100, 99, 100)],
  ]);
  const result = runBook({
    pairs: [pair("AAA", bars)],
    candidates: [
      { classId: "B", productId: "AAA", signalDate: "1970-01-01", entryTs: 0, stopDistance: 10 },
      { classId: "B", productId: "AAA", signalDate: "1970-01-01", entryTs: tooSoon, stopDistance: 10 },
      { classId: "B", productId: "AAA", signalDate: "1970-01-02", entryTs: allowed, stopDistance: 10 },
    ],
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: allowed + 900,
  });
  expect(result.hits.reentry).toBe(1);
  expect(result.taken).toBe(2);
});

test("average linkage keeps non-members and short histories out of the cluster", () => {
  const build = (n: number, sign = 1) => {
    const days = [{ date: "2025-10-11", close: 100 }];
    for (let i = 1; i <= n; i += 1) {
      const prev = days[days.length - 1]!.close;
      const shock = ((i % 5) - 2) * 0.01;
      days.push({
        date: new Date(Date.parse("2025-10-11T00:00:00.000Z") + i * 86_400_000).toISOString().slice(0, 10),
        close: prev * (1 + sign * shock),
      });
    }
    return days;
  };
  const flags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };
  const days = build(80);
  const map = monthlyClusters(
    [
      { productId: "AAA", flags, days },
      { productId: "BBB", flags, days: build(80) },
      { productId: "OUT", flags, days },
      { productId: "SHORT", flags, days: build(10) },
    ],
    ["2026-01-01"],
    (id) => id !== "OUT",
  );
  const month = map.get("2026-01-01")!;
  expect(month.has("OUT")).toBe(false);
  expect(month.get("AAA")).toBe(month.get("BBB"));
  expect(month.get("SHORT")).toBe("SHORT");
  expect(month.get("SHORT")).not.toBe(month.get("AAA"));
});

test("chase, ten-day close, stop, and per-fold purge stay on the v3.1 side of the probes", () => {
  expect(classAChaseSkip(105, 100, 10)).toBe(false);
  expect(classAChaseSkip(106, 100, 10)).toBe(true);
  expect(classATenDayExit(9, [11, 10, 10, 10, 10, 10, 10, 10, 10, 12])).toBe(true);
  expect(classATenDayExit(11, [9, 9, 9, 9, 9, 9, 9, 9, 9, 9])).toBe(false);
  const fold = expandingFolds()[0]!;
  const crossing = { entryDate: "2026-02-01", exitDate: "2026-02-11", netUsd: 40 };
  const kept = { entryDate: "2026-01-15", exitDate: "2026-01-20", netUsd: 5 };
  expect(purgedAtBoundary(crossing.entryDate, crossing.exitDate, fold.oosStart)).toBe(true);
  const picked = selectByFold(
    ["A20-k2", "A55-k3"],
    [fold],
    (id) => (id === "A55-k3" ? [kept, crossing] : [{ ...kept, netUsd: 1 }]),
    (trades) => trades.reduce((sum, trade) => sum + trade.netUsd, 0),
    (trades) => trades.reduce((sum, trade) => sum + trade.netUsd, 0),
  );
  expect(picked[0]?.chosen).toBe("A55-k3");
});
