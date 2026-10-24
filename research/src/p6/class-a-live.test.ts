import { expect, test } from "bun:test";
import { CLASS_A_PAPER_START_MS, emptyClassABook, type ClassABook } from "./class-a-paper";
import { classAMinOrderBase, classAMinSizeOf, stepClassAFromHost, type ClassALiveHost } from "./class-a-live";
import { captureHot, loadSplit, persistSplit } from "./hot-store";
import { acceptRestBar, startPaperHost } from "./paper-host";
import { decodeLease, LEASE_KEY, memoryKv, tryAcquire } from "./relay";
import { hostHolder } from "./vercel-live";

const DAY_MS = 86_400_000;

function liveHost(book: ClassABook, over: Partial<ClassALiveHost> = {}): ClassALiveHost {
  return {
    classAPaper: book,
    clock: () => CLASS_A_PAPER_START_MS,
    dailyBars: new Map(),
    hourWarm: new Map(),
    ticks: new Map([["SOL-USD", 0.01]]),
    trades: [],
    books: new Map(),
    book: { quotes: {} },
    ...over,
  };
}

function dayBar(date: string, close: number) {
  return { ts: Date.parse(`${date}T00:00:00.000Z`) / 1000, open: close, high: close + 0.05, low: close - 0.05, close, volume: 100_000 };
}

const DAY = 86_400;

test("the production bar path records the signal at the start and keeps it across a reload", async () => {
  const gzip = process.env.P6_GZIP_WRITES;
  try {
    for (const flag of ["0", "1"] as const) {
      process.env.P6_GZIP_WRITES = flag;
      const kv = memoryKv(() => CLASS_A_PAPER_START_MS);
      const host = startPaperHost(["SOL-USD", "BTC-USD"], {});
      host.clock = () => CLASS_A_PAPER_START_MS;
      await hostHolder(host, kv).warm();
      expect(host.classAPaper?.startMs).toBe(CLASS_A_PAPER_START_MS);
      const signalDay = Date.parse("2026-10-25T00:00:00.000Z");
      const first = signalDay - 110 * DAY * 1000;
      for (let i = 0; i <= 110; i += 1) {
        const openMs = first + i * DAY * 1000;
        const openSec = openMs / 1000;
        const close = i === 110 ? 100.05 : 100;
        host.clock = () => openMs + 15 * 60 * 1000;
        expect(acceptRestBar(host, { productId: "SOL-USD", startSec: openSec, open: close, high: close + 0.05, low: close - 0.05, close, volume: 0 })).toBe("accepted");
        host.clock = () => openMs + DAY * 1000;
        expect(acceptRestBar(host, { productId: "SOL-USD", startSec: openSec + DAY - 900, open: close, high: close + 0.05, low: close - 0.05, close, volume: 100_000 })).toBe("accepted");
      }
      const prior = Date.parse("2026-10-25T00:00:00.000Z");
      expect(host.classAPaper?.rows.some((row) => row.signalMs === prior)).toBe(false);
      const row = host.classAPaper?.rows.find((item) => item.signalMs === CLASS_A_PAPER_START_MS);
      expect(row?.pair).toBe("SOL-USD");
      expect(row?.skipReason).toBe("skip_btcveto");
      expect(await tryAcquire(kv, `live-${flag}`, CLASS_A_PAPER_START_MS + DAY * 1000, CLASS_A_PAPER_START_MS)).toBe(true);
      host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
      host.clock = () => CLASS_A_PAPER_START_MS;
      await persistSplit(kv, host);
      const loaded = startPaperHost(["SOL-USD", "BTC-USD"], {});
      loaded.clock = () => CLASS_A_PAPER_START_MS;
      await hostHolder(loaded, kv).warm();
      expect(loaded.classAPaper?.rows.some((item) => item.signalMs === CLASS_A_PAPER_START_MS)).toBe(true);
      const again = startPaperHost(["SOL-USD", "BTC-USD"], {});
      again.clock = () => CLASS_A_PAPER_START_MS;
      const body = await loadSplit(kv, again);
      expect(body?.classAPaper?.rows.some((item) => item.signalMs === CLASS_A_PAPER_START_MS)).toBe(true);
      expect("classAPaper" in captureHot(startPaperHost(["SOL-USD"], {}))).toBe(false);
    }
  } finally {
    if (gzip === undefined) delete process.env.P6_GZIP_WRITES;
    else process.env.P6_GZIP_WRITES = gzip;
  }
});

