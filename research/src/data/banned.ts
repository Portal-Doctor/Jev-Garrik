const BANNED = /pnl|p&l|return|profit|drawdown|forward|hitrate|hit_rate|gross|net_bps|netbps/i;

/** Throws when a stats or decision document carries a banned field name. */
export function assertNoBannedKeys(value: unknown, label: string): void {
  const hits = findBannedKeys(value);
  if (hits.length > 0) throw new Error(`${label} has banned fields: ${hits.join(", ")}`);
}

export function findBannedKeys(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => findBannedKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  const hits: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    if (BANNED.test(key)) hits.push(`${path}.${key}`);
    hits.push(...findBannedKeys(child, `${path}.${key}`));
  }
  return hits;
}
