import { expect, test } from "bun:test";
import { TAKER_FEE_BPS } from "../../vendor/87b35d0/config.ts";
import { CLASS_C_MAX_HOLD_MS } from "../p3/design-rules";
import type { ClassId } from "../p3/portfolio";
import { applyForward, freshBook, type Book, type ForwardEvent, type Position } from "./engine";
import { captureHot, HOT_MAX_BYTES, hotBytes, loadSplit, persistSplit } from "./hot-store";
import { isoWeekWindow } from "./latches";
import { installPaperState, startPaperHost } from "./paper-host";
import { decodeStored } from "./redis-gzip";
import { decodeLease, HOT_KEY, LEASE_KEY, memoryKv, peekStored, tryAcquire } from "./relay";
import { classDollarBackstop } from "./session";

const SAT = Date.parse("2026-10-17T12:00:00.000Z");
const SUN = Date.parse("2026-10-18T00:00:00.000Z");
const MON = Date.parse("2026-10-19T00:00:00.000Z");
const FOUR_H = 14_400_000;
const CLASSES: readonly ClassId[] = ["A", "B", "C", "D", "E"];

function boot(tsMs = SAT - 60_000, config?: Parameters<typeof freshBook>[0]): Book {
  return applyForward(freshBook(config), { kind: "clock", tsMs });
}

function x1(id: string, classId: ClassId, productId: string, tsMs: number, stop = 90): ForwardEvent {
  return {
    kind: "x1",
    id,
    classId,
    productId,
    tsMs,
    nextOpen: 100,
    stop,
    atr1h: 1,
    bid: 100,
    ask: 100,
    bookTsMs: tsMs,
    sendTsMs: tsMs + 5,
    decisionMid: 100,
  };
}

function dOrder(id: string, productId: string, placedTs: number, limit: number, stop: number, target?: number): ForwardEvent {
  return {
    kind: "d-order",
    id,
    productId,
    limit,
    units: 1,
    placedTs,
    stop,
    bid: limit,
    ask: limit,
    bookTsMs: placedTs,
    sendTsMs: placedTs + 5,
    decisionMid: limit,
    tick: 0.01,
    ...(target != null ? { target } : {}),
  };
}

function realize(id: string, classId: ClassId, productId: string, netUsd: number, exitTs: number, netR = -1, riskUsd = 20): ForwardEvent {
  return { kind: "realize", id, classId, productId, netR, netUsd, riskUsd, entryDate: "2026-10-17", exitTs };
}

function bar(productId: string, startSec: number, low: number): ForwardEvent {
  return {
    kind: "bar15",
    productId,
    startSec,
    nowSec: startSec + 900,
    open: 100,
    high: 100,
    low,
    close: 95,
  };
}

function withClear<T>(token: string | undefined, run: () => T): T {
  const previous = process.env.P6_CLEAR_LATCH;
  if (token == null || token.length === 0) delete process.env.P6_CLEAR_LATCH;
  else process.env.P6_CLEAR_LATCH = token;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env.P6_CLEAR_LATCH;
    else process.env.P6_CLEAR_LATCH = previous;
  }
}

function liveDrawdown(book: Book): number {
  const equity = book.realizedUsd;
  return Math.max(0, Math.max(book.peakEquity, equity) - equity);
}

/** Same equity-loss mark the fee tests use: threshold minus the entry fee, one ulp on the trip side. */
function markForEquityLoss(position: Position, thresholdUsd: number): number {
  const k = (TAKER_FEE_BPS + position.sLiveBps) / 10_000;
  const priceAndExitLoss = thresholdUsd - position.entryFeeUsd + 1e-9;
  return (position.fillPrice * position.units - priceAndExitLoss) / (position.units * (1 - k));
}

function leaks(book: Book, token: string): boolean {
  return book.incidents.some((line) => line.includes(token));
}

