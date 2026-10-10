import { expect, test } from "bun:test";
import { findSetups, type DecisionSnapshot } from "./src/rules";

function snap(patch: Partial<DecisionSnapshot> = {}): DecisionSnapshot {
  return {
    pair: "UNI-USD",
    barTs: 1,
    close: 100,
    low: 97,
    high: 101,
    prevClose: 100,
    prevVwap: 99,
    vwap: 99,
    ema9: 98,
    ema20: 97,
    ema50: 90,
    ema200: 80,
    rsi: 50,
    macd: 1,
    macdSignal: 0.4,
    atr: 2,
    volume: 20,
    volSma20: 10,
    recentLow3: 94,
    donchian5mPriorHigh: 110,
    close4h: 90,
    donchian4hPriorHigh: 100,
    biasKnown: true,
    biasUp: true,
    ...patch,
  };
}

test("setup A is the pullback and is the only setup when sentiment is unknown", () => {
  const clear = findSetups(snap(), "clear");
  expect(clear.map((c) => c.setup)).toEqual(["A"]);
  const caution = findSetups(snap(), "unknown");
  expect(caution.map((c) => c.setup)).toEqual(["A"]);
  expect(caution[0]?.originatedFromSentiment).toBe(false);
  expect(findSetups(snap(), "veto")).toEqual([]);
  expect(findSetups(snap({ biasUp: false }), "clear")).toEqual([]);
  expect(findSetups(snap({ ema200: null }), "clear")).toEqual([]);
});

test("setup B is a VWAP reclaim and setup C is a Donchian break, only when sentiment is clear", () => {
  const b = snap({ low: 99, ema20: 96, prevClose: 98, prevVwap: 99, vwap: 99, close: 100 });
  expect(findSetups(b, "clear").map((c) => c.setup)).toContain("B");
  expect(findSetups(b, "unknown").some((c) => c.setup === "B")).toBe(false);

  const c = snap({
    low: 99,
    ema20: 96,
    close: 111,
    donchian5mPriorHigh: 110,
    close4h: 101,
    donchian4hPriorHigh: 100,
    rsi: 60,
    recentLow3: 100,
  });
  expect(findSetups(c, "clear").map((cnd) => cnd.setup)).toContain("C");
  expect(findSetups(c, "clear", "C").every((cnd) => cnd.setup === "C")).toBe(true);
  expect(findSetups(c, "unknown").some((cnd) => cnd.setup === "C")).toBe(false);
});
