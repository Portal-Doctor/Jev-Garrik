import { test, expect, afterEach } from "bun:test";
import { Feed, divergenceThreshold } from "./feed";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function mockRestPrice(bid: number, ask: number) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ best_bid: String(bid), best_ask: String(ask) }), { status: 200 })) as typeof fetch;
}

function seedBook(feed: Feed, pair: string, bid: number, ask: number) {
  const book = feed.book(pair)!;
  book.set("bid", bid, 10);
  book.set("offer", ask, 10);
}

test("divergenceThreshold scales with spread but never drops below the fixed floor", () => {
  expect(divergenceThreshold(0)).toBe(5); // no spread info: fixed floor
  expect(divergenceThreshold(1)).toBe(5); // 2x a 1 bps spread is under the floor
  expect(divergenceThreshold(10)).toBe(20); // wide spread pair: scale up, timing skew is expected
  expect(divergenceThreshold(null)).toBe(5);
});

test("a single divergent REST check is logged but not counted as an incident", async () => {
  const incidents: string[] = [];
  const feed = new Feed(["SOL-USD"], null, (m) => incidents.push(m));
  seedBook(feed, "SOL-USD", 99.9, 100.1); // mid 100, tight spread -> threshold stays at the 5 bps floor
  mockRestPrice(101, 101); // ~100 bps away: one-off divergence

  await (feed as any).checkDivergence();

  expect(feed.incidents).toBe(0);
  expect(incidents.some((m) => m.includes("diverges"))).toBe(true);
});

test("divergence that persists across two consecutive checks of the same pair counts as an incident", async () => {
  const feed = new Feed(["SOL-USD"], null, () => {});
  seedBook(feed, "SOL-USD", 99.9, 100.1);
  mockRestPrice(101, 101);

  await (feed as any).checkDivergence(); // 1st: logged only
  expect(feed.incidents).toBe(0);
  await (feed as any).checkDivergence(); // 2nd consecutive: now it counts
  expect(feed.incidents).toBe(1);
  await (feed as any).checkDivergence(); // 3rd consecutive: keeps counting each persisted check
  expect(feed.incidents).toBe(2);
});

test("a resolved divergence resets the persistence streak", async () => {
  const feed = new Feed(["SOL-USD"], null, () => {});
  seedBook(feed, "SOL-USD", 99.9, 100.1);

  mockRestPrice(101, 101);
  await (feed as any).checkDivergence(); // over threshold, 1st
  mockRestPrice(100, 100);
  await (feed as any).checkDivergence(); // back in line: streak resets
  mockRestPrice(101, 101);
  await (feed as any).checkDivergence(); // over threshold again, but only the 1st of a new streak

  expect(feed.incidents).toBe(0);
});

test("a wide-spread pair does not false-positive on ordinary timing skew", async () => {
  const feed = new Feed(["SUI-USD"], null, () => {});
  seedBook(feed, "SUI-USD", 99.5, 100.5); // 100 bps spread -> threshold scales to 200 bps
  mockRestPrice(100.6, 100.6); // ~60 bps from local mid: within a scaled threshold, not the fixed 5

  await (feed as any).checkDivergence();
  await (feed as any).checkDivergence();

  expect(feed.incidents).toBe(0);
});

test("a WS drop after a successful connection counts as one incident", () => {
  const incidents: string[] = [];
  const feed = new Feed(["SOL-USD"], null, (m) => incidents.push(m));

  (feed as any).hasConnectedOnce = true;
  (feed as any).noteDisconnect();

  expect(feed.incidents).toBe(1);
  expect(incidents.some((m) => m.includes("reconnect"))).toBe(true);
});

test("a close before the feed ever connected is not counted (startup flakiness, not a defect)", () => {
  const feed = new Feed(["SOL-USD"], null, () => {});

  (feed as any).noteDisconnect();

  expect(feed.incidents).toBe(0);
});

test("a repeated close does not double count without a fresh successful connection in between", () => {
  const feed = new Feed(["SOL-USD"], null, () => {});

  (feed as any).hasConnectedOnce = true;
  (feed as any).noteDisconnect();
  (feed as any).noteDisconnect(); // no reconnection happened in between

  expect(feed.incidents).toBe(1);
});

test("the initial startup book snapshot is not counted as a resync incident", () => {
  const feed = new Feed(["SOL-USD"], null, () => {});
  (feed as any).onL2({ product_id: "SOL-USD", type: "snapshot", updates: [] });

  expect(feed.incidents).toBe(0);
});

test("a mid-stream resync while already synced on the live connection counts as an incident", () => {
  const incidents: string[] = [];
  const feed = new Feed(["SOL-USD"], null, (m) => incidents.push(m));

  (feed as any).onL2({ product_id: "SOL-USD", type: "snapshot", updates: [] }); // startup: not counted
  (feed as any).onL2({ product_id: "SOL-USD", type: "snapshot", updates: [] }); // mid-stream: counted

  expect(feed.incidents).toBe(1);
  expect(incidents.some((m) => m.includes("resync"))).toBe(true);
});

test("a resync right after a reconnect (synced cleared) is not double-counted on top of the reconnect", () => {
  const feed = new Feed(["SOL-USD"], null, () => {});

  (feed as any).onL2({ product_id: "SOL-USD", type: "snapshot", updates: [] }); // startup sync
  (feed as any).hasConnectedOnce = true;
  (feed as any).noteDisconnect(); // reconnect incident #1, and clears `synced` upstream in onclose
  (feed as any).synced.clear(); // mirror what ws.onclose does before reconnecting
  (feed as any).onL2({ product_id: "SOL-USD", type: "snapshot", updates: [] }); // post-reconnect resync

  expect(feed.incidents).toBe(1); // only the reconnect, not a second resync incident
});
