import { expect, test } from "bun:test";
import { addDays, daysBetween } from "../p5/stats";
import { applyForward, freshBook } from "./engine";
import { captureHot, loadSplit, persistSplit } from "./hot-store";
import { installPaperState, startPaperHost } from "./paper-host";
import { decodeStored } from "./redis-gzip";
import { decodeLease, HOT_KEY, LEASE_KEY, memoryKv, peekStored, tryAcquire } from "./relay";
import {
  CLASS_A_KILL_USD,
  CLASS_A_PAPER_START_MS,
  CLASS_A_SPEC_SHA256,
  classARuleExit,
  classAStartMs,
  concentrationOf,
  deployedFraction,
  emptyClassABook,
  equalWeightBuyHold,
  evaluateSignal,
  evaluateSignals,
  exclusionPreflight,
  exposureAdjusted,
  healthCheckpoints,
  medianVolumeUsd,
  onDaily,
  onIntrabar,
  openClassABook,
  orderClassASignals,
  promotionOf,
  regimeOf,
  scrubClassAPaper,
  sizedOrder,
  signalCloseMs,
  stopFillPx,
  takerSpreadBps,
  walkCostBps,
  type ClassABook,
  type ClassADay,
  type ClassAScored,
  type ClassASignal,
} from "./class-a-paper";

const START = Date.parse("2024-01-01T00:00:00.000Z");

function daysOf(baseVolume = 100_000, last = 100.05): ClassADay[] {
  const n = 70;
  return Array.from({ length: n }, (_, i) => {
    const close = i === n - 1 ? last : 100;
    return {
      date: addDays("2024-01-01", i),
      high: close + 0.05,
      low: close - 0.05,
      close,
      baseVolume,
    };
  });
}

function signal(over: Partial<ClassASignal> = {}): ClassASignal {
  const days = over.days ?? daysOf();
  const index = over.index ?? days.length - 1;
  const close = days[index]!.close;
  const at = signalCloseMs(days[index]!.date);
  return {
    pair: "SOL-USD",
    listedDays: 120,
    btcClose: null,
    btcEma50: null,
    btcDailyMove: null,
    btcSma200: null,
    btcSma50: null,
    btcSma50TenAgo: null,
    spreadBps: 1,
    depthCostBps: 1,
    quoteAgeMs: 100,
    minOrderBase: 0.0001,
    tick: 0.01,
    medianSpreadBps: 10,
    spreadSamples: Array.from({ length: 30 }, () => 10),
    nextHourOpen: close,
    hourAtr14: 0.2,
    prints: [{ tsMs: at + 60_000, price: close - 0.01 }],
    ...over,
    days,
    index,
  };
}

function book(): ClassABook {
  return emptyClassABook(START);
}

function trade(pair: string, over: Partial<ClassASignal> = {}): ClassASignal {
  return signal({ ...over, pair });
}

test("a null start records nothing", () => {
  const idle = emptyClassABook(null);
  expect(evaluateSignal(idle, signal())).toBeNull();
  expect(idle.rows).toHaveLength(0);
  expect(scrubClassAPaper(undefined).status).toBe("running");
  expect(scrubClassAPaper(undefined).start).toBe("2026-10-26T00:00:00.000Z");
  expect(CLASS_A_SPEC_SHA256).toBe("56fb7543d69a80b536d7ae4d9f9d9240ebde33f1500fde45e6b5235e70a753d0");
});

test("excluded names and a listing under 90 days produce no row", () => {
  const paper = book();
  expect(evaluateSignal(paper, signal({ pair: "WBTC-USD" }))).toBeNull();
  expect(evaluateSignal(paper, signal({ listedDays: 89 }))).toBeNull();
  expect(evaluateSignal(paper, signal({ listedDays: 90 }))).not.toBeNull();
  expect(paper.rows).toHaveLength(1);
});

test("the volume floor is the 30 completed days before the signal day", () => {
  const prior = Array.from({ length: 30 }, () => ({ baseVolume: 50_000, close: 100 }));
  const withSignal = [...prior, { baseVolume: 1_000_000, close: 100 }];
  expect(medianVolumeUsd(withSignal, 30)).toBe(5_000_000);
  expect(medianVolumeUsd(prior, 29)).toBeNull();
  expect(medianVolumeUsd(withSignal, 29)).toBeNull();
  const below = book();
  const skipped = evaluateSignal(below, signal({ days: daysOf(49_000) }));
  expect(skipped?.skipReason).toBe("skip_volume");
  expect(skipped?.counterfactual).toBeNull();
  const atFloor = book();
  const row = evaluateSignal(atFloor, signal({ days: daysOf(50_000) }));
  expect(row?.skipReason).not.toBe("skip_volume");
  expect(row?.medianVolumeUsd).toBeGreaterThanOrEqual(5_000_000);
});

