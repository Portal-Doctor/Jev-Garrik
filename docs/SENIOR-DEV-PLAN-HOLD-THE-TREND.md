---
name: Hold the trend
overview: "The 12 hour review showed the book could not hold a move. The toxic flow veto fires on about 98% of decisions and flattens every long within one 5 minute cycle, and the trend filter reads a 20 minute average that points down on every dip. Fix those two, rest the take-profit as a maker order, and measure sizing before touching it."
todos:
  - id: exit-toxic
    content: Remove toxic flow as a reason to flatten an open long in evaluateGate. Keep halt and contraction
    status: completed
  - id: veto-calibrate
    content: Record Jev's probability of toxic and stressed, veto only above a per-pair rolling 85th percentile, and fall back to the deterministic label until warm
    status: completed
  - id: htf-trend
    content: Add a 4 hour trend state seeded from Coinbase hourly candles at boot, use it for the entry trend check and a post-only trend exit, and stop gating on the 1 minute EMA cross
    status: pending
  - id: maker-tp
    content: Rest a post-only take-profit ask as soon as an entry fills. Stops still cross on the 1 second tick
    status: completed
  - id: backtest-align
    content: Make the fixed-target backtest fill take-profit as maker and use the same 4 hour trend check
    status: pending
  - id: measure
    content: Add veto rate, hold time, take-profit maker share, and sized-versus-clip ratio to /report, then run the 24 hour and 30 day checks in section 8
    status: pending
isProject: false
---

# Hold the trend

The live process stays [cb/](cb/index.ts). The Kuru demo in [src/](src/index.ts) stays stopped. Do not start the `kuru` compose profile. Do not change fees, `CB_FEE_BUFFER`, clips, the stop table in [cb/books.ts](cb/books.ts), or the gross cap.

Jev still classifies. Code still owns the order. No middle dots, em dashes, or en dashes in any rendered text. No blinking or pulsing indicators.

This plan changes two lines of [SENIOR-DEV-PLAN-PAYOFF.md](SENIOR-DEV-PLAN-PAYOFF.md). That plan flattens a long on toxic flow and uses `emaCross` as the trend check. Both are replaced below. The breakout plan, [SENIOR-DEV-PLAN-BREAKOUT-TRAIL.md](SENIOR-DEV-PLAN-BREAKOUT-TRAIL.md), is unchanged. Its phase 2 still waits on its own adoption rule.

## 1. What the 12 hour review found

Window: 2026-09-24 10:32 to 22:32 UTC, run `807a6f33`, model `typesafe-ai/jev`, 821 decisions across six pairs.

| Pair | Oracle | Hold one clip | Engine |
|---|---:|---:|---|
| UNI-USD | $33.67 | $11.18 | no trades |
| NEAR-USD | $131.13 | $55.28 | no trades |
| BCH-USD | $29.29 | $8.27 | one round trip on about $100 |
| SUI-USD | $42.11 | $23.24 | one round trip on about $151 |
| AVAX-USD | $25.88 | $4.11 | one round trip on about $272 |
| ARB-USD | $19.82 | $5.66 | no trades |
| Total | about $282 | about $108 | about -$5 after fees |

All six pairs rose in the same three legs (about 10:35 to 14:30, 15:00 to 16:30, 18:00 to 19:50 UTC). The oracle's largest trade on each pair was the first leg, 500 to 1,360 bps. Holding one clip per pair captured $108 of the $282.

Findings, with the data behind each:

