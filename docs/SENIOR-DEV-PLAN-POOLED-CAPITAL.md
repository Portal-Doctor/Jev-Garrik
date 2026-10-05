---
name: Pooled capital rotation book
overview: "Replace per-pair clip accounting with one $12,000 pool that can fund any live pair with a locked breakout 20/3/50 signal, rotate out a weaker open to fund a better one, count 40/80 on every flatten, and cap portfolio drawdown at 15% of the pool. Live HTF stays up until this book is implemented, backtested, and shipped into compose."
todos:
  - id: pool-core
    content: Add ranking, flatten-to-fund, concurrent/gross caps, and the 15% pool DD trip as pure functions with unit tests
    status: pending
  - id: backtest
    content: Replay Jul/Aug/Sep 2026 at 40/80 for split-clip HTF, split-clip breakout, and pooled rotation. Record monthly nets, trades, fees, portfolio DD, and harness scores. Do not tune knobs to force $300/mo
    status: pending
  - id: live-wire
    content: Wire CB_BOOK=pooled into the paper broker and engine so docker compose up -d --build cb (no kuru) runs the pool. Host .env must match. Do not enable TAO or ADA. Do not /reset
    status: pending
  - id: pre-ship
    content: Run the existing pre-ship checklist (bun test cb, web tsc, compose health, GET /health, t=0 rings). Report pass or fail from real output
    status: pending
isProject: false
---

# Pooled capital rotation book

The live process stays [cb/](cb/index.ts). The Kuru demo in [src/](src/index.ts) stays stopped. Do not start the `kuru` compose profile.

Jev still classifies. Code still owns the order. No middle dots, em dashes, or en dashes in any rendered text. No blinking or pulsing indicators.

Brian approved this after split-clip breakout failed adoption rule 3 on the ten-pair book (VVV and PUMP drawdown) even though the Jul/Aug/Sep $300/mo gate passed. Per-pair clips cannot recycle capital into the better signal. This pass builds one pool that can.

Shipping this book into Docker **replaces** the live HTF ten-pair book on the next `docker compose up -d --build cb`. Say that before the rebuild. Do not `/reset`. Do not enable TAO-USD or ADA-USD.

## Locked

Do not change:

- Live fees (`CB_MAKER_FEE_BPS=40`, `CB_TAKER_FEE_BPS=80`).
- Breakout knobs: `CB_BREAKOUT_BARS=20`, `CB_TRAIL_ATR=3`, `CB_TREND_EMA_BARS=50`, `CB_ATR_BARS=14`, `CB_BREAKOUT_MAX_HOLD_SEC=1209600`.
- The ten live names. TAO and ADA stay `enabled: false`.
- Stops in [cb/books.ts](cb/books.ts) (1 sigma). Those remain the initial stop under the trail.
- The 2-to-1 after-fee boot check. It still uses the table take-profit so TAO/ADA cannot sneak in.
- `CB_MAX_GROSS_USD=3000`. Do not raise it. Ten clips sum to $4,200, so this cap already forbids a fully long book.
- The $300/mo gate and the two-miss-months-per-year rule. Do not tune a rank weight, clip, or trail to force that gate.

## 1. One pool

| Knob | Value | Env |
|---|---:|---|
| Pool | $12,000 | `CB_BANKROLL_USD` |
| Book mode | `pooled` | `CB_BOOK` |
| Max concurrent longs | 3 | `CB_MAX_CONCURRENT` |
| Gross mark cap | $3,000 | `CB_MAX_GROSS_USD` |
| Pool drawdown trip | 15% of $12,000 ($1,800), flatten all and halt new entries when mark equity `<= 10,200` | `CB_POOL_DD=0.15` |
| Clip | that pair's `notionalUsd` from the book table, capped by free cash, remaining gross room, and min size | none |
| Entry | post-only, same miss rule as [cb/breakout.ts](cb/breakout.ts) | none |
| Flatten | taker at 80 bps. Rotation, trail, initial stop, max hold, and the DD trip all count 40/80 | none |
| Hold cap | 14 days | `CB_BREAKOUT_MAX_HOLD_SEC` |
| Take-profit | none. Trail only | none |