test("the production bar path keeps a pending maker order across a reload, fills on a print, and records nofill only after four hours", async () => {
  const gzip = process.env.P6_GZIP_WRITES;
  try {
    for (const flag of ["0", "1"] as const) {
      process.env.P6_GZIP_WRITES = flag;
      const kv = memoryKv(() => CLASS_A_PAPER_START_MS);
      const host = startPaperHost(["SOL-USD", "BTC-USD"], {});
      host.clock = () => CLASS_A_PAPER_START_MS;
      await hostHolder(host, kv).warm();
      host.classAPaper!.spreadLog = { "SOL-USD": Array.from({ length: 25 }, () => 2) };
      const signalDay = Date.parse("2026-10-25T00:00:00.000Z");
      const first = signalDay - 110 * DAY * 1000;
      for (let i = 0; i <= 110; i += 1) {
        const openMs = first + i * DAY * 1000;
        const openSec = openMs / 1000;
        const sol = i === 110 ? 100.05 : 100;
        const btc = 100 * (1 + 0.002 * i);
        const closeOf = (productId: string, close: number) => {
          host.clock = () => openMs + DAY * 1000;
          expect(acceptRestBar(host, { productId, startSec: openSec + DAY - 900, open: close, high: close + 0.05, low: close - 0.05, close, volume: 100_000 })).toBe("accepted");
        };
        closeOf("BTC-USD", btc);
        if (i === 110) {
          host.books.set("SOL-USD", { bids: new Map([["100.04", 1_000_000]]), asks: new Map([["100.06", 1_000_000]]) });
          host.l2Ts.set("SOL-USD", CLASS_A_PAPER_START_MS - 100);
        }
        closeOf("SOL-USD", sol);
      }
      const placed = host.classAPaper?.rows.find((item) => item.pair === "SOL-USD" && item.signalMs === CLASS_A_PAPER_START_MS);
      expect(placed?.fill).toBe("pending");
      expect(placed?.skipReason).toBeNull();
      expect(host.classAPaper?.resting).toHaveLength(1);
      host.clock = () => CLASS_A_PAPER_START_MS + 900_000;
      expect(acceptRestBar(host, {
        productId: "SOL-USD",
        startSec: CLASS_A_PAPER_START_MS / 1000,
        open: 100.05,
        high: 100.06,
        low: 100.05,
        close: 100.05,
        volume: 1,
      })).toBe("accepted");
      expect(placed?.fill).toBe("pending");
      expect(await tryAcquire(kv, `maker-${flag}`, CLASS_A_PAPER_START_MS + DAY * 1000, CLASS_A_PAPER_START_MS)).toBe(true);
      host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
      host.clock = () => CLASS_A_PAPER_START_MS + 900_000;
      await persistSplit(kv, host);
      const loaded = startPaperHost(["SOL-USD", "BTC-USD"], {});
      loaded.clock = () => CLASS_A_PAPER_START_MS + 900_000;
      await hostHolder(loaded, kv).warm();
      const rested = loaded.classAPaper?.rows.find((item) => item.pair === "SOL-USD" && item.signalMs === CLASS_A_PAPER_START_MS);
      expect(rested?.fill).toBe("pending");
      expect(loaded.classAPaper?.resting).toHaveLength(1);
      if (flag === "0") {
        loaded.trades.push({ productId: "SOL-USD", tsSec: CLASS_A_PAPER_START_MS / 1000 + 600, price: 100, size: 1 });
        loaded.clock = () => CLASS_A_PAPER_START_MS + 1_800_000;
        expect(acceptRestBar(loaded, {
          productId: "SOL-USD",
          startSec: CLASS_A_PAPER_START_MS / 1000 + 900,
          open: 100.05,
          high: 100.06,
          low: 100.05,
          close: 100.05,
          volume: 1,
        })).toBe("accepted");
        expect(rested?.fill).toBe("fill");
        expect(rested?.skipReason).toBeNull();
        expect(loaded.classAPaper?.open).toHaveLength(1);
        expect(loaded.classAPaper?.open[0]?.entry).toBe(100.05);
        expect(loaded.classAPaper?.open[0]?.feeEntryBps).toBe(35);
      } else {
        loaded.clock = () => CLASS_A_PAPER_START_MS + 4 * 60 * 60 * 1000;
        expect(acceptRestBar(loaded, {
          productId: "SOL-USD",
          startSec: CLASS_A_PAPER_START_MS / 1000 + 4 * 60 * 60 - 900,
          open: 100.05,
          high: 100.06,
          low: 100.05,
          close: 100.05,
          volume: 1,
        })).toBe("accepted");
        expect(rested?.fill).toBe("nofill");
        expect(rested?.skipReason).toBe("skip_nofill");
        expect(loaded.classAPaper?.open).toHaveLength(0);
        expect(loaded.classAPaper?.resting).toHaveLength(0);
      }
    }
  } finally {
    if (gzip === undefined) delete process.env.P6_GZIP_WRITES;
    else process.env.P6_GZIP_WRITES = gzip;
  }
});

