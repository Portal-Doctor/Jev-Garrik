import { expect, test } from "bun:test";
import { ema, wilderAtr } from "../p2/indicators";
import { generateForward, vetoFromBtc } from "./generate";
import { WARM as hostWarm } from "./paper-host";
import { cappedLength, WARM as parityWarm } from "./parity";
import { FOUR_KEEP, HOUR_KEEP, WARM } from "./warm-caps";

function price(index: number): number {
  return 100 * (1 + 0.000001 * index + 0.0008 * Math.sin(index / 29));
}

function bars(count: number, step: number) {
  return Array.from({ length: count }, (_, index) => {
    const close = price(index);
    return { ts: (index + 1) * step, open: close, high: close * 1.001, low: close * 0.999, close, volume: 10 };
  });
}

function bps(left: number, right: number): number {
  return (Math.abs(left - right) / right) * 10_000;
}

test("host and offline share the warm caps", () => {
  expect(hostWarm).toBe(parityWarm);
  expect(hostWarm).toBe(WARM);
  expect(WARM.FOUR_KEEP).toBe(700);
  expect(WARM.HOUR_KEEP).toBe(240);
  expect(FOUR_KEEP).toBe(700);
  expect(HOUR_KEEP).toBe(240);
  expect(cappedLength(900, "four")).toBe(700);
  expect(cappedLength(100, "hour")).toBe(100);
});

test("capped EMAs stay within 1bp, ATR within 0.5%, and decisions match", () => {
  const four = bars(900, 14_400);
  const hour = bars(400, 3_600);
  const fourCap = four.slice(-FOUR_KEEP);
  const hourCap = hour.slice(-HOUR_KEEP);
  const fullEma = ema(four.map((bar) => bar.close), 200);
  const capEma = ema(fourCap.map((bar) => bar.close), 200);
  const boundary: number[] = [];
  let maxEma = 0;
  const overlap = Math.min(fullEma.length, capEma.length);
  for (let index = 0; index < overlap; index += 1) {
    const full = fullEma[fullEma.length - 1 - index];
    const cap = capEma[capEma.length - 1 - index];
    if (full == null || cap == null) continue;
    const diff = bps(cap, full);
    maxEma = Math.max(maxEma, diff);
    if (diff > 0 && diff < 1) boundary.push(diff);
  }
  expect(maxEma, `boundary under 1bp: ${boundary.map((row) => row.toFixed(4)).join(",")}`).toBeLessThan(1);

  const fullAtr = wilderAtr(hour.map((bar) => bar.high), hour.map((bar) => bar.low), hour.map((bar) => bar.close), 14);
  const capAtr = wilderAtr(hourCap.map((bar) => bar.high), hourCap.map((bar) => bar.low), hourCap.map((bar) => bar.close), 14);
  const fullLast = fullAtr[fullAtr.length - 1];
  const capLast = capAtr[capAtr.length - 1];
  expect(fullLast).toBeTruthy();
  expect(capLast).toBeTruthy();
  expect(Math.abs(capLast! - fullLast!) / fullLast!).toBeLessThan(0.005);

  const days = Array.from({ length: 400 }, (_, index) => {
    const close = price(index);
    const date = new Date(Date.parse("2024-01-01T00:00:00.000Z") + index * 86_400_000).toISOString().slice(0, 10);
    return { date, ts: Date.parse(`${date}T00:00:00.000Z`) / 1000, open: close, high: close, low: close, close, volume: 10, empty: false };
  });
  const flags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };
  const nowSec = four[four.length - 1]!.ts + 14_400;
  const book = (fourRows: typeof four, hourRows: typeof hour) => new Map([["ETH-USD", { days, hour: hourRows, four: fourRows, quarter: [] as typeof four }]]);
  const full = generateForward({
    bars: [],
    nowSec,
    flags,
    lookback: 20,
    k: 2,
    products: book(four, hour),
    memberOn: () => true,
    young: () => false,
    veto: vetoFromBtc(days, four),
  });
  const capped = generateForward({
    bars: [],
    nowSec,
    flags,
    lookback: 20,
    k: 2,
    products: book(fourCap, hourCap),
    memberOn: () => true,
    young: () => false,
    veto: vetoFromBtc(days, fourCap),
  });
  const key = (row: { classId: string; productId: string; signalDate: string; stop: number; target: number | null }) =>
    `${row.classId}|${row.productId}|${row.signalDate}|${row.stop}|${row.target}`;
  expect(capped.entries.map(key)).toEqual(full.entries.map(key));
  expect(capped.weeks).toEqual(full.weeks);
  const dates = [...new Set(days.map((row) => row.date))];
  const fullVeto = vetoFromBtc(days, four);
  const capVeto = vetoFromBtc(days, fourCap);
  expect(dates.map((date) => capVeto(date))).toEqual(dates.map((date) => fullVeto(date)));
  const atrRel = Math.abs(capLast! - fullLast!) / fullLast!;
  console.log(`warm parity ema max ${maxEma.toFixed(4)} bp, under 1bp ${boundary.length}, atr rel ${(atrRel * 100).toFixed(4)}%, entries ${full.entries.length}, decision diffs 0`);
});
