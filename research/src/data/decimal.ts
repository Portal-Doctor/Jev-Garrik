/** Exact decimal values for candle tokens. No binary float rounding. */

export interface Decimal {
  neg: boolean;
  mag: bigint;
  scale: number;
}

export function parseDecimal(token: string): Decimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(token);
  if (!match) throw new Error(`not a decimal: ${token}`);
  const exp = match[4] != null ? Number(match[4]) : 0;
  if (!Number.isInteger(exp)) throw new Error(`not a decimal: ${token}`);
  let digits = `${match[2]}${match[3] ?? ""}`.replace(/^0+/, "") || "0";
  let scale = (match[3] ?? "").length - exp;
  if (digits === "0") return { neg: false, mag: 0n, scale: 0 };
  if (scale < 0) {
    digits += "0".repeat(-scale);
    scale = 0;
  }
  return { neg: match[1] === "-", mag: BigInt(digits), scale };
}

function signed(d: Decimal): bigint {
  return d.neg ? -d.mag : d.mag;
}

export function compareDecimal(a: Decimal, b: Decimal): number {
  const scale = Math.max(a.scale, b.scale);
  const av = signed(a) * 10n ** BigInt(scale - a.scale);
  const bv = signed(b) * 10n ** BigInt(scale - b.scale);
  if (av < bv) return -1;
  if (av > bv) return 1;
  return 0;
}

export function addDecimal(a: Decimal, b: Decimal): Decimal {
  const scale = Math.max(a.scale, b.scale);
  const sum = signed(a) * 10n ** BigInt(scale - a.scale) + signed(b) * 10n ** BigInt(scale - b.scale);
  if (sum === 0n) return { neg: false, mag: 0n, scale: 0 };
  const neg = sum < 0n;
  return { neg, mag: neg ? -sum : sum, scale };
}

export function formatDecimal(d: Decimal): string {
  if (d.mag === 0n) return "0";
  let mag = d.mag;
  let scale = d.scale;
  while (scale > 0 && mag % 10n === 0n) {
    mag /= 10n;
    scale -= 1;
  }
  const digits = mag.toString();
  let body: string;
  if (scale === 0) body = digits;
  else if (digits.length <= scale) body = `0.${digits.padStart(scale, "0")}`;
  else body = `${digits.slice(0, digits.length - scale)}.${digits.slice(digits.length - scale)}`;
  return d.neg ? `-${body}` : body;
}
