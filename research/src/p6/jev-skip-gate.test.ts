import { expect, test } from "bun:test";
import type { MarketState } from "../../../cb/state";
import { gapWeekReport } from "./amendment-v6";
import {
  archiveJevLegacy,
  drainJevShadow,
  freshJevSkip,
  mergeJevSkip,
  noteOnTimePacket,
  scheduleLiveJev,
  trailingSkipGate,
  type JevDayCount,
  type JevReason,
} from "./jev-call";
import { hotSnapshot } from "./hot-store";
import { capturePaperState, installPaperState, startPaperHost } from "./paper-host";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-16T18:00:00.000Z");
const TODAY = Math.floor(NOW / DAY) * DAY;
const ANSWER = { market_regime: "balance", direction_bias: "flat", toxic_flow_risk: "low", liquidity_stress: "normal" } as const;

function day(offset: number, scheduled: number, skipped: number, answered = Math.max(0, scheduled - skipped)): JevDayCount {
  return { dayMs: TODAY + offset * DAY, onTime: 0, catchUp: 0, scheduled, skipped, answered };
}

function gate(days: JevDayCount[], now = NOW) {
  return trailingSkipGate(days, now);
}

test("legacy lifetime counters do not feed the skip gate", () => {
  const host = startPaperHost(["BTC-USD"], {});
  installPaperState(host, { jevPackets: 13_100, jevSkipped: 13_051 });
  expect(host.jevLegacy).toEqual({ jevPackets: 13_100, jevSkipped: 13_051 });
  installPaperState(host, { jevPackets: 20_000, jevSkipped: 19_900 });
  expect(host.jevLegacy).toEqual({ jevPackets: 13_100, jevSkipped: 13_051 });
  expect(host.book.jevPackets).toBe(20_000);

  const fresh = startPaperHost(["BTC-USD"], {});
  installPaperState(fresh, { jevPackets: 50, jevSkipped: 40, jevLegacy: { jevPackets: 13_100, jevSkipped: 13_051 } });
  expect(fresh.jevLegacy).toEqual({ jevPackets: 13_100, jevSkipped: 13_051 });

  const empty = startPaperHost(["BTC-USD"], {});
  installPaperState(empty, { jevPackets: 0, jevSkipped: 0 });
  expect(empty.jevLegacy).toBeUndefined();
  expect(archiveJevLegacy(undefined, 0, 0)).toBeUndefined();
  expect(archiveJevLegacy({ jevPackets: 3, jevSkipped: 2 }, 9, 8)).toEqual({ jevPackets: 3, jevSkipped: 2 });

  const report = gapWeekReport({
    weekMs: 7 * DAY,
    gaps: [],
    hours: [],
    jevSkipped: 13_051,
    jevPackets: 13_100,
    dIndeterminate: 0,
    dSubmitted: 0,
    catchUpDays: [],
    nowMs: NOW,
  });
  expect(report.jevSkipStatus).toBe("INSUFFICIENT_DATA");
  expect(report.jevSkipShare).toBe(0);
  expect(report.jevSkipShare).not.toBeCloseTo(13_051 / 13_100);
  expect(report.jevSkipLabel).toBe("insufficient data (days 0/7, scheduled 0)");
  expect(report.flags).not.toContain("jev-skip");
  expect(report.noGo).toBe(false);
  expect(report.flagWeek).toBe(false);
});

test("the trailing window drops the oldest UTC day at midnight and counts a new day", () => {
  const days = [day(-7, 200, 200), ...Array.from({ length: 6 }, (_, i) => day(-6 + i, 50, 0)), day(0, 50, 0)];
  const before = gate(days, NOW - DAY);
  expect(before.scheduled).toBe(500);
  expect(before.skipped).toBe(200);
  expect(before.days).toBe(7);
  const after = gate(days, NOW);
  expect(after.scheduled).toBe(350);
  expect(after.skipped).toBe(0);
  expect(after.days).toBe(7);
  expect(after.share).toBe(0);
  expect(after.status).toBe("PASS");
});

