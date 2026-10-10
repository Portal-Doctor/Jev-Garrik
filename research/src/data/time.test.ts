import { expect, test } from "bun:test";
import { BAR_SEC, CHUNK_BARS, chunksForWindow, DAY_SEC, HISTORY_DAYS, latestCompletedDayEndSec, monthWindows, windowForProduct } from "./time";

test("latest completed UTC day ends at 00:00 of the current day", () => {
  expect(latestCompletedDayEndSec(new Date("2026-10-10T22:29:45.000Z"))).toBe(Date.parse("2026-10-10T00:00:00.000Z") / 1000);
  expect(latestCompletedDayEndSec(new Date("2026-10-10T00:00:00.000Z"))).toBe(Date.parse("2026-10-10T00:00:00.000Z") / 1000);
});

test("history window is 365 days ending at the latest completed UTC day", () => {
  const now = new Date("2026-10-10T22:29:45.000Z");
  const window = windowForProduct(now, null);
  const end = Date.parse("2026-10-10T00:00:00.000Z") / 1000;
  expect(window.endSec).toBe(end);
  expect(window.startSec).toBe(end - HISTORY_DAYS * DAY_SEC);
  const months = monthWindows(window.startSec, window.endSec);
  expect(months).toHaveLength(13);
  expect(months[0]?.month).toBe("2025-10");
  expect(months[0]?.startSec).toBe(window.startSec);
  expect(months[12]?.month).toBe("2026-10");
  expect(months[12]?.endSec).toBe(window.endSec);
});

test("a supplied listing date starts the window later than 1 Oct 2023", () => {
  const now = new Date("2024-01-15T08:00:00.000Z");
  const listing = Date.parse("2023-12-02T03:15:00.000Z") / 1000;
  const window = windowForProduct(now, listing);
  expect(window.startSec).toBe(Date.parse("2023-12-02T03:15:00.000Z") / 1000);
  expect(window.endSec).toBe(Date.parse("2024-01-15T00:00:00.000Z") / 1000);
});

test("chunks stay within 299 bars", () => {
  const start = Date.parse("2023-10-01T00:00:00.000Z") / 1000;
  const end = start + 2 * CHUNK_BARS * BAR_SEC + 10 * BAR_SEC;
  const chunks = chunksForWindow(start, end);
  expect(chunks).toHaveLength(3);
  const first = chunks[0];
  const last = chunks[2];
  if (!first || !last) throw new Error("missing chunk");
  expect(first.endSec - first.startSec).toBe(CHUNK_BARS * BAR_SEC);
  expect(last.endSec).toBe(end);
  expect(last.endSec - last.startSec).toBe(10 * BAR_SEC);
});
