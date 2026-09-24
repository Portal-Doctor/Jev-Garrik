---
name: Six-pair Coinbase paper book
overview: "Replace the single SOL-USD paper book with six liquid Coinbase pairs whose 4-hour move can clear a post-only fee hurdle, scale stops and size to each pair, and expose per-pair feedback so later knobs are chosen from data."
todos:
  - id: pair-config
    content: Add a typed per-pair book (sigma, stop, take-profit, notional, max concurrent) and set CB_PAIRS to the six names
    status: pending
  - id: hurdle-stop
    content: Keep the 1.5x maker-plus-maker hurdle, scale stop and take-profit to each pair's 4-hour sigma, and refuse a pair whose live sigma cannot cover the hurdle at 80% confidence
    status: pending
  - id: timing
    content: Keep decideSec at 300s, stagger the six pairs by 50s, keep the 4h traded horizon, and add 30m plus 2h measured horizons
    status: pending
  - id: allocation
    content: Raise bankroll to 12000, cap total open notional at 3000, and size each pair from last-day volume so the six clips stay inside 25% of near-touch depth
    status: pending
  - id: feedback
    content: Persist per-pair gate reasons, hold time, stop versus take-profit versus horizon exits, and a weekly pair score that can demote a book
    status: pending
  - id: backtest-ui
    content: Replay all six pairs on the same 5-minute window, show six pair cards, and do not start Kuru
    status: pending
isProject: false
---

# Six-pair Coinbase paper book

The live process stays `[cb/](cb/index.ts)`. The Kuru demo in `[src/](src/index.ts)` stays stopped. Do not start the `kuru` compose profile. Do not add Hyperliquid, Bybit, or any venue that is not Coinbase Advanced Trade. Do not invent L2 history.

This is not a pair-list change. SOL-USD cannot clear the current fee hurdle on a normal day, and a more volatile coin with the same 150 bp stop gets flattened by ordinary noise. The senior developer owns the per-pair risk table, the cadence, the bankroll split, and the measurement surfaces that decide which of the six stay on after the first week.

Jev still only classifies. Code still owns fees, size, stop, take-profit, and whether an order posts. No middle dots, em dashes, or en dashes in any rendered text. No blinking or pulsing indicators.

## 1. Premise the change has to keep true

The engine makes money only when three numbers line up.

1. Expected yield `horizonVolBps * max(0, 2 * confidence - 1)` is larger than `hurdleBps`.
2. Realized move after fees is still positive more often than the losers and the stops wipe the winners.
3. Sample size is large enough that a later knob change can be judged. Promotion still needs 200 resolved decisions at the traded horizon, Wilson lower bound above 52%, net P and L above zero, drawdown under 15% of that pair's bankroll, and fewer than one feed incident per day (`[docs/SPEC-COINBASE.md](docs/SPEC-COINBASE.md)` section 9).

Current defaults in `[cb/config.ts](cb/config.ts)` fail (1) on SOL and fail (2) on any coin whose 4-hour sigma is much larger than 150 bps.

```
hurdleBps = (makerFeeBps + makerFeeBps + halfSpreadBps) * feeBuffer
          = (50 + 50 + 1) * 1.5
          = 151.5 bps
```

At `CB_BUY_THRESHOLD = 0.60` the confidence edge is 0.20, so a 4-hour sigma of about 760 bps is required. No liquid Coinbase pair has that as a typical move. The book therefore only trades volatility bursts, then pays 50 bp in and 50 or 90 bp out.

Do not lower `feeBuffer` below 1.5 in this pass. The last 2.5 to 1.5 cut already let 175 SOL trades through in one month and they lost about $1,906 after fees. A lower multiplier would raise fill count, not revenue.

## 2. The six pairs

Source: Coinbase Exchange hourly candles, 9 Sep 2026 through 23 Sep 2026, 83 non-overlapping 4-hour close-to-close returns. Volume is the last 24 hours of close times base size.