test("the early Wilson flag fires only above the bound, with 2 days and 100 packets", () => {
  const flags = (rows: JevDayCount[]) => gapWeekReport({
    weekMs: 7 * DAY,
    gaps: [],
    hours: [],
    jevSkipped: 13_051,
    jevPackets: 13_100,
    dIndeterminate: 0,
    dSubmitted: 0,
    catchUpDays: rows,
    nowMs: NOW,
  });
  const above = flags([day(-1, 50, 4), day(0, 50, 5)]);
  expect(above.jevSkipStatus).toBe("FLAG");
  expect(above.jevSkipWilson).toBeGreaterThan(0.05);
  expect(above.flags).toContain("jev-skip");
  expect(above.flagWeek).toBe(true);
  expect(above.noGo).toBe(false);
  const below = flags([day(-1, 50, 4), day(0, 50, 4)]);
  expect(below.jevSkipWilson).toBeLessThanOrEqual(0.05);
  expect(below.jevSkipStatus).toBe("INSUFFICIENT_DATA");
  expect(below.flags).not.toContain("jev-skip");
  const oneDay = flags([day(0, 100, 9)]);
  expect(oneDay.jevSkipStatus).toBe("INSUFFICIENT_DATA");
  expect(oneDay.flags).not.toContain("jev-skip");
  const fewPackets = flags([day(-1, 50, 50), day(0, 49, 49)]);
  expect(fewPackets.jevSkipScheduled).toBe(99);
  expect(fewPackets.jevSkipStatus).toBe("INSUFFICIENT_DATA");
  expect(fewPackets.flags).not.toContain("jev-skip");
});

test("PASS is exactly 5 percent with 7 days and 300 packets, and short samples stay insufficient", () => {
  const full = [...Array.from({ length: 6 }, (_, i) => day(-6 + i, 40, 2)), day(0, 60, 3)];
  const pass = gate(full);
  expect(pass.days).toBe(7);
  expect(pass.scheduled).toBe(300);
  expect(pass.share).toBeCloseTo(0.05);
  expect(pass.status).toBe("PASS");
  expect(pass.flag).toBe(false);

  const sixDays = Array.from({ length: 6 }, (_, i) => day(-5 + i, 50, 0));
  expect(gate(sixDays).days).toBe(6);
  expect(gate(sixDays).scheduled).toBe(300);
  expect(gate(sixDays).status).toBe("INSUFFICIENT_DATA");

  const short = [...Array.from({ length: 6 }, (_, i) => day(-6 + i, 40, 0)), day(0, 59, 0)];
  expect(gate(short).scheduled).toBe(299);
  expect(gate(short).days).toBe(7);
  expect(gate(short).status).toBe("INSUFFICIENT_DATA");
  expect(gate(short).label).toBe("insufficient data (days 7/7, scheduled 299)");

  const over = [...Array.from({ length: 6 }, (_, i) => day(-6 + i, 40, 2)), day(0, 60, 4)];
  const flagged = gate(over);
  expect(flagged.scheduled).toBe(300);
  expect(flagged.share).toBeCloseTo(16 / 300);
  expect(flagged.wilsonLower).toBeLessThanOrEqual(0.05);
  expect(flagged.status).toBe("FLAG");
});

test("a zero-packet day adds no data and does not count toward the 7 days", () => {
  const rows = [...Array.from({ length: 6 }, (_, i) => day(-6 + i, 50, 0)), day(0, 0, 0)];
  const row = gate(rows);
  expect(row.days).toBe(6);
  expect(row.scheduled).toBe(300);
  expect(row.skipped).toBe(0);
  expect(row.share).toBe(0);
  expect(row.status).toBe("INSUFFICIENT_DATA");
  expect(row.label).toBe("insufficient data (days 6/7, scheduled 300)");
});