test("the BTC veto is strict on both sides and does not block the maker when it is off", () => {
  const vetoed = evaluateSignal(book(), signal({ btcClose: 100, btcEma50: 101, btcDailyMove: -0.03 }));
  expect(vetoed?.skipReason).toBe("skip_btcveto");
  expect(vetoed?.counterfactual).toBeNull();
  expect(vetoed?.btcVeto).toBe(true);
  const softer = evaluateSignal(book(), signal({ btcClose: 100, btcEma50: 101, btcDailyMove: -0.029 }));
  expect(softer?.skipReason).not.toBe("skip_btcveto");
  const touch = evaluateSignal(book(), signal({ btcClose: 101, btcEma50: 101, btcDailyMove: -0.05 }));
  expect(touch?.btcVeto).toBe(false);
});

test("live checks use a strict greater-than and the first failure wins", () => {
  const tight = daysOf(200_001);
  expect(evaluateSignal(book(), signal({ days: tight, spreadBps: 5 }))?.skipReason).not.toBe("skip_spread");
  expect(evaluateSignal(book(), signal({ days: tight, spreadBps: 5.01 }))?.skipReason).toBe("skip_spread");
  const wide = daysOf(200_000);
  expect(medianVolumeUsd(wide, wide.length - 1)).toBe(20_000_000);
  expect(evaluateSignal(book(), signal({ days: wide, spreadBps: 10 }))?.skipReason).not.toBe("skip_spread");
  expect(evaluateSignal(book(), signal({ days: wide, spreadBps: 10.01 }))?.skipReason).toBe("skip_spread");
  expect(evaluateSignal(book(), signal({ depthCostBps: 15 }))?.skipReason).not.toBe("skip_depth");
  expect(evaluateSignal(book(), signal({ depthCostBps: 15.01 }))?.skipReason).toBe("skip_depth");
  expect(evaluateSignal(book(), signal({ depthCostBps: Number.POSITIVE_INFINITY }))?.skipReason).toBe("skip_depth");
  expect(evaluateSignal(book(), signal({ quoteAgeMs: 2_000 }))?.skipReason).not.toBe("skip_stale");
  expect(evaluateSignal(book(), signal({ quoteAgeMs: 2_001 }))?.skipReason).toBe("skip_stale");
  const both = evaluateSignal(book(), signal({ spreadBps: 11, depthCostBps: 40 }));
  expect(both?.skipReason).toBe("skip_spread");
  expect(both?.counterfactual?.status).toBe("open");
});

test("a maker fill needs a trade at least one tick through the limit inside the four hour window", () => {
  const paper = book();
  const row = evaluateSignal(paper, signal());
  expect(row?.fill).toBe("fill");
  expect(row?.exitPrice).toBeNull();
  expect(row?.signalClose).toBe(100.05);
  expect(paper.open[0]?.entry).toBe(100.05);
  expect(paper.open[0]?.feeEntryBps).toBe(50);
  expect(row?.notionalUsd).toBe(2_000);
  expect(paper.open[0]?.units).toBeCloseTo(2_000 / 100.05, 8);
  const days = daysOf();
  const close = days[69]!.close;
  const at = signalCloseMs(days[69]!.date);
  const late = evaluateSignal(book(), signal({ days, prints: [{ tsMs: at + 4 * 60 * 60 * 1000, price: close - 1 }] }));
  expect(late?.skipReason).toBe("skip_nofill");
  const touch = evaluateSignal(book(), signal({ days, prints: [{ tsMs: at + 1_000, price: close }] }));
  expect(touch?.skipReason).toBe("skip_nofill");
  const exact = evaluateSignal(book(), signal({ days, prints: [{ tsMs: at + 4 * 60 * 60 * 1000 - 1, price: close - 0.01 }] }));
  expect(exact?.fill).toBe("fill");
  expect(exact?.signalClose).toBe(close);
  expect(evaluateSignal(book(), signal({ tick: null }))?.skipReason).toBe("skip_nofill");
});

test("the chase skip applies only to the counterfactual taker", () => {
  const days = daysOf();
  const close = days[69]!.close;
  const paper = book();
  const row = evaluateSignal(paper, signal({ days, nextHourOpen: close + 1 }));
  expect(row?.fill).toBe("fill");
  expect(row?.counterfactual?.status).toBe("chase");
  expect(paper.shadows).toHaveLength(0);
  expect(paper.open).toHaveLength(1);
});

