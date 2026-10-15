import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FeatureAccumulator } from "../../../cb/features";
import { buildState } from "../../../cb/state";
import { parsePublicMessage, type PublicEvent } from "./feed";
import { JEV_CARRY_MAX, JEV_HORIZON_SEC, JEV_MIN_PRESENT, JEV_MINUTE_MS, JEV_SLOT_LAST, JevTape, bookView, returnBpsFromRing } from "./jev-minute";

interface FixtureMessage {
  at: number;
  msg: unknown;
}

test("a recorded websocket fixture matches cb/state.ts", () => {
  const fixture = JSON.parse(readFileSync(join(import.meta.dir, "fixtures/jev-ws-replay.json"), "utf8")) as {
    pair: string;
    messages: FixtureMessage[];
  };
  const pair = fixture.pair;
  const tape = new JevTape();
  const acc = new FeatureAccumulator();
  const book = { bids: new Map<string, number>(), asks: new Map<string, number>() };
  const ring: { ts: number; mid: number }[] = [];
  let lastView: ReturnType<typeof bookView> = null;
  let now = 0;
  const products = [pair];
  for (const row of fixture.messages) {
    now = row.at;
    const events: PublicEvent[] = parsePublicMessage(row.msg);
    for (const event of events) {
      if (event.kind === "heartbeat") {
        tape.heartbeat(now, products);
        continue;
      }
      if (event.kind === "trade") {
        if (event.side !== "BUY" && event.side !== "SELL") continue;
        const taker = event.side === "BUY" ? "sell" : "buy";
        acc.onTrade(now, event.size, taker);
        tape.onTrade(pair, now, event.price, event.size, event.side);
        continue;
      }
      if (event.kind === "l2-snapshot") {
        book.bids.clear();
        book.asks.clear();
        for (const [price, size] of event.bids) book.bids.set(price, Number(size));
        for (const [price, size] of event.asks) book.asks.set(price, Number(size));
      } else if (event.kind === "l2-update") {
        const side = event.side === "bid" ? book.bids : book.asks;
        const qty = Number(event.size);
        if (!(qty > 0)) side.delete(event.price);
        else side.set(event.price, qty);
      } else {
        continue;
      }
      const view = bookView(book);
      if (!view) continue;
      lastView = view;
      acc.onBook(now, view);
      const mid = view.mid();
      if (mid != null) ring.push({ ts: now, mid });
      tape.onBook(pair, now, book);
    }
  }
  tape.closeThrough(pair, now);
  const reference = buildState(
    {
      book: () => lastView ?? undefined,
      returnBps: (_id, sec, at) => returnBpsFromRing(ring, lastView?.mid() ?? null, sec, at ?? now),
      featureSnapshot: () => acc.snapshot(JEV_HORIZON_SEC),
    },
    pair,
    "flat",
    { horizonSec: JEV_HORIZON_SEC, makerFeeBps: 0, takerFeeBps: 0 },
    now,
  );
  expect(reference).not.toBeNull();
  expect(tape.marketState(pair, now)).toEqual(reference);
  const window = tape.assess(pair, 1_700_000_040_000);
  expect(window.minutes).toHaveLength(0);
  expect(window.sub).toBe("no_book_feed");
});

test("carry stays at five and a packet still needs 13 of 15 including slot 14", () => {
  expect(JEV_CARRY_MAX).toBe(5);
  expect(JEV_MIN_PRESENT).toBe(13);
  expect(JEV_SLOT_LAST).toBe(14);
  const start = 1_700_000_040_000;
  const levels = { bids: new Map([["100", 2]]), asks: new Map([["101", 1]]) };
  const quiet = new JevTape();
  for (let i = 0; i < 9; i += 1) {
    const at = start + i * JEV_MINUTE_MS + 1_000;
    quiet.heartbeat(at, ["ETH-USD"]);
    quiet.onBook("ETH-USD", at + 500, levels);
    quiet.onTrade("ETH-USD", at + 800, 100.5, 1, "SELL");
    quiet.closeThrough("ETH-USD", start + (i + 1) * JEV_MINUTE_MS);
  }
  for (let i = 9; i <= 14; i += 1) {
    quiet.heartbeat(start + i * JEV_MINUTE_MS + 1_000, ["ETH-USD"]);
    quiet.closeThrough("ETH-USD", start + (i + 1) * JEV_MINUTE_MS);
  }
  const carried = quiet.assess("ETH-USD", start);
  expect(carried.minutes.filter((row) => row.carried)).toHaveLength(5);
  expect(carried.minutes.some((row) => row.ts === start + 14 * JEV_MINUTE_MS)).toBe(false);

  const bare = new JevTape();
  bare.heartbeat(start + 1_000, ["ETH-USD"]);
  bare.onBook("ETH-USD", start + 2_000, levels);
  bare.onTrade("ETH-USD", start + 3_000, 100.5, 1, "SELL");
  bare.closeThrough("ETH-USD", start + JEV_MINUTE_MS);
  bare.closeThrough("ETH-USD", start + 2 * JEV_MINUTE_MS);
  const noBeat = bare.assess("ETH-USD", start);
  expect(noBeat.minutes.some((row) => row.ts === start + JEV_MINUTE_MS)).toBe(false);

  const held = new JevTape();
  held.heartbeat(start + 1_000, ["ETH-USD"]);
  held.onBook("ETH-USD", start + 2_000, levels);
  held.onTrade("ETH-USD", start + 3_000, 100.5, 1, "SELL");
  held.closeThrough("ETH-USD", start + JEV_MINUTE_MS);
  held.heartbeat(start + JEV_MINUTE_MS + 1_000, ["ETH-USD"]);
  held.closeThrough("ETH-USD", start + 2 * JEV_MINUTE_MS);
  expect(held.assess("ETH-USD", start).minutes.some((row) => row.ts === start + JEV_MINUTE_MS && row.carried)).toBe(true);

  const dozen = new JevTape();
  dozen.heartbeat(start + 3 * JEV_MINUTE_MS - 1_000, ["ETH-USD"]);
  dozen.onBook("ETH-USD", start + 3 * JEV_MINUTE_MS - 1_000, levels);
  for (let i = 3; i < 15; i += 1) {
    const at = start + i * JEV_MINUTE_MS + 1_000;
    dozen.heartbeat(at, ["ETH-USD"]);
    dozen.onBook("ETH-USD", at + 500, levels);
  }
  dozen.closeThrough("ETH-USD", start + 15 * JEV_MINUTE_MS);
  expect(dozen.assess("ETH-USD", start).ok).toBe(false);
  expect(dozen.assess("ETH-USD", start).minutes).toHaveLength(12);

  const noSlot = new JevTape();
  noSlot.heartbeat(start - 1_000, ["ETH-USD"]);
  noSlot.onBook("ETH-USD", start - 1_000, levels);
  for (let i = 0; i < 14; i += 1) {
    const at = start + i * JEV_MINUTE_MS + 1_000;
    noSlot.heartbeat(at, ["ETH-USD"]);
    noSlot.onBook("ETH-USD", at + 500, levels);
  }
  noSlot.feedDown(start + 14 * JEV_MINUTE_MS, ["ETH-USD"]);
  noSlot.closeThrough("ETH-USD", start + 15 * JEV_MINUTE_MS);
  const missed = noSlot.assess("ETH-USD", start);
  expect(missed.ok).toBe(false);
  expect(missed.minutes).toHaveLength(14);
  expect(missed.minutes.some((row) => row.ts === start + JEV_SLOT_LAST * JEV_MINUTE_MS)).toBe(false);
});

