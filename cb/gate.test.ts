import { test, expect } from "bun:test";
import { assertTakeProfitClearsFees, evaluateGate, guardTrip, type GateInput } from "./gate";

function input(over: Partial<GateInput> = {}): GateInput {
  return {
    position: "flat",
    vector: {
      market_regime: "expansion",
      direction_bias: "long",
      toxic_flow_risk: "low",
      liquidity_stress: "normal",
      confidence: 0.9,
    },
    horizonVolBps: 800,
    spreadBps: 2,
    makerFeeBps: 50,
    takerFeeBps: 90,
    feeBuffer: 1.5,
    buyThreshold: 0.7,
    sellThreshold: 0.4,
    depthUsd: 100_000,
    notionalUsd: 600,
    participation: 0.25,
    minSizeUsd: 25,
    remainingGrossUsd: Number.POSITIVE_INFINITY,
    halted: false,
    feedBlocked: false,
    emaCross: "above",
    h4ReturnBps: 0,
    stopLossBps: 295,
    takeProfitBps: 1180,
    ...over,
  };
}

test("flat with the average stack not up refuses trend even at high confidence", () => {
  const r = evaluateGate(
    input({
      emaCross: "flat",
      vector: { ...input().vector, confidence: 0.9, market_regime: "expansion" },
    }),
  );
  expect(r.approved).toBe(false);
  expect(r.reason).toBe("trend");
  expect(r.expectedYieldBps).toBeGreaterThan(0);
});

test("flat with the average stack up and toxic flow refuses toxic flow", () => {
  const r = evaluateGate(input({ vector: { ...input().vector, toxic_flow_risk: "high" } }));
  expect(r.approved).toBe(false);
  expect(r.reason).toBe("toxic flow");
});

test("flat with the average stack up refuses a chase past the stop", () => {
  const r = evaluateGate(input({ h4ReturnBps: 296, stopLossBps: 295 }));
  expect(r.approved).toBe(false);
  expect(r.reason).toBe("chase");
});

test("flat with the average stack up and a clear veto approves even when the bias is flat", () => {
  const r = evaluateGate(
    input({
      vector: { ...input().vector, direction_bias: "flat", confidence: 0.2, market_regime: "balance" },
    }),
  );
  expect(r.approved).toBe(true);
  expect(r.target).toBe("long");
  expect(r.reason).toBeNull();
  expect(r.sizeUsd).toBe(600);
});

test("a payoff under two to one refuses the entry", () => {
  const r = evaluateGate(input({ takeProfitBps: 590, stopLossBps: 295 }));
  expect(r.approved).toBe(false);
  expect(r.reason).toBe("payoff");
});

test("gross cap refuses a residual under the minimum and clips a residual that still clears it", () => {
  const blocked = evaluateGate(input({ remainingGrossUsd: 10, notionalUsd: 600 }));
  expect(blocked.approved).toBe(false);
  expect(blocked.reason).toBe("gross cap");
  const clipped = evaluateGate(input({ remainingGrossUsd: 200, notionalUsd: 600 }));
  expect(clipped.approved).toBe(true);
  expect(clipped.sizeUsd).toBe(200);
});

test("gate refuses when depth sizes the order to dust", () => {
  const r = evaluateGate(input({ depthUsd: 40 }));
  expect(r.approved).toBe(false);
  expect(r.reason).toBe("dust");
  expect(r.sizeUsd).toBeCloseTo(10);
});

test("a long stays open when confidence falls and flattens when the regime contracts", () => {
  const held = evaluateGate(
    input({
      position: "long",
      vector: { ...input().vector, confidence: 0.2, market_regime: "expansion", toxic_flow_risk: "low" },
    }),
  );
  expect(held.target).toBe("long");
  expect(held.reason).toBeNull();

  const toxic = evaluateGate(
    input({
      position: "long",
      vector: { ...input().vector, toxic_flow_risk: "high", confidence: 0.95 },
    }),
  );
  expect(toxic.target).toBe("flat");
  expect(toxic.reason).toBe("toxic flow");

  const contracted = evaluateGate(
    input({
      position: "long",
      vector: { ...input().vector, market_regime: "contraction", confidence: 0.9 },
    }),
  );
  expect(contracted.target).toBe("flat");
  expect(contracted.reason).toBe("regime");
});

test("boot refuses a take-profit that does not clear maker plus taker fees", () => {
  expect(() => assertTakeProfitClearsFees(140, 50, 90)).toThrow(/maker plus taker/);
  expect(() => assertTakeProfitClearsFees(50 + 90, 50, 90)).toThrow(/maker plus taker/);
  expect(() => assertTakeProfitClearsFees(141, 50, 90)).not.toThrow();
});

test("stop and take-profit measure the fee-inclusive entry, and a flat mid does not trip", () => {
  expect(guardTrip(100, 98.5, 150, 250)).toBe("stop");
  expect(guardTrip(100, 102.5, 150, 250)).toBe("take_profit");
  expect(guardTrip(100, 100, 150, 250)).toBeNull();
  expect(guardTrip(100, 99, 150, 250)).toBeNull();
});