test("order size is never rounded up to the minimum", () => {
  const sized = evaluateSignal(book(), signal());
  const units = 2_000 / 100.05;
  expect(sized?.fill).toBe("fill");
  const under = evaluateSignal(book(), signal({ minOrderBase: units }));
  expect(under?.fill).toBe("fill");
  const over = evaluateSignal(book(), signal({ minOrderBase: units + 1e-8 }));
  expect(over?.skipReason).toBe("skip_minsize");
  expect(over?.notionalUsd).toBeNull();
  expect(over?.measured).toBeCloseTo(units, 8);
});

test("the fourth open slot is skip_cap and open risk above $60 is skip_cap", () => {
  const paper = book();
  for (const pair of ["SOL-USD", "ETH-USD", "ADA-USD"]) expect(evaluateSignal(paper, trade(pair))?.fill).toBe("fill");
  expect(evaluateSignal(paper, trade("DOGE-USD"))?.skipReason).toBe("skip_cap");
  const risk = book();
  risk.open.push({
    rowId: "planted",
    pair: "ETH-USD",
    scored: true,
    entry: 100,
    entryMs: START,
    entryDate: "2024-03-11",
    stop: 40,
    initialStop: 40,
    notionalUsd: 100,
    units: 1,
    feeEntryBps: 50,
    sBps: 5,
    highestClose: 100,
    priorCloses: [],
    pending: null,
  });
  expect(evaluateSignal(risk, signal())?.skipReason).toBe("skip_cap");
  expect(risk.open).toHaveLength(1);
});

test("one position per pair, and the 24h re-entry block follows a stop only", () => {
  const paper = book();
  expect(evaluateSignal(paper, signal())?.fill).toBe("fill");
  expect(evaluateSignal(paper, signal())?.skipReason).toBe("skip_pair");
  const entryMs = paper.open[0]!.entryMs;
  onIntrabar(paper, { pair: "SOL-USD", tsMs: entryMs - 1, open: 1, low: 1, hourAtr: 1 });
  expect(paper.open).toHaveLength(1);
  onIntrabar(paper, { pair: "SOL-USD", tsMs: entryMs + 3_600_000, open: 90, low: 90, hourAtr: 0.2 });
  expect(paper.open).toHaveLength(0);
  const filled = paper.rows.find((row) => row.fill === "fill");
  expect(filled?.exitReason).toBe("stop");
  expect(filled?.exitPrice).toBe(90);
  const again = daysOf();
  again.push({ date: addDays(again[69]!.date, 1), high: 101, low: 100, close: 100.5, baseVolume: 100_000 });
  const blocked = evaluateSignal(paper, signal({ days: again, index: 70 }));
  expect(blocked?.skipReason).toBe("skip_reentry");
  const ruled = book();
  evaluateSignal(ruled, signal());
  ruled.open[0]!.pending = "rule";
  const nextDate = addDays(ruled.open[0]!.entryDate, 1);
  onDaily(ruled, { pair: "SOL-USD", date: nextDate, open: 100.05, low: 100, close: 100.05, atr: 0.1, hourAtr: 0.2 });
  expect(ruled.rows[0]?.exitReason).toBe("rule");
  expect(ruled.reentryUntil["SOL-USD"]).toBeUndefined();
  expect(evaluateSignal(ruled, signal({ days: again, index: 70 }))?.skipReason).not.toBe("skip_reentry");
});

test("a stop gap fills at the open and a touch fills at the stop minus the larger slip", () => {
  const gap = book();
  evaluateSignal(gap, signal());
  const sim = gap.open[0]!;
  expect(stopFillPx(sim.stop, 1, sim.stop - 1)).toBe(sim.stop - 1);
  expect(stopFillPx(sim.stop, 1, sim.stop + 1)).toBeCloseTo(sim.stop - 0.1, 8);
  expect(stopFillPx(sim.stop, 0.1, sim.stop + 1)).toBeCloseTo(sim.stop * (1 - 0.0005), 8);
  onIntrabar(gap, { pair: "SOL-USD", tsMs: sim.entryMs + 1_000, open: sim.stop + 0.2, low: sim.stop - 0.01, hourAtr: 1 });
  expect(gap.rows[0]?.exitPrice).toBeCloseTo(sim.stop - 0.1, 8);
  expect(gap.rows[0]?.gap).toBeUndefined();
  const through = book();
  evaluateSignal(through, signal());
  const openSim = through.open[0]!;
  onIntrabar(through, { pair: "SOL-USD", tsMs: openSim.entryMs + 1_000, open: openSim.stop - 1, low: openSim.stop - 2, hourAtr: 0.2 });
  const gapped = through.rows.find((row) => row.fill === "fill");
  expect(gapped?.gap).toBe(true);
  expect(gapped?.exitPrice).toBe(openSim.stop - 1);
});

