# Jev 1m shadow input

schema-version: jev-1m-v2.1

v2 SHA-256 46bfb2c1d0caa710ac2e20299bbd5e8b1eacd16def4498316eee6c443790cf6b superseded by v2.1.

Frozen for the live shadow caller. v2 wins wherever it conflicts with v1. `cb/` is not edited. The formulas below are copied verbatim from `cb/state.ts`, `cb/features.ts`, and `cb/feed.ts`. The caller builds `MarketState` with `buildState` and those functions. It does not re-derive them.

Sources locked into this file:

- Quant v1 items 1–6 and 8, and v2's replacement of item 7 (packet = `MarketState`).
- QA note "Jev skip 100%": per packet, open positions plus BTC, drain after `sendDueEntries` on the lease holder only.
- Architect-2: minute aggregates from the existing `level2` and `market_trades` feeds, imbalance from the full book, no new channel, persist aggregates only.

## Window

- Slots are UTC. Slot `i` starts at `barStartMs + i * 60000` for `i` in `0..14`.
- The window is `[barStartMs, barStartMs + 900000)`.
- A packet is valid when at least 13 of the 15 slots are present and slot 14 is present.
- The forming minute closes when `nowMs` reaches the next minute. The caller evaluates on the first scheduled pass at or after the 15m boundary.
- A present minute is a closed live minute from this process. A restored row is an audit copy and is not present.

## Minute

Each closed minute stores only:

- taker buy USD and taker sell USD (`price * size`)
- trade count
- mid close, mid high, mid low
- spread in bps (last two-sided book in the minute)
- imbalance over 5 levels and over 20 levels (base size, `topImbalance`)
- `carried`

Taker side is the opposite of the Coinbase maker side. A carried minute copies the last mid into close, high, and low, copies the last spread and the last imbalance, and has zero buy USD, zero sell USD, and zero trades. At most 5 carried minutes in a row. The 6th quiet minute is absent. An absent minute resets the run, so a later quiet minute may start a new run of 5.

A minute is absent when the book feed was down, when the trades feed was down, or when the carry run is already 5. REST candles, REST trades, and takeover backfill do not create minutes.

Channel health, per product:

- The book feed is up after a two-sided level2 snapshot or update, until the shard socket closes or the heartbeat gap fires.
- The trades feed is up after a trade or a heartbeat on that shard, until the same down event.
A minute is CARRIED only if, for that product, BOTH the book feed and the trades feed were continuously up from the minute start (T) to the minute end (T+60s). That means: no down event (socket close or heartbeat-gap fire) with a timestamp in [T, T+60s), both feeds were already up at T, and each feed has at least one heartbeat or message inside [T, T+60s). A heartbeat, snapshot or reconnect that arrives after T+60s never makes the minute carried or present. A minute that fails this is ABSENT. This applies to slot 14 at bar time as well, and the slot is never fabricated. A minute is judged only from the per-channel health timestamps recorded while it was live.

The same wording applies to the book feed alone for a minute that has a real sample. That minute is present, and its trade fields are real zeros only if the trades feed was continuously up.
- Carry requires the book feed, the trades feed, a covering heartbeat, and a last mid.
- A minute with a book sample but no trades-feed confirmation is absent (`no_trades_feed`), not carried.
- Both feeds down is `no_book_feed`.

## Who is called

Scheduled pairs are the open-position product ids, plus `BTC-USD` once. Each pair is judged on its own minutes. One reason, in this order: `no_1m_input`, then `not_called`, then `timeout` or `call_error` or `invalid_response`.

`no_1m_input` carries a sub-reason when one applies: `no_book_feed` if any missing slot was book-down or never seen, otherwise `no_trades_feed` if any missing slot was trades-down. A carry-limit miss has no sub-reason.

`skipShare` for a reason is that reason's count divided by scheduled packets. `skipShare` for a tier is that tier's skipped packets divided by that tier's scheduled packets. Tiers are static: `btc` is `BTC-USD`, `major` is `ETH-USD` and `SOL-USD`, `other` is every other pair.

## Packet

The stored packet is a `MarketState` from the verbatim `buildState` below, plus the minute rows and the answer. `position` is `"flat"` on every packet, including an open pair. `horizonSec` is 900. `feeBps` is `{ maker: 0, taker: 0 }`. Returns use the verbatim mid-ring formula. Volume on the state is the feature accumulator's base-size window. The minute row's USD notionals are separate and are not fed back into that window.

## Call

Drain in `driveHost` after `sendDueEntries`, only when this process holds the lease (`applyBars` and a lease token, or no kv). One call per tick. Timeout is `min(8000, untilMs - nowMs - 60000)` milliseconds. A non-positive budget does not start a call. Those packets are `timeout` and are not retried.

`noteJevSpend` is applied to a copy with a `1e-9` USD probe before the call. If that throws, the packet is `not_called` and nothing is fetched. After a priced answer, `noteJevSpend` commits the real cost. If the real cost would pass the cap, the meter is left unchanged, the outcome is `call_error`, and the key is still stored.

The key is `(pair, barStartSec)`. Any terminal outcome stores the key. A second pass does not call. The stored value is the packet and the answer, or the reason. No order endpoint is called. The cron tick awaits at most that one timeout. `TYPESAFE_AI_API_KEY` unset yields `not_called` and does not open a connection. Answers must be `expansion|balance|contraction`, `long|flat`, `low|high`, and `normal|stressed`. Anything else, or a missing positive token total, is `invalid_response`.

The cumulative cap stays $5, shared with the existing meter. The month cap stays $100. Spend persisted for the dashboard is `totalUsd` (cumulative), `todayUsd` (UTC day), and `calls`.

