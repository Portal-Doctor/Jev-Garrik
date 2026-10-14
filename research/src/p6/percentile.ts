/**
 * Index ceil(p * n) - 1 on the sorted sample. See open question quantile.
 * An empty sample has no percentile.
 */

export function empiricalQuantile(values: readonly number[], p: number): number | null {
  if (values.length === 0 || !(p > 0) || p > 1) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index] ?? null;
}

export function atOrAboveQuantile(value: number, history: readonly number[], p: number): boolean {
  const cutoff = empiricalQuantile(history, p);
  return cutoff != null && value >= cutoff;
}
