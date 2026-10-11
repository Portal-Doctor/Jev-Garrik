import { expect, test } from "bun:test";
import { walkLong } from "./walk";

const bars = [
  { ts: 0, open: 100, high: 101, low: 99, close: 100.5 },
  { ts: 900, open: 100, high: 110, low: 90, close: 105 },
];

test("a stop fills before a rule exit on the same day", () => {
  const leg = walkLong({ bars, entryTs: 0, endTs: 1800, stop: 95, sBtBps: 5, atr1h: () => 0, ruleExitTs: 1800 });
  expect(leg?.reason).toBe("stop");
  expect(leg?.rawExit).toBe(95);
  expect(leg?.fillExit).toBeCloseTo(94.95, 8);
  expect(leg?.entryFeeBps).toBe(90);
  expect(leg?.exitFeeBps).toBe(90);
  expect(leg?.spreadBps).toBe(5);
  expect(leg!.grossBps).toBeCloseTo(-500, 6);
  expect(leg!.netBps).toBeLessThan(leg!.grossBps);
});

test("a bar that opens through the stop fills at the open", () => {
  const gapped = [
    bars[0]!,
    { ts: 900, open: 90, high: 91, low: 89, close: 90.5 },
  ];
  const leg = walkLong({ bars: gapped, entryTs: 0, endTs: 1800, stop: 95, sBtBps: 5, atr1h: () => 0, ruleExitTs: 1800 });
  expect(leg?.reason).toBe("gap");
  expect(leg?.rawExit).toBe(90);
  expect(leg?.fillExit).toBe(90);
});

test("a rule exit uses the close when the stop is not touched", () => {
  const quiet = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100.4 },
    { ts: 900, open: 100.4, high: 102, low: 100, close: 101 },
  ];
  const leg = walkLong({ bars: quiet, entryTs: 0, endTs: 1800, stop: 90, sBtBps: 10, atr1h: () => 0, ruleExitTs: 1800 });
  expect(leg?.reason).toBe("rule");
  expect(leg?.rawExit).toBe(101);
  expect(leg?.spreadBps).toBe(10);
});

test("an open trade at the window end is marked to the last close", () => {
  const quiet = [
    { ts: 0, open: 100, high: 101, low: 99, close: 100.2 },
    { ts: 900, open: 100.2, high: 101, low: 100, close: 100.6 },
  ];
  const leg = walkLong({ bars: quiet, entryTs: 0, endTs: 1800, stop: 90, sBtBps: 5, atr1h: () => 0, ruleExitTs: null });
  expect(leg?.reason).toBe("window");
  expect(leg?.rawExit).toBe(100.6);
});
