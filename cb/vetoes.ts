/**
 * Per-pair entry veto calibration (hold-the-trend plan section 3).
 * Until a pair has 200 samples, the deterministic label decides.
 * After that, veto when Jev's probability sits above the rolling 85th percentile.
 */

export type VetoSource = "jev" | "rule";

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
    const toxicVeto = warm ? input.toxicPHigh > quantile(this.ring.map((s) => s.toxicPHigh), VETO_PERCENTILE) : input.ruleToxic;
    const stressVeto = warm
      ? input.stressPStressed > quantile(this.ring.map((s) => s.stressPStressed), VETO_PERCENTILE)
      : input.ruleStress;
    this.ring.push({
      ts: input.ts,
      toxicPHigh: input.toxicPHigh,
      stressPStressed: input.stressPStressed,
    });
    this.trim(input.ts);
    const source: VetoSource = warm ? "jev" : "rule";
    return {
      toxicVeto,
      toxicSource: source,
      stressVeto,
      stressSource: source,
    };
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
