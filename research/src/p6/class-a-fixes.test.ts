import { expect, test } from "bun:test";
import { addDays } from "../p5/stats";
import { captureHot, loadSplit, persistSplit } from "./hot-store";
import { installPaperState, startPaperHost } from "./paper-host";
import { decodeLease, HOT_KEY, LEASE_KEY, memoryKv, tryAcquire } from "./relay";
import { hostHolder } from "./vercel-live";
import { classABuyHoldFromJson } from "./class-a-bh";
import {
  CLASS_A_BOOTSTRAP_REPS,
  CLASS_A_BOOTSTRAP_SEED,
  CLASS_A_HOLM_FAMILY,
  CLASS_A_KILL_USD,
  CLASS_A_LOOKBACK,
  CLASS_A_MAX_OPEN_RISK_USD,
  CLASS_A_PAPER_START_MS,
  classABuyHoldSeries,
  emptyClassABook,
  ensureClassAPaper,
  evaluateSignal,
  onIntrabar,
  promotionOf,
  restoreClassABook,
  signalCloseMs,
  type ClassADay,
  type ClassAScored,
  type ClassASignal,
} from "./class-a-paper";

const START = Date.parse("2024-01-01T00:00:00.000Z");

function daysOf(baseVolume = 100_000, last = 100.05): ClassADay[] {
  const n = 70;
  return Array.from({ length: n }, (_, i) => {
    const close = i === n - 1 ? last : 100;
    return { date: addDays("2024-01-01", i), high: close + 0.05, low: close - 0.05, close, baseVolume };
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
    btcClose: 110,
    btcEma50: 90,
    btcDailyMove: 0,
    btcSma200: 100,
    btcSma50: 90,
    btcSma50TenAgo: 80,
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

function family() {
  return CLASS_A_HOLM_FAMILY.map((id) => ({ id, p: id === "A" ? 1 : 0.9 }));
}

function row(pair: string, grossUsd: number, grossBps: number): ClassAScored {
  return { pair, grossUsd, netUsd: grossUsd, grossBps, netBps: grossBps, netR: grossUsd / 20, regime: "CHOP" };
}

test("errata 002 bootstrap constants stay fixed", () => {
  expect(CLASS_A_BOOTSTRAP_SEED).toBe(20261011);
  expect(CLASS_A_BOOTSTRAP_REPS).toBe(10_000);
  expect(CLASS_A_LOOKBACK).toBe(55);
  expect(CLASS_A_KILL_USD).toBe(-400);
  expect(CLASS_A_HOLM_FAMILY).toHaveLength(8);
});

test("buy-and-hold matches the Quant fixture to 1e-12", () => {
  const n = 125;
  const closes = {
    AAA: [...Array(101).fill(100), 110, 121, 121, ...Array(n - 104).fill(133.1)],
    BBB: [...Array(101).fill(50), 40, 40, ...Array(n - 103).fill(80)],
    STB: Array(n).fill(1),
  };
  const vols = {
    AAA: Array(n).fill(100_000),
    BBB: [...Array(86).fill(200_000), ...Array(n - 86).fill(1_000)],
    STB: Array(n).fill(10_000_000),
  };
  const series = classABuyHoldSeries({
    t0: 100,
    t1: 104,
    excluded: ["STB"],
    candles: (["AAA", "BBB", "STB"] as const).map((pair) => ({ pair, listedIndex: 0, closes: closes[pair], volumes: vols[pair] })),
  });
  const expectAt = (t: number, V: number, members: string[]) => {
    const point = series.find((item) => item.t === t);
    expect(point).toBeDefined();
    expect(Math.abs(point!.V - V)).toBeLessThan(1e-12);
    expect(point!.members).toEqual(members);
  };
  expectAt(100, 1, ["AAA", "BBB"]);
  expectAt(101, 0.95, ["AAA", "BBB"]);
  expectAt(102, 1.005, ["AAA"]);
  expectAt(103, 1.005, ["AAA"]);
  expectAt(104, 1.1055, ["AAA"]);
  const json = classABuyHoldFromJson({
    t0: 100,
    t1: 102,
    excluded: ["STB"],
    candles: (["AAA", "BBB", "STB"] as const).map((pair) => ({ pair, listedIndex: 0, closes: closes[pair], volumes: vols[pair] })),
  });
  expect(json.map((item) => item.t)).toEqual([100, 101, 102]);
  expect(Math.abs(json[2]!.V - 1.005)).toBeLessThan(1e-12);
});

test("a carried close is a flat day and a zero close drops membership", () => {
  const n = 125;
  const aaa = Array(n).fill(100);
  aaa[101] = null;
  const series = classABuyHoldSeries({
    t0: 100,
    t1: 102,
    excluded: [],
    candles: [{ pair: "AAA", listedIndex: 0, closes: aaa, volumes: Array(n).fill(100_000) }],
  });
  expect(Math.abs(series[1]!.V - 1)).toBeLessThan(1e-12);
  expect(series[1]!.members).toEqual(["AAA"]);
});

test("a print at the window open fills and one tick before does not", () => {
  const days = daysOf();
  const close = days[days.length - 1]!.close;
  const at = signalCloseMs(days[days.length - 1]!.date);
  const price = close - 0.01;
  expect(evaluateSignal(emptyClassABook(START), signal({ days, prints: [{ tsMs: at, price }] }))?.fill).toBe("fill");
  expect(evaluateSignal(emptyClassABook(START), signal({ days, prints: [{ tsMs: at - 1, price }] }))?.skipReason).toBe("skip_nofill");
  expect(evaluateSignal(emptyClassABook(START), signal({ days, prints: [{ tsMs: at + 4 * 60 * 60 * 1000, price }] }))?.skipReason).toBe("skip_nofill");
  expect(evaluateSignal(emptyClassABook(START), signal({ days, prints: [{ tsMs: at + 4 * 60 * 60 * 1000 - 1, price }] }))?.fill).toBe("fill");
});

test("lookback 55 does not fire when only the 55th prior close is above", () => {
  const n = 70;
  const days = Array.from({ length: n }, (_, i) => {
    let close = 100;
    if (i < 14) close = 80 + i;
    if (i === n - 1 - 55) close = 200;
    if (i === n - 1) close = 150;
    return { date: addDays("2024-01-01", i), high: close + 1, low: close - 1, close, baseVolume: 100_000 };
  });
  expect(evaluateSignal(emptyClassABook(START), signal({ days }))).toBeNull();
});

test("open risk of exactly $60 is taken and one cent over is skip_cap", () => {
  const probe = emptyClassABook(START);
  evaluateSignal(probe, signal());
  const sim = probe.open[0]!;
  const newRisk = sim.notionalUsd * ((sim.entry - sim.initialStop) / sim.entry);
  expect(newRisk).toBeLessThan(CLASS_A_MAX_OPEN_RISK_USD);
  const plant = (risk: number) => {
    const paper = emptyClassABook(START);
    const entry = 100;
    const fraction = risk / 100;
    paper.open.push({
      rowId: "planted",
      pair: "ETH-USD",
      scored: true,
      entry,
      entryMs: START,
      entryDate: "2024-03-11",
      stop: entry * (1 - fraction),
      initialStop: entry * (1 - fraction),
      notionalUsd: 100,
      units: 1,
      feeEntryBps: 50,
      sBps: 5,
      highestClose: 100,
      priorCloses: [],
      pending: null,
    });
    return evaluateSignal(paper, signal());
  };
  expect(plant(CLASS_A_MAX_OPEN_RISK_USD - newRisk)?.fill).toBe("fill");
  expect(plant(CLASS_A_MAX_OPEN_RISK_USD - newRisk + 0.01)?.skipReason).toBe("skip_cap");
});

test("a missing depth cost is skip_depth", () => {
  expect(evaluateSignal(emptyClassABook(START), signal({ depthCostBps: null }))?.skipReason).toBe("skip_depth");
  expect(evaluateSignal(emptyClassABook(START), signal({ depthCostBps: 15 }))?.skipReason).not.toBe("skip_depth");
});

test("a live-check skip closes its counterfactual", () => {
  const days = daysOf();
  const at = signalCloseMs(days[days.length - 1]!.date);
  const paper = emptyClassABook(START);
  const row = evaluateSignal(paper, signal({ days, spreadBps: 50 }));
  expect(row?.skipReason).toBe("skip_spread");
  expect(row?.counterfactual?.status).toBe("open");
  expect(row?.feesUsd).toBeNull();
  onIntrabar(paper, { pair: "SOL-USD", tsMs: at + 2 * 3_600_000, open: 100, low: 50, hourAtr: 0.2 });
  expect(row?.counterfactual?.status).toBe("closed");
});

test("fees are the maker entry until the exit, then both legs", () => {
  const paper = emptyClassABook(START);
  const row = evaluateSignal(paper, signal());
  expect(row?.fill).toBe("fill");
  expect(row?.feesUsd).toBeCloseTo((2_000 * 50) / 10_000, 8);
  const sim = paper.open[0]!;
  onIntrabar(paper, { pair: "SOL-USD", tsMs: sim.entryMs + 1_000, open: sim.stop, low: sim.stop - 1, hourAtr: 0.2 });
  expect(row?.gap).toBe(true);
  expect(row?.exitPrice).toBe(sim.stop);
  const exitFee = (sim.units * sim.stop * (90 + sim.sBps)) / 10_000;
  expect(row?.feesUsd).toBeCloseTo((2_000 * 50) / 10_000 + exitFee, 8);
  const touch = emptyClassABook(START);
  evaluateSignal(touch, signal());
  const openSim = touch.open[0]!;
  onIntrabar(touch, { pair: "SOL-USD", tsMs: openSim.entryMs + 1_000, open: openSim.stop + 0.2, low: openSim.stop - 0.01, hourAtr: 1 });
  expect(touch.rows.find((item) => item.fill === "fill")?.gap).toBeUndefined();
});

test("cumulative net of exactly -$400 kills and -$399.99 does not", () => {
  const sample = emptyClassABook(START);
  evaluateSignal(sample, signal());
  const sim = sample.open[0]!;
  onIntrabar(sample, { pair: "SOL-USD", tsMs: sim.entryMs + 1_000, open: 70, low: 70, hourAtr: 0.2 });
  const net = sample.scored[0]!.netUsd;
  const again = emptyClassABook(START);
  evaluateSignal(again, signal());
  const open = again.open[0]!;
  again.cumNetUsd = -400 - net;
  onIntrabar(again, { pair: "SOL-USD", tsMs: open.entryMs + 1_000, open: 70, low: 70, hourAtr: 0.2 });
  expect(again.cumNetUsd).toBe(-400);
  expect(again.killed).toBe(true);
  const shy = emptyClassABook(START);
  evaluateSignal(shy, signal());
  const shySim = shy.open[0]!;
  shy.cumNetUsd = -399.99 - net;
  onIntrabar(shy, { pair: "SOL-USD", tsMs: shySim.entryMs + 1_000, open: 70, low: 70, hourAtr: 0.2 });
  expect(shy.cumNetUsd).toBeGreaterThan(CLASS_A_KILL_USD);
  expect(shy.killed).toBe(false);
});

test("one pair blocks promotion when the other gates pass", () => {
  const same = Array.from({ length: 30 }, () => row("SOL-USD", 10, 400));
  expect(promotionOf(same, { bhReturn: 0, family: family() }).status).toBe("blocked");
});

test("an out-of-order signal and a duplicate are flagged and not applied", () => {
  const paper = emptyClassABook(START);
  const days = daysOf();
  expect(evaluateSignal(paper, signal({ days }))?.fill).toBe("fill");
  const earlier = days.slice(0, -1);
  earlier[earlier.length - 1] = { ...earlier[earlier.length - 1]!, close: 150, high: 151, low: 149 };
  const flagged = evaluateSignal(paper, signal({ days: earlier, index: earlier.length - 1, pair: "ETH-USD" }));
  expect(flagged?.signalOrder).toBe("out-of-order");
  expect(paper.open).toHaveLength(1);
  const again = evaluateSignal(paper, signal({ days }));
  expect(again?.signalOrder).toBe("duplicate");
  expect(paper.open).toHaveLength(1);
  const restored = restoreClassABook({ ...paper, lastSignalMs: paper.lastSignalMs });
  expect(restored?.lastSignalMs).toBe(paper.lastSignalMs);
  const legacy = restoreClassABook({ ...paper, lastSignalMs: undefined });
  expect(legacy?.lastSignalMs).toBeNull();
});

test("a failed preflight does not start and a stored false exclusion stays false", () => {
  const blocked = emptyClassABook(START, { ok: false, reason: "duplicate" });
  expect(blocked.startMs).toBeNull();
  expect(blocked.exclusionOk).toBe(false);
  const restored = restoreClassABook({ ...emptyClassABook(START), exclusionOk: false });
  expect(restored?.exclusionOk).toBe(false);
  const old = restoreClassABook({ ...emptyClassABook(START), exclusionOk: undefined });
  expect(old?.exclusionOk).toBe(true);
});

test("a warm restart keeps an existing book with gzip off and on", async () => {
  const gzip = process.env.P6_GZIP_WRITES;
  try {
    for (const flag of ["0", "1"] as const) {
      process.env.P6_GZIP_WRITES = flag;
      const host = startPaperHost(["BTC-USD"], {});
      host.clock = () => CLASS_A_PAPER_START_MS;
      const kv = memoryKv(() => CLASS_A_PAPER_START_MS);
      await hostHolder(host, kv).warm();
      expect(host.classAPaper?.startMs).toBe(CLASS_A_PAPER_START_MS);
      const paper = emptyClassABook(START);
      evaluateSignal(paper, signal());
      host.classAPaper = paper;
      expect(await tryAcquire(kv, `fixes-${flag}`, CLASS_A_PAPER_START_MS + 86_400_000, CLASS_A_PAPER_START_MS)).toBe(true);
      host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
      await persistSplit(kv, host);
      const loaded = startPaperHost(["BTC-USD"], {});
      loaded.clock = () => CLASS_A_PAPER_START_MS;
      await hostHolder(loaded, kv).warm();
      expect(loaded.classAPaper?.rows.some((row) => row.fill === "fill")).toBe(true);
      expect(loaded.classAPaper?.open).toHaveLength(1);
      await hostHolder(loaded, kv).reload();
      expect(loaded.classAPaper?.open).toHaveLength(1);
      const bare = startPaperHost(["BTC-USD"], {});
      expect("classAPaper" in captureHot(bare)).toBe(false);
    }
  } finally {
    if (gzip === undefined) delete process.env.P6_GZIP_WRITES;
    else process.env.P6_GZIP_WRITES = gzip;
  }
});

test("install of a saved book is not replaced when ensure runs", () => {
  const host = startPaperHost(["BTC-USD"], {});
  const paper = emptyClassABook(START);
  evaluateSignal(paper, signal());
  installPaperState(host, { classAPaper: paper } as never);
  ensureClassAPaper(host);
  expect(host.classAPaper?.open).toHaveLength(1);
});
