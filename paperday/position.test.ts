import { expect, test } from "bun:test";
import { openPosition, stepPosition, target, tightenStop, type Position } from "./src/position";
import type { MinuteBar } from "./src/fill";
import type { StepContext } from "./src/position";

const OPEN = Date.parse("2026-10-07T15:00:00.000Z");

function pos(patch: Partial<Position> = {}): Position {
  return {
    ...openPosition({ id: "p", pair: "UNI-USD", entry: 100, units: 10, stop: 94, openedTs: OPEN, entryFeeUsd: 5 }),
    ...patch,
  };
}

function bar(patch: Partial<MinuteBar> & { ts: number }): MinuteBar {
  return { open: 100, high: 101, low: 96, close: 100, volume: 10, ...patch };
}

const quiet: StepContext = {
  gapSec: 0,
  fiveMinComplete: false,
  fiveMinClose: null,
  vwap: null,
  confirmedSwingLow: null,
};

test("stop exits at the stop, or at the open when the bar gaps through", () => {
  const hit = stepPosition(pos(), bar({ ts: OPEN + 60_000, open: 99, high: 101, low: 94, close: 97 }), quiet);
  expect(hit.position).toBeNull();
  expect(hit.events[0]?.reason).toBe("stop");
  expect(hit.events[0]?.price).toBe(94);
  expect(hit.events[0]?.feeBps).toBe(90);

  const gap = stepPosition(pos(), bar({ ts: OPEN + 60_000, open: 90, high: 92, low: 89, close: 91 }), quiet);
  expect(gap.events[0]?.reason).toBe("stop");
  expect(gap.events[0]?.price).toBe(90);
});

test("t1 sells half and the later breakeven exit is the entry price", () => {
  const t1 = target(100, 94, 1.5);
  expect(t1).toBe(109);
  const first = stepPosition(pos(), bar({ ts: OPEN + 60_000, open: 100, high: 109, low: 96, close: 109 }), quiet);
  expect(first.position).not.toBeNull();
  expect(first.events[0]?.kind).toBe("t1");
  expect(first.events[0]?.units).toBe(5);
  expect(first.events[0]?.price).toBe(109);
  expect(first.position!.stop).toBe(100);
  expect(first.position!.t1Done).toBe(true);
  expect(first.position!.units).toBe(5);

  const be = stepPosition(first.position!, bar({ ts: OPEN + 120_000, open: 102, high: 104, low: 100, close: 101 }), quiet);
  expect(be.position).toBeNull();
  expect(be.events[0]?.reason).toBe("breakeven");
  expect(be.events[0]?.price).toBe(100);
});

test("trail exit uses a tightened swing low and never a widened stop", () => {
  const afterT1 = pos({ t1Done: true, stop: 100, units: 5 });
  const armed = stepPosition(
    afterT1,
    bar({ ts: OPEN + 60_000, open: 106, high: 112, low: 104, close: 110 }),
    { ...quiet, confirmedSwingLow: 103 },
  );
  expect(armed.position!.stop).toBe(103);
  expect(tightenStop(103, 101).widened).toBe(true);
  expect(tightenStop(103, 101).stop).toBe(103);

  const trailed = stepPosition(armed.position!, bar({ ts: OPEN + 120_000, open: 108, high: 109, low: 103, close: 104 }), quiet);
  expect(trailed.position).toBeNull();
  expect(trailed.events[0]?.reason).toBe("trail");
  expect(trailed.events[0]?.price).toBe(103);
});

test("t2 exits the position at 3R", () => {
  expect(target(100, 94, 3)).toBe(118);
  const hit = stepPosition(pos(), bar({ ts: OPEN + 60_000, open: 100, high: 118, low: 96, close: 118 }), quiet);
  expect(hit.position).toBeNull();
  expect(hit.events[0]?.reason).toBe("t2");
  expect(hit.events[0]?.price).toBe(118);
  expect(hit.events[0]?.feeBps).toBe(50);
});

test("time_stop exits on the bar whose close reaches 60 minutes", () => {
  const tooSoon = stepPosition(pos(), bar({ ts: OPEN + 58 * 60_000, open: 101, high: 102, low: 96, close: 101 }), quiet);
  expect(tooSoon.position).not.toBeNull();
  const due = stepPosition(pos(), bar({ ts: OPEN + 59 * 60_000, open: 101, high: 102, low: 96, close: 101.5 }), quiet);
  expect(due.position).toBeNull();
  expect(due.events[0]?.reason).toBe("time_stop");
  expect(due.events[0]?.price).toBe(101.5);
  expect(due.events[0]?.feeBps).toBe(90);
});

test("vwap_invalidation exits when the completed 5-minute close is under session VWAP", () => {
  const hit = stepPosition(
    pos(),
    bar({ ts: OPEN + 4 * 60_000, open: 100, high: 101, low: 96, close: 100 }),
    { ...quiet, fiveMinComplete: true, fiveMinClose: 99, vwap: 100 },
  );
  expect(hit.position).toBeNull();
  expect(hit.events[0]?.reason).toBe("vwap_invalidation");
  expect(hit.events[0]?.price).toBe(99);
});

test("rollover_flat forces the long out on the last minute of the UTC day", () => {
  const ts = Date.parse("2026-10-07T23:59:00.000Z");
  const hit = stepPosition(pos({ openedTs: ts - 60_000 }), bar({ ts, open: 105, high: 106, low: 104, close: 105 }), quiet);
  expect(hit.position).toBeNull();
  expect(hit.events[0]?.reason).toBe("rollover_flat");
  expect(hit.events[0]?.price).toBe(105);
});

test("an unfilled target sold at market is taker, not the resting maker fee", () => {
  const hit = stepPosition(
    pos(),
    bar({ ts: OPEN + 60_000, open: 100, high: 130, low: 96, close: 120 }),
    { ...quiet, forceMarketExit: true },
  );
  expect(hit.position).toBeNull();
  expect(hit.events[0]?.reason).toBe("market_exit");
  expect(hit.events[0]?.feeBps).toBe(90);
  expect(hit.events[0]?.price).toBe(120);
  expect(hit.events[0]?.feeUsd).toBeCloseTo((10 * 120 * 90) / 10_000, 8);
});

test("swing hold is 48h and does not flatten at UTC midnight", () => {
  const held = pos({ maxHoldMs: 48 * 60 * 60_000, flatAtMidnight: false, vwapExit: false });
  const midnight = Date.parse("2026-10-07T23:59:00.000Z");
  const stay = stepPosition(held, bar({ ts: midnight, open: 105, high: 106, low: 104, close: 105 }), quiet);
  expect(stay.position).not.toBeNull();
  expect(stay.events).toEqual([]);
  const early = stepPosition(held, bar({ ts: OPEN + 48 * 60 * 60_000 - 120_000, open: 101, high: 102, low: 96, close: 101 }), quiet);
  expect(early.position).not.toBeNull();
  const due = stepPosition(held, bar({ ts: OPEN + 48 * 60 * 60_000 - 60_000, open: 101, high: 102, low: 96, close: 101.25 }), quiet);
  expect(due.position).toBeNull();
  expect(due.events[0]?.reason).toBe("max_hold");
  expect(due.events[0]?.feeBps).toBe(90);
});

test("data_gap exits at the next bar open", () => {
  const hit = stepPosition(
    pos(),
    bar({ ts: OPEN + 180_000, open: 107, high: 108, low: 90, close: 106 }),
    { ...quiet, gapSec: 180 },
  );
  expect(hit.position).toBeNull();
  expect(hit.events[0]?.reason).toBe("data_gap");
  expect(hit.events[0]?.price).toBe(107);
});