test("a green close does not unlatch the class backstop or the book halt", () => {
  const classLoss = applyForward(boot(), realize("loss-c", "C", "LOSS-USD", -1_200, SAT, -1, 1_200));
  const classLatch = classLoss.latches?.class?.C;
  expect(classDollarBackstop(classLoss.classes.C)).toBe(true);
  expect(classLatch?.id).toBe(`class-C-${SAT}`);
  expect(classLatch?.tradeId).toBe("loss-c");
  expect(classLatch?.peakUsd).toBe(0);
  expect(classLatch?.cumUsd).toBe(-1_200);
  expect(classLoss.latches?.book).toBeUndefined();

  const classGreen = applyForward(classLoss, realize("green-c", "C", "GAIN-USD", 1_100, SAT + 1_000, 1, 20));
  expect(classDollarBackstop(classGreen.classes.C)).toBe(false);
  expect(classGreen.classes.C.peakUsd - classGreen.classes.C.cumUsd).toBe(100);
  expect(classGreen.latches?.class?.C).toEqual(classLatch);
  expect(classGreen.latches?.daily?.window).toBe("2026-10-17");
  expect(classGreen.latches?.weekly?.window).toBe(isoWeekWindow("2026-10-17"));
  const classBlocked = applyForward(classGreen, x1("again-c", "C", "SOL-USD", SAT + 2_000));
  expect(classBlocked.positions).toHaveLength(0);
  expect(classBlocked.rejected.at(-1)?.reason ?? "").toContain("backstop");

  const bookLoss = applyForward(boot(), realize("loss-book", "A", "LOSS-USD", -1_600, SAT, -1, 1_600));
  const bookLatch = bookLoss.latches?.book;
  expect(bookLatch?.id).toBe(`book-${SAT}`);
  expect(bookLatch?.drawdownUsd).toBe(1_600);
  expect(bookLatch?.peakEquityUsd).toBe(0);
  const bookGreen = applyForward(bookLoss, realize("green-book", "A", "GAIN-USD", 1_600, SAT + 1_000, 1, 20));
  expect(liveDrawdown(bookGreen)).toBe(0);
  expect(bookGreen.latches?.book).toEqual(bookLatch);
  const bookBlocked = applyForward(bookGreen, x1("again-book", "E", "SOL-USD", SAT + 2_000));
  expect(bookBlocked.positions).toHaveLength(0);
  expect(bookBlocked.rejected.at(-1)?.reason ?? "").toContain("halt");
});

test("a day roll clears daily and a week roll clears weekly, and neither clears book or class", () => {
  expect(isoWeekWindow("2026-10-18")).toBe(isoWeekWindow("2026-10-17"));
  expect(isoWeekWindow("2026-10-19")).not.toBe(isoWeekWindow("2026-10-17"));

  const daily = applyForward(boot(), realize("day", "C", "LOSS-USD", -240, SAT, -1, 240));
  expect(daily.latches?.daily?.window).toBe("2026-10-17");
  expect(daily.latches?.weekly).toBeUndefined();
  expect(daily.latches?.book).toBeUndefined();
  const nextDay = applyForward(daily, { kind: "clock", tsMs: SUN });
  expect(nextDay.latches?.daily).toBeUndefined();
  expect(nextDay.latches?.weekly).toBeUndefined();
  const dailyOpen = applyForward(nextDay, x1("day-open", "E", "SOL-USD", SUN));
  expect(dailyOpen.rejected.some((row) => row.id === "day-open")).toBe(false);
  expect(dailyOpen.positions.some((row) => row.id === "day-open")).toBe(true);

  const weekly = applyForward(boot(), realize("week", "C", "LOSS-USD", -480, SAT, -1, 480));
  expect(weekly.latches?.weekly?.window).toBe(isoWeekWindow("2026-10-17"));
  const sunday = applyForward(weekly, { kind: "clock", tsMs: SUN });
  expect(sunday.latches?.daily).toBeUndefined();
  expect(sunday.latches?.weekly?.window).toBe(isoWeekWindow("2026-10-17"));
  const sundayBlocked = applyForward(sunday, x1("week-sun", "E", "SOL-USD", SUN));
  expect(sundayBlocked.positions).toHaveLength(0);
  expect(sundayBlocked.rejected.at(-1)?.reason ?? "").toContain("halt");
  const monday = applyForward(sundayBlocked, { kind: "clock", tsMs: MON });
  expect(monday.latches?.weekly).toBeUndefined();
  expect(monday.latches?.book).toBeUndefined();
  const weekOpen = applyForward(monday, x1("week-open", "E", "SOL-USD", MON));
  expect(weekOpen.positions.some((row) => row.id === "week-open")).toBe(true);

  let klass = applyForward(boot(), realize("class-loss", "C", "LOSS-USD", -1_200, SAT, -1, 1_200));
  klass = applyForward(klass, realize("class-green", "C", "GAIN-USD", 1_100, SAT + 1_000, 1, 20));
  const frozen = klass.latches?.class?.C;
  expect(classDollarBackstop(klass.classes.C)).toBe(false);
  const classSunday = applyForward(klass, { kind: "clock", tsMs: SUN });
  expect(classSunday.latches?.daily).toBeUndefined();
  expect(classSunday.latches?.weekly).toBeDefined();
  expect(classSunday.latches?.class?.C).toEqual(frozen);
  const classMonday = applyForward(classSunday, { kind: "clock", tsMs: MON });
  expect(classMonday.latches?.weekly).toBeUndefined();
  expect(classMonday.latches?.book).toBeUndefined();
  expect(classMonday.latches?.class?.C).toEqual(frozen);
  const same = applyForward(classMonday, x1("class-same", "C", "SOL-USD", MON));
  expect(same.positions).toHaveLength(0);
  expect(same.rejected.at(-1)?.reason ?? "").toContain("backstop");
  const other = applyForward(same, x1("class-other", "E", "ETH-USD", MON));
  expect(other.positions.some((row) => row.id === "class-other")).toBe(true);

  let book = applyForward(boot(), realize("book-loss", "A", "LOSS-USD", -1_600, SAT, -1, 1_600));
  book = applyForward(book, realize("book-green", "A", "GAIN-USD", 1_600, SAT + 1_000, 1, 20));
  const bookFrozen = book.latches?.book;
  expect(liveDrawdown(book)).toBe(0);
  const bookMonday = applyForward(book, { kind: "clock", tsMs: MON });
  expect(bookMonday.latches?.daily).toBeUndefined();
  expect(bookMonday.latches?.weekly).toBeUndefined();
  expect(bookMonday.latches?.book).toEqual(bookFrozen);
  expect(bookMonday.latches?.class?.A?.id).toBe(`class-A-${SAT}`);
  const bookBlocked = applyForward(bookMonday, x1("book-monday", "E", "SOL-USD", MON));
  expect(bookBlocked.positions).toHaveLength(0);
  expect(bookBlocked.rejected.at(-1)?.reason ?? "").toContain("halt");
});

