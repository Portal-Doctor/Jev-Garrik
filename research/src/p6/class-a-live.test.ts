import { expect, test } from "bun:test";
import { CLASS_A_PAPER_START_MS, emptyClassABook, restoreClassABook, type ClassABook } from "./class-a-paper";
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
        const filled = loaded.classAPaper?.rows.find((item) => item.pair === "SOL-USD" && item.signalMs === CLASS_A_PAPER_START_MS);
        expect(filled?.fill).toBe("fill");
        expect(filled?.skipReason).toBeNull();
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
        const expired = loaded.classAPaper?.rows.find((item) => item.pair === "SOL-USD" && item.signalMs === CLASS_A_PAPER_START_MS);
        expect(expired?.fill).toBe("nofill");
        expect(expired?.skipReason).toBe("skip_nofill");
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

const SIGNAL_PAIRS = ["ADA-USD", "ETH-USD", "SOL-USD"] as const;
const DAY_CLOSE_SEC = CLASS_A_PAPER_START_MS / 1000 - 900;

function permutations(items: readonly string[]): string[][] {
  if (items.length <= 1) return [items.slice()];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]));
}

function signalCandles(lastClose: number, rising: boolean) {
  const last = Date.parse("2026-10-25T00:00:00.000Z");
  return Array.from({ length: 111 }, (_, index) => {
    const close = rising ? 100 * (1 + 0.002 * index) : index === 110 ? lastClose : 100;
    return { ts: (last - (110 - index) * DAY_MS) / 1000, open: close, high: close + 0.05, low: close - 0.05, close, volume: 100_000 };
  });
}

function dayCloseHost(): { host: ClassALiveHost; now: { ms: number } } {
  const paper = emptyClassABook(CLASS_A_PAPER_START_MS);
  paper.spreadLog = Object.fromEntries(SIGNAL_PAIRS.map((pair) => [pair, Array.from({ length: 25 }, () => 2)]));
  const now = { ms: CLASS_A_PAPER_START_MS };
  const quotes: ClassALiveHost["book"]["quotes"] = {};
  const books = new Map<string, { asks: Map<string, number> }>();
  const ticks = new Map<string, number>();
  for (const pair of SIGNAL_PAIRS) {
    quotes[pair] = { bid: 100.04, ask: 100.06, tsMs: now.ms };
    books.set(pair, { asks: new Map([["100.06", 1_000_000]]) });
    ticks.set(pair, 0.01);
  }
  const dailyBars = new Map<string, ReturnType<typeof signalCandles>>();
  for (const pair of SIGNAL_PAIRS) dailyBars.set(pair, signalCandles(100.05, false));
  dailyBars.set("BTC-USD", signalCandles(100, true));
  return {
    now,
    host: liveHost(paper, {
      clock: () => now.ms,
      dailyBars,
      ticks,
      books,
      book: { quotes },
      listingFirstMs: Object.fromEntries(SIGNAL_PAIRS.map((pair) => [pair, Date.parse("2024-01-01T00:00:00.000Z")])),
    }),
  };
}

function dayCloseBar(pair: string) {
  return { productId: pair, startSec: DAY_CLOSE_SEC, open: 100.05, high: 100.1, low: 100, close: 100.05 };
}

function askBooks(host: ClassALiveHost): Map<string, { asks: Map<string, number> }> {
  return host.books as Map<string, { asks: Map<string, number> }>;
}

function showBook(host: ClassALiveHost, pair: string, nowMs: number): void {
  askBooks(host).set(pair, { asks: new Map([["100.06", 1_000_000]]) });
  host.book.quotes[pair] = { bid: 100.04, ask: 100.06, tsMs: nowMs };
}

function hideBook(host: ClassALiveHost, pair: string): void {
  askBooks(host).set(pair, { asks: new Map() });
  const quote = host.book.quotes[pair];
  if (quote) quote.tsMs = 0;
}

function heldSnapshot(frozen: ReadonlyMap<string, string>, pair: string): string {
  const seen = frozen.get(pair);
  if (seen == null) throw new Error(`missing snapshot ${pair}`);
  return seen;
}

function signalSnapshot(book: ClassABook, pair: string): string {
  const row = book.rows.find((item) => item.pair === pair && item.signalMs === CLASS_A_PAPER_START_MS);
  const resting = (book.resting ?? []).filter((order) => order.pair === pair);
  return JSON.stringify({ row, resting });
}