test("catch-up bars stay out of the skip counters and reasons sum to skipped", async () => {
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => NOW;
  host.holderId = "holder-a";
  host.leaseFromMs = 100;
  const newest = Math.floor(NOW / 1000) - 5_000;
  const oldest = newest - 4 * 900;
  for (let i = 0; i < 5; i += 1) {
    host.book.jevBarSec = undefined;
    scheduleLiveJev(host, oldest + i * 900);
  }
  expect(host.jevSkip.jevDays.reduce((sum, row) => sum + (row.scheduled ?? 0), 0)).toBe(0);
  expect(host.jevSkip.jevDays.reduce((sum, row) => sum + (row.skipped ?? 0), 0)).toBe(0);
  expect(host.jevSkip.jevDays.reduce((sum, row) => sum + row.catchUp, 0)).toBe(5);

  host.book.jevBarSec = undefined;
  scheduleLiveJev(host, Math.floor(NOW / 1000) - 1_000);
  const live = host.jevSkip.jevDays.find((row) => (row.scheduled ?? 0) > 0);
  expect(live?.scheduled).toBe(1);
  expect(live?.skipped).toBe(1);
  expect(live?.byReason?.no_1m_input).toBe(1);

  const ledger = freshJevSkip();
  const reasons: JevReason[] = ["no_1m_input", "not_called", "timeout", "call_error", "invalid_response"];
  for (const reason of reasons) {
    noteOnTimePacket(ledger, NOW, "scheduled");
    noteOnTimePacket(ledger, NOW, reason);
  }
  const counted = ledger.jevDays[0]!;
  const sum = Object.values(counted.byReason ?? {}).reduce((total, value) => total + (value ?? 0), 0);
  expect(counted.skipped).toBe(reasons.length);
  expect(sum).toBe(reasons.length);
  expect(counted.scheduled).toBe(reasons.length);

  const answered = startPaperHost(["BTC-USD"], {});
  answered.clock = () => NOW;
  answered.leaseToken = "held";
  answered.jevCaller = async () => ({ ok: true, answer: ANSWER, costUsd: 0.01, tokens: 2 });
  answered.jevQueue.push({ pair: "BTC-USD", barStartSec: Math.floor(NOW / 1000) - 901, state: state(), minutes: [] });
  await drainJevShadow(answered, NOW, NOW + 120_000);
  expect(answered.jevAnswers[0]?.reason).toBe("ok");
  expect(answered.jevSkip.jevDays.reduce((sum, row) => sum + (row.answered ?? 0), 0)).toBe(1);
  expect(answered.jevSkip.jevDays.reduce((sum, row) => sum + (row.skipped ?? 0), 0)).toBe(0);
});

test("daily skip counters stay inside 14 UTC days and the watermark is not shed", () => {
  const ledger = freshJevSkip();
  for (let i = 19; i >= 0; i -= 1) noteOnTimePacket(ledger, TODAY - i * DAY, "scheduled");
  expect(ledger.jevDays).toHaveLength(14);
  expect(Buffer.byteLength(JSON.stringify(ledger.jevDays))).toBeLessThan(4_096);

  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => NOW;
  host.leaseToken = "held";
  host.jevSkip = ledger;
  host.jevThrough = { "BTC-USD": 123_456 };
  host.jevLegacy = { jevPackets: 13_100, jevSkipped: 13_051 };
  host.jevFirst = Array.from({ length: 20 }, (_, i) => ({
    bar: i + 1,
    atMs: 1,
    holder: "h".repeat(20_000),
    leaseFromMs: 1,
    pairs: ["BTC-USD"],
  }));
  const body = JSON.parse(hotSnapshot(host)) as {
    jevFirst: unknown[];
    jevThrough: Record<string, number>;
    jevSkip: { jevDays: unknown[] };
    jevLegacy: { jevPackets: number; jevSkipped: number };
  };
  expect(body.jevFirst).toEqual([]);
  expect(body.jevThrough["BTC-USD"]).toBe(123_456);
  expect(body.jevSkip.jevDays).toHaveLength(14);
  expect(body.jevLegacy).toEqual({ jevPackets: 13_100, jevSkipped: 13_051 });
});

