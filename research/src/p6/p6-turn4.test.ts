import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { classATrigger, classBScore, type DailyBar } from "../p3/classes";
import { x1FillPrice } from "../p3/design-rules";
import { isMondayCloseBar, x1EntryTs } from "../p5/run";
import { applyForward, freshBook } from "./engine";
import { AMENDMENT_2B_RULE, amendment2bApprovalBody, amendment2bBody } from "./amendment2b";
import { entriesToEvents, generateEntries, quoteAt, type FifteenBar } from "./generate";
import { halfSpreadBps } from "./mid-feed";
import { P6_STAMP_COMMANDS, stampP6Record } from "./stamp-records";

const wednesday = Date.parse("2026-03-04T00:00:00.000Z");

function enter(book: ReturnType<typeof freshBook>, id: string, productId: string, tsMs: number, nextOpen = 100, stop = 99.5): void {
  applyForward(book, {
    kind: "x1",
    id,
    classId: "A",
    productId,
    tsMs,
    nextOpen,
    stop,
    atr1h: 0.2,
    bid: nextOpen,
    ask: nextOpen * 1.002,
    bookTsMs: tsMs,
    sendTsMs: tsMs,
    decisionMid: nextOpen,
  });
}

test("the $500 backstop latches one pair, logs the trip, and re-arms on re-enable", () => {
  const book = freshBook({ members: ["ETH-USD", "SOL-USD"] });
  applyForward(book, { kind: "clock", tsMs: wednesday });
  applyForward(book, {
    kind: "realize",
    id: "cushion",
    classId: "C",
    productId: "BTC-USD",
    netR: 1,
    netUsd: 2_000,
    riskUsd: 20,
    entryDate: "2026-03-04",
    exitTs: wednesday,
  });
  applyForward(book, {
    kind: "realize",
    id: "eth-loss",
    classId: "A",
    productId: "ETH-USD",
    netR: -1,
    netUsd: -500,
    riskUsd: 500,
    entryDate: "2026-03-04",
    exitTs: wednesday,
  });
  const trip = book.pairs["ETH-USD"];
  expect(trip?.latched).toBe(true);
  expect(trip?.log[0]).toEqual({ kind: "trip", tsMs: wednesday, realizedUsd: -500, markedUsd: 0, cumulativeUsd: -500 });
  enter(book, "sol", "SOL-USD", wednesday + 2_000);
  expect(book.positions.some((position) => position.productId === "SOL-USD")).toBe(true);
  enter(book, "eth-again", "ETH-USD", wednesday + 3_000);
  expect(book.rejected.some((row) => row.id === "eth-again" && row.reason === "pair-backstop")).toBe(true);

  applyForward(book, {
    kind: "realize",
    id: "eth-back",
    classId: "A",
    productId: "ETH-USD",
    netR: 1,
    netUsd: 800,
    riskUsd: 500,
    entryDate: "2026-03-06",
    exitTs: wednesday + 2 * 86_400_000,
  });
  expect(book.pairs["ETH-USD"]?.latched).toBe(true);
  enter(book, "eth-recovered", "ETH-USD", wednesday + 3 * 86_400_000);
  expect(book.rejected.some((row) => row.id === "eth-recovered" && row.reason === "pair-backstop")).toBe(true);

  applyForward(book, { kind: "pair-enable", productId: "ETH-USD", tsMs: wednesday + 3 * 86_400_000, who: "Brian", why: "re-enable after review" });
  const enabled = book.pairs["ETH-USD"];
  expect(enabled?.latched).toBe(false);
  expect(enabled?.baselineUsd).toBe(300);
  expect(enabled?.log[1]).toMatchObject({ kind: "reenable", tsMs: wednesday + 3 * 86_400_000, realizedUsd: 300, markedUsd: 0, cumulativeUsd: 300, who: "Brian", why: "re-enable after review" });
  enter(book, "eth-ok", "ETH-USD", wednesday + 3 * 86_400_000 + 1_000);
  expect(book.positions.some((position) => position.id === "eth-ok")).toBe(true);

  applyForward(book, {
    kind: "realize",
    id: "eth-again-loss",
    classId: "B",
    productId: "ETH-USD",
    netR: -1,
    netUsd: -800,
    riskUsd: 500,
    entryDate: "2026-03-08",
    exitTs: wednesday + 4 * 86_400_000,
  });
  expect(book.pairs["ETH-USD"]?.latched).toBe(true);
  expect(book.pairs["ETH-USD"]?.log.at(-1)?.kind).toBe("trip");
  expect(book.pairs["ETH-USD"]?.log.at(-1)?.cumulativeUsd).toBeLessThanOrEqual(-200);
  expect(book.positions.some((position) => position.id === "eth-ok")).toBe(true);
  expect(book.positions.some((position) => position.id === "sol")).toBe(true);
});

