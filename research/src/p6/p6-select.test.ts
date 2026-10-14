import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { selectInSample } from "../p5/stats";
import { applyForward, forwardSessionReport, freshBook } from "./engine";
import { generateForward } from "./generate";
import { kellyStatusBody, kellySupersedingBody } from "./kelly";
import { A_REGISTRATION, readForwardPick, scoreAnchoredIs, type ScoredTrade } from "./select";

const flags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };

function trade(book: string, netUsd: number, entryDate: string, exitDate: string, exitTs: number, windowMark = false): ScoredTrade {
  return { book, classId: "A", path: "base", entryDate, exitDate, exitTs, netUsd, windowMark };
}

test("R7 keeps the higher IS total when the lower-80% bounds tie, then registration order", () => {
  const rows = [
    { id: "A20-k2", l80: 1.004, total: 10 },
    { id: "A20-k2.5", l80: 1.001, total: 12.004 },
    { id: "A20-k3", l80: 2, total: 1 },
  ];
  expect(selectInSample(rows, (row) => row.l80, (row) => row.total).id).toBe("A20-k3");
  expect(selectInSample(rows.slice(0, 2), (row) => row.l80, (row) => row.total).id).toBe("A20-k2.5");
  expect(selectInSample(
    [{ id: "A20-k2", l80: 1, total: 5.004 }, { id: "A20-k2.5", l80: 1, total: 5.001 }],
    (row) => row.l80,
    (row) => row.total,
  ).id).toBe("A20-k2");
  expect(A_REGISTRATION.map((row) => row.id)[0]).toBe("A20-k2");
});

test("the anchored purge drops trades still open and counts them", () => {
  const trades = [
    trade("A20-k2", 10, "2025-11-11", "2025-11-20", Date.parse("2025-11-20T00:00:00.000Z") / 1000),
    trade("A20-k2", 500, "2026-10-01", "2026-10-09", Date.parse("2026-10-09T00:00:00.000Z") / 1000, true),
    trade("A20-k2", 500, "2026-09-01", "2026-10-10", Date.parse("2026-10-10T00:00:00.000Z") / 1000),
    trade("A55-k3", -1, "2025-11-11", "2025-11-20", Date.parse("2025-11-20T00:00:00.000Z") / 1000),
  ];
  const scored = scoreAnchoredIs(trades);
  const a20 = scored.configs.find((row) => row.config === "A20-k2")!;
  expect(a20.kept).toBe(1);
  expect(a20.purgedOpen).toBe(2);
  expect(a20.totalNetUsd).toBe(10);
  expect(scored.chosen.config).toBe("A20-k2");
});

test("the generator has no built-in A config", () => {
  const source = readFileSync(fileURLToPath(new URL("./generate.ts", import.meta.url)), "utf8");
  expect(source.includes("lookback ?? 20")).toBe(false);
  expect(source.includes("k ?? 2")).toBe(false);
  expect(source.includes("readForwardPick")).toBe(true);
  expect(() => readForwardPick(join(tmpdir(), "no-forward-pick"))).toThrow();
  const picked = generateForward({ bars: [], nowSec: 0, flags, pick: { lookback: 55, k: 3 } });
  expect(picked.entries).toEqual([]);
  const stamped = readForwardPick();
  expect(stamped.config).toBe("A55-k3");
  expect(stamped.lookback).toBe(55);
  expect(stamped.k).toBe(3);
  expect(stamped.stats).toHaveLength(6);
  expect(generateForward({ bars: [], nowSec: 1, flags }).entries).toEqual([]);
});

test("monthly re-selection is off by default and leaves an open position on its entry config", () => {
  const initial = { config: "A20-k2", lookback: 20 as const, k: 2, at: "2026-10-09", stats: [] };
  let calls = 0;
  const frozen = freshBook({
    members: ["ETH-USD"],
    aPick: initial,
    aReselect: () => {
      calls += 1;
      return { config: "A55-k3", lookback: 55, k: 3, at: "2026-11-01", stats: [] };
    },
  });
  applyForward(frozen, { kind: "clock", tsMs: Date.parse("2026-10-15T00:00:00.000Z") });
  applyForward(frozen, { kind: "clock", tsMs: Date.parse("2026-11-01T00:00:00.000Z") });
  expect(calls).toBe(0);
  expect(frozen.aPick?.config).toBe("A20-k2");

  const book = freshBook({
    members: ["ETH-USD"],
    monthlyASelect: true,
    aPick: initial,
    aReselect: () => ({
      config: "A55-k3",
      lookback: 55,
      k: 3,
      at: "2026-11-01",
      stats: [{ config: "A55-k3", l80NetUsdPerMonth: 1, totalNetUsd: 2, kept: 1, purgedOpen: 0 }],
    }),
  });
  const ts = Date.parse("2026-10-15T01:00:00.000Z");
  applyForward(book, { kind: "clock", tsMs: ts });
  applyForward(book, {
    kind: "x1",
    id: "open-a",
    classId: "A",
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
    aConfig: "A20-k2",
  });
  const open = book.positions.find((position) => position.id === "open-a");
  expect(open?.aConfig).toBe("A20-k2");
  const stop = open?.stop;
  applyForward(book, { kind: "clock", tsMs: Date.parse("2026-11-01T00:00:00.000Z") });
  expect(book.aPick?.config).toBe("A55-k3");
  expect(book.positions.find((position) => position.id === "open-a")?.aConfig).toBe("A20-k2");
  expect(book.positions.find((position) => position.id === "open-a")?.stop).toBe(stop);
  const next = Date.parse("2026-11-02T01:00:00.000Z");
  applyForward(book, {
    kind: "x1",
    id: "stale",
    classId: "A",
    productId: "SOL-USD",
    tsMs: next,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: next,
    sendTsMs: next,
    decisionMid: 100,
    aConfig: "A20-k2",
  });
  expect(book.rejected.some((row) => row.id === "stale" && row.reason === "a-config")).toBe(true);
  applyForward(book, {
    kind: "x1",
    id: "fresh",
    classId: "A",
    productId: "SOL-USD",
    tsMs: next,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: next,
    sendTsMs: next,
    decisionMid: 100,
    aConfig: "A55-k3",
  });
  expect(book.positions.find((position) => position.id === "fresh")?.aConfig).toBe("A55-k3");
  const report = forwardSessionReport(book, null);
  expect(report.aPicks.map((row) => `${row.reason} ${row.config}`)).toEqual(["forward-bar-1 A20-k2", "month A55-k3"]);
  expect(report.aPicks[1]?.stats[0]?.l80NetUsdPerMonth).toBe(1);
});

test("the superseding Kelly label does not restate the registered $60", () => {
  expect(kellyStatusBody().registeredRiskUsd).toBe(60);
  expect("registeredRiskUsd" in kellySupersedingBody()).toBe(false);
  expect(kellySupersedingBody().unpromotedRiskUsd).toBe(20);
  expect(kellySupersedingBody().supersedesSha256).toBe("162131821d358c2caf8faf21ebe58005dee875a8e7d7023b33c8324bcea584ba");
});
