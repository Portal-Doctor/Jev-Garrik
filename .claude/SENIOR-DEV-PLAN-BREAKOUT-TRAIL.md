---
name: Breakout with a trailing stop, as a second backtest line
overview: "Add a 4-hour Donchian breakout with a 3 ATR trailing stop to the historical backtest, next to the current fixed-target strategy, on the same six pairs and the same fees. Decide from the result whether the live engine should switch exits. No live behavior changes in this pass."
todos:
  - id: breakout-core
    content: Add cb/breakout.ts with 4-hour aggregation, Donchian high, 4-hour EMA, Wilder ATR, a ratcheting trail, and runBreakout on 5-minute candles
    status: pending
  - id: backtest-wire
    content: Run runBreakout inside loadHistoricalBacktest, widen indicator warm-up to 10 days, and add a breakout block plus totals to the /backtest and /backtest/all payloads
    status: pending
  - id: ui
    content: Show a Breakout tile, breakout markers on the chart, and a fixed-target versus trailing comparison table on the backtest page
    status: pending
  - id: tests
    content: Pure tests for aggregation, no lookahead, trail ratchet, gap-honest stop fills, missed post-only entries, and fees at 50/90 and 10/10
    status: pending
  - id: decision
    content: Run 6 months on all six pairs and record the result against the adoption rule in section 8. Do not change cb/paper.ts or cb/gate.ts in this pass
    status: pending
isProject: false
---

# Breakout with a trailing stop, as a second backtest line

The live process stays [cb/](cb/index.ts). The Kuru demo in [src/](src/index.ts) stays stopped. Do not start the `kuru` compose profile. This pass is backtest and dashboard only. [cb/paper.ts](cb/paper.ts), [cb/gate.ts](cb/gate.ts), and [cb/engine.ts](cb/engine.ts) do not change.

No middle dots, em dashes, or en dashes in any rendered text. No blinking or pulsing indicators.

## 1. Why this, and why only as a comparison first

[SENIOR-DEV-PLAN-PAYOFF.md](SENIOR-DEV-PLAN-PAYOFF.md) moved the book to trend entries, a 1 sigma stop, a 4 sigma fixed take-profit, and a 24-hour hold. That is the right shape for 50 bps maker and 90 bps taker: few trades, winners at least twice the losers.

A fixed target still caps the winner. Last month UNI ran from about $4 to about $11. A 4 sigma target on UNI is 1,180 bps, roughly 12%. A trend follower would have ridden most of that move instead of taking 12% and then waiting for a fresh entry signal.

The best-documented public rule set for this is the breakout with a trailing exit: the Donchian or "Turtle" entry and the ATR ("Chandelier") trailing stop, both common on TradingView. Time-series momentum is well documented across asset classes, including crypto. That does not make any TradingView script's published backtest trustworthy. Those usually run with zero commission, fill at the bar close, and many read higher-timeframe data before the bar has closed. This pass rebuilds the rule in our own backtest, with our fees and our fill rules, and compares it against what we already run.

Parameters are the textbook values. Do not sweep them in this pass. A sweep on six months of six pairs will find a winner by chance.

## 2. The rule

All signals are computed on completed 4-hour bars built from the 5-minute Coinbase candles the backtest already fetches. Stops are checked on every 5-minute bar.

| Knob | Value | Env |
|---|---:|---|
| Breakout lookback | 20 completed 4-hour bars (about 3.3 days) | `CB_BREAKOUT_BARS` |
| Trend filter | 4-hour close above the 50-bar 4-hour EMA | `CB_TREND_EMA_BARS` |
| ATR | Wilder, 14 completed 4-hour bars | `CB_ATR_BARS` |
| Trail distance | 3 times ATR under the highest 4-hour close since entry | `CB_TRAIL_ATR` |
| Initial stop | the pair's book stop from [cb/books.ts](cb/books.ts), 1 times sigma | none |
| Max hold | 14 days | `CB_BREAKOUT_MAX_HOLD_SEC=1209600` |
| Take-profit | none | none |

**Entry.** When a 4-hour bar closes, and the pair is flat, go long only if all of these hold:

- That bar's close is above the highest high of the 20 completed 4-hour bars before it.
- That bar's close is above the 50-bar 4-hour EMA.
- No Jev veto on the 5-minute state at the bucket's last bar. Use `classifyDeterministic` from [cb/model.ts](cb/model.ts) exactly as the current backtest does. Refuse if `toxic_flow_risk` is `high`, `liquidity_stress` is `stressed`, or `market_regime` is `contraction`. `direction_bias` and confidence are recorded and do not gate the entry.

**Entry fill, post-only.** Post a limit at the breakout bar's close. It fills only if the next 5-minute bar's low is at or below that price, at the maker fee. Otherwise the entry is missed and counted in `missedEntries`. There is no taker chase. Breakouts are where post-only bids get skipped, so the miss count is one of the numbers this pass exists to measure. Do not "fix" a high miss rate by crossing.