1. **The toxic flow veto is saturated.** Jev returned `toxic_flow_risk: high` on 131 of 133 UNI decisions, 135 of 136 NEAR, 138 of 139 SUI, 138 of 140 AVAX, 138 of 138 ARB. BCH was 67 of 134. `liquidity_stress: stressed` was 55% to 80% on every pair. A label that is on 98% of the time is an off switch.
2. **The toxic flow exit closed every trade within one cycle.** `evaluateGate` flattens an open long on `toxic_flow_risk === "high"` ([cb/gate.ts](cb/gate.ts), the `position === "long"` branch). AVAX in at 13:44, out at 13:49. BCH in at 14:19, out 14:23 to 14:43, before the oracle's sell at 348. SUI in at 21:38, out at 21:43. That is a 5 minute scalp paying about 100 bps a round trip.
3. **The trend check is on the wrong timeframe.** `emaCross` comes from 8 and 21 period EMAs on 1 minute closes in [cb/features.ts](cb/features.ts), so it describes the last 20 minutes. It refused with `trend` at 16 of the oracle's 22 buys. The oracle buys dips, and on a dip that average points down. The 24 hour trend was up on all six, for example SUI `h24` was +719 bps at a `trend` refusal.
4. **Take-profit crosses as taker.** `enforceGuards` calls `takerFlatten` for both `stop` and `take_profit` in [cb/paper.ts](cb/paper.ts). A take-profit is a price the market comes up to. It can rest as a maker ask and pay 50 bps, not 90.
5. **Entries were sized well under the clip.** `depthParticipation` 0.25 of levels 1 to 3 cut entries to $99 to $272 against $300 to $600 clips.
6. **Jev's direction call was under a coin flip at 1 hour.** Hit rate 37% to 49% on every pair, worse when confident (33% to 44%). Jev's p(up) was 0.00 to 0.30 at 21 of the 22 oracle buys. The payoff plan already stopped using direction as the entry. Keep it that way. Only 1 hour could be scored from 12 hours of data.

30 day replay on the same six pairs, 5 minute candles, 50 bps maker and 90 bps taker, book stops:

| Rule | Trades | Net |
|---|---:|---:|
| 8/21 EMA cross in, cross down out (what the current trend check approximates) | 1,225 | -$7,518 |
| RSI under 40 in, RSI over 70 out, no trend filter | 459 | -$1,381 |
| RSI under 40 in an uptrend, taker exit | 148 | -$461 |
| Same entries, resting post-only take-profit | 148 | -$235 |
| Hold one clip each, 30 days | 6 | +$2,323 |

No 5 minute rule clears these fees. The same entries with a maker exit lost half as much. The money is in holding a multi-hour trend, which the current exits cannot do. That was an up month, so every long-biased rule looks better than it would in chop.

## 2. Stop flattening longs on toxic flow

In `evaluateGate`, the `position === "long"` branch becomes:

- `halted` flattens with `halt`.
- `market_regime === "contraction"` flattens with `regime`.
- The 4 hour trend turning down flattens with `trend down` (section 4).
- Otherwise hold.

Toxic flow and liquidity stress are entry vetoes only. The 1 second stop and take-profit in [cb/paper.ts](cb/paper.ts) are unchanged as guards. The 24 hour hold clock (`CB_HORIZON_SEC`) is unchanged.

Update the Jev prompt in [cb/model.ts](cb/model.ts): the `toxic_flow_risk` goal currently says "High toxic flow blocks a new long and flattens an open long." Change it to "blocks a new long."

Delete the gate test that expects a long to flatten on toxic flow. Add one that expects it to hold.

## 3. Calibrate the entry vetoes

`readChoice` in [cb/model.ts](cb/model.ts) already returns per-choice probabilities. Carry two of them onto the vector:

```ts
export interface DecisionVector {
  // existing fields
  toxicPHigh: number;
  stressPStressed: number;
}
```

For the mock and the backtest, set them to 1 or 0 from the deterministic label in `classifyDeterministic`.

New file [cb/vetoes.ts](cb/vetoes.ts), one instance per pair in the engine:

- Keep the last 7 days of `toxicPHigh` and `stressPStressed` per pair in a ring. Seed it from `decisions.state` at boot so a restart does not reset it. The column is JSON text inside JSONB, so read it with `(state #>> '{}')::jsonb`.
- Veto an entry when the current value is above that pair's rolling 85th percentile. That vetoes about 15% of decisions by construction.
- Until a pair has 200 samples, use the deterministic label from `classifyDeterministic` on the same state instead. That label is already what the backtest uses.
- Persist both on `state.gate`: `toxicVeto`, `toxicSource` (`jev` or `rule`), `stressVeto`, `stressSource`.

`market_regime` returned `expansion` on 99% of decisions, so the contraction veto almost never fires. Leave it. It is harmless and it is the one exit Jev still owns.

After 7 days, compare the forward 1 hour and 4 hour returns of decisions where the toxic veto fired against those where it did not, per pair. If vetoed decisions are not worse, delete the toxic veto rather than tune it. Put that comparison on `/report` (section 7) so the decision is visible.

## 4. A 4 hour trend state

The live feed only has history since the last restart, so a 50 bar 4 hour EMA cannot come from the feed.

New file [cb/trend.ts](cb/trend.ts):

