import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDOVER_MARGIN_MS } from "./relay";
import { applyPublic, startPaperHost } from "./paper-host";
import { JEV_CALL_MARGIN_MS } from "./jev-call";
import { JevTape, liquidityTier, scheduledPairs } from "./jev-minute";

const START = 1_700_000_040_000;

function book(bid = "100", ask = "101"): { bids: Map<string, number>; asks: Map<string, number> } {
  return { bids: new Map([[bid, 2], ["99", 1]]), asks: new Map([[ask, 2], ["102", 1]]) };
}

function fillFifteen(tape: JevTape, pair: string, skip = new Set<number>()): void {
  for (let i = 0; i < 15; i += 1) {
    const at = START + i * 60_000 + 1_000;
    if (skip.has(i)) continue;
    tape.heartbeat(at, [pair]);
    tape.onBook(pair, at + 1_000, book());
  }
  tape.heartbeat(START + 15 * 60_000, [pair]);
  tape.closeThrough(pair, START + 15 * 60_000);
}

test("a packet is the open pairs plus BTC, valid at 13 of 15 including slot 14", () => {
  expect(scheduledPairs(["ETH-USD", "ETH-USD"])).toEqual(["ETH-USD", "BTC-USD"]);
  expect(scheduledPairs(["BTC-USD"])).toEqual(["BTC-USD"]);
  expect(liquidityTier("BTC-USD")).toBe("btc");
  expect(liquidityTier("SOL-USD")).toBe("major");
  expect(liquidityTier("CRV-USD")).toBe("other");
  const tape = new JevTape();
  fillFifteen(tape, "ETH-USD");
  const full = tape.assess("ETH-USD", START);
  expect(full.ok).toBe(true);
  expect(full.minutes).toHaveLength(15);
  expect(full.minutes.every((row) => row.carried === false)).toBe(true);
  const dropped = new JevTape();
  dropped.heartbeat(START + 1_000, ["ETH-USD"]);
  dropped.onBook("ETH-USD", START + 2_000, book());
  dropped.feedDown(START + 60_000, ["ETH-USD"]);
  dropped.closeThrough("ETH-USD", START + 3 * 60_000);
  for (let i = 3; i < 15; i += 1) {
    const at = START + i * 60_000 + 1_000;
    dropped.heartbeat(at, ["ETH-USD"]);
    dropped.onBook("ETH-USD", at + 1_000, book());
  }
  dropped.closeThrough("ETH-USD", START + 15 * 60_000);
  expect(dropped.assess("ETH-USD", START).ok).toBe(true);
  const noSlot = new JevTape();
  for (let i = 0; i < 14; i += 1) {
    const at = START + i * 60_000 + 1_000;
    noSlot.heartbeat(at, ["ETH-USD"]);
    noSlot.onBook("ETH-USD", at + 1_000, book());
  }
  noSlot.feedDown(START + 14 * 60_000, ["ETH-USD"]);
  noSlot.closeThrough("ETH-USD", START + 15 * 60_000);
  const missed = noSlot.assess("ETH-USD", START);
  expect(missed.ok).toBe(false);
  expect(missed.sub).toBe("no_book_feed");
  const state = tape.marketState("ETH-USD", START + 15 * 60_000);
  expect(state?.position).toBe("flat");
  expect(state?.horizonSec).toBe(900);
  expect(state?.feeBps).toEqual({ maker: 0, taker: 0 });
});

