import { expect, test } from "bun:test";
import {
  TP_FILL_SAMPLE_MIN,
  TP_MAKER_SHARE_MIN,
  TP_TICK_MS,
  buildHoldTrendWindow,
  scoreRestingAsk,
  scoreTakeProfitMakerShare,
} from "./report";

const fill = (at: number, pair = "UNI-USD") => ({ pair, at });

test("the check 2 thresholds are the ones Brian signed off", () => {
  expect(TP_TICK_MS).toBe(1_000);
  expect(TP_FILL_SAMPLE_MIN).toBe(5);
  expect(TP_MAKER_SHARE_MIN).toBe(0.8);
});

test("no filled longs is no sample, not a pass", () => {
  expect(scoreRestingAsk([], []).verdict).toBe("no sample");
  expect(scoreRestingAsk([], [fill(10)]).verdict).toBe("no sample");
});

test("an ask in the same millisecond as the fill passes", () => {
  const r = scoreRestingAsk([fill(1_000)], [fill(1_000)]);
  expect(r.verdict).toBe("pass");
  expect(r.withAskWithinOneTick).toBe(1);
  expect(r.maxLagMs).toBe(0);
});

test("an ask at exactly one tick passes and one millisecond later fails", () => {
  expect(scoreRestingAsk([fill(1_000)], [fill(2_000)]).verdict).toBe("pass");
  expect(scoreRestingAsk([fill(1_000)], [fill(2_001)]).verdict).toBe("fail");
});

test("an ask placed before the fill does not count", () => {
  const r = scoreRestingAsk([fill(2_000)], [fill(1_999)]);
  expect(r.verdict).toBe("fail");
  expect(r.withAskWithinOneTick).toBe(0);
});

test("one uncovered long out of three fails the check", () => {
  const r = scoreRestingAsk([fill(1_000), fill(5_000), fill(9_000)], [fill(1_000), fill(5_500)]);
  expect(r.filledLongs).toBe(3);
  expect(r.withAskWithinOneTick).toBe(2);
  expect(r.maxLagMs).toBe(500);
  expect(r.verdict).toBe("fail");
});

test("an ask on another pair does not cover a long", () => {
  expect(scoreRestingAsk([fill(1_000, "UNI-USD")], [fill(1_000, "NEAR-USD")]).verdict).toBe("fail");
});

test("under five take-profit fills the maker share is no sample, not fail", () => {
  const four = scoreTakeProfitMakerShare([{ liquidity: "taker" }, { liquidity: "taker" }, { liquidity: "taker" }, { liquidity: "taker" }]);
  expect(four.verdict).toBe("no sample");
  expect(four.makerShare).toBe(0);
  expect(scoreTakeProfitMakerShare([]).verdict).toBe("no sample");
  expect(scoreTakeProfitMakerShare([]).makerShare).toBeNull();
});

test("five fills at exactly 80% maker passes and four of five fails", () => {
  const maker = (n: number) => Array.from({ length: n }, () => ({ liquidity: "maker" }));
  const taker = (n: number) => Array.from({ length: n }, () => ({ liquidity: "taker" }));
  expect(scoreTakeProfitMakerShare([...maker(4), ...taker(1)]).verdict).toBe("pass");
  expect(scoreTakeProfitMakerShare([...maker(4), ...taker(1)]).makerShare).toBeCloseTo(0.8);
  expect(scoreTakeProfitMakerShare([...maker(3), ...taker(2)]).verdict).toBe("fail");
});

test("the window groups partial entry legs into one long and scores the completing fill", () => {
  const w = buildHoldTrendWindow({
    notionalUsd: 600,
    decisions: [],
    outcomes: [],
    // Three legs of one entry order. Only the last leg is the completing fill.
    fills: [
      { run_id: "r1", purpose: "entry", decision_id: "d", order_id: "o1", liquidity: "maker", side: "buy", traded_at: 1_000 },
      { run_id: "r1", purpose: "entry", decision_id: "d", order_id: "o1", liquidity: "maker", side: "buy", traded_at: 2_000 },
      { run_id: "r1", purpose: "entry", decision_id: "d", order_id: "o1", liquidity: "maker", side: "buy", traded_at: 3_000 },
    ],
    takeProfitOrders: [{ run_id: "r1", created_at: 3_000 }],
  });
  expect(w.restingAsk.filledLongs).toBe(1);
  expect(w.restingAsk.verdict).toBe("pass");
  expect(w.restingAsk.maxLagMs).toBe(0);
});

test("the window reports no sample for the maker share when the take-profit never fills", () => {
  const w = buildHoldTrendWindow({
    notionalUsd: 600,
    decisions: [],
    outcomes: [],
    fills: [
      { run_id: "r1", purpose: "entry", decision_id: "d", order_id: "o1", liquidity: "maker", side: "buy", traded_at: 1_000 },
      { run_id: "r1", purpose: "stop", decision_id: null, order_id: "o2", liquidity: "taker", side: "sell", traded_at: 9_000 },
    ],
    takeProfitOrders: [{ run_id: "r1", created_at: 1_000 }],
  });
  expect(w.restingAsk.verdict).toBe("pass");
  expect(w.takeProfitMaker.fills).toBe(0);
  expect(w.takeProfitMaker.verdict).toBe("no sample");
});

test("an ask outside the window does not cover a long inside it", () => {
  const w = buildHoldTrendWindow({
    notionalUsd: 600,
    decisions: [],
    outcomes: [],
    fromTs: 5_000,
    fills: [
      { run_id: "r1", purpose: "entry", decision_id: "d", order_id: "o1", liquidity: "maker", side: "buy", traded_at: 6_000 },
    ],
    takeProfitOrders: [{ run_id: "r1", created_at: 4_000 }],
  });
  expect(w.restingAsk.filledLongs).toBe(1);
  expect(w.restingAsk.verdict).toBe("fail");
});
