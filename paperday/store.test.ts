import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupJsonl } from "./src/backup";
import { aggregate, backfill, barKey, findGaps } from "./src/bars";
import { assertPublicFrame, publicSubscribeFrame } from "./src/ingest";
import { buildManifest } from "./src/manifest";
import { dailySummary, quarterTracker, rejectHistogram, scorecard } from "./src/reporter";
import { judgePosts, XSentiment } from "./src/sentiment";
import { MemoryStore } from "./src/store";
import { runEngine } from "./src/engine";
import { revenueGate } from "./src/backtest";

test("store keys are idempotent and the JSONL mirror writes once", () => {
  const dir = mkdtempSync(join(tmpdir(), "paperday-store-"));
  const path = join(dir, "mirror.jsonl");
  const store = new MemoryStore(path);
  expect(store.put("ideas", "a", { take: true }).inserted).toBe(true);
  expect(store.put("ideas", "a", { take: false }).inserted).toBe(false);
  expect(store.count("ideas")).toBe(1);
  expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
  writeFileSync(join(dir, "note.txt"), "skip");
  const dest = backupJsonl(dir, join(dir, "backup"), new Date("2026-10-09T00:00:00.000Z"));
  expect(readFileSync(join(dest, "mirror.jsonl"), "utf8").includes("ideas")).toBe(true);
});

test("bars drop the running bucket, detect gaps, and backfill without duplicating", () => {
  const minute = Array.from({ length: 10 }, (_, i) => ({
    ts: i * 60_000,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1,
    volume: 1,
  }));
  expect(aggregate(minute, 300_000)).toHaveLength(1);
  expect(aggregate(minute, 300_000, 10 * 60_000)).toHaveLength(2);
  const gappy = [minute[0]!, { ...minute[0]!, ts: 180_000 }];
  expect(findGaps(gappy, 60_000)).toHaveLength(1);
  const filled = backfill(gappy, [gappy[0]!, { ...minute[0]!, ts: 60_000 }]);
  expect(filled.added).toBe(1);
  expect(backfill(filled.bars, [{ ...minute[0]!, ts: 60_000 }]).added).toBe(0);
  expect(barKey("UNI-USD", "5m", 0)).toBe("UNI-USD|5m|0");
});

test("public ingest refuses the user channel and a signed frame", () => {
  const frame = publicSubscribeFrame(["UNI-USD"]);
  expect(frame.includes("candles")).toBe(true);
  expect(() => assertPublicFrame(frame)).not.toThrow();
  expect(() => assertPublicFrame(JSON.stringify({ type: "subscribe", channel: "user", product_ids: ["UNI-USD"] }))).toThrow("user channel");
  expect(() => assertPublicFrame(JSON.stringify({ type: "subscribe", channel: "candles", jwt: "x" }))).toThrow("signed");
});

test("sentiment can veto and cannot create an entry", async () => {
  const veto = judgePosts("UNI-USD", [{ id: "1", text: "UNI halt rumors" }], 0);
  expect(veto.sentiment).toBe("veto");
  expect(veto.postIds).toEqual(["1"]);
  const bullish = judgePosts("UNI-USD", [{ id: "2", text: "UNI looking great, buy the dip" }], 0);
  expect(bullish.sentiment).toBe("clear");
  expect("entry" in bullish).toBe(false);
  const x = new XSentiment({
    async search() {
      throw new Error("down");
    },
  }, { minIntervalMs: 1_000, maxPerHour: 2 });
  expect((await x.read("UNI-USD", 0)).sentiment).toBe("unknown");
  expect((await x.read("UNI-USD", 500)).reason).toBe("rate_limit");
  expect(x.calls).toBe(1);
  expect((await new XSentiment(null).read("UNI-USD", 0)).reason).toBe("no reader");
});

