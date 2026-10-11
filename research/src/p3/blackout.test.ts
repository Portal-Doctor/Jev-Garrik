import { expect, test } from "bun:test";
import { entryInBlackout } from "./signals";
import { blackoutContentSha256, loadBlackoutCalendar } from "./blackout";

test("the blackout file hash matches its events", () => {
  const file = loadBlackoutCalendar(new URL("../../data/reports/blackout-calendar.json", import.meta.url).pathname);
  expect(file.events.length).toBeGreaterThan(0);
  expect(file.contentSha256).toBe(blackoutContentSha256(file.events));
  expect(file.events.some((event) => event.kind === "CPI")).toBe(true);
  expect(file.events.some((event) => event.kind === "NFP")).toBe(true);
  expect(file.events.some((event) => event.kind === "FOMC")).toBe(true);
  const january = file.events.find((event) => event.kind === "FOMC" && event.releaseLocal.startsWith("2026-01-28"));
  expect(january?.releaseAt).toBe("2026-01-28T19:00:00.000Z");
});

test("a class E decision inside the release window is blocked", () => {
  const releaseAt = "2026-01-13T13:30:00.000Z";
  const release = Date.parse(releaseAt) / 1000;
  expect(entryInBlackout(release - 30 * 60, [{ releaseAt }])).toBe(true);
  expect(entryInBlackout(release + 60 * 60, [{ releaseAt }])).toBe(true);
  expect(entryInBlackout(release - 31 * 60, [{ releaseAt }])).toBe(false);
  expect(entryInBlackout(release + 61 * 60, [{ releaseAt }])).toBe(false);
});