test("a re-enable needs a note and a latched pair", () => {
  const book = freshBook({ members: ["ETH-USD"] });
  applyForward(book, { kind: "clock", tsMs: wednesday });
  applyForward(book, { kind: "pair-enable", productId: "ETH-USD", tsMs: wednesday, who: "Brian", why: "not latched yet" });
  expect(book.rejected.some((row) => row.reason === "not-latched")).toBe(true);
  expect(book.pairs["ETH-USD"]?.baselineUsd ?? 0).toBe(0);
  applyForward(book, {
    kind: "realize",
    id: "cushion",
    classId: "C",
    productId: "BTC-USD",
    netR: 1,
    netUsd: 2_000,
    riskUsd: 20,
    entryDate: "2026-03-04",
    exitTs: wednesday,
  });
  applyForward(book, {
    kind: "realize",
    id: "eth-loss",
    classId: "A",
    productId: "ETH-USD",
    netR: -1,
    netUsd: -500,
    riskUsd: 500,
    entryDate: "2026-03-04",
    exitTs: wednesday,
  });
  applyForward(book, { kind: "pair-enable", productId: "ETH-USD", tsMs: wednesday + 1_000, who: " ", why: " " });
  expect(book.pairs["ETH-USD"]?.latched).toBe(true);
  expect(book.rejected.some((row) => row.reason === "reenable-note")).toBe(true);
});

test("parity mode keeps B at $60 after a rolling-20 breach and a 10R pause", () => {
  const book = freshBook({ members: ["ETH-USD"], parity: { riskUsd: 60, sBtBps: 5 } });
  applyForward(book, { kind: "clock", tsMs: wednesday });
  for (let i = 0; i < 20; i += 1) {
    applyForward(book, {
      kind: "realize",
      id: `loss-${i}`,
      classId: "B",
      productId: "BTC-USD",
      netR: -0.3,
      netUsd: -18,
      riskUsd: 60,
      entryDate: "2026-03-04",
      exitTs: wednesday + i,
    });
  }
  applyForward(book, {
    kind: "x1",
    id: "b-week",
    classId: "B",
    productId: "ETH-USD",
    tsMs: wednesday + 86_400_000,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: wednesday + 86_400_000,
    sendTsMs: wednesday + 86_400_000,
    decisionMid: 100,
    dailyAtr: 4,
  });
  expect(book.rejected.find((row) => row.id === "b-week")).toBeUndefined();
  expect(book.positions.find((position) => position.id === "b-week")?.riskUsd).toBe(60);
});

test("an open pair runs to its stop after the latch", () => {
  const book = freshBook({ members: ["ETH-USD", "SOL-USD", "BTC-USD"] });
  applyForward(book, { kind: "clock", tsMs: wednesday });
  applyForward(book, {
    kind: "realize",
    id: "cushion",
    classId: "C",
    productId: "BTC-USD",
    netR: 1,
    netUsd: 2_000,
    riskUsd: 20,
    entryDate: "2026-03-04",
    exitTs: wednesday,
  });
  enter(book, "eth", "ETH-USD", wednesday, 100, 99.5);
  expect(book.positions).toHaveLength(1);
  applyForward(book, { kind: "mark", productId: "ETH-USD", price: 20 });
  expect(book.pairs["ETH-USD"]?.latched).toBe(true);
  expect(book.positions).toHaveLength(1);
  expect(book.pairs["ETH-USD"]?.log[0]?.markedUsd).toBeLessThan(0);
  expect(book.pairs["ETH-USD"]?.log[0]?.realizedUsd).toBe(0);
  enter(book, "sol", "SOL-USD", wednesday + 1_000, 10, 9);
  expect(book.positions.some((position) => position.id === "sol")).toBe(true);
  const start = Math.floor(wednesday / 1000);
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: start, nowSec: start + 900, open: 100, high: 101, low: 90, close: 95 });
  expect(book.closed.some((trade) => trade.id === "eth" && trade.exitKind === "stop")).toBe(true);
  expect(book.pairs["ETH-USD"]?.latched).toBe(true);
});