| Pair | 4h sigma (bps) | Median \|4h\| (bps) | Share of windows > 152 bps | Last-day volume | Min p(buy) to clear 152 bps | Why it is in |
|---|---:|---:|---:|---:|---:|---|
| UNI-USD | 295 | 153 | 53% | $64M | 76% | Liquid enough for a $500 clip, sigma clears the hurdle once conviction is real |
| NEAR-USD | 331 | 198 | 61% | $70M | 73% | Same, slightly larger move |
| BCH-USD | 242 | 95 | 31% | $62M | 81% | Large tape, quieter than UNI, still above the hurdle on a strong day |
| SUI-USD | 219 | 95 | 35% | $35M | 85% | Already named in SPEC-COINBASE. Keep it. |
| AVAX-USD | 227 | 93 | 30% | $21M | 83% | Same class as SUI, independent enough of SOL to add information |
| ARB-USD | 390 | 188 | 63% | $13M | 69% | Largest liquid 4-hour move. Smallest clip. The canary for "vol without depth" |

Leave out:

- SOL-USD, ETH-USD, BTC-USD. Typical 4-hour sigma is 129, 107, and 82 bps. A certain call still sits under 152 bps.
- XRP-USD. Sigma 157 bps needs about 98% confidence. That is a coin that almost never trades, not a sixth book.
- WIF-USD, PEPE-USD, BONK-USD, MOG-USD. The move is large and last-day volume is a few million dollars or less. A post-only $500 to $1,000 clip is the book.
- DOGE-USD. Named in the old SPEC list. Sigma 141 bps, still under the hurdle on a median day.

Default env:

```
CB_PAIRS=UNI-USD,NEAR-USD,BCH-USD,SUI-USD,AVAX-USD,ARB-USD
```

Feed already subscribes every configured pair on one socket (`[cb/feed.ts](cb/feed.ts)`). Engine already staggers decide calls (`[cb/engine.ts](cb/engine.ts)`). Broker already splits bankroll by pair count (`[cb/paper.ts](cb/paper.ts)`). The missing piece is a per-pair risk table. A single `CB_STOP_LOSS_BPS=150` across these six is the bug.

## 3. Hurdle, stop, and take-profit

Keep one fee hurdle for every pair. Coinbase Advanced maker is still 50 bps in this paper book until a real VIP schedule is wired. Do not pretend a pair is cheaper because it is more volatile.

```
feeBuffer              1.5
makerFeeBps            50
takerFeeBps            90
hurdleBps              (50 + 50 + liveHalfSpread) * 1.5
buyThreshold           0.70
sellThreshold          0.40
```

Buy threshold moves from 0.60 to 0.70. At 0.70 the edge is 0.40, so the 4-hour sigma must be at least `hurdle / 0.40`, about 380 bps at a 1 bp half spread. ARB's measured sigma is 390. UNI, NEAR, BCH, SUI, and AVAX will still refuse most hours and only clear when live `horizonVolBps` is above their own median. That is the intended behavior: fewer entries, each one a real expansion.

Add a live vol floor inside `[cb/gate.ts](cb/gate.ts)` before the yield check:

```
minHorizonVolBps = hurdleBps / max(0, 2 * buyThreshold - 1)
```

If `horizonVolBps` is below that floor, refuse with reason `quiet`. Do not wait for Jev to invent a 99% call on a 90 bp tape. Persist the reason. The dashboard must show `quiet` as its own count, not lump it into `yield`.

Stop and take-profit scale with the pair's measured 4-hour sigma, not with the fee stack.

| Pair | Stop (bps) | Take-profit (bps) | Rule |
|---|---:|---:|---|
| UNI-USD | 295 | 590 | stop = 1.0 sigma, take-profit = 2.0 sigma |
| NEAR-USD | 331 | 662 | same |
| BCH-USD | 242 | 484 | same |
| SUI-USD | 219 | 438 | same |
| AVAX-USD | 227 | 454 | same |
| ARB-USD | 390 | 780 | same |

Take-profit must still clear maker plus taker (`assertTakeProfitClearsFees` in `[cb/gate.ts](cb/gate.ts)`). 438 bps is above 140. Keep that assert.