test("every latch survives a hot reload and a clear survives the next holder", async () => {
  const gzip = process.env.P6_GZIP_WRITES;
  const clear = process.env.P6_CLEAR_LATCH;
  delete process.env.P6_CLEAR_LATCH;
  process.env.P6_GZIP_WRITES = "0";
  try {
    const host = startPaperHost(["BTC-USD"], {});
    host.clock = () => SAT;
    applyForward(host.book, { kind: "clock", tsMs: SAT });
    CLASSES.forEach((classId, index) => {
      applyForward(host.book, realize(`loss-${classId}`, classId, `LOSS-${classId}`, -1_200, SAT + index, -1, 1_200));
    });
    expect(host.book.latches?.daily).toBeDefined();
    expect(host.book.latches?.weekly).toBeDefined();
    // The second closed loss is the one that crosses $1,600. The first $1,200 does not.
    expect(host.book.latches?.book?.id).toBe(`book-${SAT + 1}`);
    for (const classId of CLASSES) expect(host.book.latches?.class?.[classId]?.id).toBe(`class-${classId}-${SAT + CLASSES.indexOf(classId)}`);

    const kv = memoryKv(() => SAT);
    expect(await tryAcquire(kv, "latch-holder", SAT + 86_400_000, SAT)).toBe(true);
    host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
    await persistSplit(kv, host);
    const stored = peekStored(kv, HOT_KEY);
    expect(stored).not.toBeNull();
    expect(stored!.startsWith("gz1:")).toBe(false);
    expect(await kv.get("p6:latches")).toBeNull();
    const hot = JSON.parse(decodeStored(HOT_KEY, stored) ?? "{}") as { latches?: { book?: { id: string } } };
    expect(hot.latches?.book?.id).toBe(host.book.latches?.book?.id);

    const loaded = startPaperHost(["BTC-USD"], {});
    loaded.clock = () => SAT;
    const body = await loadSplit(kv, loaded);
    expect(body).not.toBeNull();
    installPaperState(loaded, body!);
    expect(loaded.book.latches?.book?.id).toBe(host.book.latches?.book?.id);
    expect(loaded.book.latches?.daily?.window).toBe(host.book.latches?.daily?.window);
    expect(loaded.book.latches?.weekly?.window).toBe(host.book.latches?.weekly?.window);
    for (const classId of CLASSES) expect(loaded.book.latches?.class?.[classId]).toEqual(host.book.latches?.class?.[classId]);
    const blocked = applyForward(loaded.book, x1("reloaded", "E", "SOL-USD", SAT + 10_000));
    expect(blocked.positions).toHaveLength(0);
    expect(blocked.rejected.at(-1)?.reason ?? "").toContain("halt");

    const cleared = startPaperHost(["BTC-USD"], {});
    cleared.clock = () => SAT;
    applyForward(cleared.book, { kind: "clock", tsMs: SAT });
    applyForward(cleared.book, realize("book-only", "A", "LOSS-USD", -1_600, SAT, -1, 1_600));
    const tripAt = cleared.book.latches?.book?.tripAt;
    const latchId = cleared.book.latches?.book?.id;
    expect(latchId).toBe(`book-${tripAt}`);
    const token = `book:${latchId}:${tripAt}`;
    withClear(token, () => {
      applyForward(cleared.book, { kind: "clock", tsMs: SAT + 1_000 });
    });
    expect(leaks(cleared.book, token)).toBe(false);
    expect(cleared.book.latches?.book).toBeUndefined();
    expect(cleared.book.latchRearm?.book).toBe(true);
    expect(cleared.book.clearedLatchIds).toContain(latchId);
    const kv2 = memoryKv(() => SAT);
    expect(await tryAcquire(kv2, "latch-next", SAT + 86_400_000, SAT)).toBe(true);
    cleared.leaseToken = decodeLease(await kv2.get(LEASE_KEY))?.token ?? null;
    await persistSplit(kv2, cleared);
    const next = startPaperHost(["BTC-USD"], {});
    next.clock = () => SAT;
    const again = await loadSplit(kv2, next);
    expect(again).not.toBeNull();
    installPaperState(next, again!);
    expect(next.book.latches?.book).toBeUndefined();
    expect(next.book.latchRearm?.book).toBe(true);
    applyForward(next.book, { kind: "clock", tsMs: SAT + 2_000 });
    expect(next.book.latches?.book).toBeUndefined();
    expect(next.book.latchRearm?.book).toBe(true);
  } finally {
    if (gzip === undefined) delete process.env.P6_GZIP_WRITES;
    else process.env.P6_GZIP_WRITES = gzip;
    if (clear === undefined) delete process.env.P6_CLEAR_LATCH;
    else process.env.P6_CLEAR_LATCH = clear;
  }
});