test("install max-merges the watermark per pair", () => {
  const host = startPaperHost(["BTC-USD", "ETH-USD"], {});
  host.jevThrough = { "BTC-USD": 5_000, "ETH-USD": 100 };
  installPaperState(host, { jevThrough: { "BTC-USD": 4_000, "ETH-USD": 200, "SOL-USD": 50 } });
  expect(host.jevThrough["BTC-USD"]).toBe(5_000);
  expect(host.jevThrough["ETH-USD"]).toBe(200);
  expect(host.jevThrough["SOL-USD"]).toBe(50);
});

test("scheduled survives capture then install", () => {
  const host = startPaperHost(["BTC-USD"], {});
  noteOnTimePacket(host.jevSkip, TODAY, "scheduled");
  noteOnTimePacket(host.jevSkip, TODAY, "scheduled");
  const body = capturePaperState(host);
  const next = startPaperHost(["BTC-USD"], {});
  installPaperState(next, body);
  expect(next.jevSkip.jevDays.find((row) => row.dayMs === TODAY)?.scheduled).toBe(2);
});

test("install merges jevSkip days and keeps the 14-day bound", () => {
  const host = startPaperHost(["BTC-USD"], {});
  installPaperState(host, {
    jevSkip: { ...freshJevSkip(), jevDays: [day(0, 10, 4), day(-1, 8, 1), day(-10, 3, 1)] },
  });
  installPaperState(host, {
    jevSkip: { ...freshJevSkip(), jevDays: [day(0, 10, 0), day(-3, 2, 0), day(-20, 99, 0)] },
  });
  const today = host.jevSkip.jevDays.find((row) => row.dayMs === TODAY);
  expect(today?.scheduled).toBe(10);
  expect(today?.skipped).toBe(4);
  expect(host.jevSkip.jevDays.find((row) => row.dayMs === TODAY - DAY)?.scheduled).toBe(8);
  expect(host.jevSkip.jevDays.find((row) => row.dayMs === TODAY - 3 * DAY)?.scheduled).toBe(2);
  expect(host.jevSkip.jevDays.find((row) => row.dayMs === TODAY - 10 * DAY)?.scheduled).toBe(3);
  expect(host.jevSkip.jevDays.find((row) => row.dayMs === TODAY - 20 * DAY)).toBeUndefined();

  installPaperState(host, { jevSkip: { ...freshJevSkip(), jevDays: [day(0, 12, 1)] } });
  expect(host.jevSkip.jevDays.find((row) => row.dayMs === TODAY)?.scheduled).toBe(12);
  expect(host.jevSkip.jevDays.find((row) => row.dayMs === TODAY)?.skipped).toBe(1);

  const wide = startPaperHost(["BTC-USD"], {});
  installPaperState(wide, {
    jevSkip: { ...freshJevSkip(), jevDays: Array.from({ length: 20 }, (_, index) => day(-index, 1, 0)) },
  });
  expect(wide.jevSkip.jevDays).toHaveLength(14);
  expect(wide.jevSkip.jevDays.some((row) => row.dayMs === TODAY - 14 * DAY)).toBe(false);
  expect(wide.jevSkip.jevDays.some((row) => row.dayMs === TODAY - 13 * DAY)).toBe(true);

  const lower = mergeJevSkip(
    { ...freshJevSkip(), jevDays: Array.from({ length: 7 }, (_, index) => day(-index, 50, 5)) },
    { ...freshJevSkip(), jevDays: [day(0, 1, 0)] },
  );
  expect(lower.jevDays.find((row) => row.dayMs === TODAY)?.scheduled).toBe(50);
  expect(lower.jevDays).toHaveLength(7);
});

function state(): MarketState {
  return {
    pair: "BTC-USD",
    ts: NOW,
    horizonSec: 900,
    mid: 100,
    spreadBps: 1,
    spreadEmaBps: 1,
    imbalance5: 0,
    imbalance20: 0,
    volBps: 1,
    parkinsonBps: 1,
    emaGapBps: 0,
    emaCross: 0,
    rsi: 50,
    volumeDelta: 0,
    volumeGross: 1,
    returnsBps: { m5: 0, m30: 0, h1: 0, h4: 0 },
    position: "flat",
    feeBps: { maker: 0, taker: 0 },
  } as unknown as MarketState;
}
