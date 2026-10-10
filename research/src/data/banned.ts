const BANNED = /pnl|p&l|return|profit|drawdown|forward|hitrate|hit_rate|gross|net_bps|netbps/i;

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
