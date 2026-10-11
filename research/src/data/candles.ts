import { BAR_SEC } from "./time";

/** One exchange candle, with price and volume kept as the JSON number tokens. */
export interface CandleLexeme {
  minuteSec: number;
  low: string;
  high: string;
  open: string;
  close: string;
  volume: string;
}

export interface MinuteRow {
  minuteSec: number;
  empty: boolean;
  open: string | null;
  high: string | null;
  low: string | null;
  close: string | null;
  volume: string | null;
}

const WS = new Set([" ", "\n", "\r", "\t"]);

/**
 * Parse an exchange candle payload, preserving number lexemes.
 * Rows are [time, low, high, open, close, volume].
 */
export function parseCandlePayload(text: string): CandleLexeme[] {
  const rows = parseNumericRows(text);
  const out: CandleLexeme[] = [];
  for (const row of rows) {
    const time = row[0];
    const low = row[1];
    const high = row[2];
    const open = row[3];
    const close = row[4];
    const volume = row[5];
    if (time == null || low == null || high == null || open == null || close == null || volume == null) {
      throw new Error("candle row is short");
    }
    if (!/^-?\d+$/.test(time)) throw new Error(`candle time is not an integer: ${time}`);
    const minuteSec = Number(time);
    if (!Number.isSafeInteger(minuteSec)) throw new Error(`candle time is out of range: ${time}`);
    out.push({ minuteSec, low, high, open, close, volume });
  }
  return out;
}

/** Every bar in [startSec, endSec) is present. Missing bars are empty, not filled. */
export function minutesForChunk(
  startSec: number,
  endSec: number,
  candles: readonly CandleLexeme[],
  barSec: number = BAR_SEC,
): MinuteRow[] {
  const byMinute = new Map<number, CandleLexeme>();
  for (const candle of candles) {
    if (candle.minuteSec < startSec || candle.minuteSec >= endSec) continue;
    if (candle.minuteSec % barSec !== 0) throw new Error(`off-grid candle ${candle.minuteSec}`);
    if (byMinute.has(candle.minuteSec)) throw new Error(`duplicate candle ${candle.minuteSec}`);
    byMinute.set(candle.minuteSec, candle);
  }
  const rows: MinuteRow[] = [];
  for (let minuteSec = startSec; minuteSec < endSec; minuteSec += barSec) {
    const candle = byMinute.get(minuteSec);
    if (!candle) {
      rows.push({ minuteSec, empty: true, open: null, high: null, low: null, close: null, volume: null });
      continue;
    }
    rows.push({
      minuteSec,
      empty: false,
      open: candle.open,
      high: candle.high,
      low: candle.low,
      close: candle.close,
      volume: candle.volume,
    });
  }
  return rows;
}

function parseNumericRows(text: string): string[][] {
  let i = 0;
  const n = text.length;
  const skip = () => {
    while (i < n && WS.has(text[i] ?? "")) i += 1;
  };
  const expect = (ch: string) => {
    skip();
    if (text[i] !== ch) throw new Error(`candles payload: expected ${ch} at ${i}`);
    i += 1;
  };
  const readNumber = (): string => {
    skip();
    const start = i;
    if (text[i] === "-") i += 1;
    if (i >= n || (text[i] ?? "") < "0" || (text[i] ?? "") > "9") {
      throw new Error(`candles payload: expected number at ${start}`);
    }
    if (text[i] === "0") i += 1;
    else while (i < n && (text[i] ?? "") >= "0" && (text[i] ?? "") <= "9") i += 1;
    if (text[i] === ".") {
      i += 1;
      const frac = i;
      while (i < n && (text[i] ?? "") >= "0" && (text[i] ?? "") <= "9") i += 1;
      if (i === frac) throw new Error("candles payload: empty fraction");
    }
    if (text[i] === "e" || text[i] === "E") {
      i += 1;
      if (text[i] === "+" || text[i] === "-") i += 1;
      const exp = i;
      while (i < n && (text[i] ?? "") >= "0" && (text[i] ?? "") <= "9") i += 1;
      if (i === exp) throw new Error("candles payload: empty exponent");
    }
    return text.slice(start, i);
  };

  expect("[");
  skip();
  const rows: string[][] = [];
  if (text[i] === "]") {
    i += 1;
    skip();
    if (i !== n) throw new Error("candles payload: trailing data");
    return rows;
  }
  for (;;) {
    expect("[");
    const row: string[] = [];
    for (let col = 0; col < 6; col++) {
      if (col > 0) expect(",");
      row.push(readNumber());
    }
    expect("]");
    rows.push(row);
    skip();
    if (text[i] === ",") {
      i += 1;
      continue;
    }
    break;
  }
  expect("]");
  skip();
  if (i !== n) throw new Error("candles payload: trailing data");
  return rows;
}