test("a resting D entry is cancelled when a blocker appears", () => {
  const daily = applyForward(boot(), dOrder("d-day", "ETH-USD", SAT, 100, 90));
  expect(daily.working).toHaveLength(1);
  const dailyBlocked = applyForward(daily, realize("day-loss", "C", "LOSS-USD", -240, SAT + 1_000, -1, 240));
  expect(dailyBlocked.working).toHaveLength(0);
  expect(dailyBlocked.incidents).toContain("cancel_blocked d-day");
  expect(dailyBlocked.dEntryNotBeforeMs).toBe(SAT + FOUR_H);

  const killed = applyForward(boot(), dOrder("d-kill", "ETH-USD", SAT, 100, 90));
  const kill = applyForward(killed, { kind: "kill-switch", on: true });
  expect(kill.working).toHaveLength(0);
  expect(kill.incidents).toContain("cancel_blocked d-kill");
  expect(kill.latches?.daily).toBeUndefined();

  let marked = applyForward(boot(), dOrder("d-book", "SOL-USD", SAT, 100, 90));
  expect(marked.working).toHaveLength(1);
  marked = applyForward(marked, x1("m1", "C", "BTC-USD", SAT + 1_000, 99.8));
  marked = applyForward(marked, x1("m2", "E", "ETH-USD", SAT + 1_000, 99.8));
  expect(marked.positions).toHaveLength(2);
  for (const position of [...marked.positions]) {
    marked = applyForward(marked, { kind: "mark", productId: position.productId, price: markForEquityLoss(position, 800) });
  }
  expect(marked.latches?.book).toBeDefined();
  expect(marked.working).toHaveLength(0);
  expect(marked.incidents).toContain("cancel_blocked d-book");
});

