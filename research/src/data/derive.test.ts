import { expect, test } from "bun:test";
import type { MinuteRow } from "./candles";
import { deriveBars, foldedCovers, foldHours } from "./derive";
import { BAR_SEC } from "./time";

function filled(minuteSec: number, close: string, high = close, low = close, volume = "1"): MinuteRow {
  return { minuteSec, empty: false, open: close, high, low, close, volume };
}

function empty(minuteSec: number): MinuteRow {
  return { minuteSec, empty: true, open: null, high: null, low: null, close: null, volume: null };
}

function grid(start: number, end: number, at: (minuteSec: number) => MinuteRow): MinuteRow[] {
  const rows: MinuteRow[] = [];
  for (let minuteSec = start; minuteSec < end; minuteSec += BAR_SEC) rows.push(at(minuteSec));
  return rows;
}

test("bars that end at 00:00 UTC belong to the previous period", () => {
  const start = Date.parse("2023-10-01T00:00:00.000Z") / 1000;
  const end = Date.parse("2023-10-02T00:00:00.000Z") / 1000;
  const minutes = grid(start, end, (minuteSec) => filled(minuteSec, minuteSec === end - BAR_SEC ? "2" : "1"));
  const days = deriveBars(minutes, "1d", start, end);
  expect(days).toHaveLength(1);
  expect(days[0]?.openTs).toBe(start);
  expect(days[0]?.endTs).toBe(end);
  expect(days[0]?.close).toBe("2");

  const hours = deriveBars(minutes, "1h", start, end);
  expect(hours).toHaveLength(24);
  expect(hours[23]?.openTs).toBe(end - 3600);
  expect(hours[23]?.endTs).toBe(end);

  const four = deriveBars(minutes, "4h", start, end);
  expect(four).toHaveLength(6);
  expect(four[5]?.openTs).toBe(end - 4 * 3600);
  expect(four[5]?.endTs).toBe(end);

  const next = grid(end, end + 86400, (minuteSec) => filled(minuteSec, "9"));
  const both = deriveBars([...minutes, ...next], "1d", start, end + 86400);
  expect(both[0]?.close).toBe("2");
  expect(both[1]?.open).toBe("9");
  expect(both[0]?.endTs).toBe(end);
});

test("UTC buckets ignore US DST transitions", () => {
  for (const day of ["2026-03-08", "2026-11-01"]) {
    const start = Date.parse(`${day}T00:00:00.000Z`) / 1000;
    const end = start + 86400;
    const minutes = grid(start, end, (minuteSec) => filled(minuteSec, "1"));
    const hours = deriveBars(minutes, "1h", start, end);
    expect(hours).toHaveLength(24);
    expect(hours[6]?.openTs).toBe(start + 6 * 3600);
    expect(hours[6]!.endTs - hours[6]!.openTs).toBe(3600);
    const days = deriveBars(minutes, "1d", start, end);
    expect(days).toHaveLength(1);
    expect(days[0]?.endTs).toBe(end);
  }
});

test("empty minutes stay empty and are not filled from neighbors", () => {
  const start = Date.parse("2023-10-01T00:00:00.000Z") / 1000;
  const allEmpty = grid(start, start + 3600, empty);
  const [blank] = deriveBars(allEmpty, "1h", start, start + 3600);
  expect(blank?.empty).toBe(true);
  expect(blank?.open).toBeNull();
  expect(blank?.high).toBeNull();
  expect(blank?.low).toBeNull();
  expect(blank?.close).toBeNull();
  expect(blank?.volume).toBeNull();

  const barsInHour = 3600 / BAR_SEC;
  const mixed = grid(start, start + 3600, (minuteSec) => {
    if (minuteSec === start) return filled(minuteSec, "5", "6", "4", "1.5");
    if (minuteSec === start + (barsInHour - 1) * BAR_SEC) return filled(minuteSec, "8", "9", "7", "2.5");
    return empty(minuteSec);
  });
  const [bar] = deriveBars(mixed, "1h", start, start + 3600);
  expect(bar?.empty).toBe(false);
  expect(bar?.open).toBe("5");
  expect(bar?.close).toBe("8");
  expect(bar?.high).toBe("9");
  expect(bar?.low).toBe("4");
  expect(bar?.volume).toBe("4");
  expect(bar?.emptyMinutes).toBe(barsInHour - 2);

  const previous = grid(start, start + 3600, (minuteSec) => filled(minuteSec, "100"));
  const following = grid(start + 3600, start + 7200, empty);
  const hours = deriveBars([...previous, ...following], "1h", start, start + 7200);
  expect(hours[1]?.empty).toBe(true);
  expect(hours[1]?.open).toBeNull();
});

test("a fully empty 4h bucket is dropped and the neighbors still cover", () => {
  const start = Date.parse("2026-05-08T00:00:00.000Z") / 1000;
  const minutes = grid(start, start + 20 * 3600, (minuteSec) => {
    const hour = Math.floor((minuteSec - start) / 3600);
    return hour >= 2 && hour <= 16 ? empty(minuteSec) : filled(minuteSec, "3");
  });
  const offline = deriveBars(minutes, "4h", start, start + 20 * 3600)
    .filter((bar) => !bar.empty)
    .map((bar) => bar.openTs);
  const tradedHours = [0, 1, 17, 18, 19].map((hour) => ({
    ts: start + hour * 3600,
    open: 3,
    high: 3,
    low: 3,
    close: 3,
    volume: 1,
  }));
  const folded = foldHours(tradedHours, 14_400, 3600);
  expect(folded.map((bar) => bar.ts)).toEqual(offline);
  expect(folded.map((bar) => bar.ts)).toEqual([start, start + 4 * 14_400]);
  expect(foldedCovers(folded, 14_400, 2)).toBe(true);
  expect(foldedCovers(folded, 14_400, 3)).toBe(false);
  const offGrid = folded.map((bar, index) => (index === 1 ? { ts: bar.ts + 60 } : bar));
  expect(foldedCovers(offGrid, 14_400, 2)).toBe(false);
});
