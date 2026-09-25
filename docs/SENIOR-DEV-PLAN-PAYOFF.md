---
name: Restore a real payoff
overview: "Make a winning trade worth at least twice a stopped trade after fees, enter only with the trend, and hold long enough for that target to exist. The $500 a month goal is the business target, not a test assertion."
todos:
  - id: payoff-table
    content: Set each take-profit to 4 times that pair's 4-hour sigma and refuse a book whose after-fee winner is under twice the after-fee loser
    status: pending
  - id: gate-entry
    content: Enter on an up EMA stack, and let Jev veto toxic flow, stress, and contraction. Drop the confidence-times-vol yield test
    status: pending
  - id: hold
    content: Stop flattening a long on a confidence dip. Hold until stop, take-profit, toxic veto, contraction, or 24 hours
    status: pending
  - id: fee-compare
    content: Keep 50/90 as the live assumption and add a 10/10 column on the backtest so the fee tier is visible
    status: pending
  - id: tests
    content: Update gate, book, and UNI backtest tests. Do not raise notionals and do not start Kuru
    status: pending
isProject: false
---

# Restore a real payoff

The live process stays [cb/](cb/index.ts). The Kuru demo in [src/](src/index.ts) stays stopped. Do not start the `kuru` compose profile. Do not add another venue. Do not raise clips. Do not lower `CB_FEE_BUFFER` below 1.5.

Jev still only classifies. Code still owns the order. This pass changes when code is allowed to enter, how far the take-profit sits, and how long a long is allowed to live. No middle dots, em dashes, or en dashes in any rendered text. No blinking or pulsing indicators.

## 1. Why the current book cannot make $500

$500 a month is about 4% of the $12,000 bankroll. The engine cannot get there on the current payoff.

Entry hurdle in [cb/gate.ts](cb/gate.ts) prices a maker round trip:

```
hurdleBps = (maker + maker + halfSpread) * feeBuffer
          = (50 + 50 + 1) * 1.5
          = 151.5 bps
```

A stop does not pay that. [cb/paper.ts](cb/paper.ts) flattens a stop and a take-profit as a taker. On UNI, from [cb/books.ts](cb/books.ts), stop is 295 bps and take-profit is 590 bps (2 times sigma) on a $600 clip:

| Exit | Price | Fees (maker in, taker out, 140 bps) | Net |
|---|---:|---:|---:|
| Take profit 590 bps | +$35.40 | $8.40 | +$27 |
| Stop 295 bps | -$17.70 | $8.40 | -$26 |

Breakeven win rate is about 49%. The 1-month UNI backtest was 46% at 1 hour and 48% at 4 hours, and the gate took zero trades. A 51% win rate at this payoff is about $1.25 a trade. $500 would take roughly 400 trades a month. The tape does not offer that.

The same month, holding the $600 UNI clip made about $716. The move was there. The system stood flat, which is the correct output for a coin-flip signal behind a 152 bps toll. Do not "fix" this by loosening the hurdle. The last cut in `feeBuffer` already let losing trades through.

The 4-hour clock makes a wider target useless if it stays. UNI's 4-hour sigma is 295 bps. A target at 4 times sigma is about 1,180 bps, which is several 4-hour windows, not one. `CB_HORIZON_SEC` at 14,400 flattens the trade before that target can hit, and the flatten pays the fee on a small move.

## 2. Take-profit is 4 times sigma

In [cb/books.ts](cb/books.ts), `takeProfitBps` becomes `4 * sigmaBps`. Stops stay at `1 * sigmaBps`. Clips stay put.

| Pair | Sigma | Stop | Take profit | Clip |
|---|---:|---:|---:|---:|
| UNI-USD | 295 | 295 | 1180 | $600 |
| NEAR-USD | 331 | 331 | 1324 | $600 |
| BCH-USD | 242 | 242 | 968 | $500 |
| SUI-USD | 219 | 219 | 876 | $400 |
| AVAX-USD | 227 | 227 | 908 | $400 |
| ARB-USD | 390 | 390 | 1560 | $300 |

