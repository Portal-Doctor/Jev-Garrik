/**
 * Banned field names are whole tokens, or camelCase / snake_case parts.
 * A token inside a longer word (window, exchange, returned) is not a hit.
 */

const BANNED_TOKENS = new Set([
  "pnl",
  "return",
  "profit",
  "drawdown",
  "forward",
  "hitrate",
  "gross",
  "netbps",
  "fwd",
  "ret",
  "change",
  "outcome",
  "win",
]);

/** Consecutive tokens, after the key is split on punctuation and camelCase. */
const BANNED_PHRASES = [
  ["p", "l"],
  ["hit", "rate"],
  ["net", "bps"],
  ["r", "multiple"],
];

export function fieldTokens(key: string): string[] {
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  return spaced
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export function keyIsBanned(key: string): boolean {
  const tokens = fieldTokens(key);
  if (tokens.some((token) => BANNED_TOKENS.has(token))) return true;
  for (let i = 0; i < tokens.length; i += 1) {
    for (const phrase of BANNED_PHRASES) {
      if (phrase.every((part, offset) => tokens[i + offset] === part)) return true;
    }
  }
  return false;
}

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
    if (keyIsBanned(key)) hits.push(`${path}.${key}`);
    hits.push(...findBannedKeys(child, `${path}.${key}`));
  }
  return hits;
}