test("the chandelier ratchets up and a 10-day or 30-day rule exits at the next open", () => {
  const paper = book();
  evaluateSignal(paper, signal());
  const sim = paper.open[0]!;
  const first = sim.entryDate;
  onDaily(paper, { pair: "SOL-USD", date: first, open: 100.05, low: 100, close: 101, atr: 0.1, hourAtr: 0.2 });
  const raised = paper.open[0]!.stop;
  expect(raised).toBeGreaterThan(sim.initialStop);
  onDaily(paper, { pair: "SOL-USD", date: addDays(first, 1), open: 100.9, low: 100.8, close: 100.8, atr: 2, hourAtr: 0.2 });
  expect(paper.open[0]!.stop).toBe(raised);
  paper.open[0]!.priorCloses = Array.from({ length: 10 }, () => 101);
  onDaily(paper, { pair: "SOL-USD", date: addDays(first, 2), open: 100.95, low: 100.85, close: 100.9, atr: 0.1, hourAtr: 0.2 });
  expect(paper.open[0]?.pending).toBe("rule");
  onDaily(paper, { pair: "SOL-USD", date: addDays(first, 3), open: 100.4, low: 100.2, close: 100.3, atr: 0.1, hourAtr: 0.2 });
  expect(paper.rows[0]?.exitReason).toBe("rule");
  expect(paper.rows[0]?.exitPrice).toBe(100.4);

  const held = book();
  evaluateSignal(held, signal());
  const entryDate = held.open[0]!.entryDate;
  let pendingOn: string | null = null;
  for (let i = 0; i < 40 && held.open[0] && !held.open[0].pending; i += 1) {
    const date = addDays(entryDate, i);
    onDaily(held, { pair: "SOL-USD", date, open: 100.05, low: 100, close: 100.05, atr: 0.1, hourAtr: 0.2 });
    if (held.open[0]?.pending) pendingOn = date;
  }
  expect(pendingOn).not.toBeNull();
  expect(daysBetween(entryDate, addDays(pendingOn!, 1))).toBe(30);
  expect(classARuleExit(100, Array.from({ length: 10 }, () => 101), 10, 2)).toBe(true);
  expect(classARuleExit(101, Array.from({ length: 10 }, () => 100), 30, 1)).toBe(false);
  expect(classARuleExit(101, Array.from({ length: 10 }, () => 100), 30, 0.99)).toBe(true);
});

test("interim kill stops new entries and still lets an open trade exit", () => {
  const paper = book();
  evaluateSignal(paper, trade("ETH-USD"));
  evaluateSignal(paper, signal());
  expect(paper.open).toHaveLength(2);
  const sol = paper.open.find((row) => row.pair === "SOL-USD")!;
  onIntrabar(paper, { pair: "SOL-USD", tsMs: sol.entryMs + 1_000, open: 70, low: 70, hourAtr: 0.2 });
  expect(paper.killed).toBe(true);
  expect(paper.cumNetUsd).toBeLessThanOrEqual(CLASS_A_KILL_USD);
  expect(paper.open.some((row) => row.pair === "ETH-USD")).toBe(true);
  const eth = paper.open.find((row) => row.pair === "ETH-USD")!;
  onIntrabar(paper, { pair: "ETH-USD", tsMs: eth.entryMs + 1_000, open: eth.stop + 1, low: eth.stop, hourAtr: 0.2 });
  expect(paper.rows.find((row) => row.pair === "ETH-USD")?.exitReason).toBe("stop");
  expect(evaluateSignal(paper, trade("ADA-USD"))?.skipReason).toBe("skip_kill");
});