**Stop level.** `stop = max(initialStop, trail)`. `initialStop = entry * (1 - stopLossBps / 10_000)`, using the fee-inclusive entry, the same reference the live guard uses. After each completed 4-hour bar, `trail = max(trail, highestCloseSinceEntry - 3 * ATR)`. The stop only moves up.

**Exit.** On any 5-minute bar whose low is at or below the stop, exit as taker at `min(stop, bar.open)`. If the bar opens below the stop, the fill is the open, not the stop. The current fixed-target backtest fills at the stop price even through a gap. Keep that code as it is in this pass, but add one line to its `ASSUMPTIONS` saying so, so the two columns are not compared as if they fill the same way.

At the max hold, exit at the 5-minute close. Price it as taker, because a stale long is not something to rest on.

**Size.** The pair's book notional, capped by the backtest's cash, the same as the current strategy. One position per pair.

## 3. No lookahead

This is the mistake that makes most TradingView breakout scripts look better than they trade. A 4-hour bar's high, close, ATR, and EMA are known only at the end of its bucket. Inside a bucket, the 5-minute loop may check stops against the stop level set at the previous bucket close. It must not use the running high or close of the bucket it is in.

Build the 4-hour bars in one pass, keyed by `floor(ts / 14_400_000)`. Treat a bucket as complete when the first 5-minute bar of the next bucket arrives. Drop a partial last bucket. Write the test in section 7 that proves a spike inside an open bucket does not trigger an entry until that bucket closes.

## 4. Code

New file [cb/breakout.ts](cb/breakout.ts), pure functions, no network:

- `aggregate(candles: Candle[], bucketSec: number): Candle[]` returns completed buckets only.
- `atrNext(prevAtr, bar, prevClose, period)` uses Wilder smoothing. Seed it with the mean true range of the first `period` bars.
- `emaNext` is already exported from [cb/features.ts](cb/features.ts). Reuse it.
- `trailNext(trail, highestClose, atr, mult)` returns the higher of the old trail and `highestClose - mult * atr`.
- `runBreakout(candles5m: Candle[], opts: BreakoutOpts): BreakoutSummary`.

```ts
export interface BreakoutSummary extends SideSummary {
  missedEntries: number;
  vetoedEntries: number;
  avgWinUsd: number | null;
  avgLossUsd: number | null;
  maxDrawdown: number | null;
  maxHoldHours: number;
  lowFeeNetUsd: number;
}
```

`SideSummary` is the existing type in [cb/backtest.ts](cb/backtest.ts). `lowFeeNetUsd` replays the same fills at 10 bps maker and 10 bps taker, matching the fixed-target `diagnostics.lowFeeNetUsd`.

In [cb/backtest.ts](cb/backtest.ts):

- `loadHistoricalBacktest` fetches from `windowStartTs - 10 * DAY_MS`, not 3 days. The 50-bar 4-hour EMA needs about 8.3 days of history before the window opens. The fixed-target strategy warms up on the same longer history, which is harmless.
- Call `runBreakout` on the same 5-minute candles and put the result on `BacktestResult.breakout`.
- `/backtest/all` totals add `breakoutNetUsd` and `breakoutTrades` next to the existing totals.
- Cache key stays `pair:months`.

Mirror the new fields in [web/src/lib/backtestTypes.ts](web/src/lib/backtestTypes.ts).

## 5. Dashboard

On [web/src/app/paper/backtest/page.tsx](web/src/app/paper/backtest/page.tsx):

- A fourth stat tile, `Breakout`, after `Strategy`, `Oracle`, and `One clip held`.
- Breakout entries and exits on the existing chart as small squares, green in and red out, so they are not confused with the strategy triangles or the oracle rings. Add both to the legend.
- A comparison table under the scorecard with two columns, `Fixed target` and `Trailing stop`, and these rows: trades, missed entries (trailing only), win rate, average win, average loss, net at 50/90, net at 10/10, max drawdown, longest hold.
- One more assumptions line: "Breakout uses completed 4 hour bars, a post-only entry that can miss, a 3 ATR trailing stop, and a 14 day cap. Stops fill at the stop or the bar open, whichever is worse."

No new routes.

## 6. What not to change

- Live entry, exit, sizing, fees, and guards. That is phase 2, and only if section 8 passes.
- `CB_FEE_BUFFER`, clips, the depth cap, the gross cap.
- The fixed-target strategy's rules. It is the control.
- Kuru.

## 7. Tests

`bun test cb/breakout.test.ts cb/backtest.test.ts`

