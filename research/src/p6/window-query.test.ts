import { expect, test } from "bun:test";
import { parseSummaryWindow, SUMMARY_WINDOWS } from "./window-query";

test("?w= accepts only the four window ids and never returns the raw text", () => {
  expect(SUMMARY_WINDOWS).toEqual(["8h", "24h", "7d", "30d"]);
  for (const id of SUMMARY_WINDOWS) {
    expect(parseSummaryWindow(id)).toEqual({ id, open: true });
  }
  expect(parseSummaryWindow(["7d", "8h"])).toEqual({ id: "7d", open: true });
  expect(parseSummaryWindow(["nope", "8h"])).toEqual({ id: "24h", open: false });
  expect(parseSummaryWindow(undefined)).toEqual({ id: "24h", open: false });
  expect(parseSummaryWindow(null)).toEqual({ id: "24h", open: false });
  expect(parseSummaryWindow("")).toEqual({ id: "24h", open: false });
  expect(parseSummaryWindow([])).toEqual({ id: "24h", open: false });
  expect(parseSummaryWindow("8H")).toEqual({ id: "24h", open: false });
  expect(parseSummaryWindow(" 8h")).toEqual({ id: "24h", open: false });
  expect(parseSummaryWindow("8h ")).toEqual({ id: "24h", open: false });
  expect(parseSummaryWindow("24h<script>")).toEqual({ id: "24h", open: false });
  const markup = "<img src=x onerror=alert(1)>";
  const marked = parseSummaryWindow(markup);
  expect(marked).toEqual({ id: "24h", open: false });
  expect(JSON.stringify(marked).includes(markup)).toBe(false);
  const huge = "x".repeat(2048);
  const oversized = parseSummaryWindow(huge);
  expect(oversized).toEqual({ id: "24h", open: false });
  expect(JSON.stringify(oversized).includes(huge)).toBe(false);
  expect(parseSummaryWindow("8h\n24h")).toEqual({ id: "24h", open: false });
});
