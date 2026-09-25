import { expect, test } from "bun:test";
import { PairVetoes, quantile, sampleFromState, VETO_WARM_SAMPLES } from "./vetoes";

test("with 200 samples uniform 0 to 1, 0.9 vetoes and 0.8 does not", () => {
  const ring = new PairVetoes();
  const start = 1_700_000_000_000;
  ring.seed(
    Array.from({ length: VETO_WARM_SAMPLES }, (_, i) => ({
      ts: start + i * 1_000,
      toxicPHigh: i / (VETO_WARM_SAMPLES - 1),
      stressPStressed: i / (VETO_WARM_SAMPLES - 1),
    })),
  );
  const high = ring.decide({
    ts: start + VETO_WARM_SAMPLES * 1_000,
    toxicPHigh: 0.9,
    stressPStressed: 0.9,
    ruleToxic: false,
    ruleStress: false,
  });
  expect(high.toxicSource).toBe("jev");
  expect(high.stressSource).toBe("jev");
  expect(high.toxicVeto).toBe(true);
  expect(high.stressVeto).toBe(true);

  const mid = new PairVetoes();
  mid.seed(
    Array.from({ length: VETO_WARM_SAMPLES }, (_, i) => ({
      ts: start + i * 1_000,
      toxicPHigh: i / (VETO_WARM_SAMPLES - 1),
      stressPStressed: i / (VETO_WARM_SAMPLES - 1),
    })),
  );
  const low = mid.decide({
    ts: start + VETO_WARM_SAMPLES * 1_000,
    toxicPHigh: 0.8,
    stressPStressed: 0.8,
    ruleToxic: true,
    ruleStress: true,
  });
  expect(low.toxicSource).toBe("jev");
  expect(low.toxicVeto).toBe(false);
  expect(low.stressVeto).toBe(false);
});

test("under 200 samples the deterministic label decides", () => {
  const ring = new PairVetoes();
  ring.seed(
    Array.from({ length: 199 }, (_, i) => ({
      ts: i,
      toxicPHigh: 0.99,
      stressPStressed: 0.99,
    })),
  );
  const byRule = ring.decide({
    ts: 1_000,
    toxicPHigh: 0.99,
    stressPStressed: 0.01,
    ruleToxic: false,
    ruleStress: true,
  });
  expect(byRule.toxicSource).toBe("rule");
  expect(byRule.stressSource).toBe("rule");
  expect(byRule.toxicVeto).toBe(false);
  expect(byRule.stressVeto).toBe(true);
});

test("sampleFromState reads probabilities and falls back to labels", () => {
  expect(
    sampleFromState(10, {
      vector: { toxicPHigh: 0.7, stressPStressed: 0.2, toxic_flow_risk: "low", liquidity_stress: "stressed" },
    }),
  ).toEqual({ ts: 10, toxicPHigh: 0.7, stressPStressed: 0.2 });
  expect(
    sampleFromState(11, {
      vector: { toxic_flow_risk: "high", liquidity_stress: "normal" },
    }),
  ).toEqual({ ts: 11, toxicPHigh: 1, stressPStressed: 0 });
  expect(sampleFromState(12, { pair: "UNI-USD" })).toBeNull();
});

test("quantile of a uniform 0 to 1 ring sits at the asked percentile", () => {
  const values = Array.from({ length: 200 }, (_, i) => i / 199);
  expect(quantile(values, 0.85)).toBeCloseTo(0.85, 2);
});