- `aggregate` builds 4-hour open, high, low, close, and volume correctly from 48 five-minute bars, and drops a partial last bucket.
- No lookahead: a 5-minute spike above the 20-bar high inside an open bucket does not enter until that bucket closes above the high.
- An entry requires a close above the prior 20-bar high and above the 50-bar EMA. A close above the high but under the EMA does not enter.
- A veto (`toxic`, `stressed`, `contraction`) refuses a valid breakout and increments `vetoedEntries`.
- A post-only entry misses when the next 5-minute low stays above the limit, and increments `missedEntries`.
- The trail only rises. A falling ATR after a new high cannot lower the stop.
- A 5-minute bar that gaps below the stop fills at its open, not at the stop.
- Fees: maker on entry, taker on the stop and on the max-hold exit. The 10/10 replay uses the same fills.
- The UNI `backtestRisk` test still passes with stop 295 and notional 600.

Then `docker compose up -d --build cb` with no `--profile kuru`. Confirm `GET /health`. Open `http://localhost:3000/paper/backtest` and check that UNI 6 months shows the Breakout tile, the squares, and the comparison table.

## 8. Adoption rule, decided before the run

Run 6 months on all six pairs at 50 bps maker and 90 bps taker. Record the table in this file under a new heading, "Result".

Switch the live exit to the trailing stop, in a separate reviewed pass, only if all of these hold:

1. Breakout net after fees is above zero across the six pairs combined.
2. Breakout net beats the fixed-target net on at least 4 of the 6 pairs.
3. Breakout max drawdown stays under 15% of each pair's bankroll.
4. Missed entries are under half of breakout signals. Otherwise post-only cannot get this strategy filled, and the honest answer is a fee-tier conversation, not a taker entry.
5. At least 30 breakout trades across the six pairs. Fewer is a story, not a sample.

If it fails, keep the fixed target and write down which rule failed. Do not re-run with new parameters to make it pass.

Phase 2, only after a pass: the live paper broker replaces the fixed take-profit with the ratcheting trail on completed 4-hour bars, keeps the 1-second initial-stop check, and lifts the 24-hour hold to the 14-day cap. That work gets its own plan.

## Result

Run on 2026-09-24 against the rebuilt engine (`GET /health` ok, run `807a6f33-bfde-4073-beb6-74cbebb612df`). Fees in the container were `CB_MAKER_FEE_BPS=50` and `CB_TAKER_FEE_BPS=90`. Six months, one pair at a time. Fixed-target net is closed trades (`score.netUsd`). Trailing-stop net is mark-to-market equity (`breakout.returnUsd`), which includes an open position when one is still on. The 10 and 10 column replays the same fills. Max drawdown is peak to trough as a fraction of peak equity. Each pair's bankroll is $2,000.

| Pair | Fixed trades | Fixed win | Fixed net 50/90 | Fixed net 10/10 | Fixed drawdown | Trail trades | Trail win | Trail net 50/90 | Trail net 10/10 | Trail drawdown | Missed | Signals | Miss rate |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| UNI | 252 | 31.7% | -$1,391.04 | $165.41 | 75.3% | 20 | 30.0% | $379.11 | $527.53 | 8.24% | 1 | 21 | 4.8% |
| NEAR | 252 | 31.0% | -$1,389.16 | $133.80 | 77.5% | 19 | 21.1% | $449.66 | $194.51 | 15.05% | 2 | 22 | 9.1% |
| BCH | 246 | 24.4% | -$1,606.97 | -$392.07 | 82.9% | 16 | 12.5% | $128.09 | $8.06 | 8.30% | 3 | 20 | 15.0% |
| SUI | 289 | 23.9% | -$1,448.42 | -$217.55 | 73.6% | 21 | 14.3% | -$77.19 | $23.93 | 9.55% | 4 | 25 | 16.0% |
| AVAX | 252 | 28.6% | -$1,149.16 | -$119.76 | 62.2% | 18 | 16.7% | -$11.27 | $75.85 | 7.72% | 3 | 21 | 14.3% |
| ARB | 225 | 32.4% | -$710.66 | -$35.56 | 42.9% | 17 | 41.2% | $159.87 | $222.93 | 5.36% | 2 | 19 | 10.5% |
| Six books | 1,516 |  | -$7,695.42 | -$465.73 |  | 111 |  | $1,028.25 | $1,052.82 |  | 15 | 128 | 11.7% |

NEAR still has one open breakout (20 buys, 19 closed trades). The other five closed every breakout.

Adoption:

1. Pass. Combined trailing net is $1,028.25.
2. Pass. Trailing net beats the fixed target on all 6 pairs.
3. Fail. NEAR drawdown is 15.05%, which is not under 15%. The other five are under 15%.
4. Pass. Missed entries are 15 of 128 signals (11.7%), and no pair is at or above half.
5. Pass. 111 closed breakout trades.

Rule 3 failed. The live exit stays the fixed target. Parameters were not changed and the run was not repeated.

The dashboard at `http://localhost:3000/paper/backtest` shows the UNI 6 month book with the Breakout tile ($379.11), the buy and sell squares, and the Fixed target vs Trailing stop table.