test("a day close before the book start does not log a spread or a row", () => {
  const paper = emptyClassABook(CLASS_A_PAPER_START_MS);
  const openSec = Date.parse("2026-10-24T00:00:00.000Z") / 1000;
  const host = liveHost(paper, {
    dailyBars: new Map([["SOL-USD", [dayBar("2026-10-24", 100)]]]),
    book: { quotes: { "SOL-USD": { bid: 100, ask: 100.02, tsMs: CLASS_A_PAPER_START_MS } } },
  });
  stepClassAFromHost(host, { productId: "SOL-USD", startSec: openSec + 86_400 - 900, open: 100, high: 100.05, low: 99.95, close: 100 });
  expect(paper.rows).toHaveLength(0);
  expect(paper.spreadLog?.["SOL-USD"]).toBeUndefined();
});

test("a day close with a quote appends that spread on a fresh book", () => {
  const paper = emptyClassABook(CLASS_A_PAPER_START_MS);
  const openSec = Date.parse("2026-10-25T00:00:00.000Z") / 1000;
  const host = liveHost(paper, {
    dailyBars: new Map([["SOL-USD", [dayBar("2026-10-25", 100)]]]),
    book: { quotes: { "SOL-USD": { bid: 100, ask: 100.02, tsMs: CLASS_A_PAPER_START_MS } } },
    listingFirstMs: { "SOL-USD": Date.parse("2024-01-01T00:00:00.000Z") },
  });
  stepClassAFromHost(host, { productId: "SOL-USD", startSec: openSec + 86_400 - 900, open: 100, high: 100.05, low: 99.95, close: 100 });
  expect(paper.spreadLog?.["SOL-USD"]).toHaveLength(1);
  expect(paper.spreadLog?.["SOL-USD"]?.[0]).toBeGreaterThan(0);
});

test("a young listing does not enter and an unknown listing is flagged", () => {
  const last = Date.parse("2026-10-25T00:00:00.000Z");
  const bars = Array.from({ length: 70 }, (_, index) => {
    const close = index === 69 ? 100.05 : 100;
    return dayBar(new Date(last - (69 - index) * DAY_MS).toISOString().slice(0, 10), close);
  });
  const bar = { productId: "SOL-USD", startSec: last / 1000 + 86_400 - 900, open: 100.05, high: 100.1, low: 100, close: 100.05 };
  const young = emptyClassABook(CLASS_A_PAPER_START_MS);
  stepClassAFromHost(liveHost(young, {
    dailyBars: new Map([["SOL-USD", bars]]),
    listingFirstMs: { "SOL-USD": CLASS_A_PAPER_START_MS - 10 * DAY_MS },
  }), bar);
  expect(young.rows).toHaveLength(0);
  expect(young.open).toHaveLength(0);
  const unknown = emptyClassABook(CLASS_A_PAPER_START_MS);
  stepClassAFromHost(liveHost(unknown, {
    dailyBars: new Map([["SOL-USD", bars]]),
    listingFirstMs: { "SOL-USD": null },
  }), bar);
  expect(unknown.open).toHaveLength(0);
  expect(unknown.rows.some((row) => row.listedDaysEstimated === true)).toBe(true);
});

test("a live bar stops an open position when the low trades through the stop", () => {
  const paper = emptyClassABook(CLASS_A_PAPER_START_MS);
  paper.open.push({
    rowId: "SOL-USD:1",
    pair: "SOL-USD",
    scored: true,
    entry: 100,
    entryMs: CLASS_A_PAPER_START_MS,
    entryDate: "2026-10-26",
    stop: 90,
    initialStop: 90,
    notionalUsd: 100,
    units: 1,
    feeEntryBps: 35,
    sBps: 5,
    highestClose: 100,
    priorCloses: [],
    pending: null,
  });
  stepClassAFromHost(liveHost(paper), {
    productId: "SOL-USD",
    startSec: CLASS_A_PAPER_START_MS / 1000 + 900,
    open: 95,
    high: 96,
    low: 80,
    close: 94,
  });
  expect(paper.open).toHaveLength(0);
  expect(paper.scored).toHaveLength(1);
});

test("the order minimum uses base_min_size, then base_increment, and an unknown pair is null", () => {
  expect(classAMinSizeOf({ base_min_size: "0.001", base_increment: "0.01" })).toBe(0.001);
  expect(classAMinSizeOf({ base_increment: "0.01" })).toBe(0.01);
  expect(classAMinSizeOf({ base_min_size: 0, base_increment: "0.0001" })).toBe(0.0001);
  expect(classAMinSizeOf({})).toBeNull();
  expect(classAMinOrderBase("NOT-A-REAL-PAIR")).toBeNull();
});