Cash is one ledger. A pair does not have a reserved $1,200 slice. Free cash plus open marks is the book. A new long spends free cash. A flatten returns cash after the taker fee.

`CB_HORIZON_SEC` stays 86,400 for resolver scoring. The pooled broker hold clock is the 14 day breakout cap, not the HTF 24 hour clock.

## 2. Positive metrics (not vague)

A pair is a **candidate** only when every line holds on the last **completed** 4-hour bar. A running bucket never qualifies.

1. ATR is warm (Wilder 14 on completed 4-hour bars).
2. The 50-bar 4-hour EMA is warm.
3. That bar's close is strictly above the highest high of the prior 20 completed 4-hour bars (Donchian 20).
4. That bar's close is strictly above the 50-bar 4-hour EMA.
5. The 5-minute state at the bucket's last bar is not vetoed: `liquidity_stress` is not `stressed` and `market_regime` is not `contraction`. Same deterministic classifier [cb/breakout.ts](cb/breakout.ts) already uses. Toxic flow is observation only.

That is the locked breakout 20/3/50 signal. There is no extra percentile, no confidence floor, and no HTF `h24 > 0` filter on this book.

## 3. Ranking (locked arithmetic, not a sweep)

All three terms are in ATR units of the last completed 4-hour ATR. No extra weights. No threshold fitted to $300/mo.

```
breakQualityAtr = (close - prior20High) / ATR
emaSlopeAtr    = (ema - emaPrev) / ATR
openMfeAtr     = 0 when flat
               = (highestCloseSinceEntry - fill) / ATR when long
rank           = breakQualityAtr + emaSlopeAtr + openMfeAtr
```

`emaPrev` is the 50-bar EMA after the previous completed 4-hour bar. `highestCloseSinceEntry` is the highest **completed** 4-hour close since the fill, the same series the trail uses.

**Open override.** If the 5-minute low is at or below `max(initialStop, trail)`, the open is a **broken trail**. Its rank is `-Infinity`. It flattens as taker before any new entry is considered.

**Ties.** Higher rank wins. If ranks are equal, the already-open pair keeps the slot. If both are flat, lexicographic pair name wins so the replay is deterministic.

## 4. Flatten to fund

After every completed 4-hour close (all pairs, same bucket), and after any broken-trail flatten on the 5-minute loop:

1. Flatten every broken trail and every open that has hit the 14 day cap. Taker. 40/80.
2. If mark equity `<= $10,200`, flatten every remaining open and refuse new entries for the rest of the run. That is the pool DD trip. It is not reset by a later recovery.
3. Collect candidates (section 2) that are still flat.
4. Sort candidates by rank, high to low.
5. For each candidate, if there is room (concurrent longs `< 3`, remaining gross `>=` clip, free cash `>=` clip plus maker), enter post-only at the breakout close.
6. If there is no room, look at the lowest-rank open that is not a broken trail (already gone). If `candidate.rank > open.rank`, flatten that open as taker (40/80) and, on the next 5-minute bar after that flatten is booked, enter the candidate if cash is now there. One flatten funds one candidate. Do not flatten two opens to stuff two new names in the same bucket.

A missed post-only entry is counted and does not retry until a later completed 4-hour bar reprints a candidate. Do not chase as taker.

## 5. Why this, and what it is not

Split-clip HTF is the live control. Split-clip breakout already cleared the three-month $300 gate and then failed adoption rule 3 because VVV and PUMP each have their own $2,000-style bankroll slice and cannot give that cash to a cleaner break. The pool scores drawdown on the $12,000 book, not on each name.