test("a later day-close push cannot flip an earlier signal, in every order and after a restart", () => {
  const orders = permutations(SIGNAL_PAIRS);
  expect(orders).toHaveLength(6);
  for (const order of orders) {
    const { host, now } = dayCloseHost();
    const paper = host.classAPaper;
    if (!paper) throw new Error("book");
    const frozen = new Map<string, string>();
    for (const pair of order) {
      showBook(host, pair, now.ms);
      stepClassAFromHost(host, dayCloseBar(pair));
      const row = paper.rows.find((item) => item.pair === pair && item.signalMs === CLASS_A_PAPER_START_MS);
      expect(row?.fill).toBe("pending");
      expect(row?.skipReason).toBeNull();
      expect(paper.resting?.some((item) => item.rowId === row?.id)).toBe(true);
      expect(paper.spreadLog?.[pair]).toHaveLength(26);
      frozen.set(pair, signalSnapshot(paper, pair));
      for (const earlier of order) {
        if (!frozen.has(earlier)) continue;
        expect(signalSnapshot(paper, earlier)).toBe(heldSnapshot(frozen, earlier));
        expect(paper.spreadLog?.[earlier]).toHaveLength(26);
      }
      now.ms += 5_000;
      hideBook(host, pair);
    }
    stepClassAFromHost(host, dayCloseBar(order[order.length - 1]!));
    expect(paper.resting).toHaveLength(order.length);
    expect(paper.bucket?.decisions).toHaveLength(order.length);
    expect(paper.bucket?.image.rows.some((row) => row.signalMs === CLASS_A_PAPER_START_MS)).toBe(false);
    for (const pair of order) {
      expect(signalSnapshot(paper, pair)).toBe(heldSnapshot(frozen, pair));
      expect(paper.rows.find((row) => row.pair === pair)?.fill).toBe("pending");
    }

    const first = order[0]!;
    const mid = dayCloseHost();
    const midPaper = mid.host.classAPaper;
    if (!midPaper) throw new Error("book");
    showBook(mid.host, first, mid.now.ms);
    stepClassAFromHost(mid.host, dayCloseBar(first));
    const midFrozen = signalSnapshot(midPaper, first);
    expect(midPaper.rows.find((row) => row.pair === first)?.fill).toBe("pending");
    const restarted = restoreClassABook(JSON.parse(JSON.stringify(midPaper)));
    if (!restarted?.bucket) throw new Error("bucket missing after restart");
    const again = dayCloseHost();
    again.host.classAPaper = restarted;
    again.now.ms = mid.now.ms + 5_000;
    expect(again.host.classABucket).toBeUndefined();
    hideBook(again.host, first);
    for (const pair of order.slice(1)) {
      showBook(again.host, pair, again.now.ms);
      stepClassAFromHost(again.host, dayCloseBar(pair));
      expect(signalSnapshot(restarted, first)).toBe(midFrozen);
      expect(restarted.rows.find((row) => row.pair === first)?.fill).toBe("pending");
      expect(restarted.rows.find((row) => row.pair === first)?.skipReason).toBeNull();
      expect(restarted.resting?.some((orderRow) => orderRow.pair === first)).toBe(true);
      again.now.ms += 5_000;
      hideBook(again.host, pair);
    }
  }
});