A stop of 1.0 sigma means a normal 4-hour draw does not automatically become a taker flatten. The current 150 bp stop is 0.38 to 0.68 sigma on these six, which is why more volatility would have made the book worse.

Do not hardcode the table in `evaluateGate`. Put it in a new `[cb/books.ts](cb/books.ts)`:

```
export interface PairBook {
  pair: string;
  sigmaBps: number;       // 14-day 4h close-to-close, refresh weekly from candles
  stopLossBps: number;
  takeProfitBps: number;
  notionalUsd: number;
  maxOpen: 1;
}
```

`[cb/paper.ts](cb/paper.ts)` and `[cb/engine.ts](cb/engine.ts)` read stop, take-profit, and notional from `PairBook`, not from a single config number. Global env stays the fallback for tests that construct a one-pair broker.

Boot must refuse to start when any configured pair is missing from the table, when take-profit is at or below maker plus taker, or when `stopLossBps` is below `hurdleBps` at a 2 bp assumed spread. A stop tighter than the entry hurdle recreates the SOL failure mode.

## 4. Timing

Keep `CB_DECIDE_SEC=300`. Jev is one classify per pair per cycle. Six pairs at 300s is 12 calls per hour, 288 per day, about 2,000 per week. That is the sample the promotion gate needs. Do not decide every N blocks. Do not drop below 60s. A 60s cadence on six pairs is 8,640 Jev calls per day and still cannot clear a 152 bp hurdle on a 60s hold.

Stagger is already `decideSec * 1000 * i / n`. With six pairs that is 50 seconds. Keep it. Confirm `DECIDE_DEADLINE_MS` (25,000) stays below the stagger so a hung UNI call cannot collide with NEAR.

Keep `CB_HORIZON_SEC=14400`. The 4-hour window is the one the sigma table was built on. Changing it in the same pass as the pair list mixes two experiments.

Add two scored-only horizons so later timing changes have data:

```
MEASURED_HORIZONS_SEC = [1800, 3600, 7200, 14400, 86400]
```

1 hour, 4 hour, and 24 hour already exist. 30 minute and 2 hour are the missing rungs between "too short for fees" and "the traded hold". Resolver, report, and the paper report page already iterate `MEASURED_HORIZONS_SEC`. Extend the UI horizon cells. Do not trade the new rungs.

Entry timeout stays 120s, post-only, no taker convert. Signal and horizon exits stay maker-first. Stops and take-profits stay immediate taker. That split is honest and it is what the last backtest assumed.

Broker tick stays 1s. That is the only clock the stop may use. Do not evaluate stops on the 300s decide.

After seven days, the horizon comparison already specified in SPEC-COINBASE section 11.6 decides whether `CB_HORIZON_SEC` should move. The winner is the horizon whose hypothetical net P and L, after the same fee stack, is highest with n at least 200. Do not pre-commit to 2 hours because ARB looks fast.

## 5. Allocation

Current: `$10,000` bankroll, `$1,000` notional, one pair. Six times $1,000 with the same bankroll is 60% deployed if every book is long, and ARB cannot host that clip.

Target paper book:

```
CB_BANKROLL_USD=12000
CB_MAX_GROSS_USD=3000
CB_DAILY_LOSS_USD=900
```

Per-pair notional, set so a $1,000 idea is reserved for the deepest tapes and the thinnest tape cannot take a tenth of the bankroll.

| Pair | Notional | Pair bankroll (bankroll / 6) | Last-day volume / notional |
|---|---:|---:|---:|
| UNI-USD | $600 | $2,000 | 107,000 |
| NEAR-USD | $600 | $2,000 | 117,000 |
| BCH-USD | $500 | $2,000 | 124,000 |
| SUI-USD | $400 | $2,000 | 88,000 |
| AVAX-USD | $400 | $2,000 | 53,000 |
| ARB-USD | $300 | $2,000 | 43,000 |

Sum of notionals is $2,800, under the $3,000 gross cap. One pair, one position. No pyramiding. `maxOpen = 1` per pair.