test("reporter tracks the quarter against $1,200 and keeps the pre-registered scorecard closed", () => {
  const day = Date.parse("2026-10-07T15:00:00.000Z");
  const summary = dailySummary(
    [{ closedTs: day, pair: "UNI-USD", netUsd: 10, reason: "t2" }],
    [{ ts: day, reason: "fee_gate,fee_gate" }],
    "2026-10-07",
  );
  expect(summary.trades).toBe(1);
  expect(summary.netUsd).toBe(10);
  expect(rejectHistogram([{ ts: day, reason: "fee_gate" }, { ts: day, reason: "kill_switch" }]).fee_gate).toBe(1);
  const quarters = quarterTracker([
    { closedTs: Date.parse("2026-08-01T00:00:00.000Z"), pair: "UNI-USD", netUsd: 1_200, reason: "t2" },
    { closedTs: Date.parse("2026-08-02T00:00:00.000Z"), pair: "UNI-USD", netUsd: -1, reason: "stop" },
  ]);
  expect(quarters[0]?.pass).toBe(false);
  expect(quarters[0]?.goalUsd).toBe(1_200);
  const empty = scorecard({
    jevOnTrades: 0,
    jevOffTrades: 0,
    jevOnNetUsd: 0,
    jevOffNetUsd: 0,
    jevOnMaxDrawdownUsd: 0,
    jevOffMaxDrawdownUsd: 0,
  });
  expect(empty.eligible).toBe(false);
  expect(empty.thresholds.minClosedTradesEachVariant).toBe(100);
  expect(empty.thresholds.writtenAt).toBe("2026-10-09");
  const ready = scorecard({
    jevOnTrades: 100,
    jevOffTrades: 100,
    jevOnNetUsd: 10,
    jevOffNetUsd: 9,
    jevOnMaxDrawdownUsd: 100,
    jevOffMaxDrawdownUsd: 100,
  });
  expect(ready.eligible).toBe(true);
});

test("manifest records stage 0, 50/90, and the locked budget", () => {
  const manifest = buildManifest({ jevStage: 0, mode: "POOL", formula: "equal", strategy: "combined", variant: "jev_off" });
  expect(manifest.feeTier).toBe("50/90");
  expect(manifest.jevStage).toBe(0);
  expect(manifest.budgetUsd).toBe(10_000);
  expect(manifest.reserveUsd).toBe(2_000);
  expect(manifest.deployableUsd).toBe(8_000);
  expect(manifest.drawdownHaltUsd).toBe(8_000);
  expect(manifest.pairLossHaltUsd).toBe(500);
  expect(manifest.jevMonthlyBudgetUsd).toBe(100);
  expect(manifest.paper).toBe(true);
});

test("revenue gate thresholds and the engine refuses unpaid Jev variants", async () => {
  expect(revenueGate("1m", { netUsd: 400, maxDrawdownUsd: 10, quarters: [] }).pass).toBe(true);
  expect(revenueGate("1m", { netUsd: 399.99, maxDrawdownUsd: 10, quarters: [] }).pass).toBe(false);
  expect(revenueGate("6m", { netUsd: 2400, maxDrawdownUsd: 10, quarters: [{ quarter: "2026Q3", netUsd: 1199 }] }).pass).toBe(false);
  expect(revenueGate("6m", { netUsd: 5000, maxDrawdownUsd: 10, quarters: [{ quarter: "2026Q3", netUsd: 5000 }] }).pass).toBe(false);
  expect(revenueGate("6m", {
    netUsd: 3600,
    maxDrawdownUsd: 10,
    quarters: [
      { quarter: "2026Q2", netUsd: 1200 },
      { quarter: "2026Q3", netUsd: 1200 },
      { quarter: "2026Q4", netUsd: 1200 },
    ],
  }).pass).toBe(true);
  expect(revenueGate("6m", { netUsd: 8000, maxDrawdownUsd: 8000.01, quarters: [{ quarter: "2026Q3", netUsd: 1200 }] }).pass).toBe(false);
  await expect(
    runEngine({
      candles: {},
      fromMs: 0,
      toMs: 1,
      mode: "POOL",
      formula: "equal",
      strategy: "combined",
      sentiment: "unknown",
      enabledPairs: ["UNI-USD"],
      variant: "jev_veto",
    }),
  ).rejects.toThrow("needs paid Jev reviews");
});

test("engine replay on a short synthetic tape finishes without a Jev call", async () => {
  const bars = Array.from({ length: 500 }, (_, i) => {
    const close = 100 + i * 0.01;
    return { ts: Date.parse("2026-10-01T00:00:00.000Z") + i * 60_000, open: close, high: close + 0.2, low: close - 0.2, close, volume: 10 };
  });
  const result = await runEngine({
    candles: { "UNI-USD": bars },
    fromMs: bars[200]!.ts,
    toMs: bars[499]!.ts + 60_000,
    mode: "SILO",
    formula: "equal",
    strategy: "A",
    sentiment: "unknown",
    enabledPairs: ["UNI-USD"],
    variant: "jev_off",
  });
  expect(Number.isFinite(result.netUsd)).toBe(true);
  expect(result.variant).toBe("jev_off");
  expect(result.maxDrawdownUsd).toBeGreaterThanOrEqual(0);
});