test("a counterfactual loss does not change the scored book", () => {
  const days = daysOf();
  const close = days[69]!.close;
  const paper = book();
  const row = evaluateSignal(paper, signal({ days, nextHourOpen: close + 0.04 }));
  expect(row?.counterfactual?.status).toBe("open");
  expect(paper.shadows).toHaveLength(1);
  const maker = paper.open[0]!;
  const shadow = paper.shadows[0]!;
  expect(shadow.feeEntryBps).toBeGreaterThan(maker.feeEntryBps);
  expect(shadow.stop).toBeGreaterThan(maker.stop);
  onIntrabar(paper, { pair: "SOL-USD", tsMs: shadow.entryMs + 1_000, open: maker.stop + 0.02, low: shadow.stop, hourAtr: 0.01 });
  expect(paper.open).toHaveLength(1);
  expect(paper.shadows).toHaveLength(0);
  expect(paper.cumNetUsd).toBe(0);
  expect(paper.killed).toBe(false);
  expect(row?.counterfactual?.status).toBe("closed");
  const exit = book();
  evaluateSignal(exit, signal());
  exit.open[0]!.pending = "rule";
  exit.shadows[0]!.pending = "rule";
  const date = addDays(exit.open[0]!.entryDate, 1);
  onDaily(exit, { pair: "SOL-USD", date, open: 100.05, low: 100, close: 100.05, atr: 0.1, hourAtr: 0.2 });
  const closed = exit.rows[0]!;
  expect(closed.netBps).toBeCloseTo(-145, 6);
  expect(closed.counterfactual?.netBps).toBeCloseTo(-190, 6);
});

test("regime tags are descriptive and promotion never recommends", () => {
  expect(regimeOf(110, 100, 90, 80)).toBe("BULL");
  expect(regimeOf(90, 100, 80, 90)).toBe("BEAR");
  expect(regimeOf(110, 100, 90, 90)).toBe("CHOP");
  expect(regimeOf(null, 100, 90, 80)).toBe("CHOP");
  const tagged = evaluateSignal(book(), signal({ btcClose: 110, btcSma200: 100, btcSma50: 90, btcSma50TenAgo: 80 }));
  expect(tagged?.regime).toBe("BULL");
  const row = (pair: string, grossUsd: number, grossBps: number): ClassAScored => ({
    pair,
    grossUsd,
    netUsd: grossUsd,
    grossBps,
    netBps: grossBps,
    netR: grossUsd / 20,
    regime: "CHOP",
  });
  const sample = Array.from({ length: 30 }, (_, i) => row(`P${i}-USD`, 10, 300));
  expect(promotionOf(sample).status).toBe("unresolved");
  expect(promotionOf(sample.slice(0, 29)).status).toBe("not-considered");
  expect(promotionOf(sample.map((item) => ({ ...item, grossBps: 100 }))).status).toBe("blocked");
  const concentrated = sample.map((item, i) => (i < 3 ? { ...item, grossUsd: 100, netUsd: 100, netR: 5 } : item));
  expect(concentrationOf(concentrated).top3Kill).toBe(true);
  expect(promotionOf(concentrated).status).toBe("blocked");
  expect(concentrationOf(sample.map((item) => ({ ...item, pair: "SOL-USD" }))).pairKill).toBe(true);
  expect(promotionOf([row("SOL-USD", 10, 300)]).status).toBe("not-considered");
  expect(concentrationOf([row("SOL-USD", 10, 300)]).pairKill).toBe(true);
});

test("health checks and the benchmarks do not decide promotion", () => {
  const start = Date.parse("2026-01-01T00:00:00.000Z");
  expect(healthCheckpoints(null, start + 1)).toEqual([]);
  expect(healthCheckpoints(start, start + 90 * 86_400_000 - 1)).toEqual([]);
  expect(healthCheckpoints(start, start + 90 * 86_400_000)).toEqual(["90d"]);
  expect(healthCheckpoints(start, Date.parse("2026-07-01T00:00:00.000Z"))).toEqual(["90d", "6m"]);
  const held = equalWeightBuyHold([
    { members: ["SOL-USD", "ETH-USD"], close: { "SOL-USD": 10, "ETH-USD": 10 } },
    { members: ["SOL-USD", "ETH-USD"], close: { "SOL-USD": 20, "ETH-USD": 10 } },
    { members: ["SOL-USD"], close: { "SOL-USD": 20 } },
  ]);
  expect(held).toBeCloseTo(0.5, 8);
  expect(exposureAdjusted(0.1, [0.5])).toBeCloseTo(0.2, 8);
  expect(exposureAdjusted(0.1, [0])).toBeNull();
  expect(deployedFraction(3_000)).toBeCloseTo(0.5, 8);
});