`[cb/paper.ts](cb/paper.ts)` currently does `perPairBankroll = bankroll / n` and sizes from `opts.notionalUsd`. Change size to `books.get(pair).notionalUsd`, then `min(that, participation * depthUsd, remainingGross)`. `remainingGross` is `CB_MAX_GROSS_USD` minus the mark of every open long. If the residual is under `CB_MIN_SIZE_USD`, refuse with reason `gross cap`.

Daily kill stays on total realized P and L, including fees (`[cb/kill.ts](cb/kill.ts)`). $900 is 7.5% of the $12,000 book, about one bad ARB day plus fees, not a full wipe. Flatten still works when the kill is on.

Do not raise notionals until the pair's own promotion gate is green. The first week is measurement capital.

## 6. Feedback that can change the next week

The current report is already the right skeleton (`[cb/report.ts](cb/report.ts)`): Wilson, Brier, calibration, edge, capture, maker-fee sensitivity, five promotion booleans. It is missing the counts that explain why a pair did not trade, and it is missing a demote rule.

Add a `PairDiagnostics` block to `GET /report`, one object per pair.

```
decisions
approved
refused.quiet
refused.yield
refused.toxic
refused.stress
refused.regime
refused.bias
refused.confidence
refused.dust
refused.grossCap
fills.entry
fills.exitSignal
fills.exitHorizon
fills.stop
fills.takeProfit
holdMs.p50
holdMs.p90
makerFeesUsd
takerFeesUsd
netUsd
grossUsd
edgeRatio          # same definition as cb/metrics.ts predictiveEdge
stopRate           # stops / entries
takeProfitRate
adverseNextHour    # next hour close below entry, entries only
```

Persist `gate.reason` on the decision row. It is already inside `state` JSON (`[cb/index.ts](cb/index.ts)`). Do not make the UI parse that blob. Lift `reason` and `approved` onto the decision event and the `/decisions` payload.

Add a weekly pair score, computed in `buildReport`, not in Jev:

```
score = 0
+ 2 if netUsd > 0
+ 1 if edgeRatio > 1.30
+ 1 if stopRate < 0.35
+ 1 if takerFillShare < 0.25
+ 1 if quiet refusals are not the majority of refusals
- 2 if netUsd < 0 and fills.entry >= 20
- 2 if maxDrawdownPct > 15
```

A pair at or below 0 after 7 days and at least 20 entries is demoted: `enabled: false` in `[cb/books.ts](cb/books.ts)`, process restart, no code comment as a feature flag. Replacement candidates, in order, if a seat opens: XRP-USD only if the buy threshold experiment is dropped, then TIA-USD, then nothing. Do not add a seventh live pair in the same week.

Backtest must run the same six books on the same 5-minute Coinbase window (`[cb/backtest.ts](cb/backtest.ts)`). `GET /backtest?months=1` today uses `config.pairs[0]`. Change it to accept `pair=` (already there) and add `GET /backtest/all?months=1` that returns an array of six `BacktestResult` objects plus a totals row. Cache key stays `pair:months`. Sequential, not parallel, so Coinbase candle rate limits do not 429 the box.

UI (`[web/src/app/paper/page.tsx](web/src/app/paper/page.tsx)`):

- Six pair cards, already mapped from `config.pairs`. Confirm they render UNI through ARB without assuming two-decimal prices. `fmtPrice` already scales.
- Each card shows last reason, hurdle, live `horizonVolBps`, armed stop and take-profit, and time to next decide.
- Decision log shows pair, action, approved or reason, p(buy), mid. Fills stay empty when the gate refuses. Do not treat a buy tag as a fill. That confusion is why this plan exists.
- Report page: one promotion gate per pair, plus the diagnostics table above, plus the 30m / 1h / 2h / 4h / 24h comparison.
- Backtest page: a pair picker, then the existing scorecard.

Do not add a Kuru card, a Kuru report, or a Kuru tax row.

## 7. File-level work