Add a pure helper, next to `hurdleAtAssumedSpread`, and call it from `assertPairBooks`:

```
winnerBps = takeProfitBps - makerFeeBps - takerFeeBps
loserBps  = stopLossBps + makerFeeBps + takerFeeBps
```

Refuse to boot when `winnerBps < 2 * loserBps`. At 50 bps maker and 90 bps taker, SUI is the tight one: winner 736 bps, loser 359 bps, ratio about 2.05. A pair that fails the ratio is dropped from the table, not given a looser stop.

`assertTakeProfitClearsFees` in [cb/gate.ts](cb/gate.ts) only checks that take-profit exceeds maker plus taker. Keep that check. The 2-to-1 test is the one that matters, and it belongs on the book because stop and take-profit are per pair.

Update [cb/books.test.ts](cb/books.test.ts) and the UNI expectations in [cb/backtest.test.ts](cb/backtest.test.ts). UNI take-profit is 1180, not 590.

## 3. Code enters the trend. Jev vetoes.

`evaluateGate` in [cb/gate.ts](cb/gate.ts) currently requires `direction_bias === "long"`, confidence at or above `CB_BUY_THRESHOLD` (0.70), regime `expansion`, and `expectedYieldBps(vol, confidence) > hurdle`. That asks the classifier to predict the next 4 hours at 70% confidence. It cannot, so the book does not trade.

Replace the flat-to-long path with all of the following:

- `emaCross === "above"`. The fast average is already over the slow average. This field is on [cb/state.ts](cb/state.ts). Pass it into `GateInput` from [cb/engine.ts](cb/engine.ts) and from the `evaluateGate` call in [cb/backtest.ts](cb/backtest.ts). Refuse with reason `trend` when the stack is not up.
- Jev veto, any one of these refuses the entry: `toxic_flow_risk === "high"` (`toxic flow`), `liquidity_stress === "stressed"` (`liquidity stress`), `market_regime === "contraction"` (`regime`).
- Chase filter. Refuse with reason `chase` when `returnsBps.h4` is already greater than that pair's `stopLossBps`. The easy part of the move is gone. Pass `h4ReturnBps` and `stopLossBps` on `GateInput`.
- Payoff filter. Refuse with reason `payoff` when this pair fails the section 2 ratio at the configured fees. A book that booted has already passed, so this is the backtest and a fee-tier experiment staying honest.
- Existing halt, feed, gross cap, and dust refusals stay.

Remove the entry dependence on `direction_bias`, on `buyThreshold`, and on `expectedYieldBps`. Keep computing `expectedYieldBps` on the result so old rows and the diagnostics still have a number. An approved entry records `action: "buy"` because code entered. The vector, including Jev's own `direction_bias` and confidence, stays on `decisions.state` so the resolver and the report can still score the classifier. Do not change [cb/resolver.ts](cb/resolver.ts).

`classifyDeterministic` in [cb/model.ts](cb/model.ts) stays the mock and the backtest classifier. Do not retune its weights in this pass. The gate is what changes which of its calls become orders.

Update the Jev prompt in the same file so the questions match the job. Regime, toxic flow, and liquidity stress are vetoes. Direction is recorded and is not the order. Do not ask Jev for a price target or a fee.

## 4. Hold until the target can exist

While the pair is long, `evaluateGate` must not flatten because confidence fell through `sellThreshold`. The test "sold when confidence is 0.4" in [cb/gate.test.ts](cb/gate.test.ts) is the behavior to delete. A confidence dip is how a 4-sigma target gets scratched for a fee.

Flatten a long only when:

- the kill switch or halt is on (`halt`)
- toxic flow is high (`toxic flow`)
- regime is contraction (`regime`)
- the 1-second stop or take-profit in [cb/paper.ts](cb/paper.ts) trips
- the hold clock expires

Set the hold clock to 24 hours: `CB_HORIZON_SEC=86400`. That is the position timer in the paper broker, not a new decide cadence. `CB_DECIDE_SEC` stays 300. Measured outcomes stay at 1 hour, 4 hours, and 24 hours. A 4-sigma UNI target is about four typical 4-hour moves, so a 4-hour flatten made the target decorative.

