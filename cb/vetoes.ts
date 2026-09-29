/**
 * Per-pair entry veto calibration (hold-the-trend plan section 3).
 * Until a pair has 200 samples, the deterministic label decides.
 * After that, veto when Jev's probability sits above the rolling 85th percentile.
 *
 * A warm ring whose probabilities are tied cannot be calibrated: a percentile over a handful of
 * repeated values is not a percentile. Such a ring falls back to the deterministic label and says
 * so with `rule_degenerate`, rather than quietly under-vetoing. The percentile itself is never
 * moved to make a rate land in a band.
 */

export type VetoSource = "jev" | "rule" | "rule_degenerate";

export interface VetoSample {
  ts: number;
  toxicPHigh: number;
  stressPStressed: number;
}

export interface VetoDecision {
  toxicVeto: boolean;
  toxicSource: VetoSource;
  stressVeto: boolean;
  stressSource: VetoSource;
}

export const VETO_RING_MS = 7 * 86_400_000;
export const VETO_WARM_SAMPLES = 200;
export const VETO_PERCENTILE = 0.85;
/** A warm ring with fewer distinct probabilities than this cannot be calibrated. */
export const VETO_MIN_DISTINCT = 20;

export function distinctCount(values: number[]): number {
  return new Set(values).size;
}

export function quantile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const a = sorted[lo]!;
  const b = sorted[hi]!;
  if (lo === hi) return a;
  return a + (b - a) * (idx - lo);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object") return value as Record<string, unknown>;
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Pull a ring sample off a stored decision. Missing probabilities fall back to the label. */
export function sampleFromState(ts: number, state: unknown): VetoSample | null {
  const root = asRecord(state);
  if (!root) return null;
  const vector = asRecord(root.vector) ?? {};
  const toxicP = num(vector.toxicPHigh);
  const stressP = num(vector.stressPStressed);
  const toxicFromLabel = vector.toxic_flow_risk === "high" ? 1 : vector.toxic_flow_risk === "low" ? 0 : null;
  const stressFromLabel = vector.liquidity_stress === "stressed" ? 1 : vector.liquidity_stress === "normal" ? 0 : null;
  const toxicPHigh = toxicP ?? toxicFromLabel;
  const stressPStressed = stressP ?? stressFromLabel;
  if (toxicPHigh == null || stressPStressed == null) return null;
  return { ts, toxicPHigh, stressPStressed };
}

export class PairVetoes {
  private ring: VetoSample[] = [];

  size(): number {
    return this.ring.length;
  }

  seed(samples: VetoSample[]): void {
    this.ring = samples
      .filter((s) => Number.isFinite(s.ts) && Number.isFinite(s.toxicPHigh) && Number.isFinite(s.stressPStressed))
      .slice()
      .sort((a, b) => a.ts - b.ts);
    this.trim(this.ring.at(-1)?.ts ?? Date.now());
  }

  decide(input: {
    ts: number;
    toxicPHigh: number;
    stressPStressed: number;
    ruleToxic: boolean;
    ruleStress: boolean;
  }): VetoDecision {
    this.trim(input.ts);
    const warm = this.ring.length >= VETO_WARM_SAMPLES;
    const toxic = this.judge(this.ring.map((s) => s.toxicPHigh), input.toxicPHigh, input.ruleToxic, warm);
    const stress = this.judge(this.ring.map((s) => s.stressPStressed), input.stressPStressed, input.ruleStress, warm);
    this.ring.push({
      ts: input.ts,
      toxicPHigh: input.toxicPHigh,
      stressPStressed: input.stressPStressed,
    });
    this.trim(input.ts);
    return {
      toxicVeto: toxic.veto,
      toxicSource: toxic.source,
      stressVeto: stress.veto,
      stressSource: stress.source,
    };
  }

  /**
   * Each field is judged on its own ring, so a tied toxic ring does not drag the stress veto
   * onto the fallback with it.
   */
  private judge(ring: number[], current: number, ruleSaysVeto: boolean, warm: boolean): { veto: boolean; source: VetoSource } {
    if (!warm) return { veto: ruleSaysVeto, source: "rule" };
    if (distinctCount(ring) < VETO_MIN_DISTINCT) return { veto: ruleSaysVeto, source: "rule_degenerate" };
    return { veto: current > quantile(ring, VETO_PERCENTILE), source: "jev" };
  }

  private trim(now: number): void {
    const floor = now - VETO_RING_MS;
    if (this.ring.length === 0) return;
    const firstKeep = this.ring.findIndex((s) => s.ts >= floor);
    if (firstKeep <= 0) {
      if (firstKeep === -1) this.ring = [];
      return;
    }
    this.ring = this.ring.slice(firstKeep);
  }
}