| File | Change |
|---|---|
| `[cb/books.ts](cb/books.ts)` | New. Pair table, vol floor helper, boot asserts. |
| `[cb/books.test.ts](cb/books.test.ts)` | Table completeness, take-profit above fees, stop at or above hurdle, unknown pair throws. |
| `[cb/config.ts](cb/config.ts)` | Default pairs, bankroll 12000, maxGross 3000, dailyLoss 900, buyThreshold 0.70, measured horizons include 1800 and 7200. |
| `[.env.example](.env.example)` | Same keys. |
| `[cb/gate.ts](cb/gate.ts)` | `quiet` refuse. Stop and take-profit stay arguments, not globals. |
| `[cb/engine.ts](cb/engine.ts)` | Pass per-pair notional and depth. Record reason on the decision event. |
| `[cb/paper.ts](cb/paper.ts)` | Per-pair stop, take-profit, notional. Gross cap. |
| `[cb/index.ts](cb/index.ts)` | Wire `books` into broker and engine. Boot assert. |
| `[cb/report.ts](cb/report.ts)` | `PairDiagnostics`, weekly score, extra horizons. |
| `[cb/backtest.ts](cb/backtest.ts)` | Use the pair's stop and notional. `/all` helper. |
| `[cb/server.ts](cb/server.ts)` | `GET /backtest/all`. Idle timeout already 120. |
| `[docs/SPEC-COINBASE.md](docs/SPEC-COINBASE.md)` | Pair list, per-pair guards, new horizons, diagnostics. |
| `[web/src/lib/paperTypes.ts](web/src/lib/paperTypes.ts)` | Reason, diagnostics, extra horizons. |
| `[web/src/app/paper/page.tsx](web/src/app/paper/page.tsx)` | Reason on the card and in the log. |
| `[web/src/app/paper/report/page.tsx](web/src/app/paper/report/page.tsx)` | Per-pair diagnostics and score. |
| `[web/src/app/paper/backtest/page.tsx](web/src/app/paper/backtest/page.tsx)` | Pair picker. |

Do not edit `[src/](src/)`. Do not edit `[docs/SPEC.md](docs/SPEC.md)`.

Tests: `bun test cb/books.test.ts cb/gate.test.ts cb/paper.test.ts cb/engine.test.ts cb/report.test.ts cb/backtest.test.ts`. Then `docker compose up -d --build cb` with no `--profile kuru`. Then `GET /health`, `GET /report`, and one `/backtest?months=1&pair=UNI-USD`.

Verify the six cards and the reason log in the browser. A screenshot is not verification. Confirm a refused buy stays out of Fills.

## 8. What "revenue generating" means in week one

This is still paper. Revenue here means the fills ledger's net P and L, after maker and taker fees and inference, is above zero on the six-pair book, and at least one pair has a weekly score above 0 with 20 or more entries.

A pair that does not trade is not a failure if `quiet` is the reason and live sigma is below the vol floor. That is the engine doing its job. A pair that trades and dies on stops is a table bug: stop is still too tight. A pair that trades, has expectancy above 1.30, and still loses money is a fee bug: hurdle or clip size is wrong. Those three buckets are the only optimization inputs for week two.

Week two, only after the report has n, is allowed to change one knob: either `CB_HORIZON_SEC` to the winning measured horizon, or one pair's notional by at most $100, or one pair's stop by at most 0.25 sigma. Not all three.

## 9. Acceptance

1. Process starts with exactly the six pairs above. SOL is absent.
2. A 60% long on a 130 bp UNI tape is refused `quiet`. The same tape at 90% is still refused if `130 * 0.80 < hurdle`.
3. A 90% long on a 400 bp ARB tape posts a $300 post-only bid, stop 390 bps, take-profit 780 bps.
4. Five concurrent approved entries cannot exceed $3,000 gross.
5. `GET /report` returns diagnostics and a score for each pair, and 30m plus 2h horizon rows.
6. `/paper` shows six cards and prints the gate reason next to every buy or sell. Fills stay empty until the broker prints.
7. Kuru is not in the side menu, not in compose, and not started.
8. One-month UNI backtest returns a non-empty scorecard with the UNI stop and notional, not the old 150 / 1000 SOL values.
