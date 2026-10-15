import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FeatureAccumulator } from "../../../cb/features";
import { buildState } from "../../../cb/state";
import { parsePublicMessage, type PublicEvent } from "./feed";
import { JEV_HORIZON_SEC, JevTape, bookView, returnBpsFromRing } from "./jev-minute";

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
  const minute = START_MINUTE(tape, pair);
  expect(minute.takerBuyUsd).toBe(201);
  expect(minute.takerSellUsd).toBe(100);
  expect(minute.trades).toBe(2);
  expect(minute.carried).toBe(false);
  expect(minute.imbalance5).toBeCloseTo(0.5, 8);
});

function START_MINUTE(tape: JevTape, pair: string): { takerBuyUsd: number; takerSellUsd: number; trades: number; carried: boolean; imbalance5: number } {
  const window = tape.assess(pair, 1_700_000_040_000);
  const row = window.minutes[0];
  if (!row) throw new Error("fixture minute missing");
  return row;
}
