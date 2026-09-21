import { test, expect, beforeAll, afterAll } from "bun:test";
import { PairBook, type TradePrint } from "./feed";
import { PaperBroker, crosses, makerFillSize, type FeedLike } from "./paper";
import { Store } from "./db/store";
import { config } from "./config";

test("crosses: a resting bid is hit by a taker sell at or below its price", () => {
  const bid: TradePrint = { ts: 0, price: 100, size: 1, takerSide: "sell" };
  expect(crosses("buy", 100, bid)).toBe(true); // taker sold at 100, our bid at 100 is hit
  expect(crosses("buy", 99, bid)).toBe(false); // taker sold at 100, above our 99 bid: no fill
  expect(crosses("buy", 100, { ...bid, price: 101 })).toBe(false); // taker sold above our bid
  expect(crosses("buy", 100, { ...bid, takerSide: "buy" })).toBe(false); // wrong aggressor side
});

test("crosses: a resting ask is hit by a taker buy at or above its price", () => {
  const buy: TradePrint = { ts: 0, price: 100, size: 1, takerSide: "buy" };
  expect(crosses("sell", 100, buy)).toBe(true);
  expect(crosses("sell", 100, { ...buy, price: 99 })).toBe(false);
});

test("makerFillSize applies the haircut and caps at the remaining size", () => {
  expect(makerFillSize(10, 4, 0.5)).toBe(2); // 4 * 0.5
  expect(makerFillSize(1, 4, 0.5)).toBe(1); // capped at remaining
});

// A scripted end-to-end sequence against a fake feed, persisting to Postgres.
const store = new Store(config.databaseUrl);
const runId = `test-${crypto.randomUUID()}`;
const pair = "PAPER-USD";

class FakeFeed implements FeedLike {
  private b = new PairBook();
  private prints: TradePrint[] = [];
  constructor() {
    this.b.set("bid", 100, 50);
    this.b.set("offer", 100.1, 50);
  }
  book(): PairBook {
    return this.b;
  }
  drainPrints(): TradePrint[] {
    const out = this.prints;
    this.prints = [];
    return out;
  }
  push(p: TradePrint): void {
    this.prints.push(p);
  }
}

beforeAll(async () => {
  await store.init();
  await store.insertRun({ id: runId, mode: "paper", model: "mock", pairs: pair, config: {}, git_sha: null, started_at: Date.now() });
});

afterAll(async () => {
  await store.sql`DELETE FROM fills WHERE run_id = ${runId}`;
  await store.sql`DELETE FROM orders WHERE run_id = ${runId}`;
  await store.sql`DELETE FROM snapshots WHERE run_id = ${runId}`;
  await store.sql`DELETE FROM runs WHERE id = ${runId}`;
  await store.close();
});

test("entry maker fill takes a haircut of a crossing print and records a fee-inclusive fill", async () => {
  const feed = new FakeFeed();
  const broker = new PaperBroker(
    [pair],
    feed,
    store,
    runId,
    { notionalUsd: 1000, makerFeeBps: 50, takerFeeBps: 90, fillHaircut: 0.5, entryTimeoutSec: 120, repriceTicks: 2, horizonSec: 14400, bankrollUsd: 10000 },
  );

  await (broker as any).place(pair, "buy", "entry", null); // await placement (onIntent fires this async)
  // Order rests at best bid 100 with ~10 base (1000 / 100). Print a taker sell of 4 that crosses.
  const t = Date.now() + 2_000;
  feed.push({ ts: t, price: 99.9, size: 4, takerSide: "sell" });
  await (broker as any).processOrder(pair, t);

  const fills = await store.sql<{ side: string; size_base: number; fee_usd: number; cost_basis_usd: number; liquidity: string }[]>`SELECT side, size_base, fee_usd, cost_basis_usd, liquidity FROM fills WHERE run_id = ${runId}`;
  expect(fills.length).toBe(1);
  expect(Number(fills[0]!.size_base)).toBeCloseTo(2, 9); // 4 * 0.5 haircut
  expect(fills[0]!.liquidity).toBe("maker");
  const notional = 2 * 100;
  expect(Number(fills[0]!.fee_usd)).toBeCloseTo((notional * 50) / 10_000, 9); // 0.5% maker
  expect(Number(fills[0]!.cost_basis_usd)).toBeCloseTo(notional + (notional * 50) / 10_000, 9);
  expect(broker.state(pair).position).toBe("long");
});

test("unfilled entry converts to taker after the timeout, walking the book for slippage", async () => {
  const feed = new FakeFeed();
  const broker = new PaperBroker(
    [pair],
    feed,
    store,
    runId,
    { notionalUsd: 1000, makerFeeBps: 50, takerFeeBps: 90, fillHaircut: 0.5, entryTimeoutSec: 1, repriceTicks: 999, horizonSec: 14400, bankrollUsd: 10000 },
  );
  const t0 = Date.now();
  await (broker as any).place(pair, "buy", "entry", null); // await placement (onIntent fires this async)
  // No crossing prints; advance past the 1s timeout so it must taker-convert.
  await (broker as any).processOrder(pair, t0 + 2_000);

  const taker = await store.sql<{ price: number }[]>`SELECT price FROM fills WHERE run_id = ${runId} AND liquidity = 'taker' ORDER BY recorded_at DESC LIMIT 1`;
  expect(taker.length).toBe(1);
  expect(Number(taker[0]!.price)).toBeGreaterThanOrEqual(100.1); // crossed the spread to the ask
});

test("a pair with insufficient cash cannot enter a new position (confirms it has money to spend)", async () => {
  const feed = new FakeFeed();
  const broker = new PaperBroker(
    [pair],
    feed,
    store,
    runId,
    // Bankroll smaller than the notional: a $1000 clip on a $500 bankroll should never be entered.
    { notionalUsd: 1000, makerFeeBps: 50, takerFeeBps: 90, fillHaircut: 0.5, entryTimeoutSec: 120, repriceTicks: 2, horizonSec: 14400, bankrollUsd: 500 },
  );

  expect(broker.state(pair).cashUsd).toBe(500);
  await (broker as any).place(pair, "buy", "entry", null);
  expect(broker.state(pair).openOrder).toBeNull(); // rejected before an order was ever placed
  expect(broker.state(pair).position).toBe("flat");
  expect(broker.state(pair).cashUsd).toBe(500); // untouched
});

test("start restores inventory and leftover orders after a process restart", async () => {
  const restorePair = "PAPER-RESTORE-USD";
  const feed = new FakeFeed();
  const opts = {
    notionalUsd: 1000,
    makerFeeBps: 50,
    takerFeeBps: 90,
    fillHaircut: 0.5,
    entryTimeoutSec: 120,
    repriceTicks: 2,
    horizonSec: 14400,
    bankrollUsd: 10000,
  };
  const first = new PaperBroker([restorePair], feed, store, runId, opts);
  await (first as any).place(restorePair, "buy", "entry", null);
  const t = Date.now() + 2_000;
  feed.push({ ts: t, price: 99.9, size: 4, takerSide: "sell" });
  await (first as any).processOrder(restorePair, t);
  const size = first.state(restorePair).sizeBase;
  expect(size).toBeGreaterThan(0);
  expect(first.state(restorePair).openOrder).not.toBeNull();
  first.stop();

  const again = new PaperBroker([restorePair], feed, store, `test-${crypto.randomUUID()}`, opts);
  await again.start();
  again.stop();
  expect(again.state(restorePair).position).toBe("long");
  expect(again.state(restorePair).sizeBase).toBeCloseTo(size, 6);
  expect(again.state(restorePair).openOrder?.remaining).toBeGreaterThan(0);
});