- At boot, fetch 12 days of 1 hour candles per pair from Coinbase Exchange (`granularity=3600`). Coinbase has no 4 hour granularity. Aggregate completed 1 hour bars into 4 hour buckets keyed by `floor(ts / 14_400_000)`. Reuse `aggregate` from [cb/breakout.ts](cb/breakout.ts) and `emaNext` from [cb/features.ts](cb/features.ts).
- Refresh once an hour, a few minutes after the hour.
- `trendUp(pair)` is true when the last completed 4 hour close is above the 50 bar 4 hour EMA (`CB_TREND_EMA_BARS`, already in [cb/config.ts](cb/config.ts)) and the 24 hour return is above zero.
- Only completed buckets count. A running bucket never changes the answer.
- If the fetch fails at boot, `trendUp` returns false and the gate refuses with `trend unknown`. Retry on the hourly timer. Do not trade on a missing trend.

In [cb/engine.ts](cb/engine.ts), pass `htfTrendUp: trend.trendUp(pair)` into `GateInput`. In `evaluateGate`:

- Flat: refuse with `trend` when `htfTrendUp` is false. Remove the `emaCross !== "above"` check. Keep `emaCross` on the state so Jev still sees it.
- Long: flatten with `trend down` when `htfTrendUp` is false. This exit rests post-only first and then crosses on the existing horizon path, the same as the contraction exit.

Keep the `chase` refusal (`h4ReturnBps > stopLossBps`) and the payoff 2 to 1 check. With the trend on 4 hours, entries happen whenever vetoes clear inside an uptrend, including on dips. Dips are also where a post-only bid actually fills, which addresses the five canceled BCH entries in the rally.

## 5. Take-profit rests as a maker ask

In [cb/paper.ts](cb/paper.ts):

- When an entry fills (fully, or partially and the entry order is done), place a resting post-only sell at `entry * (1 + takeProfitBps / 10_000)` for the full position, with purpose `take_profit`. `entry` is `Accounting.entryPrice()`, the fee-inclusive average, so the target is the same price `guardPrice` already shows.
- It fills the way any resting maker order fills today: a taker buy print at or above the price, through `crosses()`, with the fill haircut. The fee is maker.
- If the mid is at or above the target and the ask has not filled for 30 seconds (`CB_TP_CROSS_SEC`), cross the remainder as taker. That covers a gap through the level. Record it as `take_profit` with liquidity `taker`.
- `enforceGuards` keeps the stop on the 1 second tick. It no longer calls `takerFlatten` for `take_profit`. A stop trip already cancels the resting order before it crosses, so a resting take-profit is canceled by the stop.
- The broker holds one open order per pair. While long, that slot is the take-profit. A signal exit (contraction, trend down, 24 hour clock) cancels the take-profit and places its own exit.
- `processOrder` currently crosses any open `stop` or `take_profit` order immediately, which exists for restarts. Narrow that to `stop`. A restored `take_profit` stays resting.
- `restore()` must rebuild a resting take-profit for a long that comes back from fills without one.

The payoff check in `payoffLegs` still prices the take-profit exit as taker. Leave it conservative. If take-profits mostly fill as maker, the live payoff is better than the guard assumes.

## 6. Keep the backtest honest to the same rules

In [cb/backtest.ts](cb/backtest.ts), fixed-target strategy only:

- Take-profit fills as maker at `takePx` when `bar.high > takePx`, strictly above, to stand in for queue position. A bar that only touches the level does not fill it.
- Replace the `emaCross` entry check with the same 4 hour trend test from section 4, computed on 4 hour buckets aggregated from the 5 minute candles already loaded. The warm-up is already 10 days.
- A long flattens on the trend turning down, post-only at the close, and no longer on toxic flow.
- Add an assumptions line: "Take-profit rests as a post-only ask and fills only when the high trades through it. Trend is the 4 hour close above its 50 bar EMA with a positive 24 hour return."

The backtest cannot replay Jev, so its vetoes stay the deterministic labels. Say so in the assumptions list, since the live vetoes now use Jev's probability once warm.

The breakout strategy in [cb/breakout.ts](cb/breakout.ts) is not touched.

## 7. Measurement on /report

Add per pair, for the current run and the last 24 hours:

