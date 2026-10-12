import { expect, test } from "bun:test";
import { aRuleDate, bHeldExitTs, isMondayCloseBar, x1EntryTs } from "./run";

test("the Monday 00:00 close is the Sunday-dated bar and the entry is Monday 01:00", () => {
  expect(isMondayCloseBar("2026-02-08")).toBe(true);
  expect(isMondayCloseBar("2026-02-09")).toBe(false);
  expect(new Date(x1EntryTs("2026-02-08") * 1000).toISOString()).toBe("2026-02-09T01:00:00.000Z");
  expect(new Date(x1EntryTs("2026-02-10") * 1000).toISOString()).toBe("2026-02-11T01:00:00.000Z");
  const held = bHeldExitTs("2026-02-08");
  expect(held.at).toBe("open");
  expect(new Date(held.ts * 1000).toISOString()).toBe("2026-02-09T01:00:00.000Z");
  const ohlc = Array.from({ length: 40 }, (_, i) => {
    const date = new Date(Date.parse("2026-01-01T00:00:00.000Z") + i * 86_400_000).toISOString().slice(0, 10);
    return { date, low: 100, close: 100 };
  });
  expect(aRuleDate(ohlc, "2026-01-01", 100, 90)).toEqual({ date: "2026-01-31", at: "open" });
});