This is not a pair-list change. This is not a knob sweep. This is not HTF with a shared wallet. Entries are breakout. Exits are trail, rotation, max hold, or the pool DD trip.

## 6. Code

New files, pure where they can be:

- [cb/pool.ts](cb/pool.ts): `rankOf`, `compareRank`, `poolDrawdownTripped`, `planRotation`.
- [cb/pool.test.ts](cb/pool.test.ts): ranking order, flatten-to-fund, DD cap.
- [cb/poolbacktest.ts](cb/poolbacktest.ts): one cash ledger over the ten-pair 5-minute tape, no lookahead, same fill rules as `runBreakout`.
- [cb/pool-run.ts](cb/pool-run.ts): the three-book Jul/Aug/Sep replay. Writes the Result tables. No estimates.

Live:

- `CB_BOOK=pooled` in [cb/config.ts](cb/config.ts), [.env.example](.env.example), and the host `.env`.
- [cb/paper.ts](cb/paper.ts): one cash ledger when pooled. No resting take-profit. Stop is `max(1 sigma, trail)`. Hold clock is 14 days. Shared cash so pair A can spend what pair B just returned.
- [cb/engine.ts](cb/engine.ts) / [cb/index.ts](cb/index.ts): when pooled, do not flatten on HTF trend-down and do not enter on the HTF yield gate. Enter only from `planRotation`. Jev still runs. Stress and contraction still veto an entry.

`CB_BOOK=htf` must still boot the current HTF book so the control stays runnable.

## 7. Backtest gate (decided before the run)

Replay the ten live names at 40/80 on UTC months **2026-07, 2026-08, 2026-09**. Warm up from 10 days before July 1. Score closed-trade monthly nets with [cb/monthgate.ts](cb/monthgate.ts) (`$300/mo`, 2 miss months/year).

Three books, same tape, same fees, same clips:

| Book | Entries | Exits | Capital |
|---|---|---|---|
| (a) Split-clip HTF | official HTF fixed-target | 1 sigma stop, 4 sigma maker TP, 24h | $1,200 per pair |
| (b) Split-clip breakout | locked 20/3/50 | 3 ATR trail, 14d | $1,200 per pair |
| (c) Pooled rotation breakout | locked 20/3/50 plus rank | trail, rotation, 14d, pool DD | one $12,000 ledger |

Record, for each book: monthly nets, trade count, fees, max **portfolio** drawdown (peak to trough of the summed mark path, as a fraction of the $12,000 pool), and `n` / Accuracy / Wilson / Brier / Edge from [cb/tradescore.ts](cb/tradescore.ts) if the book has closed trades.

Do not retune if (c) misses the gate. Write which months missed.

## 8. Tests

`bun test cb/pool.test.ts cb/poolbacktest.test.ts`

- Rank: a 2 ATR break beats a 0.5 ATR break when slope and MFE are equal. A broken trail ranks below every finite rank.
- Flatten-to-fund: at 3 concurrent, a higher-rank new signal flattens the lowest-rank open and does not flatten a higher-rank open.
- DD cap: equity at $10,200 trips. Equity at $10,200.01 does not. After a trip, a later candidate is refused.
- No lookahead: a spike inside an open 4-hour bucket is not a candidate.
- Pooled cash: flattening B frees cash for A on the next bar, not the same bar as the flatten fill.

Then the repo pre-ship checklist, not a new script: `bun test cb`, `cd web && bunx tsc --noEmit`, `docker compose up -d --build cb` with no kuru profile, `GET /health`, and t=0 veto ring n plus first `toxicSource` per pair. Record the real output.

## 9. What not to change

- Do not `/reset`.
- Do not start Kuru.
- Do not enable TAO or ADA.
- Do not move the 15% pool limit or the $300/mo target.
- Do not add a rank weight, a slope floor, or a break-quality cutoff after seeing the tape.

## Result

Empty until the replay and the pre-ship checklist land.
