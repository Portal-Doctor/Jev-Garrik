---
name: Profitability
overview: "Fees, the unused toxic veto forward-return test, and a NEAR clip cut to re-score breakout adoption. Largest lever first. Do not change the live 50/90 default. Do not move the 15% drawdown limit. Do not start Breakout phase 2 unless all five adoption rules pass after the NEAR clip change."
todos:
  - id: fee-tier
    content: Replay locked breakout and HTF fixed-target on the 6-month tape at the real Coinbase Advanced Trade US spot tiers. Table net per pair and per month, 30-day volume required, and whether this book's turnover can reach each tier. Live 50/90 stays the default
    status: pending
  - id: veto-forward
    content: Compare 1h and 4h forward returns of toxic-vetoed versus clear decisions per pair on /report. If vetoed is not worse, delete the toxic veto rather than tune it. That may moot the PR 9 band work
    status: pending
  - id: near-clip
    content: Re-run the 6-month six-pair breakout adoption table with the NEAR clip halved. Re-score all five rules. Do not move the 15% drawdown limit. If rule 3 still fails, report and stop
    status: pending
isProject: false
---

# Profitability

The live process stays [cb/](cb/index.ts). The Kuru demo in [src/](src/index.ts) stays stopped. Do not start the `kuru` compose profile.

Jev still classifies. Code still owns the order. No middle dots, em dashes, or en dashes in any rendered text. No blinking or pulsing indicators.