test("quoted spread has no 15 bps cap and a short book cannot walk the size", () => {
  expect(takerSpreadBps(null)).toBe(5);
  expect(takerSpreadBps(8)).toBe(5);
  expect(takerSpreadBps(100)).toBe(50);
  expect(walkCostBps(100, [{ price: 101, size: 10 }], 5)).toBeCloseTo(100, 8);
  expect(walkCostBps(100, [{ price: 101, size: 10 }], 11)).toBe(Number.POSITIVE_INFINITY);
  const sized = sizedOrder(100, 0.1);
  expect(sized?.notionalUsd).toBe(2_000);
  expect(sized?.riskUsd).toBeCloseTo(6, 8);
  const wide = sizedOrder(100, 10);
  expect(wide?.riskUsd).toBeCloseTo(20, 8);
  expect(wide?.notionalUsd).toBeCloseTo(20 / 0.3, 8);
});

test("a hostile paper payload cannot carry a secret onto the public view", () => {
  const scrubbed = scrubClassAPaper({
    specSha256: "nope",
    status: "recommend",
    start: "user:PASSWORD@x.upstash.io",
    promotion: "recommend",
    skips: { skip_kill: 1, leak: "https://x.upstash.io" },
  });
  const output = JSON.stringify(scrubbed);
  expect(scrubbed.status).toBe("redacted");
  expect(scrubbed.specSha256).toBe("redacted");
  expect(scrubbed.promotion).toBe("redacted");
  expect(scrubbed.config).toBe("A55-k3");
  expect(output.includes("upstash")).toBe(false);
  expect(output.includes("PASSWORD")).toBe(false);
});

test("the paper book round-trips through hot storage with gzip writes off and on", async () => {
  const gzip = process.env.P6_GZIP_WRITES;
  try {
    for (const flag of ["0", "1"] as const) {
      process.env.P6_GZIP_WRITES = flag;
      const host = startPaperHost(["BTC-USD"], {});
      const empty = captureHot(host) as unknown as Record<string, unknown>;
      expect("classAPaper" in empty).toBe(false);
      const paper = book();
      evaluateSignal(paper, signal());
      host.classAPaper = paper;
      const kv = memoryKv(() => START);
      expect(await tryAcquire(kv, `class-a-${flag}`, START + 86_400_000, START)).toBe(true);
      host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
      await persistSplit(kv, host);
      const stored = peekStored(kv, HOT_KEY);
      expect(stored).not.toBeNull();
      expect(stored!.startsWith("gz1:")).toBe(flag === "1");
      const loaded = startPaperHost(["BTC-USD"], {});
      const body = await loadSplit(kv, loaded);
      expect(body?.classAPaper?.cumNetUsd).toBe(0);
      installPaperState(loaded, body!);
      expect(loaded.classAPaper?.open).toHaveLength(1);
      expect(loaded.classAPaper?.rows[0]?.fill).toBe("fill");
      installPaperState(loaded, { classAPaper: { leak: "user:PASSWORD@x.upstash.io" } as never });
      expect(loaded.classAPaper).toBeUndefined();
      const text = decodeStored(HOT_KEY, stored) ?? "";
      expect(text.includes("PASSWORD")).toBe(false);
    }
  } finally {
    if (gzip === undefined) delete process.env.P6_GZIP_WRITES;
    else process.env.P6_GZIP_WRITES = gzip;
  }
});

test("errata 001 start is the committed close or the next 00:00Z, with no backfill", () => {
  expect(CLASS_A_PAPER_START_MS).toBe(Date.parse("2026-10-26T00:00:00.000Z"));
  expect(classAStartMs(Date.parse("2026-10-24T14:53:00.000Z"))).toBe(CLASS_A_PAPER_START_MS);
  expect(classAStartMs(CLASS_A_PAPER_START_MS)).toBe(CLASS_A_PAPER_START_MS);
  expect(classAStartMs(CLASS_A_PAPER_START_MS + 1)).toBe(CLASS_A_PAPER_START_MS + 86_400_000);
  const opened = openClassABook(Date.parse("2026-10-24T14:53:00.000Z"));
  expect(opened.startMs).toBe(CLASS_A_PAPER_START_MS);
  expect(evaluateSignal(opened, signal())).toBeNull();
  const days = daysOf();
  const at = signalCloseMs(days[days.length - 1]!.date);
  expect(at % 86_400_000).toBe(0);
  expect(evaluateSignal(emptyClassABook(at), signal({ days }))?.fill).toBe("fill");
  expect(evaluateSignal(emptyClassABook(at + 1), signal({ days }))).toBeNull();
});