test("a fill that arrives after a block is refused and opens nothing", () => {
  const placed = applyForward(boot(), dOrder("d-race", "ETH-USD", SAT, 100, 90));
  const kept = placed.working.slice();
  expect(kept).toHaveLength(1);
  const blocked = applyForward(placed, realize("race-loss", "C", "LOSS-USD", -240, SAT + 1_000, -1, 240));
  expect(blocked.working).toHaveLength(0);
  expect(blocked.incidents).toContain("cancel_blocked d-race");
  blocked.working = kept;
  const raced = applyForward(blocked, {
    kind: "trade",
    productId: "ETH-USD",
    price: 99.98,
    size: 10_000,
    makerSide: "sell",
    tsMs: SAT + 2_000,
  });
  expect(raced.incidents).toContain("blocked_fill d-race");
  expect(raced.positions).toHaveLength(0);
  expect(raced.working).toHaveLength(0);
  expect(raced.closed.every((trade) => trade.id !== "d-race")).toBe(true);
});

test("stops, targets, rules, and time exits still fill while every latch is set", () => {
  let book = boot();
  book = applyForward(book, x1("btc", "C", "BTC-USD", SAT, 90));
  book = applyForward(book, x1("sol", "B", "SOL-USD", SAT, 90));
  book = applyForward(book, x1("avax", "C", "AVAX-USD", SAT, 90));
  book = applyForward(book, dOrder("eth", "ETH-USD", SAT, 100, 90, 110));
  book = applyForward(book, { kind: "trade", productId: "ETH-USD", price: 99.98, size: 10_000, makerSide: "sell", tsMs: SAT + 1_000 });
  expect(book.positions.map((row) => row.productId).sort()).toEqual(["AVAX-USD", "BTC-USD", "ETH-USD", "SOL-USD"]);

  CLASSES.forEach((classId, index) => {
    book = applyForward(book, realize(`latch-${classId}`, classId, `LOSS-${classId}`, -1_200, SAT + 2_000 + index, -1, 1_200));
  });
  expect(book.latches?.daily).toBeDefined();
  expect(book.latches?.weekly).toBeDefined();
  expect(book.latches?.book).toBeDefined();
  for (const classId of CLASSES) expect(book.latches?.class?.[classId]).toBeDefined();
  expect(book.positions).toHaveLength(4);

  const sol = book.positions.find((row) => row.productId === "SOL-USD");
  const avax = book.positions.find((row) => row.productId === "AVAX-USD");
  expect(sol).toBeDefined();
  expect(avax).toBeDefined();
  // No injected event arms a rule exit without a ten-day class-A setup. The field is the registered pending exit.
  sol!.pendingExit = "rule";
  // Aging the timestamp reaches the 72h cap on this same Saturday bar. Rolling the clock forward would clear the daily latch.
  avax!.entryTs = SAT - CLASS_C_MAX_HOLD_MS - 3_600_000;

  const startSec = SAT / 1000;
  book = applyForward(book, bar("BTC-USD", startSec, 80));
  book = applyForward(book, { kind: "trade", productId: "ETH-USD", price: 110.02, size: 10_000, makerSide: "buy", tsMs: SAT + 20_000 });
  book = applyForward(book, bar("SOL-USD", startSec, 95));
  book = applyForward(book, bar("AVAX-USD", startSec, 95));

  const exits = book.closed.filter((trade) => trade.exitKind !== "realize");
  expect(exits.map((trade) => trade.exitKind).sort()).toEqual(["rule", "stop", "target", "time"]);
  expect(book.positions).toHaveLength(0);
  expect(book.latches?.book).toBeDefined();
  expect(book.latches?.daily).toBeDefined();
  for (const classId of CLASSES) expect(book.latches?.class?.[classId]).toBeDefined();
  const blocked = applyForward(book, x1("after-exits", "E", "LINK-USD", SAT + 30_000));
  expect(blocked.positions).toHaveLength(0);
  expect(blocked.rejected.at(-1)?.reason ?? "").toContain("halt");
});

