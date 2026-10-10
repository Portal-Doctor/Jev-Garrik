import { expect, test } from "bun:test";
import { chunksForWindow, latestCompletedDayEndSec, monthWindows, windowForProduct, HISTORY_START_SEC } from "./time";

test("latest completed UTC day ends at 00:00 of the current day", () => {
  expect(latestCompletedDayEndSec(new Date("2026-10-10T22:29:45.000Z"))).toBe(Date.parse("2026-10-10T00:00:00.000Z") / 1000);
  expect(latestCompletedDayEndSec(new Date("2026-10-10T00:00:00.000Z"))).toBe(Date.parse("2026-10-10T00:00:00.000Z") / 1000);
});

test("history window runs from 1 Oct 2023 through the latest completed day", () => {
  const now = new Date("2026-10-10T22:29:45.000Z");
  const window = windowForProduct(now, null);
  expect(window.startSec).toBe(HISTORY_START_SEC);
  expect(window.endSec).toBe(Date.parse("2026-10-10T00:00:00.000Z") / 1000);
  const months = monthWindows(window.startSec, window.endSec);
  expect(months).toHaveLength(37);
  expect(months[0]?.month).toBe("2023-10");
  expect(months[0]?.startSec).toBe(window.startSec);
  expect(months[36]?.month).toBe("2026-10");
  expect(months[36]?.endSec).toBe(window.endSec);
});

test("a supplied listing date starts the window later than 1 Oct 2023", () => {
  const now = new Date("2024-01-15T08:00:00.000Z");
  const listing = Date.parse("2023-12-02T03:15:00.000Z") / 1000;
  const window = windowForProduct(now, listing);
  expect(window.startSec).toBe(Date.parse("2023-12-02T03:15:00.000Z") / 1000);
  expect(window.endSec).toBe(Date.parse("2024-01-15T00:00:00.000Z") / 1000);
});

test("chunks stay within 299 minutes", () => {
  const start = Date.parse("2023-10-01T00:00:00.000Z") / 1000;
  const end = start + 1440 * 60;
  const chunks = chunksForWindow(start, end);
  expect(chunks).toHaveLength(5);
  const first = chunks[0];
  const last = chunks[4];
  if (!first || !last) throw new Error("missing chunk");
  expect(first.endSec - first.startSec).toBe(299 * 60);
  expect(last.endSec).toBe(end);
  expect(last.endSec - last.startSec).toBeLessThanOrEqual(299 * 60);
});