test("errata 001 spread days, volume ties, concentration, and fill rate", () => {
  const twenty = Array.from({ length: 20 }, () => 10);
  const nineteen = Array.from({ length: 19 }, () => 10);
  expect(evaluateSignal(book(), signal({ spreadSamples: twenty }))?.skipReason).not.toBe("skip_spread");
  const short = evaluateSignal(book(), signal({ spreadSamples: nineteen }));
  expect(short?.skipReason).toBe("skip_spread");
  expect(short?.check).toBe("spread-days");
  expect(short?.measured).toBe(19);
  expect(short?.threshold).toBe(20);
  const holes = [...nineteen, ...Array.from({ length: 11 }, () => null)];
  expect(evaluateSignal(book(), signal({ spreadSamples: holes }))?.measured).toBe(19);

  const rich = trade("SOL-USD", { days: daysOf(80_000) });
  const thin = trade("ETH-USD", { days: daysOf(50_000) });
  expect(orderClassASignals([thin, rich]).map((row) => row.pair)).toEqual(["SOL-USD", "ETH-USD"]);
  const ada = trade("ADA-USD", { days: daysOf(80_000) });
  const eth = trade("ETH-USD", { days: daysOf(80_000) });
  expect(orderClassASignals([eth, ada]).map((row) => row.pair)).toEqual(["ADA-USD", "ETH-USD"]);
  const capped = book();
  evaluateSignal(capped, trade("BTC-USD"));
  evaluateSignal(capped, trade("DOGE-USD"));
  const raced = evaluateSignals(capped, [thin, rich]);
  expect(raced.find((row) => row?.pair === "SOL-USD")?.fill).toBe("fill");
  expect(raced.find((row) => row?.pair === "ETH-USD")?.skipReason).toBe("skip_cap");
  const tied = book();
  evaluateSignal(tied, trade("BTC-USD"));
  evaluateSignal(tied, trade("DOGE-USD"));
  const az = evaluateSignals(tied, [eth, ada]);
  expect(az.find((row) => row?.pair === "ADA-USD")?.fill).toBe("fill");
  expect(az.find((row) => row?.pair === "ETH-USD")?.skipReason).toBe("skip_cap");

  const row = (pair: string, grossUsd: number, grossBps: number): ClassAScored => ({
    pair,
    grossUsd,
    netUsd: grossUsd,
    grossBps,
    netBps: grossBps,
    netR: grossUsd / 20,
    regime: "CHOP",
  });
  const two = [row("AAA-USD", 10, 400), row("BBB-USD", 10, 400)];
  expect(concentrationOf(two).top3Share).toBe(1);
  expect(concentrationOf(two).top3Kill).toBe(true);
  const six = Array.from({ length: 6 }, (_, i) => row(`Q${i}-USD`, 10, 400));
  expect(concentrationOf(six).top3Share).toBeCloseTo(0.5, 8);
  expect(concentrationOf(six).top3Kill).toBe(false);
  expect(concentrationOf([row("AAA-USD", -5, 100), row("BBB-USD", 0, 100)]).top3Kill).toBe(false);

  const rate = book();
  evaluateSignal(rate, signal());
  const days = daysOf();
  const at = signalCloseMs(days[days.length - 1]!.date);
  evaluateSignal(rate, trade("ETH-USD", { days, prints: [{ tsMs: at + 4 * 60 * 60 * 1000, price: 1 }] }));
  evaluateSignal(rate, trade("ADA-USD", { days: daysOf(1_000) }));
  const view = scrubClassAPaper(rate);
  expect(view.fills).toBe(1);
  expect(view.fillRate).toBeCloseTo(0.5, 8);
  expect(view.perSignalRate).toBeCloseTo(1 / 3, 8);
});