test("a bound clear matches scope, id, and tripAt, and a reused token does not clear a new trip", () => {
  let book = applyForward(boot(), realize("book-loss", "C", "LOSS-USD", -1_600, SAT, -1, 1_600));
  const tripAt = book.latches?.book?.tripAt ?? 0;
  const latchId = book.latches?.book?.id ?? "";
  expect(latchId).toBe(`book-${tripAt}`);
  const wrongId = "book:book-1:1";
  book = withClear(wrongId, () => applyForward(book, { kind: "clock", tsMs: SAT + 1_000 }));
  expect(book.latches?.book?.id).toBe(latchId);
  expect(book.incidents).toContain("latch_clear_mismatch scope=book id=book-1");
  expect(leaks(book, wrongId)).toBe(false);
  const wrongTrip = "book:book-999:999";
  book = withClear(wrongTrip, () => applyForward(book, { kind: "clock", tsMs: SAT + 2_000 }));
  expect(book.latches?.book?.id).toBe(latchId);
  expect(book.incidents).toContain("latch_clear_mismatch scope=book id=book-999");
  expect(leaks(book, wrongTrip)).toBe(false);
  const malformed = `book:book-${tripAt}:999`;
  book = withClear(malformed, () => applyForward(book, { kind: "clock", tsMs: SAT + 3_000 }));
  expect(book.latches?.book?.id).toBe(latchId);
  expect(book.incidents.some((line) => line === "latch_clear_mismatch")).toBe(true);
  expect(leaks(book, malformed)).toBe(false);

  const token = `book:${latchId}:${tripAt}`;
  book = withClear(token, () => applyForward(book, { kind: "clock", tsMs: SAT + 4_000 }));
  expect(leaks(book, token)).toBe(false);
  expect(book.latches?.book).toBeUndefined();
  expect(book.clearedLatchIds).toEqual([latchId]);
  expect(book.incidents.filter((line) => line === `latch_cleared who=brian scope=book id=${latchId}`)).toHaveLength(1);
  expect(liveDrawdown(book)).toBe(1_600);
  const still = applyForward(book, x1("still", "E", "SOL-USD", SAT + 5_000));
  expect(still.positions).toHaveLength(0);
  expect(still.rejected.at(-1)?.reason ?? "").toContain("halt");

  let recovered = applyForward(still, realize("book-green", "C", "GAIN-USD", 1_600, SAT + 6_000, 1, 20));
  expect(recovered.latchRearm?.book).toBeUndefined();
  recovered = applyForward(recovered, { kind: "clock", tsMs: MON });
  expect(recovered.latches?.daily).toBeUndefined();
  expect(recovered.latches?.weekly).toBeUndefined();
  expect(recovered.latches?.book).toBeUndefined();
  expect(recovered.latches?.class?.C).toBeDefined();
  const opened = applyForward(recovered, x1("after-clear", "E", "SOL-USD", MON));
  expect(opened.positions.some((row) => row.id === "after-clear")).toBe(true);
  const retrip = applyForward(opened, realize("book-again", "E", "LOSS-2", -1_600, MON + 1_000, -1, 1_600));
  const nextId = retrip.latches?.book?.id;
  expect(nextId).toBe(`book-${MON + 1_000}`);
  expect(nextId).not.toBe(latchId);
  const reused = withClear(token, () => applyForward(retrip, { kind: "clock", tsMs: MON + 2_000 }));
  expect(reused.latches?.book?.id).toBe(nextId);
  expect(reused.incidents.filter((line) => line === `latch_clear_mismatch scope=book id=${latchId}`)).toHaveLength(1);
  expect(reused.incidents.some((line) => line === `latch_cleared who=brian scope=book id=${nextId}`)).toBe(false);
  expect(leaks(reused, token)).toBe(false);

  let klass = applyForward(boot(), realize("class-loss", "C", "LOSS-USD", -1_200, SAT, -1, 1_200));
  const classTrip = klass.latches?.class?.C?.tripAt ?? 0;
  const classId = klass.latches?.class?.C?.id ?? "";
  expect(klass.latches?.book).toBeUndefined();
  const classToken = `class-C:${classId}:${classTrip}`;
  const classWrong = `class-C:class-C-1:1`;
  klass = withClear(classWrong, () => applyForward(klass, { kind: "clock", tsMs: SAT + 1_000 }));
  expect(klass.latches?.class?.C?.id).toBe(classId);
  expect(klass.incidents).toContain("latch_clear_mismatch scope=class-C id=class-C-1");
  expect(leaks(klass, classWrong)).toBe(false);
  klass = withClear(classToken, () => applyForward(klass, { kind: "clock", tsMs: SAT + 2_000 }));
  expect(leaks(klass, classToken)).toBe(false);
  expect(klass.latches?.class?.C).toBeUndefined();
  expect(klass.latchRearm?.class?.C).toBe(true);
  expect(klass.incidents.filter((line) => line === `latch_cleared who=brian scope=class-C id=${classId}`)).toHaveLength(1);
  klass = applyForward(klass, realize("class-green", "C", "GAIN-USD", 1_100, SAT + 3_000, 1, 20));
  expect(klass.latchRearm?.class?.C).toBeUndefined();
  klass = applyForward(klass, { kind: "clock", tsMs: MON });
  expect(klass.latches?.class?.C).toBeUndefined();
  expect(klass.latches?.daily).toBeUndefined();
  expect(klass.latches?.weekly).toBeUndefined();
  const classOpen = applyForward(klass, x1("class-open", "C", "SOL-USD", MON));
  expect(classOpen.positions.some((row) => row.id === "class-open")).toBe(true);
  const classAgain = applyForward(classOpen, realize("class-again", "C", "LOSS-2", -1_200, MON + 1_000, -1, 1_200));
  expect(classAgain.latches?.class?.C?.id).toBe(`class-C-${MON + 1_000}`);
  const classReused = withClear(classToken, () => applyForward(classAgain, { kind: "clock", tsMs: MON + 2_000 }));
  expect(classReused.latches?.class?.C?.id).toBe(`class-C-${MON + 1_000}`);
  expect(classReused.incidents.some((line) => line === `latch_cleared who=brian scope=class-C id=class-C-${MON + 1_000}`)).toBe(false);
  expect(leaks(classReused, classToken)).toBe(false);

  const daily = applyForward(boot(), realize("daily-only", "E", "LOSS-USD", -240, SAT, -1, 240));
  const dailyWindow = daily.latches?.daily;
  const dailyTried = withClear("daily:daily-1:1", () => applyForward(daily, { kind: "clock", tsMs: SAT + 1_000 }));
  expect(dailyTried.latches?.daily).toEqual(dailyWindow);
  expect(dailyTried.incidents.some((line) => line === "latch_clear_mismatch")).toBe(true);
  expect(dailyTried.incidents.some((line) => line.startsWith("latch_cleared"))).toBe(false);
  expect(leaks(dailyTried, "daily:daily-1:1")).toBe(false);
});

