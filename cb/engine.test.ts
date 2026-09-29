import { test, expect } from "bun:test";
import { applyEntryVetoes, withDeadline } from "./engine";
import type { DecisionVector } from "./gate";
import type { VetoDecision } from "./vetoes";

const vector: DecisionVector = {
  market_regime: "expansion",
  direction_bias: "long",
  toxic_flow_risk: "low",
  liquidity_stress: "normal",
  confidence: 0.9,
  toxicPHigh: 0.95,
  stressPStressed: 0.1,
};

const veto = (toxicVeto: boolean, stressVeto: boolean): VetoDecision => ({
  toxicVeto,
  toxicSource: "jev",
  stressVeto,
  stressSource: "jev",
});

test("a fired toxic veto no longer reaches the gate vector", () => {
  const applied = applyEntryVetoes({ ...vector, toxic_flow_risk: "low" }, veto(true, false));
  expect(applied.toxic_flow_risk).toBe("low");
  expect(applied.liquidity_stress).toBe("normal");
});

test("the stress veto still reaches the gate vector", () => {
  expect(applyEntryVetoes(vector, veto(false, true)).liquidity_stress).toBe("stressed");
  expect(applyEntryVetoes({ ...vector, liquidity_stress: "stressed" }, veto(false, false)).liquidity_stress).toBe("normal");
});

test("Jev's own toxic label survives untouched so the probability stays auditable", () => {
  const applied = applyEntryVetoes({ ...vector, toxic_flow_risk: "high" }, veto(false, false));
  expect(applied.toxic_flow_risk).toBe("high");
  expect(applied.toxicPHigh).toBe(0.95);
});

test("withDeadline resolves when the work finishes in time", async () => {
  await expect(withDeadline(Promise.resolve(7), 50, "fast")).resolves.toBe(7);
});

test("withDeadline rejects a hung promise so a pair can fire again", async () => {
  const hung = new Promise<number>(() => {});
  await expect(withDeadline(hung, 20, "decide AVAX-USD")).rejects.toThrow("decide AVAX-USD timed out after 20ms");
});