Brian approved this work order on 2026-09-29 after merging [PR 9](https://github.com/Portal-Doctor/Jev-Garrik/pull/9). Priority is the order below. Record every table under Result in this file.

## Locked

Do not change:

- Live fee defaults (`CB_MAKER_FEE_BPS=50`, `CB_TAKER_FEE_BPS=90`). They stay the judged default until Brian moves them after the fee-tier table.
- Stops, the payoff 2 to 1 check, the 4 sigma take-profit, the gross cap, the kill switch.
- The 5 minute decide cadence and the 24 hour hold clock.
- Breakout knobs: `CB_BREAKOUT_BARS=20`, `CB_TRAIL_ATR=3`, `CB_TREND_EMA_BARS=50`, `CB_BREAKOUT_MAX_HOLD_SEC=1209600`.
- Clips for every pair except NEAR in work item 3.

Do not start Breakout phase 2 unless work item 3 makes all five adoption rules pass. Do not shrink NEAR again to force a pass. Do not retune signals or percentiles.

## 1. Fee tier (largest lever)

Replay two books on the same 6-month 5 minute Exchange tape the historical backtest already loads (`loadHistoricalBacktest` months=6):

- Locked breakout: Donchian 20 / trail 3 ATR / EMA 50 / hold 14d, veto on.
- Official HTF fixed-target: 4 hour trend, maker take-profit when `high > takePx`, no toxic flatten.

Do **not** use the invented 10/10 column from the breakout Result table. Do **not** invent a schedule.

Copy the **Coinbase Advanced Trade US spot** maker/taker table from Coinbase's own fees page at execution time (the September 16, 2026 US entry tier is 50 bps maker / 90 bps taker; the first discounted volume step starts at $10,000 trailing 30-day volume). Use Advanced Trade, not a Coinbase Exchange table if the two differ. Include every US Advanced spot tier this account could plausibly reach: the entry 50/90 row, the $10,000 discounted row, and any higher VIP rows whose 30-day volume is within about ten times this book's measured 30-day filled notional. Drop VIP rows that need tens of millions of dollars of volume unless the replay shows that turnover.

For each included tier, state:

- Trailing 30-day USD volume required (Coinbase's published cutoff).
- Maker bps and taker bps.
- This six-pair book's 30-day filled notional at the current clips (sum of entry plus exit notionals on the 6-month tape, scaled to 30 days, or the busiest 30-day window). Say yes or no whether that turnover can reach the cutoff.

Produce two result tables, one per book:

- Net USD per pair at each tier.
- Net USD per calendar month (six months) at each tier, six pairs combined.

Keep `CB_MAKER_FEE_BPS` and `CB_TAKER_FEE_BPS` at 50/90 in compose and `.env`. A replay helper may take maker/taker as arguments. Changing the live default is a later Brian decision.

## 2. Section 3 veto forward-return test

[docs/SENIOR-DEV-PLAN-HOLD-THE-TREND.md](docs/SENIOR-DEV-PLAN-HOLD-THE-TREND.md) section 3 already requires this and it has never been the decision input:

> After 7 days, compare the forward 1 hour and 4 hour returns of decisions where the toxic veto fired against those where it did not, per pair. If vetoed decisions are not worse, delete the toxic veto rather than tune it. Put that comparison on `/report`.

`/report` already has `holdTrend.forwardH1` and `forwardH4` (vetoed versus clear). Finish that so the live report and the paper report page show, per pair, for the current run and the last 24 hours (and a 7-day block once the tape is that long):

- n and mean forward 1 hour bps, vetoed vs clear.
- n and mean forward 4 hour bps, vetoed vs clear.
- A one-line call: vetoed worse, vetoed not worse, or no sample.

**Decision rule (do not tune instead):**

- If, per pair, the mean 1 hour and 4 hour move after a toxic veto is not worse than after a clear decision (or the sample is too small to tell after 7 days), **delete the toxic veto**. Do not raise the percentile, do not widen the ring, do not retune to hit a 5 to 30% band.
- If vetoed decisions are worse, keep the veto and say so.

Note: deleting the toxic veto may **moot** the PR 9 band work (warm seed, `rule_degenerate`, amended 5 to 30% check). Do not implement those band items in this pass until this test has a call. If the test says delete, the band work is cancelled rather than completed.

Stress veto is out of scope unless the same table is cheap to show beside toxic. Do not delete contraction.

## 3. NEAR clip sizing to unblock breakout phase 2

Brian approves changing the NEAR clip for this purpose. That overrides "do not change clips" in earlier plans **for NEAR only**.

Current NEAR row in [cb/books.ts](cb/books.ts): `notionalUsd: 600`, stop 331 bps, take-profit 1324 bps. Halve the clip to `notionalUsd: 300`. Do not change NEAR stop, take-profit, or sigma. Do not change any other pair's clip.

Re-run the 6-month six-pair locked breakout book at live 50/90 (not a fee-tier sweep). Record the same adoption table shape as [docs/SENIOR-DEV-PLAN-BREAKOUT-TRAIL.md](docs/SENIOR-DEV-PLAN-BREAKOUT-TRAIL.md) Result (trades, win, net, drawdown, missed, signals).

Re-score all five adoption rules honestly:

1. Breakout net after fees above zero across the six pairs combined.
2. Breakout net beats the fixed-target net on at least 4 of the 6 pairs.
3. Breakout max drawdown stays under 15% of each pair's bankroll. **Do not move this 15% limit.**
4. Missed entries under half of breakout signals.
5. At least 30 breakout trades across the six pairs.

Percentile and knob defaults stay locked (20 / 3 / 50 / 14d). This is a risk-sizing change, not a signal retune.

If halving NEAR still fails rule 3, report that and **stop**. Do not cut the clip again, do not drop NEAR from the live set, and do not start phase 2.

If all five pass, phase 2 still needs its own plan. Do not implement phase 2 in this PR.

## Correlation (record, do not act)

The six pairs are highly correlated. The HTF 12 hour review had all six rise in the same three legs. Per-pair drawdown limits do not capture portfolio risk. A wider or less correlated universe is the next structural question. Do not add pairs, do not change the cap, and do not build a portfolio DD rule in this pass.

## What not to change

Fees in the running engine, stops, payoff 2 to 1, gross cap, kill switch, decide cadence, breakout knobs listed above, clips other than NEAR, Kuru, `src/`.

## Result

Empty until the three items land. Put the fee-tier tables, the veto forward-return call (keep or delete), and the NEAR-halved adoption table here.