test("C and E time exits wait for the first open at or after expiry", () => {
  const start = Math.floor(wednesday / 1000);
  const book = freshBook({ members: ["ETH-USD"] });
  applyForward(book, { kind: "clock", tsMs: wednesday });
  applyForward(book, {
    kind: "x1",
    id: "e",
    classId: "E",
    productId: "ETH-USD",
    tsMs: wednesday,
    nextOpen: 100,
    stop: 50,
    atr1h: 1,
    bid: 100,
    ask: 100.02,
    bookTsMs: wednesday,
    sendTsMs: wednesday,
    decisionMid: 100,
    target: 1_000,
  });
  const early = start + 24 * 3_600 - 900;
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: early, nowSec: early + 900, open: 100, high: 101, low: 99, close: 100 });
  expect(book.positions).toHaveLength(1);
  const due = early + 900;
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: due, nowSec: due + 900, open: 101, high: 102, low: 100, close: 101 });
  expect(book.closed[0]?.exitKind).toBe("time");
  expect(book.closed[0]?.exitTs).toBe(due * 1000);
  expect(book.legs.find((leg) => leg.side === "exit")!.fillPrice).toBeLessThan(101);

  const swing = freshBook({ members: ["ETH-USD"] });
  applyForward(swing, { kind: "clock", tsMs: wednesday });
  applyForward(swing, {
    kind: "x1",
    id: "c",
    classId: "C",
    productId: "ETH-USD",
    tsMs: wednesday,
    nextOpen: 100,
    stop: 50,
    atr1h: 1,
    bid: 100,
    ask: 100.02,
    bookTsMs: wednesday,
    sendTsMs: wednesday,
    decisionMid: 100,
  });
  const cEarly = start + 72 * 3_600 - 900;
  applyForward(swing, { kind: "bar15", productId: "ETH-USD", startSec: cEarly, nowSec: cEarly + 900, open: 100, high: 101, low: 99, close: 100 });
  expect(swing.positions).toHaveLength(1);
  const cDue = cEarly + 900;
  applyForward(swing, { kind: "bar15", productId: "ETH-USD", startSec: cDue, nowSec: cDue + 900, open: 102, high: 103, low: 101, close: 102 });
  expect(swing.closed[0]?.exitKind).toBe("time");
  expect(swing.closed[0]?.exitTs).toBe(cDue * 1000);
});

test("the A trail moves only on the UTC day-close bar", () => {
  const start = Math.floor(wednesday / 1000);
  const book = freshBook({ members: ["ETH-USD"] });
  applyForward(book, { kind: "clock", tsMs: wednesday });
  enter(book, "a", "ETH-USD", wednesday, 100, 90);
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: start, nowSec: start + 900, open: 100, high: 130, low: 99, close: 120, dailyAtr: 2 });
  expect(book.positions[0]?.stop).toBe(90);
  const dayClose = start + 86_400 - 900;
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: dayClose, nowSec: dayClose + 900, open: 120, high: 121, low: 119, close: 120, dailyAtr: 2 });
  expect(book.positions[0]?.highestClose).toBe(120);
  expect(book.positions[0]?.stop).toBeCloseTo(114, 6);
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: dayClose + 900, nowSec: dayClose + 1_800, open: 140, high: 141, low: 139, close: 140, dailyAtr: 1 });
  expect(book.positions[0]?.stop).toBeCloseTo(114, 6);
});

