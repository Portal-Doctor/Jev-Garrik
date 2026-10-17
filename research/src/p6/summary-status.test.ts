import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { BOOK_HALT_USD, OPEN_RISK_CAP_USD } from "../p3/design-rules";
import { completedFlushMs, readP6Page, summaryFreshness } from "./dashboard-read";
import { STALE_MS, formatCt } from "./pnl-block";
import {
  BOOK_DRAWDOWN_AMBER_USD,
  BOOK_DRAWDOWN_HALT_USD,
  classDollarWord,
  gateBannerLines,
  riskTone,
} from "./positions-view";
import { memoryKv } from "./relay";

const root = join(import.meta.dir, "..", "..", "..");
const page = readFileSync(join(root, "web/src/app/p6/page.tsx"), "utf8");

test("riskTone uses the design-rule boundaries, including the exact cap and halt", () => {
  expect(BOOK_DRAWDOWN_HALT_USD).toBe(Math.abs(BOOK_HALT_USD));
  expect(BOOK_DRAWDOWN_HALT_USD).toBe(1600);
  expect(BOOK_DRAWDOWN_AMBER_USD).toBe(BOOK_DRAWDOWN_HALT_USD * 0.5);
  expect(BOOK_DRAWDOWN_AMBER_USD).toBe(800);
  expect(OPEN_RISK_CAP_USD).toBe(480);
  expect(OPEN_RISK_CAP_USD * 0.8).toBe(384);

  expect(riskTone(0, 799.99)).toEqual({ openRisk: "OK", drawdown: "OK" });
  expect(riskTone(0, 800)).toEqual({ openRisk: "OK", drawdown: "Near limit" });
  expect(riskTone(0, 1599.99)).toEqual({ openRisk: "OK", drawdown: "Near limit" });
  expect(riskTone(0, 1600)).toEqual({ openRisk: "OK", drawdown: "Halted" });
  expect(riskTone(383.97, 0)).toEqual({ openRisk: "OK", drawdown: "OK" });
  expect(riskTone(384, 0)).toEqual({ openRisk: "Near limit", drawdown: "OK" });
  expect(riskTone(480, 0)).toEqual({ openRisk: "Near limit", drawdown: "OK" });
  expect(riskTone(480.03, 0)).toEqual({ openRisk: "Over", drawdown: "OK" });
  expect(riskTone(480.03, 1600)).toEqual({ openRisk: "Over", drawdown: "Halted" });
  expect(riskTone(480, 1599.99)).toEqual({ openRisk: "Near limit", drawdown: "Near limit" });
  expect(riskTone(383.97, 800)).toEqual({ openRisk: "OK", drawdown: "Near limit" });
});

test("the page asks riskTone and the gate banner for the same two numbers", () => {
  expect(page.includes("riskTone(positionView.riskUsd, bookDd)")).toBe(true);
  expect(page.includes("gateBannerLines({ killSwitch: view.killSwitch, classes: pnl?.classes, drawdownUsd: bookDd })")).toBe(true);
  expect(page.includes("toneWords.openRisk")).toBe(true);
  expect(page.includes("toneWords.drawdown")).toBe(true);
  const gates = page.slice(page.indexOf('id="gates"'), page.indexOf('id="jev"'));
  expect(gates.includes("<p>Daily and weekly halt status is not reported yet</p>")).toBe(true);
  expect(gates.includes("classDollarWord(")).toBe(true);
});

test("each gate banner is its own condition, and the book halt includes the exact halt", () => {
  expect(gateBannerLines({ killSwitch: true, drawdownUsd: 0 })).toEqual(["Kill switch on. New entries are blocked."]);
  expect(gateBannerLines({ killSwitch: false, classes: { C: { paused: true } }, drawdownUsd: 0 })).toEqual([
    "Class C paused. New entries in class C are blocked until it resumes.",
  ]);
  expect(gateBannerLines({ killSwitch: false, classes: { A: { killed: true } }, drawdownUsd: 0 })).toEqual([
    "Class A killed. New entries in class A are blocked.",
  ]);
  const halt = gateBannerLines({ killSwitch: false, drawdownUsd: BOOK_DRAWDOWN_HALT_USD });
  expect(halt).toEqual(["Book halt reached. New entries are blocked until the book recovers."]);
  expect(gateBannerLines({ killSwitch: false, drawdownUsd: 1600 })).toEqual(halt);
  expect(gateBannerLines({ killSwitch: false, drawdownUsd: BOOK_DRAWDOWN_HALT_USD - 0.01 })).toEqual([]);
  expect(gateBannerLines({ killSwitch: false, drawdownUsd: 1599.99 })).toEqual([]);
  expect(gateBannerLines({ killSwitch: false, drawdownUsd: 0, classes: {} })).toEqual([]);
});

