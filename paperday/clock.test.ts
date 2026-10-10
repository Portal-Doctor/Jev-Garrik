import { expect, test } from "bun:test";
import {
  barEndsAtUtcMidnight,
  chicagoOffsetMinutes,
  chicagoParts,
  clockStatus,
  ctDayKey,
  inEntryWindow,
  inMacroBlackout,
  isWeekendCt,
  msUntilUtcMidnight,
  utcDayKey,
} from "./src/clock";

test("DST fallback on Nov 1 2026 repeats 01:30 CT and shifts the entry window by one UTC hour", () => {
  const first = Date.parse("2026-11-01T06:30:00.000Z");
  const second = Date.parse("2026-11-01T07:30:00.000Z");
  expect(chicagoOffsetMinutes(first)).toBe(-300);
  expect(chicagoOffsetMinutes(second)).toBe(-360);
  expect(chicagoParts(first).hour).toBe(1);
  expect(chicagoParts(first).minute).toBe(30);
  expect(chicagoParts(second).hour).toBe(1);
  expect(chicagoParts(second).minute).toBe(30);

  expect(inEntryWindow(Date.parse("2026-10-31T13:00:00.000Z"))).toBe(true);
  expect(inEntryWindow(Date.parse("2026-11-01T13:00:00.000Z"))).toBe(false);
  expect(inEntryWindow(Date.parse("2026-11-01T14:00:00.000Z"))).toBe(true);
});

test("UTC rollover and the Chicago day are different clocks", () => {
  const t = Date.parse("2026-11-01T04:30:00.000Z");
  expect(utcDayKey(t)).toBe("2026-11-01");
  expect(ctDayKey(t)).toBe("2026-10-31");
  expect(isWeekendCt(t)).toBe(true);
  expect(msUntilUtcMidnight(Date.parse("2026-10-31T23:00:00.000Z"))).toBe(60 * 60_000);
  expect(barEndsAtUtcMidnight(Date.parse("2026-10-31T23:59:00.000Z"))).toBe(true);
  expect(barEndsAtUtcMidnight(Date.parse("2026-10-31T23:58:00.000Z"))).toBe(false);
  expect(utcDayKey(Date.parse("2026-11-01T00:00:00.000Z"))).toBe("2026-11-01");
  expect(ctDayKey(Date.parse("2026-11-01T00:00:00.000Z"))).toBe("2026-10-31");
});

test("a missing macro calendar still blocks the default Chicago slots", () => {
  const slot = Date.parse("2026-11-01T15:00:00.000Z");
  expect(inMacroBlackout(slot)).toBe(true);
  const status = clockStatus(slot, false);
  expect(status.macroCalendarMissing).toBe(true);
  expect(status.inMacroBlackout).toBe(true);
  expect(status.inEntryWindow).toBe(true);
  const clear = clockStatus(Date.parse("2026-11-01T16:00:00.000Z"), true);
  expect(clear.macroCalendarMissing).toBe(false);
  expect(clear.inMacroBlackout).toBe(false);
});