## Memory

The engine function memory is 1024 MB, set in `web/vercel.json` at `functions["src/app/api/engine/route.ts"].memory`.

## Persist

The flush stores minute summaries only (at most 15 minutes for at most 16 products), the done keys, the answers, the meter, and the skip counts. It does not store raw level2 or raw trades. Restored minutes stay `live: false`.

## Verbatim formulas

### cb/state.ts

```ts
const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;

export function buildState(
  feed: StateSource,
  pair: string,
  position: "long" | "flat",
  opts: { horizonSec: number; makerFeeBps: number; takerFeeBps: number },
  now = Date.now(),
): MarketState | null {
  const book = feed.book(pair);
  const mid = book?.mid();
  if (!book || mid == null) return null;

  const f = feed.featureSnapshot(pair, opts.horizonSec) ?? emptySnapshot();

  return {
    pair,
    ts: now,
    horizonSec: opts.horizonSec,
    mid: round(mid, 6),
    spreadBps: round(f.spreadBps, 3),
    spreadEmaBps: round(f.spreadEmaBps, 3),
    imbalance5: round(f.imbalance5, 4),
    imbalance20: round(f.imbalance20, 4),
    volBps: round(f.volBps, 2),
    parkinsonBps: round(f.parkinsonBps, 2),
    emaGapBps: round(f.emaGapBps, 2),
    emaCross: f.emaCross,
    rsi: f.rsi == null ? null : round(f.rsi, 2),
    volumeDelta: round(f.volumeDelta, 4),
    volumeGross: round(f.volumeGross, 4),
    returnsBps: {
      m5: round(feed.returnBps(pair, 300, now), 2),
      m30: round(feed.returnBps(pair, 1_800, now), 2),
      h1: round(feed.returnBps(pair, 3_600, now), 2),
      h4: round(feed.returnBps(pair, 14_400, now), 2),
      h24: round(feed.returnBps(pair, 86_400, now), 2),
    },
    feeBps: { maker: opts.makerFeeBps, taker: opts.takerFeeBps },
    position,
  };
}
```

### cb/features.ts

```ts
export function levelImbalance(bidQty: number, askQty: number): number {
  const t = bidQty + askQty;
  return t > 0 ? (bidQty - askQty) / t : 0;
}

/** Sum the first `n` levels (best first) and return (bid - ask) / (bid + ask). */
export function topImbalance(bids: Array<[number, number]>, asks: Array<[number, number]>, n: number): number {
  let bid = 0;
  let ask = 0;
  const bn = Math.min(n, bids.length);
  const an = Math.min(n, asks.length);
  for (let i = 0; i < bn; i++) bid += bids[i]![1];
  for (let i = 0; i < an; i++) ask += asks[i]![1];
  return levelImbalance(bid, ask);
}

export function rsiFrom(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export function emaNext(prev: number | null, x: number, period: number): number {
  const k = 2 / (period + 1);
  return prev == null ? x : k * x + (1 - k) * prev;
}

/**
 * Parkinson high-low vol, in bps, scaled from 1 minute candles to `horizonSec`.
 * `sumLogHl2` is the sum of ln(high/low)^2 over `n` closed candles.
 */
export function parkinsonVolBps(sumLogHl2: number, n: number, horizonSec: number): number {
  if (n < 1 || !(horizonSec > 0) || !(sumLogHl2 >= 0)) return 0;
  const perMin = Math.sqrt(sumLogHl2 / (4 * n * Math.LN2));
  return perMin * Math.sqrt(horizonSec / 60) * 10_000;
}
```

`FeatureAccumulator.snapshot` (verbatim return math):

```ts
const volBps = this.welford.n > 1 ? this.welford.stdev() * Math.sqrt(Math.max(0, horizonSec)) : 0;
const fast = this.emaFast;
const slow = this.emaSlow;
let emaCross: FeatureSnapshot["emaCross"] = "flat";
let emaGapBps = 0;
if (fast != null && slow != null && slow > 0) {
  emaGapBps = ((fast - slow) / slow) * 10_000;
  emaCross = fast > slow ? "above" : fast < slow ? "below" : "flat";
}
```

`rsiNext` is the Wilder update in `cb/features.ts` (`RSI_PERIOD` 14). EMA periods are `EMA_FAST` 8, `EMA_SLOW` 21, `SPREAD_EMA` 8. The minute close path calls `emaNext` and `rsiNext` from `finishMinute`. The implementation calls `FeatureAccumulator`; it does not copy the class.

### cb/feed.ts

```ts
/** Interpolated (nearest at or before) mid at `targetTs` from the ring, or the oldest if before it. */
midAt(pair: string, targetTs: number): number | null {
  const ring = this.mids.get(pair);
  if (!ring || ring.length === 0) return null;
  let lo = 0;
  let hi = ring.length - 1;
  if (targetTs <= ring[0]!.ts) return ring[0]!.mid;
  if (targetTs >= ring[hi]!.ts) return ring[hi]!.mid;
  while (lo < hi) {
    const midIdx = (lo + hi + 1) >> 1;
    if (ring[midIdx]!.ts <= targetTs) lo = midIdx;
    else hi = midIdx - 1;
  }
  return ring[lo]!.mid;
}

/** Signed return in bps over the last `sec` seconds, from the mid ring. */
returnBps(pair: string, sec: number, now = Date.now()): number {
  const then = this.midAt(pair, now - sec * 1000);
  const nowMid = this.books.get(pair)?.mid() ?? this.midAt(pair, now);
  if (then === null || nowMid === null || then === 0) return 0;
  return ((nowMid - then) / then) * 10_000;
}
```