Stops and take-profits still cross immediately. Signal-style exits are no longer the path that opens the trade, and they are no longer the path that closes it, except the contraction veto and the 24-hour clock. Those two may rest post-only first, then cross if they do not fill, which is the existing horizon behavior. Price them as taker in the section 2 ratio anyway. If they often fill as maker, the live ratio is better than the guard, and that is acceptable.

## 5. Fees stay a column, not a silent default change

Leave `CB_MAKER_FEE_BPS` at 50 and `CB_TAKER_FEE_BPS` at 90. That is the assumption the paper book has been judged on. Do not pretend the intro tier is 10 bps.

On the backtest result, add one comparison row per pair: the same candles, same entries, replayed at 10 bps maker and 10 bps taker. Put it on `diagnostics` (a `lowFeeNetUsd` number is enough) and show it in the Fees and fills column of [web/src/app/paper/backtest/page.tsx](web/src/app/paper/backtest/page.tsx). At 10 and 10, UNI's winner is about 1,160 bps and the loser about 315, which is where a modest win rate can pay. At 50 and 90, the 4-sigma target is what keeps the ratio above 2. The screen should make that difference obvious so nobody loosens the live fee assumption to chase $500.

Do not size the clips up in this pass. One full stop across all six books is about $120. Ruin is not the constraint. Raise notionals only after a paper month with fills and a positive net.

## 6. What not to change

- Kuru, `src/`, and the compose profile `kuru`.
- `feeBuffer` of 1.5, the depth participation cap, and the gross cap.
- The promotion gate in the Coinbase spec: 200 resolved decisions at the traded horizon, Wilson lower bound above 52%, net above zero, drawdown under 15% of that pair's bankroll. The traded horizon for that sentence is now 24 hours.
- Dashboard chrome beyond the new take-profit numbers (they already render from the payload) and the low-fee net figure. New refuse reasons `trend`, `chase`, and `payoff` are plain words. The paper desk already prints `reason`.

## 7. Tests

`bun test cb/books.test.ts cb/gate.test.ts cb/backtest.test.ts cb/engine.test.ts cb/paper.test.ts`

Required cases:

- Every enabled book has take-profit equal to 4 times sigma, and winner bps at least twice loser bps at 50 and 90.
- A book with take-profit at 2 times sigma fails `assertPairBooks` at those fees.
- Flat, EMA not above: refuse `trend`, even when confidence is 0.9 and regime is expansion.
- Flat, EMA above, toxic high: refuse `toxic flow`.
- Flat, EMA above, 4-hour return already past the stop: refuse `chase`.
- Flat, EMA above, vetoes clear, payoff holds: approve, and `direction_bias` may be `flat`.
- Long, confidence 0.2, regime still expansion, toxic low: stay long.
- Long, regime contraction: flatten.
- Stop and take-profit still trip on the 1-second check from the fee-inclusive entry, and they still cross.
- UNI `backtestRisk` reports stop 295, take-profit 1180, notional 600.

Then `docker compose up -d --build cb` with no `--profile kuru`. Confirm `GET /health`. Run `GET /backtest?months=1&pair=UNI-USD` and read the header on `http://localhost:3000/paper/backtest`: clip $600, stop 295 bps, take profit 1180 bps.

## 8. Done when

1. Boot refuses a pair whose take-profit does not pay twice the stop after maker plus taker.
2. A long is not closed because the next classify lost confidence.
3. The hold clock is 24 hours, and the decide cadence is still 300 seconds.
4. The UNI 1-month backtest shows take-profit 1180 and a low-fee net next to the 50/90 net.
5. Kuru is still stopped.

$500 in a calendar month is not a unit test. It is two of these books catching a trend the size of the last UNI month, with losers that cost half of what the winners pay. A chop month should still print about $0. If the 50/90 backtest nets under zero after this payoff is in place, the next decision is the fee tier, not another threshold tweak.
