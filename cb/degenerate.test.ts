import { expect, test } from "bun:test";
import { PairVetoes, VETO_MIN_DISTINCT, VETO_PERCENTILE, VETO_WARM_SAMPLES, distinctCount } from "./vetoes";

const ring = (toxic: (i: number) => number, stress: (i: number) => number, n = VETO_WARM_SAMPLES) =>
  Array.from({ length: n }, (_, i) => ({ ts: i, toxicPHigh: toxic(i), stressPStressed: stress(i) }));

const spread = (i: number) => i / (VETO_WARM_SAMPLES - 1);

test("the degenerate floor is 20 distinct values and the percentile is untouched at 0.85", () => {
  expect(VETO_MIN_DISTINCT).toBe(20);
  expect(VETO_PERCENTILE).toBe(0.85);
  expect(VETO_WARM_SAMPLES).toBe(200);
});

test("distinctCount counts unique probabilities", () => {
  expect(distinctCount([])).toBe(0);
  expect(distinctCount([0.5, 0.5, 0.5])).toBe(1);
  expect(distinctCount([0.1, 0.2, 0.1, 0.3])).toBe(3);
});

test("200 identical toxic probabilities veto from the rule and report rule_degenerate", () => {
  const v = new PairVetoes();
  v.seed(ring(() => 0.42, spread));
  const out = v.decide({ ts: VETO_WARM_SAMPLES, toxicPHigh: 0.42, stressPStressed: 0.9, ruleToxic: false, ruleStress: false });
  expect(out.toxicSource).toBe("rule_degenerate");
  expect(out.toxicVeto).toBe(false);
});

test("a degenerate ring still vetoes when the deterministic label says so", () => {
  const v = new PairVetoes();
  v.seed(ring(() => 0.42, spread));
  const out = v.decide({ ts: VETO_WARM_SAMPLES, toxicPHigh: 0.99, stressPStressed: 0.1, ruleToxic: true, ruleStress: false });
  expect(out.toxicSource).toBe("rule_degenerate");
  expect(out.toxicVeto).toBe(true);
});

test("each field is judged on its own ring, so a tied toxic ring does not drag stress onto the fallback", () => {
  const v = new PairVetoes();
  v.seed(ring(() => 0.42, spread));
  const out = v.decide({ ts: VETO_WARM_SAMPLES, toxicPHigh: 0.42, stressPStressed: 0.99, ruleToxic: false, ruleStress: false });
  expect(out.toxicSource).toBe("rule_degenerate");
  expect(out.stressSource).toBe("jev");
  expect(out.stressVeto).toBe(true);
});

test("a tied stress ring reports rule_degenerate on stress alone", () => {
  const v = new PairVetoes();
  v.seed(ring(spread, () => 0.3));
  const out = v.decide({ ts: VETO_WARM_SAMPLES, toxicPHigh: 0.99, stressPStressed: 0.3, ruleToxic: false, ruleStress: true });
  expect(out.toxicSource).toBe("jev");
  expect(out.toxicVeto).toBe(true);
  expect(out.stressSource).toBe("rule_degenerate");
  expect(out.stressVeto).toBe(true);
});

test("exactly 19 distinct values is degenerate and exactly 20 is not", () => {
  const nineteen = new PairVetoes();
  nineteen.seed(ring((i) => (i % 19) / 100, spread));
  expect(nineteen.decide({ ts: 1_000, toxicPHigh: 0.5, stressPStressed: 0.5, ruleToxic: false, ruleStress: false }).toxicSource).toBe(
    "rule_degenerate",
  );

  const twenty = new PairVetoes();
  twenty.seed(ring((i) => (i % 20) / 100, spread));
  expect(twenty.decide({ ts: 1_000, toxicPHigh: 0.5, stressPStressed: 0.5, ruleToxic: false, ruleStress: false }).toxicSource).toBe("jev");
});

test("a cold ring is plain rule, never rule_degenerate, however tied it is", () => {
  const v = new PairVetoes();
  v.seed(ring(() => 0.42, () => 0.42, VETO_WARM_SAMPLES - 1));
  const out = v.decide({ ts: 1_000, toxicPHigh: 0.42, stressPStressed: 0.42, ruleToxic: true, ruleStress: false });
  expect(out.toxicSource).toBe("rule");
  expect(out.stressSource).toBe("rule");
  expect(out.toxicVeto).toBe(true);
});

test("a spread warm ring is unaffected by the guard", () => {
  const v = new PairVetoes();
  v.seed(ring(spread, spread));
  const high = v.decide({ ts: 1_000, toxicPHigh: 0.9, stressPStressed: 0.9, ruleToxic: false, ruleStress: false });
  expect(high.toxicSource).toBe("jev");
  expect(high.toxicVeto).toBe(true);
  const low = v.decide({ ts: 1_001, toxicPHigh: 0.1, stressPStressed: 0.1, ruleToxic: true, ruleStress: true });
  expect(low.toxicSource).toBe("jev");
  expect(low.toxicVeto).toBe(false);
});
