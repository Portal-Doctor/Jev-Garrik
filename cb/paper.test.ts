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
  const px = broker.state(pair).openOrder!.price;
  expect(px).toBeGreaterThan(100); // one tick inside the bid, not joined on the touch
  expect(px).toBeLessThan(100.1); // never reaches the ask
  // Order rests inside 100 with ~10 base. Print a taker sell of 4 that crosses.
  const t = Date.now() + 2_000;
  feed.push({ ts: t, price: 99.9, size: 4, takerSide: "sell" });
  await (broker as any).processOrder(pair, t);

  const fills = await store.sql<{ side: string; size_base: number; fee_usd: number; cost_basis_usd: number; liquidity: string }[]>`SELECT side, size_base, fee_usd, cost_basis_usd, liquidity FROM fills WHERE run_id = ${runId}`;
  expect(fills.length).toBe(1);
  expect(Number(fills[0]!.size_base)).toBeCloseTo(2, 9); // 4 * 0.5 haircut
  expect(fills[0]!.liquidity).toBe("maker");
  const notional = 2 * px;
  expect(Number(fills[0]!.fee_usd)).toBeCloseTo((notional * 50) / 10_000, 9); // 0.5% maker
  expect(Number(fills[0]!.cost_basis_usd)).toBeCloseTo(notional + (notional * 50) / 10_000, 9);
  expect(broker.state(pair).position).toBe("long");
});

test("paper entry rests inside the touch and an entry timeout cancels instead of crossing", async () => {
  const timeoutPair = "PAPER-TIMEOUT-USD";
  const feed = new FakeFeed();
  const broker = new PaperBroker(
    [timeoutPair],
    feed,
    store,
    runId,
    { notionalUsd: 1000, makerFeeBps: 50, takerFeeBps: 90, fillHaircut: 0.5, entryTimeoutSec: 1, repriceTicks: 999, horizonSec: 14400, bankrollUsd: 10000 },
  );
  const t0 = Date.now();
  await (broker as any).place(timeoutPair, "buy", "entry", null);
  const px = broker.state(timeoutPair).openOrder!.price;
  expect(px).toBeGreaterThan(100);
  expect(px).toBeLessThan(100.1);
  await (broker as any).tickPair(timeoutPair, t0 + 2_000);

  const orders = await store.sql<{ status: string }[]>`SELECT status FROM orders WHERE run_id = ${runId} AND pair = ${timeoutPair}`;
  expect(orders.length).toBe(1);
  expect(orders[0]!.status).toBe("canceled");
  const taker = await store.sql<{ price: number }[]>`SELECT price FROM fills WHERE run_id = ${runId} AND pair = ${timeoutPair} AND liquidity = 'taker'`;
  expect(taker.length).toBe(0);
  expect(broker.state(timeoutPair).position).toBe("flat");
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

const guardOpts = {
  notionalUsd: 1000,
  makerFeeBps: 50,
  takerFeeBps: 90,
  fillHaircut: 0.5,
  entryTimeoutSec: 120,
  repriceTicks: 999,
  horizonSec: 14400,
  bankrollUsd: 10000,
  stopLossBps: 150,
  takeProfitBps: 250,
};

function retouch(feed: FakeFeed, bid: number, ask: number): void {
  const book = feed.book();
  book.clear();
  book.set("bid", bid, 80);
  book.set("offer", ask, 80);
}

async function enterLong(pairName: string, feed: FakeFeed): Promise<PaperBroker> {
  const broker = new PaperBroker([pairName], feed, store, runId, guardOpts);
  await (broker as any).place(pairName, "buy", "entry", null);
  const px = broker.state(pairName).openOrder!.price;
  const t = Date.now() + 2_000;
  feed.push({ ts: t, price: px - 0.05, size: 80, takerSide: "sell" });
  await (broker as any).processOrder(pairName, t);
  expect(broker.state(pairName).position).toBe("long");
  expect(broker.state(pairName).openOrder).toBeNull();
  return broker;
}

test("a long flattens on the 1s tick when mid breaches the stop, even if the last call was still long", async () => {
  const stopPair = "PAPER-STOP-USD";
  const feed = new FakeFeed();
  const broker = await enterLong(stopPair, feed);
  const entry = broker.state(stopPair).entryPrice!;
  const mid = entry * (1 - 160 / 10_000);
  retouch(feed, mid - 0.02, mid + 0.02);
  broker.observe(stopPair, "buy", 0);
  await (broker as any).tickPair(stopPair, Date.now());
  expect(broker.state(stopPair).position).toBe("flat");
  expect(broker.state(stopPair).stopPrice).toBeNull();
  const rows = await store.sql<{ purpose: string; liquidity: string }[]>`
    SELECT o.purpose, f.liquidity FROM orders o
    JOIN fills f ON f.order_id = o.id
    WHERE o.run_id = ${runId} AND o.pair = ${stopPair} AND o.purpose = 'stop'
  `;
  expect(rows.length).toBe(1);
  expect(rows[0]!.liquidity).toBe("taker");
});

test("a long flattens on the 1s tick when mid clears the take-profit, even if the last call was still long", async () => {
  const tpPair = "PAPER-TP-USD";
  const feed = new FakeFeed();
  const broker = await enterLong(tpPair, feed);
  const entry = broker.state(tpPair).entryPrice!;
  const mid = entry * (1 + 260 / 10_000);
  retouch(feed, mid - 0.02, mid + 0.02);
  broker.observe(tpPair, "buy", 0);
  await (broker as any).tickPair(tpPair, Date.now());
  expect(broker.state(tpPair).position).toBe("flat");
  const rows = await store.sql<{ purpose: string; liquidity: string }[]>`
    SELECT o.purpose, f.liquidity FROM orders o
    JOIN fills f ON f.order_id = o.id
    WHERE o.run_id = ${runId} AND o.pair = ${tpPair} AND o.purpose = 'take_profit'
  `;
  expect(rows.length).toBe(1);
  expect(rows[0]!.liquidity).toBe("taker");
});

test("a flat pair never trips a stop or a take-profit", async () => {
  const flatPair = "PAPER-FLAT-USD";
  const feed = new FakeFeed();
  const broker = new PaperBroker([flatPair], feed, store, runId, guardOpts);
  retouch(feed, 1, 1.01);
  await (broker as any).tickPair(flatPair, Date.now());
  retouch(feed, 500, 500.1);
  await (broker as any).tickPair(flatPair, Date.now());
  expect(broker.state(flatPair).position).toBe("flat");
  const rows = await store.sql<{ purpose: string }[]>`SELECT purpose FROM orders WHERE run_id = ${runId} AND pair = ${flatPair}`;
  expect(rows.length).toBe(0);
});

test("five resting clips stay inside the gross cap and a sixth is refused", async () => {
  const names = ["G1-USD", "G2-USD", "G3-USD", "G4-USD", "G5-USD", "G6-USD"];
  const feed = new FakeFeed();
  const broker = new PaperBroker(names, feed, store, runId, {
    ...guardOpts,
    notionalUsd: 600,
    bankrollUsd: 12_000,
    maxGrossUsd: 3_000,
    minSizeUsd: 25,
  });
  for (const name of names.slice(0, 5)) {
    await (broker as any).place(name, "buy", "entry", null, 600);
    expect(broker.state(name).openOrder).not.toBeNull();
  }
  expect(broker.openGrossUsd()).toBeLessThanOrEqual(3_000 + 1);
  await (broker as any).place(names[5]!, "buy", "entry", null, 600);
  expect(broker.state(names[5]!).openOrder).toBeNull();
  expect(broker.state(names[5]!).position).toBe("flat");
});