test("cleared latch ids keep the last 20", () => {
  let book = boot();
  const ids: string[] = [];
  for (let i = 0; i < 21; i += 1) {
    const lossTs = SAT + i * 1_000 + 10;
    book = applyForward(book, realize(`cap-loss-${i}`, "C", "LOSS-USD", -1_600, lossTs, -1, 1_600));
    const id = book.latches?.book?.id ?? "";
    const tripAt = book.latches?.book?.tripAt;
    expect(id).toBe(`book-${tripAt}`);
    ids.push(id);
    const token = `book:${id}:${tripAt}`;
    book = withClear(token, () => applyForward(book, { kind: "clock", tsMs: lossTs + 1 }));
    expect(leaks(book, token)).toBe(false);
    expect(book.latches?.book).toBeUndefined();
    book = applyForward(book, realize(`cap-green-${i}`, "C", "GAIN-USD", 1_600, lossTs + 2, 1, 20));
    expect(book.latchRearm?.book).toBeUndefined();
  }
  expect(book.clearedLatchIds).toHaveLength(20);
  expect(book.clearedLatchIds).not.toContain(ids[0]);
  expect(book.clearedLatchIds).toContain(ids[20]);
  expect(book.latches?.daily?.tripAt).toBe(SAT + 10);
  expect(book.latches?.class?.C?.tripAt).toBe(SAT + 10);
});

