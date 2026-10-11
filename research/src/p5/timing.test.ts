import { expect, test } from "bun:test";
import { isMondayCloseBar, x1EntryTs } from "./run";

test("the Monday 00:00 close is the Sunday-dated bar and the entry is Monday 01:00", () => {
  expect(isMondayCloseBar("2026-02-08")).toBe(true);
  expect(isMondayCloseBar("2026-02-09")).toBe(false);
  expect(new Date(x1EntryTs("2026-02-08") * 1000).toISOString()).toBe("2026-02-09T01:00:00.000Z");
  expect(new Date(x1EntryTs("2026-02-10") * 1000).toISOString()).toBe("2026-02-11T01:00:00.000Z");
});
