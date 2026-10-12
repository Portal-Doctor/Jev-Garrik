/**
 * Random-exit draws. Only bars at or below +1R are eligible.
 * The RNG is injected. See open question placebo-seed.
 */

export function placeboExitIndexes(unrealizedR: readonly number[], draws: number, rng: () => number): number[] {
  const eligible = unrealizedR.map((value, index) => ({ index, value })).filter((row) => row.value <= 1);
  const picked: number[] = [];
  const pool = eligible.map((row) => row.index);
  const n = Math.min(draws, pool.length);
  for (let i = 0; i < n; i += 1) {
    const slot = Math.min(pool.length - 1, Math.floor(rng() * pool.length));
    const index = pool.splice(slot, 1)[0];
    if (index != null) picked.push(index);
  }
  return picked;
}