test("after a clear, D is placed again only as a fresh 4h signal at the current price", () => {
  let book = applyForward(boot(), dOrder("d-old", "ETH-USD", SAT, 100, 90, 110));
  expect(book.working).toHaveLength(1);
  book = applyForward(book, realize("d-loss", "D", "LOSS-USD", -1_200, SAT + 1_000, -1, 1_200));
  expect(book.incidents).toContain("cancel_blocked d-old");
  expect(book.working).toHaveLength(0);
  expect(book.dEntryNotBeforeMs).toBe(SAT + FOUR_H);
  const tripAt = book.latches?.class?.D?.tripAt ?? 0;
  const latchId = book.latches?.class?.D?.id ?? "";
  const token = `class-D:${latchId}:${tripAt}`;
  book = withClear(token, () => applyForward(book, { kind: "clock", tsMs: SAT + 1_500 }));
  expect(leaks(book, token)).toBe(false);
  expect(book.latches?.class?.D).toBeUndefined();
  expect(book.latches?.daily).toBeDefined();
  expect(book.latches?.weekly).toBeDefined();
  expect(book.latches?.book).toBeUndefined();
  expect(book.dEntryNotBeforeMs).toBe(SAT + FOUR_H);
  expect(book.working).toHaveLength(0);

  book = applyForward(book, realize("d-green", "D", "GAIN-USD", 1_100, SAT + 2_000, 1, 20));
  expect(book.latchRearm?.class?.D).toBeUndefined();
  book = applyForward(book, dOrder("d-same-day", "ETH-USD", SAT + FOUR_H, 105, 95, 115));
  expect(book.working).toHaveLength(0);
  expect(book.rejected.at(-1)?.reason ?? "").toContain("halt");

  book = applyForward(book, { kind: "clock", tsMs: MON });
  expect(book.latches?.daily).toBeUndefined();
  expect(book.latches?.weekly).toBeUndefined();
  expect(book.latches?.class?.D).toBeUndefined();
  book = applyForward(book, dOrder("d-backfill", "ETH-USD", SAT, 100, 90, 110));
  expect(book.rejected.at(-1)).toEqual({ id: "d-backfill", reason: "d-fresh" });
  book = applyForward(book, { kind: "trade", productId: "ETH-USD", price: 99.98, size: 10_000, makerSide: "sell", tsMs: MON + 1_000 });
  expect(book.positions).toHaveLength(0);
  book = applyForward(book, dOrder("d-fresh-signal", "ETH-USD", MON, 110, 100, 120));
  expect(book.working).toHaveLength(1);
  expect(book.working[0]?.order.limit).toBe(110);
  expect(book.working[0]?.order.id).toBe("d-fresh-signal");
});

test("parity keeps the recomputed backtest and does not latch", () => {
  const config = { parity: { riskUsd: 20, sBtBps: 5 }, members: ["SOL-USD"] };
  let book = applyForward(boot(SAT - 60_000, config), dOrder("d-parity", "ETH-USD", SAT, 100, 90));
  expect(book.working).toHaveLength(1);
  book = applyForward(book, realize("p-loss", "C", "LOSS-USD", -1_200, SAT + 1_000, -1, 1_200));
  book = applyForward(book, realize("p-green", "C", "GAIN-USD", 1_100, SAT + 2_000, 1, 20));
  expect(book.latches).toBeUndefined();
  expect(book.dEntryNotBeforeMs).toBeUndefined();
  expect(book.working).toHaveLength(1);
  expect(classDollarBackstop(book.classes.C)).toBe(false);
  const opened = applyForward(book, x1("p-open", "E", "SOL-USD", SAT + 3_000));
  expect(opened.rejected.some((row) => row.id === "p-open")).toBe(false);
  expect(opened.positions.some((row) => row.id === "p-open")).toBe(true);
});

test("latch bytes are omitted when nothing is tripped and stay inside the hot budget when all are set", () => {
  const empty = startPaperHost(["BTC-USD"], {});
  const emptyHot = captureHot(empty) as unknown as Record<string, unknown>;
  expect("latches" in emptyHot).toBe(false);
  expect("clearedLatchIds" in emptyHot).toBe(false);
  expect("latchRearm" in emptyHot).toBe(false);
  expect("dEntryNotBeforeMs" in emptyHot).toBe(false);

  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => SAT;
  applyForward(host.book, { kind: "clock", tsMs: SAT });
  CLASSES.forEach((classId, index) => {
    applyForward(host.book, realize(`size-${classId}`, classId, `LOSS-${classId}`, -1_200, SAT + index, -1, 1_200));
  });
  const full = captureHot(host) as unknown as Record<string, unknown>;
  const slice: Record<string, unknown> = {};
  for (const key of ["latches", "clearedLatchIds", "latchRearm", "dEntryNotBeforeMs"]) {
    if (key in full) slice[key] = full[key];
  }
  const payload = Buffer.byteLength(JSON.stringify(slice));
  expect(payload).toBeGreaterThan(0);
  expect(payload).toBeLessThan(2_048);
  expect(hotBytes(host)).toBeLessThan(HOT_MAX_BYTES);
  expect(full.latches).toBeDefined();
});