test("a missing class dollar cap is n/a and a known cap still stops at the cap", () => {
  expect(classDollarWord(8, null)).toBe("n/a");
  expect(classDollarWord(0, 1200)).toBe("OK");
  expect(classDollarWord(1200, 1200)).toBe("Over");
  expect(classDollarWord(839.99, 1200)).toBe("OK");
  expect(classDollarWord(840, 1200)).toBe("Near limit");
});

test("Last updated, as of last run, and health use the completed flush, not the render clock", async () => {
  const render = Date.parse("2026-10-17T17:49:00.000Z");
  const flush = Date.parse("2026-10-17T17:16:00.000Z");
  expect(formatCt(render, false)).toBe("12:49 CT");
  expect(formatCt(flush, false)).toBe("12:16 CT");
  expect(completedFlushMs({ outcome: "running", end: render, completed: { end: flush, cmds: 4, outcome: "handover" } })).toBe(flush);
  expect(completedFlushMs({ outcome: "running", end: render })).toBeNull();
  expect(completedFlushMs({ outcome: "handover", end: flush, completed: { end: flush, cmds: 4, outcome: "handover" } })).toBe(flush);
  expect(completedFlushMs({ end: flush })).toBe(flush);
  expect(completedFlushMs(null)).toBeNull();

  const kv = memoryKv();
  await kv.set(
    "p6:lastRun",
    JSON.stringify({
      outcome: "running",
      start: flush,
      end: render,
      completed: { end: flush, cmds: 4, outcome: "handover" },
      pnl: { equityUsd: 8000, realizedUsd: 0, unrealizedUsd: 0, feesUsd: 0, spreadSlipUsd: 0 },
      positions: [],
    }),
  );
  await kv.set("p6:hot", JSON.stringify({ killSwitch: false, positions: [], gaps: [], incidents: [] }));
  const loaded = await readP6Page(kv, render);
  expect(loaded.block.lastUpdatedMs).toBe(flush);
  expect(loaded.block.lastUpdatedMs).not.toBe(render);
  const fresh = summaryFreshness({ hasLastRun: loaded.view.lastRun != null, flushMs: loaded.block.lastUpdatedMs, nowMs: render });
  expect(fresh.lastUpdatedText).toBe("12:16 CT");
  expect(fresh.lastUpdatedText).not.toBe("12:49 CT");
  expect(fresh.health).toBe("Stale");
  expect(fresh.banner?.text.includes("12:16 CT")).toBe(true);
  expect(fresh.banner?.text.includes("12:49")).toBe(false);

  const recent = Date.parse("2026-10-17T17:40:00.000Z");
  const recentFresh = summaryFreshness({ hasLastRun: true, flushMs: recent, nowMs: render });
  expect(recentFresh.health).toBe("Healthy");
  expect(recentFresh.banner).toBeNull();
  expect(recentFresh.lastUpdatedText).toBe(formatCt(recent, false));
  expect(recentFresh.lastUpdatedText).not.toBe("12:49 CT");

  const none = summaryFreshness({ hasLastRun: false, flushMs: null, nowMs: render });
  expect(none.health).toBe("Error");
  expect(none.lastUpdatedText).toBe("—");
  expect(none.lastUpdatedText).not.toBe("12:49 CT");
  const runningOnly = summaryFreshness({ hasLastRun: true, flushMs: completedFlushMs({ outcome: "running", end: render }), nowMs: render });
  expect(runningOnly.lastUpdatedText).toBe("—");
  expect(runningOnly.health).toBe("Stale");
  expect(runningOnly.banner?.text).toBe("There is no last run time. Numbers below are stale after 20 min.");

  const exact = summaryFreshness({ hasLastRun: true, flushMs: render - STALE_MS, nowMs: render });
  expect(exact.stale).toBe(false);
  expect(exact.health).toBe("Healthy");
  expect(exact.banner).toBeNull();
  const past = summaryFreshness({ hasLastRun: true, flushMs: render - STALE_MS - 1, nowMs: render });
  expect(past.stale).toBe(true);
  expect(past.health).toBe("Stale");
  expect(past.banner).not.toBeNull();
  expect(past.banner?.staleClass).toBe(true);

  expect(page.includes("const flushMs = block.lastUpdatedMs")).toBe(true);
  expect(page.includes("markTs: flushMs")).toBe(true);
  expect(page.includes("summaryFreshness({ hasLastRun: last != null, flushMs, nowMs: now })")).toBe(true);
  expect(page.includes("Last updated {fresh.lastUpdatedText}")).toBe(true);
  expect(page.includes("as of last run {fresh.lastUpdatedText}")).toBe(true);
  expect(page.includes("formatCt(now")).toBe(false);
  expect(page.includes("formatCt(Date.now()")).toBe(false);
  expect(page.includes("{health}")).toBe(true);
});
