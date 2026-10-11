import { expect, test } from "bun:test";
import { monthlyClusters, runBook, singleLinkage, trailingReturns, type BookPair } from "./book";

function pair(productId: string, bars: BookPair["bars"], cluster = productId, daily?: BookPair["daily"], atr1h = 0): BookPair {
  return {
    productId,
    bars,
    daily: daily ?? new Map(),
    atr1h: () => atr1h,
    clusterOf: () => cluster,
  };
}

function bar(ts: number, open: number, low: number, close = open, high = Math.max(open, close)) {
  return { ts, open, high, low, close };
}

test("the fourth class A entry is blocked by the slot cap", () => {
  const quiet = new Map([[0, bar(0, 100, 99, 100)]]);
  const result = runBook({
    pairs: ["A", "B", "C", "D"].map((id) => pair(id, quiet)),
    candidates: ["A", "B", "C", "D"].map((id) => ({ classId: "A" as const, productId: id, signalDate: "1970-01-01", entryTs: 0, stopDistance: 10 })),
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: 900,
  });
  expect(result.taken).toBe(3);
  expect(result.hits.slotA).toBe(1);
  expect(result.betaApplied).toBe(false);
});

test("a third name in one cluster is blocked", () => {
  const quiet = new Map([[0, bar(0, 100, 99, 100)]]);
  const result = runBook({
    pairs: ["A", "B", "C"].map((id) => pair(id, quiet, "same")),
    candidates: ["A", "B", "C"].map((id) => ({ classId: "A" as const, productId: id, signalDate: "1970-01-01", entryTs: 0, stopDistance: 10 })),
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: 900,
  });
  expect(result.taken).toBe(2);
  expect(result.hits.cluster).toBe(1);
});

test("a stop fill uses the larger of s_bt and 0.1 times the 1h ATR", () => {
  const bars = new Map([
    [0, bar(0, 100, 99, 100)],
    [900, bar(900, 95, 80, 90)],
  ]);
  const result = runBook({
    pairs: [pair("AAA", bars, "AAA", new Map(), 20)],
    candidates: [{ classId: "B", productId: "AAA", signalDate: "1970-01-01", entryTs: 0, stopDistance: 10 }],
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: 1800,
  });
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0]?.reason).toBe("stop");
  expect(result.trades[0]?.rawExit).toBeCloseTo(90, 8);
  expect(result.trades[0]?.fillExit).toBeCloseTo(88, 8);
  expect(result.trades[0]?.entryFeeBps).toBe(90);
  expect(result.trades[0]?.exitFeeBps).toBe(90);
});

test("a gap loss trips the daily halt before the next entry", () => {
  const first = new Map([
    [0, bar(0, 100, 99, 100)],
    [900, bar(900, 50, 49, 50)],
  ]);
  const second = new Map([[900, bar(900, 100, 99, 100)]]);
  const result = runBook({
    pairs: [pair("AAA", first), pair("BBB", second)],
    candidates: [
      { classId: "B", productId: "AAA", signalDate: "1970-01-01", entryTs: 0, stopDistance: 10 },
      { classId: "B", productId: "BBB", signalDate: "1970-01-01", entryTs: 900, stopDistance: 10 },
    ],
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: 1800,
  });
  expect(result.taken).toBe(1);
  expect(result.hits.dailyHalt).toBe(1);
  expect(result.trades[0]?.netUsd).toBeLessThan(-240);
});

test("the chandelier uses the completed daily close and waits for the next bar", () => {
  const day = 86_400;
  const bars = new Map([
    [0, bar(0, 100, 99, 100)],
    [day - 900, bar(day - 900, 100, 99, 100)],
    [day, bar(day, 100, 99, 100)],
  ]);
  const daily = new Map([["1970-01-01", { close: 110, low: 99, atr: 2 }]]);
  const result = runBook({
    pairs: [pair("AAA", bars, "AAA", daily)],
    candidates: [{ classId: "A", productId: "AAA", signalDate: "1969-12-31", entryTs: 0, stopDistance: 20 }],
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: day + 900,
  });
  expect(result.trades).toHaveLength(1);
  expect(result.trades[0]?.exitTs).toBe(day);
  expect(result.trades[0]?.reason).toBe("gap");
  expect(result.trades[0]?.rawExit).toBe(100);
});

test("an open trade at the window end is flagged", () => {
  const quiet = new Map([[0, bar(0, 100, 99, 101)]]);
  const result = runBook({
    pairs: [pair("AAA", quiet)],
    candidates: [{ classId: "A", productId: "AAA", signalDate: "1970-01-01", entryTs: 0, stopDistance: 10 }],
    ruleExitTs: () => null,
    sBtBps: 5,
    endTs: 900,
  });
  expect(result.trades[0]?.reason).toBe("window");
  expect(result.trades[0]?.windowMark).toBe(true);
  expect(result.trades[0]?.rawExit).toBe(101);
});

test("single linkage joins through a middle name", () => {
  const clusters = singleLinkage(["C", "A", "B"], [["A", "B"], ["B", "C"]]);
  expect(clusters.get("A")).toBe("A");
  expect(clusters.get("B")).toBe("A");
  expect(clusters.get("C")).toBe("A");
  const build = (sign: number) => {
    const days = [{ date: "2025-10-11", close: 100 }];
    for (let i = 1; i <= 80; i += 1) {
      const prev = days[days.length - 1]!.close;
      const shock = ((i % 5) - 2) * 0.01;
      days.push({
        date: new Date(Date.parse("2025-10-11T00:00:00.000Z") + i * 86_400_000).toISOString().slice(0, 10),
        close: prev * (1 + sign * shock),
      });
    }
    return days;
  };
  const days = build(1);
  const flags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };
  const map = monthlyClusters(
    [
      { productId: "AAA", flags, days },
      { productId: "BBB", flags, days: build(1) },
      { productId: "CCC", flags, days: build(-1) },
    ],
    ["2026-01-01"],
  );
  const month = map.get("2026-01-01")!;
  expect(month.get("AAA")).toBe(month.get("BBB"));
  expect(month.get("CCC")).not.toBe(month.get("AAA"));
  expect(trailingReturns(days, "2026-01-01").size).toBe(60);
});