test("errata 001 promotion uses Holm and buy-and-hold, and the exclusion preflight is static", () => {
  const row = (pair: string, grossUsd: number, grossBps: number): ClassAScored => ({
    pair,
    grossUsd,
    netUsd: grossUsd,
    grossBps,
    netBps: grossBps,
    netR: grossUsd / 20,
    regime: "CHOP",
  });
  const strong = Array.from({ length: 30 }, (_, i) => row(`N${i}-USD`, 10, 400));
  const passed = promotionOf(strong, { bhReturn: 0.04, deployedFraction: [2] });
  expect(passed.status).toBe("pass");
  expect(passed.tP).toBe(0);
  expect(passed.holmP).toBe(0);
  expect(passed.bootstrapP).toBe(0);
  expect(passed.bookReturn).toBeCloseTo(0.05, 8);
  expect(passed.beatsBh).toBe(true);
  expect(passed.exposureAdjustedReturn).toBeLessThan(0.04);
  expect(promotionOf(strong, { bhReturn: 0.05 }).status).toBe("blocked");
  expect(promotionOf(strong).status).toBe("unresolved");
  expect(promotionOf(strong, { bhReturn: 0.05 }).bhReturn).toBe(0.05);
  const flatHold = promotionOf(strong, {
    bhDays: [
      { members: ["SOL-USD"], close: { "SOL-USD": 10 } },
      { members: ["SOL-USD"], close: { "SOL-USD": 10 } },
    ],
  });
  expect(flatHold.bhReturn).toBeCloseTo(0, 8);
  expect(flatHold.status).toBe("pass");
  const borderline = [
    ...Array.from({ length: 20 }, (_, i) => row(`L${i}-USD`, 1, 250)),
    ...Array.from({ length: 10 }, (_, i) => row(`H${i}-USD`, 1, 481)),
  ];
  const alone = promotionOf(borderline, { bhReturn: -1 });
  const family = promotionOf(borderline, { bhReturn: -1, family: [{ id: "B", p: 0.9 }] });
  expect(alone.holmP).toBeLessThan(0.05);
  expect(alone.status).toBe("pass");
  expect(family.holmP).toBeGreaterThanOrEqual(0.05);
  expect(family.status).toBe("blocked");
  expect(family.bootstrapP).not.toBeNull();
  const level = Array.from({ length: 30 }, (_, i) => row(`E${i}-USD`, 1, 290));
  expect(promotionOf(level, { bhReturn: -1 }).status).toBe("blocked");
  expect(promotionOf(level, { bhReturn: -1 }).tP).toBe(1);

  expect(exclusionPreflight().ok).toBe(true);
  expect(exclusionPreflight([]).reason).toBe("empty");
  expect(exclusionPreflight([
    { productId: "SOL-USD", rule: "fiat-or-fx", source: "x" },
    { productId: "SOL-USD", rule: "fiat-or-fx", source: "y" },
  ]).reason).toBe("duplicate");
  expect(exclusionPreflight([{ productId: "sol-usd", rule: "fiat-or-fx", source: "x" }]).reason).toBe("shape");
  expect(exclusionPreflight([{ productId: "BTC-EUR", rule: "fiat-or-fx", source: "x" }]).reason).toBe("shape");
  expect(exclusionPreflight([{ productId: "BTC-USD", rule: "nope" as "fiat-or-fx", source: "x" }]).reason).toBe("rule");
  const blocked = emptyClassABook(START);
  blocked.exclusionOk = false;
  expect(evaluateSignal(blocked, signal())).toBeNull();
  const shown = scrubClassAPaper({
    status: "running",
    promotion: "pass",
    holmP: 0.01,
    bootstrapP: 0.2,
    bookReturn: 0.1,
    bhReturn: 0.04,
    beatsBh: true,
    exposureAdjustedReturn: 0.2,
    perSignalRate: 0.5,
    note: "user:PASSWORD@x.upstash.io",
  });
  expect(shown.promotion).toBe("pass");
  expect(shown.holmP).toBe(0.01);
  expect(shown.bootstrapP).toBe(0.2);
  expect(shown.beatsBh).toBe(true);
  expect(JSON.stringify(shown).includes("PASSWORD")).toBe(false);
});

test("errata 001 live X1 class A is tagged and still class A", () => {
  const ts = Date.parse("2026-10-15T01:00:00.000Z");
  const entry = {
    kind: "x1" as const,
    classId: "A" as const,
    productId: "ETH-USD",
    tsMs: ts,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: ts,
    sendTsMs: ts,
    decisionMid: 100,
  };
  const live = freshBook({ members: ["ETH-USD"], liveQuotes: true });
  applyForward(live, { ...entry, id: "live-a", aConfig: live.aPick?.config });
  const tagged = live.positions.find((row) => row.id === "live-a");
  expect(tagged?.scoreClass).toBe("A_x1_unscored");
  expect(tagged?.classId).toBe("A");
  const quiet = freshBook({ members: ["ETH-USD"] });
  applyForward(quiet, { ...entry, id: "quiet-a", aConfig: quiet.aPick?.config });
  expect(quiet.positions.find((row) => row.id === "quiet-a")?.scoreClass).toBeUndefined();
  const other = freshBook({ members: ["ETH-USD"], liveQuotes: true });
  applyForward(other, { ...entry, id: "live-c", classId: "C" });
  expect(other.positions.find((row) => row.id === "live-c")?.classId).toBe("C");
  expect(other.positions.find((row) => row.id === "live-c")?.scoreClass).toBeUndefined();
});