- Toxic veto rate and stress veto rate, and which source (Jev or rule) fired.
- Forward 1 hour and 4 hour return after vetoed versus non-vetoed decisions.
- Hold time: median and max, and a count of longs closed in under 15 minutes.
- Exit mix: stop, take-profit maker, take-profit taker, trend down, contraction, horizon, halt.
- Sized versus clip: median `gate.sizeUsd / notionalUsd` on approved entries.

Show the same numbers as a small block on [web/src/app/paper/report/page.tsx](web/src/app/paper/report/page.tsx). Plain labels, no new routes.

Sizing is not changed in this pass. If the median sized ratio stays under 0.5 after a week of fills that hold, open a separate plan to widen the depth measure (levels 1 to 10, or a share of recent traded volume). A bigger clip on a book that exits in 5 minutes only loses faster.

## 8. Tests and checks

`bun test cb/gate.test.ts cb/vetoes.test.ts cb/trend.test.ts cb/paper.test.ts cb/backtest.test.ts cb/engine.test.ts`

Required cases:

- Long, toxic high, regime expansion, trend up: stays long.
- Long, trend turns down: flattens with `trend down`.
- Flat, 1 minute EMA below but 4 hour trend up and vetoes clear: approved.
- Flat, 4 hour trend down: refused `trend`, whatever `emaCross` says.
- Flat, trend fetch failed: refused `trend unknown`.
- Veto percentile: with 200 samples uniform 0 to 1, a value of 0.9 vetoes and 0.8 does not. Under 200 samples, the deterministic label decides.
- `trendUp` ignores a running 4 hour bucket, and a spike inside it does not flip the answer.
- After an entry fills, a `take_profit` sell rests at the fee-inclusive target. A taker buy print through it fills at maker fee. A mid above target for 30 seconds without a fill crosses as taker.
- A stop trip cancels the resting take-profit and crosses.
- A restart with an open long and a resting take-profit keeps the take-profit resting. It does not cross.
- Backtest: a bar whose high equals the take-profit price does not fill it. A bar whose high exceeds it fills as maker.

Then `docker compose up -d --build cb` with no `--profile kuru`, and confirm `GET /health`.

Checks after deploy:

1. Within 24 hours of live decisions: toxic veto rate between 5% and 30% on every pair, no long closed with reason `toxic flow`, and the median hold of any long over 1 hour.
2. At least 80% of take-profit fills are maker.
3. 30 day backtest on all six pairs, old rules against new rules, same fees. Record both totals in this file under a heading "Result". The new rules must lose less than the old. If they do not, stop and report which change made it worse before moving on to the breakout plan's phase 2.

## 9. What not to change

- Fees, `CB_FEE_BUFFER`, clips, stops, the payoff 2 to 1 check, the gross cap, the kill switch.
- The 5 minute decide cadence and the 24 hour hold clock.
- Jev's direction question. It is recorded and scored, and it does not open trades.
- Kuru, `src/`, and the `kuru` compose profile.

The oracle's $282 is hindsight on every wiggle and is not the target. Holding the move that all six pairs made together is. This pass is done when a long can survive its first five minutes, the trend check stops refusing every dip, and a winning exit pays the maker fee.

## Result

3-month gate (UTC 2026-07 through 2026-09). Pass if at most 2 of those 3 months miss a $300 six-pair closed-trade sum. Fees 50 bps maker / 90 bps taker. Yearly miss budget: 2.

| Book | Jul / Aug / Sep vs $300 | Misses | Gate |
|---|---|---:|---|
| Official breakout Donchian 20 / trail 3 ATR / EMA 50 / hold 14d / veto on (LOCKED) | -124.04 / 269.93 / 480.78 | 2 | PASS |
| Official HTF paper (4h trend, maker take-profit) | -778.59 / -636.81 / -333.23 | 3 | FAIL |
| Sweep 40 / 2 / no-EMA | -153.77 / 387.77 / 151.81 | 2 | PASS, not locked |

Locked defaults stay `CB_BREAKOUT_BARS=20`, `CB_TRAIL_ATR=3`, `CB_TREND_EMA_BARS=50`, `CB_BREAKOUT_MAX_HOLD_SEC=1209600`. August official is $30.07 short of $300; that is one of the two allowed misses. The 6-month tape (2026-04 through 2026-09) is informational only and does not block.

Live §3 vetoes are on (`cb/vetoes.ts`). Historical backtest and breakout still use deterministic labels. Sections 5 and 7 are not in this slice.