test("SOL stays pending when a later ETH push in the same bucket sees a stale SOL book", async () => {
  const gzip = process.env.P6_GZIP_WRITES;
  try {
    for (const flag of [undefined, "1"] as const) {
      if (flag === undefined) delete process.env.P6_GZIP_WRITES;
      else process.env.P6_GZIP_WRITES = flag;
      for (const order of [["SOL-USD", "ETH-USD"], ["ETH-USD", "SOL-USD"]] as const) {
        const { host, now } = dayCloseHost();
        const paper = host.classAPaper;
        if (!paper) throw new Error("book");
        showBook(host, order[0]!, now.ms);
        stepClassAFromHost(host, dayCloseBar(order[0]!));
        const placed = paper.rows.find((row) => row.pair === order[0]!);
        expect(placed?.fill).toBe("pending");
        expect(placed?.skipReason).toBeNull();
        expect(paper.resting?.some((orderRow) => orderRow.rowId === placed?.id)).toBe(true);
        const before = signalSnapshot(paper, order[0]!);
        now.ms += 5_000;
        hideBook(host, order[0]!);
        showBook(host, order[1]!, now.ms);
        stepClassAFromHost(host, dayCloseBar(order[1]!));
        expect(signalSnapshot(paper, order[0]!)).toBe(before);
        const sol = paper.rows.find((row) => row.pair === "SOL-USD" && row.signalMs === CLASS_A_PAPER_START_MS);
        expect(sol?.fill).toBe("pending");
        expect(sol?.skipReason).toBeNull();
        expect(paper.resting?.some((orderRow) => orderRow.rowId === sol?.id)).toBe(true);
        expect(paper.rows.filter((row) => row.skipReason === "skip_depth")).toHaveLength(0);
      }

      const { host, now } = dayCloseHost();
      const paper = host.classAPaper;
      if (!paper) throw new Error("book");
      showBook(host, "SOL-USD", now.ms);
      stepClassAFromHost(host, dayCloseBar("SOL-USD"));
      expect(paper.rows.find((row) => row.pair === "SOL-USD")?.fill).toBe("pending");
      const kv = memoryKv(() => now.ms);
      const saved = startPaperHost(["SOL-USD", "ETH-USD", "BTC-USD"], {});
      saved.clock = () => now.ms;
      await hostHolder(saved, kv).warm();
      saved.classAPaper = paper;
      saved.dailyBars = host.dailyBars as typeof saved.dailyBars;
      saved.books = new Map([...host.books].map(([id, book]) => [id, { bids: new Map<string, number>(), asks: new Map(book.asks) }]));
      saved.ticks = new Map(host.ticks);
      saved.book.quotes = {};
      for (const [id, quote] of Object.entries(host.book.quotes)) if (quote) saved.book.quotes[id] = { bid: quote.bid, ask: quote.ask, tsMs: quote.tsMs };
      expect(await tryAcquire(kv, `r1-${flag ?? "unset"}`, now.ms + DAY_MS, now.ms)).toBe(true);
      saved.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
      await persistSplit(kv, saved);
      const loaded = startPaperHost(["SOL-USD", "ETH-USD", "BTC-USD"], {});
      loaded.clock = () => now.ms + 5_000;
      await hostHolder(loaded, kv).warm();
      const restored = loaded.classAPaper;
      if (!restored) throw new Error("reloaded book");
      expect(restored.rows.find((row) => row.pair === "SOL-USD")?.fill).toBe("pending");
      expect(restored.resting).toHaveLength(1);
      loaded.dailyBars = host.dailyBars as typeof loaded.dailyBars;
      loaded.books = new Map([...host.books].map(([id, book]) => [id, { bids: new Map<string, number>(), asks: new Map(book.asks) }]));
      loaded.ticks = new Map(host.ticks);
      loaded.book.quotes = {};
      for (const [id, quote] of Object.entries(host.book.quotes)) if (quote) loaded.book.quotes[id] = { bid: quote.bid, ask: quote.ask, tsMs: quote.tsMs };
      (loaded as ClassALiveHost).listingFirstMs = host.listingFirstMs;
      hideBook(loaded, "SOL-USD");
      showBook(loaded, "ETH-USD", now.ms + 5_000);
      stepClassAFromHost(loaded, dayCloseBar("ETH-USD"));
      const sol = restored.rows.find((row) => row.pair === "SOL-USD" && row.signalMs === CLASS_A_PAPER_START_MS);
      expect(sol?.fill).toBe("pending");
      expect(sol?.skipReason).toBeNull();
      expect(restored.resting?.some((orderRow) => orderRow.rowId === sol?.id)).toBe(true);
      expect(restored.rows.filter((row) => row.skipReason === "skip_depth")).toHaveLength(0);
    }
  } finally {
    if (gzip === undefined) delete process.env.P6_GZIP_WRITES;
    else process.env.P6_GZIP_WRITES = gzip;
  }
});

test("the order minimum uses base_min_size, then base_increment, and an unknown pair is null", () => {
  expect(classAMinSizeOf({ base_min_size: "0.001", base_increment: "0.01" })).toBe(0.001);
  expect(classAMinSizeOf({ base_increment: "0.01" })).toBe(0.01);
  expect(classAMinSizeOf({ base_min_size: 0, base_increment: "0.0001" })).toBe(0.0001);
  expect(classAMinSizeOf({})).toBeNull();
  expect(classAMinOrderBase("NOT-A-REAL-PAIR")).toBeNull();
});