test("a throwaway worktree cannot write through the guarded writer", () => {
  const dir = mkdtempSync(join(tmpdir(), "p6-wt-"));
  execFileSync("git", ["init"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "p6@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "p6"], { cwd: dir });
  writeFileSync(join(dir, "note.txt"), "x\n");
  execFileSync("git", ["add", "note.txt"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir });
  expect(() => stampP6Record("p6-stamp-amendment-2b", dir)).toThrow(/dirty|manifest|repo root|overwrite|frozen|git/);
  expect(P6_STAMP_COMMANDS).toContain("p6-stamp-amendment-2");
  expect(P6_STAMP_COMMANDS).toContain("p6-stamp-kelly-status");
  expect(() => stampP6Record("p6-stamp-amendment-2")).toThrow(/refusing to overwrite/);
  expect(() => stampP6Record("p6-stamp-kelly-ruling")).toThrow(/refusing to overwrite/);
  expect(() => stampP6Record("p6-stamp-amendment-2b")).toThrow(/refusing to overwrite/);
  expect(() => stampP6Record("p6-stamp-amendment-2b-approval")).toThrow(/refusing to overwrite/);
  expect(() => stampP6Record("p6-stamp-forward-a")).toThrow(/refusing to overwrite/);
  expect(() => stampP6Record("p6-stamp-kelly-superseding")).toThrow(/refusing to overwrite/);
  expect(() => stampP6Record("p6-stamp-kelly-ruling-superseded")).toThrow(/refusing to overwrite/);
  expect(() => stampP6Record("p6-stamp-jev-spend" as "p6-stamp-amendment-2")).toThrow();
});

test("amendment 2b cites the frozen parents and the approval is of the wording", () => {
  const body = amendment2bBody();
  expect(body.rule).toBe(AMENDMENT_2B_RULE);
  expect(body.registrationSha256.startsWith("f4f76573")).toBe(true);
  expect(body.amendment1Sha256.startsWith("e0948e26")).toBe(true);
  expect(body.amendment2Sha256.startsWith("bfa6efb2")).toBe(true);
  expect(body.amendment2aSha256.startsWith("99cab898")).toBe(true);
  expect(body.registrationEdited).toBe(false);
  const approval = amendment2bApprovalBody();
  expect(approval.approvedBy).toBe("Brian");
  expect(approval.approvedAt).toBe("2026-10-12T02:24:00Z");
  expect(approval.approvalOf).toBe("wording");
  expect(approval.bindsToFileHash).toBe(false);
  expect(approval.rule).toBe(AMENDMENT_2B_RULE);
  expect(JSON.stringify(approval).includes("amendment2bSha")).toBe(false);
  for (const name of ["p6-amendment-2b", "p6-amendment-2b-approval"] as const) {
    const raw = readFileSync(fileURLToPath(new URL(`../../data/reports/${name}.json`, import.meta.url)));
    const hash = createHash("sha256").update(raw).digest("hex");
    const side = readFileSync(fileURLToPath(new URL(`../../data/reports/${name}.sha256`, import.meta.url)), "utf8");
    expect(side).toBe(`${hash}  research/data/reports/${name}.json\n`);
    const filed = JSON.parse(raw.toString()) as { rule: string };
    expect(filed.rule).toBe(AMENDMENT_2B_RULE);
  }
  const filedApproval = JSON.parse(readFileSync(fileURLToPath(new URL("../../data/reports/p6-amendment-2b-approval.json", import.meta.url)), "utf8")) as {
    approvedBy: string;
    approvedAt: string;
    approvalOf: string;
    bindsToFileHash: boolean;
  };
  expect(filedApproval.approvedBy).toBe("Brian");
  expect(filedApproval.approvedAt).toBe("2026-10-12T02:24:00Z");
  expect(filedApproval.approvalOf).toBe("wording");
  expect(filedApproval.bindsToFileHash).toBe(false);
  expect(JSON.stringify(filedApproval).includes("amendment2bSha")).toBe(false);
});

function dayGrid(productId: string, date: string, close: number, volume = 10): FifteenBar[] {
  const open = Date.parse(`${date}T00:00:00.000Z`) / 1000;
  const bars: FifteenBar[] = [];
  for (let step = 0; step < 96; step += 1) {
    bars.push({
      productId,
      startSec: open + step * 900,
      open: close,
      high: close + 1,
      low: close - 1,
      close,
      volume,
    });
  }
  return bars;
}

test("completed 15m bars produce the expected A and B event stream", () => {
  const dates: string[] = [];
  for (let day = Date.parse("2025-12-01T00:00:00.000Z"); day <= Date.parse("2026-03-20T00:00:00.000Z"); day += 86_400_000) {
    dates.push(new Date(day).toISOString().slice(0, 10));
  }
  const bars: FifteenBar[] = [];
  const daily: DailyBar[] = [];
  for (const date of dates) {
    const rising = date >= "2026-02-10" && date <= "2026-03-16";
    const close = rising ? 100 + (Date.parse(`${date}T00:00:00.000Z`) - Date.parse("2026-02-10T00:00:00.000Z")) / 86_400_000 : 100;
    bars.push(...dayGrid("SYN-USD", date, close));
    daily.push({ date, high: close + 1, low: close - 1, close, volume: 10 * 96 });
  }
  const nowSec = Date.parse("2026-03-21T00:00:00.000Z") / 1000;
  const flags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };
  const entries = generateEntries({ bars, nowSec, flags, young: () => true, lookback: 20, k: 2 });
  const expectedA = daily.flatMap((bar, index) => (classATrigger(daily, index, 20, true) ? [x1EntryTs(bar.date) * 1000] : []));
  const aGot = entries.filter((entry) => entry.classId === "A").map((entry) => entry.tsMs);
  expect(aGot).toEqual(expectedA.filter((ts) => ts < nowSec * 1000));
  const sundays = daily.filter((bar, index) => isMondayCloseBar(bar.date) && classBScore(daily.map((row) => row.close), index) != null);
  const bDates = sundays
    .filter((bar, _index, all) => {
      const index = daily.findIndex((row) => row.date === bar.date);
      const score = classBScore(daily.map((row) => row.close), index);
      return score != null && score > 0;
    })
    .map((bar) => bar.date);
  const bGot = entries.filter((entry) => entry.classId === "B");
  expect(bGot.map((entry) => entry.signalDate)).toEqual(bDates);
  for (const entry of bGot) {
    expect(entry.tsMs).toBe(x1EntryTs(entry.signalDate) * 1000);
    expect(new Date(entry.tsMs).toISOString().slice(11, 19)).toBe("01:00:00");
    expect(new Date(entry.tsMs).getUTCDay()).toBe(1);
  }
  expect(bGot.length).toBeGreaterThan(0);
  expect(aGot.length).toBeGreaterThan(0);
  const stream = entries.map((entry) => `${entry.classId} ${entry.kind} ${new Date(entry.tsMs).toISOString()} ${entry.productId}`);
  expect(stream.slice(0, 3)).toEqual([
    "A x1 2026-02-12T01:00:00.000Z SYN-USD",
    "A x1 2026-02-13T01:00:00.000Z SYN-USD",
    "A x1 2026-02-14T01:00:00.000Z SYN-USD",
  ]);
  expect(stream).toContain("B x1 2026-03-02T01:00:00.000Z SYN-USD");
  expect(entries.find((entry) => entry.classId === "A")?.aConfig).toBe("A20-k2");
  const quote = quoteAt(100);
  expect(halfSpreadBps(quote.bid, quote.ask)).toBeCloseTo(5, 8);
  const book = freshBook({
    members: ["SYN-USD"],
    aPick: { config: "A20-k2", lookback: 20, k: 2, at: "2026-02-11", stats: [] },
  });
  const first = entriesToEvents(entries.filter((entry) => entry.classId === "A").slice(0, 1))[0];
  if (first && first.kind === "x1") {
    applyForward(book, { kind: "clock", tsMs: first.tsMs });
    applyForward(book, first);
    expect(book.positions[0]?.classId).toBe("A");
    expect(book.positions[0]?.aConfig).toBe("A20-k2");
    expect(book.positions[0]?.fillPrice).toBeCloseTo(x1FillPrice(first.nextOpen, "buy", halfSpreadBps(first.bid, first.ask)!), 8);
  }
});

test("a completed crash path emits the class C entry at the next 4h close", () => {
  const start = Date.parse("2026-01-01T00:00:00.000Z") / 1000;
  const bars: FifteenBar[] = [];
  for (let i = 0; i < 40; i += 1) {
    const day = start + i * 86_400;
    for (let step = 0; step < 96; step += 1) {
      const ts = day + step * 900;
      let open = 100;
      let high = 104;
      let low = 96;
      let close = 100;
      let volume = 10;
      if (i === 35) {
        const block = Math.floor(step / 16);
        if (block === 2) {
          open = 100;
          high = 97;
          low = 96;
          close = 96.5;
          volume = 80;
        } else if (step >= 80) {
          open = 97;
          high = 98;
          low = 96.2;
          close = 96.4;
          volume = 80;
        } else {
          open = 120;
          high = 130;
          low = 110;
          close = 120;
          volume = 80;
        }
      }
      if (i === 36 && step < 16) {
        open = 99;
        high = 102;
        low = 98;
        close = 100;
        volume = 10;
      }
      bars.push({ productId: "SYN-USD", startSec: ts, open, high, low, close, volume });
    }
  }
  const entries = generateEntries({
    bars,
    nowSec: start + 40 * 86_400,
    flags: { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false },
    young: () => true,
    lookback: 20,
    k: 2,
  }).filter((entry) => entry.classId === "C");
  expect(entries.map((entry) => `${entry.classId} ${entry.kind} ${new Date(entry.tsMs).toISOString()} ${entry.nextOpen} ${entry.stop} ${entry.target}`)).toEqual([
    "C x1 2026-02-06T04:00:00.000Z 100 93.53571428571429 117",
  ]);
  const event = entriesToEvents(entries)[0];
  const book = freshBook({ members: ["SYN-USD"] });
  if (event?.kind === "x1") {
    applyForward(book, { kind: "clock", tsMs: event.tsMs });
    applyForward(book, event);
    expect(book.positions[0]?.classId).toBe("C");
    expect(book.positions[0]?.target).toBe(117);
  }
});

test("a completed 1h shock emits the class E entry on the 15m close", () => {
  const bars: FifteenBar[] = [];
  for (let i = 0; i < 30; i += 1) {
    const ts = i * 3600;
    const shock = i === 25;
    for (let q = 0; q < 4; q += 1) {
      bars.push({
        productId: "SYN-USD",
        startSec: ts + q * 900,
        open: 100,
        high: shock ? 130 : 100.2,
        low: shock ? 96 : 99.8,
        close: shock ? 97 : 100,
        volume: shock ? 25 : 0.25,
      });
    }
  }
  const base = 25 * 3600;
  const quarter = [
    { ts: base + 3600, open: 97, high: 101, low: 96, close: 100, volume: 5 },
    { ts: base + 4500, open: 100, high: 100.5, low: 96, close: 99, volume: 5 },
    { ts: base + 5400, open: 99, high: 104, low: 99, close: 103, volume: 5 },
  ];
  for (const bar of quarter) {
    const index = bars.findIndex((row) => row.startSec === bar.ts);
    if (index >= 0) bars[index] = { productId: "SYN-USD", startSec: bar.ts, ...bar };
  }
  const entries = generateEntries({
    bars,
    nowSec: 30 * 3600,
    flags: { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false },
    young: () => true,
    lookback: 20,
    k: 2,
  });
  expect(entries.map((entry) => `${entry.classId} ${entry.kind} ${new Date(entry.tsMs).toISOString()} ${entry.nextOpen} ${entry.stop}`)).toEqual([
    "E x1 1970-01-02T02:30:00.000Z 103 95.44",
  ]);
  const event = entriesToEvents(entries)[0];
  const book = freshBook({ members: ["SYN-USD"] });
  if (event?.kind === "x1") {
    applyForward(book, { kind: "clock", tsMs: event.tsMs });
    applyForward(book, event);
    expect(book.positions[0]?.classId).toBe("E");
  }
});

test("completed 15m bars emit the class D limit at the 4h decision", () => {
  const origin = Date.parse("2024-01-01T00:00:00.000Z") / 1000;
  const bars: FifteenBar[] = [];
  for (let day = 0; day < 260; day += 1) {
    for (let slot = 0; slot < 6; slot += 1) {
      const ts = origin + (day * 6 + slot) * 14_400;
      const accel = day > 200 ? (day - 200) * 0.08 : 0;
      const close = 100 + day * 0.02 + accel + Math.sin(slot / 1.5) * 0.8;
      for (let q = 0; q < 16; q += 1) {
        bars.push({
          productId: "SYN-USD",
          startSec: ts + q * 900,
          open: q === 0 ? close - 0.2 : close,
          high: close + 0.4,
          low: close - 1.5,
          close,
          volume: 20 / 16,
        });
      }
    }
  }
  const entries = generateEntries({
    bars,
    nowSec: origin + 270 * 86_400,
    flags: { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false },
    young: () => false,
    lookback: 20,
    k: 2,
  }).filter((entry) => entry.classId === "D");
  expect(entries.length).toBe(179);
  expect(entries.slice(0, 3).map((entry) => `${entry.kind} ${new Date(entry.tsMs).toISOString()} ${entry.nextOpen} ${entry.stop} ${entry.target}`)).toEqual([
    "d-order 2024-07-19T12:00:00.000Z 104.77755032109064 101.89928467742158 116.29061289576691",
    "d-order 2024-07-19T16:00:00.000Z 104.72743794146055 101.85119127233926 116.2324246179457",
    "d-order 2024-07-20T12:00:00.000Z 104.87755032109064 101.99928467742157 116.3906128957669",
  ]);
  const event = entriesToEvents(entries.slice(0, 1))[0];
  const book = freshBook({ members: ["SYN-USD"] });
  if (event?.kind === "d-order") {
    applyForward(book, { kind: "clock", tsMs: event.placedTs });
    applyForward(book, event);
    expect(book.working[0]?.classId).toBe("D");
    expect(book.working[0]?.order.limit).toBeCloseTo(104.77755032109064, 8);
  }
});