test("the last mid carries for five quiet minutes and the sixth is absent", () => {
  const tape = new JevTape();
  const touch = (i: number) => {
    const at = START + i * 60_000 + 1_000;
    tape.heartbeat(at, ["ETH-USD"]);
    tape.onBook("ETH-USD", at + 1_000, book());
    tape.onTrade("ETH-USD", at + 2_000, 100.5, 2, "SELL");
    tape.onTrade("ETH-USD", at + 3_000, 100, 1, "BUY");
  };
  for (let i = 0; i < 9; i += 1) {
    touch(i);
    tape.closeThrough("ETH-USD", START + (i + 1) * 60_000);
  }
  for (let i = 9; i <= 14; i += 1) {
    tape.heartbeat(START + i * 60_000 + 1_000, ["ETH-USD"]);
    tape.closeThrough("ETH-USD", START + (i + 1) * 60_000);
  }
  const window = tape.assess("ETH-USD", START);
  const carried = window.minutes.filter((row) => row.carried);
  expect(carried).toHaveLength(5);
  expect(carried.every((row) => row.takerBuyUsd === 0 && row.takerSellUsd === 0 && row.trades === 0)).toBe(true);
  expect(window.minutes.some((row) => row.takerBuyUsd === 201 && row.takerSellUsd === 100)).toBe(true);
  expect(window.ok).toBe(false);
  expect(window.minutes.some((row) => row.ts === START + 14 * 60_000)).toBe(false);
  expect(window.sub).toBeUndefined();
});

test("a minute with a book but no trades feed is no_trades_feed, and a down feed is absent", () => {
  const trades = new JevTape();
  for (let i = 0; i < 15; i += 1) trades.onBook("ETH-USD", START + i * 60_000 + 1_000, book());
  trades.closeThrough("ETH-USD", START + 15 * 60_000);
  expect(trades.assess("ETH-USD", START).sub).toBe("no_trades_feed");
  const down = new JevTape();
  down.heartbeat(START + 1_000, ["ETH-USD"]);
  down.onBook("ETH-USD", START + 2_000, book());
  down.feedDown(START + 70_000, ["ETH-USD"]);
  down.closeThrough("ETH-USD", START + 180_000);
  const gap = down.assess("ETH-USD", START);
  expect(gap.ok).toBe(false);
  expect(gap.sub).toBe("no_book_feed");
  expect(gap.minutes.every((row) => row.ts < START + 60_000)).toBe(true);
});

test("restored minutes do not authorize a call", () => {
  const tape = new JevTape();
  fillFifteen(tape, "ETH-USD");
  const copy = new JevTape();
  copy.importMinutes(tape.exportMinutes().map((row) => ({ ...row, live: true })));
  expect(copy.assess("ETH-USD", START).ok).toBe(false);
  expect(copy.exportMinutes().every((row) => row.live === false)).toBe(true);
});

test("public frames build a minute and the call margin matches the handover margin", () => {
  expect(JEV_CALL_MARGIN_MS).toBe(HANDOVER_MARGIN_MS);
  const host = startPaperHost(["ETH-USD"], {});
  const later = START + 61_000;
  host.clock = () => later;
  applyPublic(host, 0, [
    { kind: "heartbeat" },
    { kind: "l2-snapshot", productId: "ETH-USD", bids: [["100", "5"], ["99", "4"]], asks: [["101", "1"], ["102", "1"]] },
    { kind: "trade", productId: "ETH-USD", price: 100.5, size: 2, side: "SELL" },
  ], START + 1_000);
  applyPublic(host, 0, [
    { kind: "heartbeat" },
    { kind: "l2-update", productId: "ETH-USD", side: "bid", price: "100", size: "5" },
  ], later);
  const window = host.jevTape.assess("ETH-USD", START);
  expect(window.minutes).toHaveLength(1);
  expect(window.minutes[0]?.takerBuyUsd).toBe(201);
  expect(window.minutes[0]?.trades).toBe(1);
  expect(window.minutes[0]?.carried).toBe(false);
  const raw = readFileSync(join(import.meta.dir, "paper-host.ts"), "utf8");
  const drive = raw.slice(raw.indexOf("export async function driveHost"));
  const send = drive.indexOf("sendDueEntries");
  const drain = drive.indexOf("drainJevShadow");
  expect(send).toBeGreaterThan(0);
  expect(drain).toBeGreaterThan(send);
  const vercel = JSON.parse(readFileSync(join(import.meta.dir, "../../../web/vercel.json"), "utf8")) as {
    functions: Record<string, { memory?: number }>;
  };
  expect(vercel.functions["src/app/api/engine/route.ts"]?.memory).toBeGreaterThanOrEqual(1024);
});
