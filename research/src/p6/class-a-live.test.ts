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

function signalCandles(lastClose: number, rising: boolean, volume = 100_000) {
  const last = Date.parse("2026-10-25T00:00:00.000Z");
  return Array.from({ length: 111 }, (_, index) => {
    const close = rising ? 100 * (1 + 0.002 * index) : index === 110 ? lastClose : 100;
    return { ts: (last - (110 - index) * DAY_MS) / 1000, open: close, high: close + 0.05, low: close - 0.05, close, volume };
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

const CAP_PAIRS = ["ADA-USD", "AVAX-USD", "BTC-USD", "DOT-USD", "LINK-USD", "SOL-USD"] as const;

function capHost(pairs: readonly string[], opts: { prints: ReadonlySet<string>; volumes?: Readonly<Record<string, number>>; wide?: ReadonlySet<string> }): { host: ClassALiveHost; paper: ClassABook } {
  const paper = emptyClassABook(CLASS_A_PAPER_START_MS);
  paper.spreadLog = Object.fromEntries(pairs.map((pair) => [pair, Array.from({ length: 25 }, () => 2)]));
  const quotes: ClassALiveHost["book"]["quotes"] = {};
  const books = new Map<string, { asks: Map<string, number> }>();
  const ticks = new Map<string, number>();
  const dailyBars = new Map<string, ReturnType<typeof signalCandles>>();
  const trades: { productId: string; tsSec: number; price: number }[] = [];
  for (const pair of pairs) {
    const wide = opts.wide?.has(pair) === true;
    quotes[pair] = wide ? { bid: 100, ask: 102, tsMs: CLASS_A_PAPER_START_MS } : { bid: 100.04, ask: 100.06, tsMs: CLASS_A_PAPER_START_MS };
    books.set(pair, { asks: new Map([[wide ? "102" : "100.06", 1_000_000]]) });
    ticks.set(pair, 0.01);
    dailyBars.set(pair, signalCandles(pair === "BTC-USD" ? 100 : 100.05, pair === "BTC-USD", opts.volumes?.[pair] ?? 100_000));
    if (opts.prints.has(pair)) trades.push({ productId: pair, tsSec: CLASS_A_PAPER_START_MS / 1000, price: 100 });
  }
  if (!dailyBars.has("BTC-USD")) dailyBars.set("BTC-USD", signalCandles(100, true));
  return {
    paper,
    host: liveHost(paper, {
      clock: () => CLASS_A_PAPER_START_MS,
      dailyBars,
      ticks,
      books,
      trades,
      book: { quotes },
      listingFirstMs: Object.fromEntries(pairs.map((pair) => [pair, Date.parse("2024-01-01T00:00:00.000Z")])),
    }),
  };
}

function capView(paper: ClassABook) {
  return {
    rows: paper.rows.filter((row) => row.signalMs === CLASS_A_PAPER_START_MS).map((row) => `${row.pair}:${row.fill}:${row.skipReason ?? ""}`).sort(),
    open: paper.open.map((sim) => sim.pair).sort(),
    resting: (paper.resting ?? []).map((order) => order.pair).sort(),
    scored: paper.scored.map((row) => row.pair).sort(),
  };
}

function expectCapLosers(paper: ClassABook): void {
  for (const row of paper.rows) {
    if (row.skipReason !== "skip_cap") continue;
    expect(row.fill).toBe("nofill");
    expect(row.exitMs).toBeNull();
    expect(row.exitPrice).toBeNull();
    expect(row.exitReason).toBeNull();
    expect(row.feesUsd).toBeNull();
    expect(row.notionalUsd).toBeNull();
    expect(paper.open.some((sim) => sim.rowId === row.id)).toBe(false);
    expect(paper.scored.some((item) => item.pair === row.pair)).toBe(false);
  }
  for (const row of paper.rows) {
    if (row.fill !== "fill") continue;
    expect(row.feesUsd).toBe(((row.notionalUsd ?? 0) * 35) / 10_000);
    expect(row.entryMs).toBe(CLASS_A_PAPER_START_MS);
  }
  for (const decision of paper.bucket?.decisions ?? []) {
    expect(decision.open).toHaveLength(0);
    const bookRow = paper.rows.find((row) => row.pair === decision.productId && row.signalMs === CLASS_A_PAPER_START_MS);
    if (bookRow?.fill === "fill" || bookRow?.skipReason === "skip_cap") {
      expect(decision.resting).toHaveLength(1);
      expect(decision.rows[0]?.fill).toBe("pending");
    }
  }
}

function pushCap(host: ClassALiveHost, order: readonly string[]): void {
  for (const pair of order) stepClassAFromHost(host, dayCloseBar(pair));
}

test("immediate fills in one bucket open the same three pairs in every push order", () => {
  const prints = new Set(CAP_PAIRS.filter((pair) => pair !== "BTC-USD"));
  const wide = new Set(["BTC-USD"]);
  const orders = permutations(CAP_PAIRS);
  expect(orders).toHaveLength(720);
  const expected = {
    rows: ["ADA-USD:fill:", "AVAX-USD:fill:", "BTC-USD:skip:skip_spread", "DOT-USD:fill:", "LINK-USD:nofill:skip_cap", "SOL-USD:nofill:skip_cap"],
    open: ["ADA-USD", "AVAX-USD", "DOT-USD"],
    resting: [],
    scored: [],
  };
  for (const order of orders) {
    const { host, paper } = capHost(CAP_PAIRS, { prints, wide });
    pushCap(host, order);
    expect(capView(paper)).toEqual(expected);
    expect(paper.open).toHaveLength(3);
    expectCapLosers(paper);

    const restarted = capHost(CAP_PAIRS, { prints, wide });
    pushCap(restarted.host, order.slice(0, 3));
    const restored = restoreClassABook(JSON.parse(JSON.stringify(restarted.paper)));
    if (!restored?.bucket) throw new Error("bucket missing after restart");
    expect(restored.bucket.decisions?.map((item) => item.productId).sort()).toEqual(order.slice(0, 3).slice().sort());
    const again = capHost(CAP_PAIRS, { prints, wide });
    again.host.classAPaper = restored;
    again.host.classABucket = undefined;
    pushCap(again.host, order.slice(3));
    expect(capView(restored)).toEqual(expected);
    expectCapLosers(restored);
  }
});

test("a bucket mixes immediate fills and a resting order and still caps once", () => {
  const pairs = ["ADA-USD", "AVAX-USD", "DOT-USD", "LINK-USD", "SOL-USD"];
  const prints = new Set(["ADA-USD", "AVAX-USD", "DOT-USD", "LINK-USD"]);
  const orders = permutations(pairs);
  expect(orders).toHaveLength(120);
  const expected = {
    rows: ["ADA-USD:fill:", "AVAX-USD:fill:", "DOT-USD:fill:", "LINK-USD:nofill:skip_cap", "SOL-USD:pending:"],
    open: ["ADA-USD", "AVAX-USD", "DOT-USD"],
    resting: ["SOL-USD"],
    scored: [],
  };
  for (const order of orders) {
    const { host, paper } = capHost(pairs, { prints });
    pushCap(host, order);
    expect(capView(paper)).toEqual(expected);
    expectCapLosers(paper);
    const resting = paper.resting?.find((orderRow) => orderRow.pair === "SOL-USD");
    expect(resting?.signalMs).toBe(CLASS_A_PAPER_START_MS);
    expect(paper.open.some((sim) => sim.pair === "SOL-USD")).toBe(false);
  }
});

test("a higher frozen volume beats A→Z when immediate fills share a bucket", () => {
  const pairs = ["ADA-USD", "AVAX-USD", "DOT-USD", "LINK-USD", "SOL-USD"];
  const prints = new Set(pairs);
  const volumes = { "SOL-USD": 400_000 };
  const orders = permutations(pairs);
  const expected = {
    rows: ["ADA-USD:fill:", "AVAX-USD:fill:", "DOT-USD:nofill:skip_cap", "LINK-USD:nofill:skip_cap", "SOL-USD:fill:"],
    open: ["ADA-USD", "AVAX-USD", "SOL-USD"],
    resting: [],
    scored: [],
  };
  for (const order of orders) {
    const { host, paper } = capHost(pairs, { prints, volumes });
    pushCap(host, order);
    const sol = paper.rows.find((row) => row.pair === "SOL-USD");
    const ada = paper.rows.find((row) => row.pair === "ADA-USD");
    expect(sol?.medianVolumeUsd ?? 0).toBeGreaterThan(ada?.medianVolumeUsd ?? 0);
    expect(capView(paper)).toEqual(expected);
    expectCapLosers(paper);
  }
});

test("open risk rejects the next immediate fill while a slot is still free", () => {
  const pairs = ["ADA-USD", "DOT-USD", "SOL-USD"];
  const prints = new Set(pairs);
  const orders = permutations(pairs);
  expect(orders).toHaveLength(6);
  for (const order of orders) {
    const run = (split: boolean) => {
      const { host, paper } = capHost(pairs, { prints });
      paper.open.push({
        rowId: "ETH-USD:held",
        pair: "ETH-USD",
        scored: true,
        entry: 100,
        entryMs: CLASS_A_PAPER_START_MS - DAY_MS,
        entryDate: "2026-10-25",
        stop: 50,
        initialStop: 50,
        notionalUsd: 100,
        units: 1,
        feeEntryBps: 35,
        sBps: 5,
        highestClose: 100,
        priorCloses: [],
        pending: null,
      });
      if (split) {
        pushCap(host, order.slice(0, 1));
        const restored = restoreClassABook(JSON.parse(JSON.stringify(paper)));
        if (!restored?.bucket) throw new Error("bucket missing after restart");
        const again = capHost(pairs, { prints });
        again.host.classAPaper = restored;
        again.host.classABucket = undefined;
        pushCap(again.host, order.slice(1));
        return restored;
      }
      pushCap(host, order);
      return paper;
    };
    for (const paper of [run(false), run(true)]) {
      expect(paper.open.map((sim) => sim.pair).sort()).toEqual(["ADA-USD", "ETH-USD"]);
      expect(paper.open.length).toBeLessThan(3);
      const filled = paper.rows.find((row) => row.pair === "ADA-USD");
      const entry = filled?.signalClose ?? 0;
      const orderRisk = entry > 0 ? ((filled?.notionalUsd ?? 0) * (entry - (filled?.stop ?? 0))) / entry : 0;
      expect(50 + orderRisk).toBeLessThanOrEqual(60);
      expect(50 + orderRisk * 2).toBeGreaterThan(60);
      for (const pair of ["DOT-USD", "SOL-USD"]) expect(paper.rows.find((row) => row.pair === pair)?.skipReason).toBe("skip_cap");
      expectCapLosers(paper);
      expect(paper.scored).toHaveLength(0);
    }
  }
});

test("lastSignalMs is copied back from the stored decision on a later push and a restart", () => {
  const { host } = dayCloseHost();
  const paper = host.classAPaper;
  if (!paper) throw new Error("book");
  showBook(host, "ADA-USD", CLASS_A_PAPER_START_MS);
  stepClassAFromHost(host, dayCloseBar("ADA-USD"));
  expect(paper.lastSignalMs).toBe(CLASS_A_PAPER_START_MS);
  expect(paper.bucket?.image.lastSignalMs ?? null).toBeNull();
  showBook(host, "ETH-USD", CLASS_A_PAPER_START_MS);
  stepClassAFromHost(host, dayCloseBar("ETH-USD"));
  expect(paper.lastSignalMs).toBe(CLASS_A_PAPER_START_MS);
  const restored = restoreClassABook(JSON.parse(JSON.stringify(paper)));
  if (!restored?.bucket) throw new Error("bucket missing after restart");
  const again = dayCloseHost();
  again.host.classAPaper = restored;
  again.host.classABucket = undefined;
  showBook(again.host, "SOL-USD", CLASS_A_PAPER_START_MS);
  stepClassAFromHost(again.host, dayCloseBar("SOL-USD"));
  expect(restored.lastSignalMs).toBe(CLASS_A_PAPER_START_MS);
  expect(restored.rows.find((row) => row.pair === "ADA-USD")?.fill).toBe("pending");
});

test("a later pair is checked before an earlier pair's stop can kill the book", () => {
  const { host, paper } = capHost(["ADA-USD", "SOL-USD"], { prints: new Set() });
  paper.open.push({
    rowId: "SOL-USD:held",
    pair: "SOL-USD",
    scored: true,
    entry: 100,
    entryMs: CLASS_A_PAPER_START_MS - DAY_MS,
    entryDate: "2026-10-25",
    stop: 1,
    initialStop: 1,
    notionalUsd: 10_000,
    units: 100,
    feeEntryBps: 35,
    sBps: 5,
    highestClose: 100,
    priorCloses: [],
    pending: null,
  });
  stepClassAFromHost(host, { productId: "SOL-USD", startSec: DAY_CLOSE_SEC, open: 100, high: 100, low: 0.5, close: 100 });
  stepClassAFromHost(host, dayCloseBar("ADA-USD"));
  const ada = paper.rows.find((row) => row.pair === "ADA-USD" && row.signalMs === CLASS_A_PAPER_START_MS);
  expect(ada?.skipReason).not.toBe("skip_kill");
  expect(ada?.fill).toBe("pending");
  expect(paper.killed).toBe(true);
});

test("an immediate-fill bucket survives a mid-bucket reload with gzip off and on", async () => {
  const gzip = process.env.P6_GZIP_WRITES;
  try {
    const prints = new Set(CAP_PAIRS.filter((pair) => pair !== "BTC-USD"));
    const wide = new Set(["BTC-USD"]);
    const order = ["SOL-USD", "LINK-USD", "DOT-USD", "BTC-USD", "AVAX-USD", "ADA-USD"];
    const expectedOpen = ["ADA-USD", "AVAX-USD", "DOT-USD"];
    for (const flag of [undefined, "1"] as const) {
      if (flag === undefined) delete process.env.P6_GZIP_WRITES;
      else process.env.P6_GZIP_WRITES = flag;
      const { host, paper } = capHost(CAP_PAIRS, { prints, wide });
      pushCap(host, order.slice(0, 3));
      const kv = memoryKv(() => CLASS_A_PAPER_START_MS);
      const saved = startPaperHost(["ADA-USD", "AVAX-USD", "BTC-USD", "DOT-USD", "LINK-USD", "SOL-USD"], {});
      saved.clock = () => CLASS_A_PAPER_START_MS;
      await hostHolder(saved, kv).warm();
      saved.classAPaper = paper;
      saved.dailyBars = host.dailyBars as typeof saved.dailyBars;
      saved.books = new Map([...host.books].map(([id, book]) => [id, { bids: new Map<string, number>(), asks: new Map(book.asks) }]));
      saved.ticks = new Map(host.ticks);
      saved.trades = host.trades.map((trade) => ({ ...trade, size: 1 }));
      saved.book.quotes = {};
      for (const [id, quote] of Object.entries(host.book.quotes)) if (quote) saved.book.quotes[id] = { bid: quote.bid, ask: quote.ask, tsMs: quote.tsMs };
      expect(await tryAcquire(kv, `cap-${flag ?? "unset"}`, CLASS_A_PAPER_START_MS + DAY_MS, CLASS_A_PAPER_START_MS)).toBe(true);
      saved.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
      await persistSplit(kv, saved);
      const loaded = startPaperHost(["ADA-USD", "AVAX-USD", "BTC-USD", "DOT-USD", "LINK-USD", "SOL-USD"], {});
      loaded.clock = () => CLASS_A_PAPER_START_MS;
      await hostHolder(loaded, kv).warm();
      const restored = loaded.classAPaper;
      if (!restored) throw new Error("reloaded book");
      loaded.dailyBars = host.dailyBars as typeof loaded.dailyBars;
      loaded.books = new Map([...host.books].map(([id, book]) => [id, { bids: new Map<string, number>(), asks: new Map(book.asks) }]));
      loaded.ticks = new Map(host.ticks);
      loaded.trades = host.trades.map((trade) => ({ ...trade, size: 1 }));
      loaded.book.quotes = {};
      for (const [id, quote] of Object.entries(host.book.quotes)) if (quote) loaded.book.quotes[id] = { bid: quote.bid, ask: quote.ask, tsMs: quote.tsMs };
      (loaded as ClassALiveHost).listingFirstMs = host.listingFirstMs;
      pushCap(loaded, order.slice(3));
      expect(restored.open.map((sim) => sim.pair).sort()).toEqual(expectedOpen);
      expect(capView(restored).rows).toEqual([
        "ADA-USD:fill:",
        "AVAX-USD:fill:",
        "BTC-USD:skip:skip_spread",
        "DOT-USD:fill:",
        "LINK-USD:nofill:skip_cap",
        "SOL-USD:nofill:skip_cap",
      ]);
      expectCapLosers(restored);
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
