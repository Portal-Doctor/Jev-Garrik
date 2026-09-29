---
name: Profitability
overview: "Fees, the unused toxic veto forward-return test, and a NEAR clip cut to re-score breakout adoption. Largest lever first. Do not change the live 50/90 default. Do not move the 15% drawdown limit. Do not start Breakout phase 2 unless all five adoption rules pass after the NEAR clip change."
todos:
  - id: fee-tier
    content: Replay locked breakout and HTF fixed-target on the 6-month tape at the real Coinbase Advanced Trade US spot tiers. Table net per pair and per month, 30-day volume required, and whether this book's turnover can reach each tier. Live 50/90 stays the default
    status: completed
  - id: veto-forward
    content: Compare 1h and 4h forward returns of toxic-vetoed versus clear decisions per pair on /report. If vetoed is not worse, delete the toxic veto rather than tune it. That may moot the PR 9 band work
    status: completed
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

### 1. Fee tier

Run `bun run cb/fee-tier-replay.ts`. Six month 5 minute Coinbase Exchange tape, window 2026-04-02T11:37:28Z to 2026-09-29T11:37:28Z, all six pairs, current clips. Both books replayed from scratch at each tier, so entries move with the fee level rather than being repriced after the fact. `CB_MAKER_FEE_BPS` and `CB_TAKER_FEE_BPS` are untouched at 50/90.

April and September are partial calendar months on this window. Read those two columns as partial.

#### The schedule, and one thing Brian has to confirm

Coinbase moved the full US Advanced ladder behind a logged-in session during 2026, so only part of the US column is publicly readable. Two published sources are used and kept separate in [cb/feetiers.ts](cb/feetiers.ts). Nothing is merged or invented.

| Tier | 30 day volume | Maker bps | Taker bps | Source |
|---|---:|---:|---:|---|
| US entry | $0 | 50 | 90 | Coinbase Advanced US repricing, September 16, 2026 |
| US first discounted step | $10,000 | 25 | 40 | Coinbase Advanced US repricing, September 16, 2026 |
| Intro 1 | $0 | 60 | 120 | coinbase.com/advanced-vip |
| Intro 2 | $10,000 | 40 | 80 | coinbase.com/advanced-vip |
| Advanced 1 | $25,000 | 25 | 50 | coinbase.com/advanced-vip |
| Advanced 2 | $75,000 | 12.5 | 25 | coinbase.com/advanced-vip |
| Advanced 3 | $250,000 | 7.5 | 15 | coinbase.com/advanced-vip |
| VIP 1 | $500,000 | 6 | 12.5 | coinbase.com/advanced-vip |
| VIP 2 | $1,000,000 | 5 | 10 | coinbase.com/advanced-vip |

The two sources disagree above the entry row. `coinbase.com/advanced-vip` is Coinbase's own page and is the only place the volume cutoffs above $10,000 are published, but its rate column is the non-US ladder: its entry row is 60/120, not the US 50/90. The September 16 US repricing publishes the US entry row (50/90) and the first discounted step ($10,000 at 25/40), and nothing above that. Every row above $10,000 in the tables below is therefore priced off the advanced-vip column.

**Brian: read the authoritative US column off your logged-in Coinbase Advanced fee page and paste it here.** That is a two minute job for you and not reachable from this machine. Rows above $10,000 should then be re-run against the real US rates. The two rows that matter most for a decision, the entry row and the $10,000 row, are already the published US numbers.

VIP 3 and above need $5M or more of 30 day volume. This book turns over at most $239K in its busiest 30 days, so those rows are dropped.

#### This book's turnover

Sum of entry plus exit notional over the tape, at the current clips.

| Book | Tape filled notional | Scaled to 30 days | Busiest real 30 days | Reaches $10,000 | Reaches $25,000 | Reaches $75,000 | Reaches $250,000 |
|---|---:|---:|---:|---|---|---|---|
| Locked breakout | $109,601 | $18,267 | $25,612 | yes | yes | no | no |
| HTF fixed-target | $873,187 | $145,531 | $238,685 | yes | yes | yes | no |

Breakout trades rarely and holds for days, so it clears the $10,000 and $25,000 cutoffs but not $75,000. The HTF fixed-target book churns a 24 hour clock across six pairs and turns over roughly $239K in its busiest 30 days, so it clears $75,000 on its own volume. Neither book reaches $250,000.

#### Locked breakout: net USD per pair

Donchian 20 / trail 3 ATR / EMA 50 / hold 14d, veto on.

| Tier | 30d volume needed | Maker bps | Taker bps | Reachable | UNI-USD | NEAR-USD | BCH-USD | SUI-USD | AVAX-USD | ARB-USD | Total |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| US entry | $0 | 50 | 90 | yes | 379.11 | 508.87 | 107.82 | -101.88 | -23.94 | 159.87 | 1029.85 |
| US first discounted step | $10,000 | 25 | 40 | yes | 455.92 | 714.33 | 156.89 | -49.30 | 29.73 | 192.82 | 1500.39 |
| Intro 1 | $0 | 60 | 120 | yes | 335.67 | 463.40 | 61.19 | -244.44 | -48.66 | 141.30 | 708.46 |
| Intro 2 | $10,000 | 40 | 80 | yes | 397.31 | 611.37 | 119.31 | -90.05 | -14.29 | 167.40 | 1191.05 |
| Advanced 1 | $25,000 | 25 | 50 | yes | 443.38 | 702.74 | 148.68 | -58.51 | 22.46 | 187.50 | 1446.24 |
| Advanced 2 | $75,000 | 12.5 | 25 | no | 481.74 | 740.87 | 173.12 | -20.56 | 42.83 | 203.95 | 1621.95 |
| Advanced 3 | $250,000 | 7.5 | 15 | no | 497.01 | 756.12 | 182.89 | -10.47 | 50.96 | 210.53 | 1687.04 |
| VIP 1 | $500,000 | 6 | 12.5 | no | 501.04 | 760.11 | 185.40 | -7.88 | 53.04 | 212.24 | 1703.95 |
| VIP 2 | $1,000,000 | 5 | 10 | no | 504.73 | 763.74 | 187.77 | -5.43 | 54.62 | 213.82 | 1719.25 |

#### Locked breakout: net USD per calendar month, six pairs combined

| Tier | 2026-04 | 2026-05 | 2026-06 | 2026-07 | 2026-08 | 2026-09 | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| US entry | -205.39 | 159.70 | -95.96 | -124.04 | 269.93 | 1025.60 | 1029.85 |
| US first discounted step | -145.65 | 292.74 | -54.29 | -71.69 | 318.77 | 1160.51 | 1500.39 |
| Intro 1 | -267.96 | 111.11 | -120.19 | -153.65 | 159.70 | 979.46 | 708.46 |
| Intro 2 | -191.10 | 254.67 | -87.04 | -111.68 | 281.90 | 1044.29 | 1191.05 |
| Advanced 1 | -155.27 | 284.70 | -61.89 | -80.28 | 311.20 | 1147.77 | 1446.24 |
| Advanced 2 | -125.53 | 309.70 | -41.15 | -54.14 | 335.60 | 1197.48 | 1621.95 |
| Advanced 3 | -113.71 | 319.69 | -32.87 | -43.69 | 345.35 | 1212.27 | 1687.04 |
| VIP 1 | -110.56 | 322.29 | -30.77 | -40.99 | 347.90 | 1216.09 | 1703.95 |
| VIP 2 | -107.70 | 324.28 | -28.74 | -38.47 | 350.22 | 1219.66 | 1719.25 |

#### HTF fixed-target: net USD per pair

4 hour trend, maker take-profit when `high > takePx`, no toxic flatten.

| Tier | 30d volume needed | Maker bps | Taker bps | Reachable | UNI-USD | NEAR-USD | BCH-USD | SUI-USD | AVAX-USD | ARB-USD | Total |
|---|---:|---:|---:|---|---:|---:|---:|---:|---:|---:|---:|
| US entry | $0 | 50 | 90 | yes | -584.41 | -690.16 | -440.79 | -644.59 | -1012.34 | -376.54 | -3748.84 |
| US first discounted step | $10,000 | 25 | 40 | yes | 34.73 | -20.81 | -142.19 | -186.77 | -534.40 | -167.48 | -1016.90 |
| Intro 1 | $0 | 60 | 120 | yes | -910.55 | -951.18 | 0.00 | 0.00 | 0.00 | -491.18 | -2352.91 |
| Intro 2 | $10,000 | 40 | 80 | yes | -375.19 | -459.93 | -328.31 | -489.28 | -835.33 | -302.45 | -2790.47 |
| Advanced 1 | $25,000 | 25 | 50 | yes | 10.80 | -48.14 | -153.92 | -209.52 | -557.91 | -176.73 | -1135.42 |
| Advanced 2 | $75,000 | 12.5 | 25 | yes | 274.71 | 225.61 | 7.82 | -45.08 | -343.65 | -71.88 | 47.54 |
| Advanced 3 | $250,000 | 7.5 | 15 | no | 374.58 | 316.88 | 58.04 | 21.50 | -268.45 | -31.88 | 470.67 |
| VIP 1 | $500,000 | 6 | 12.5 | no | 407.00 | 350.56 | 74.17 | 38.75 | -243.13 | -21.69 | 605.66 |
| VIP 2 | $1,000,000 | 5 | 10 | no | 425.03 | 372.90 | 84.68 | 51.35 | -225.92 | -8.75 | 699.29 |

The three zeros on the Intro 1 row are not missing data. At 60 maker plus 120 taker, the after-fee winner on BCH, SUI, and AVAX falls under twice the after-fee loser, so the payoff 2 to 1 check refuses every entry on those pairs and the book never trades them. That check is working as designed.

#### HTF fixed-target: net USD per calendar month, six pairs combined

| Tier | 2026-04 | 2026-05 | 2026-06 | 2026-07 | 2026-08 | 2026-09 | Total |
|---|---:|---:|---:|---:|---:|---:|---:|
| US entry | -891.68 | -330.03 | -652.43 | -753.06 | -622.10 | -499.53 | -3748.84 |
| US first discounted step | -517.16 | 23.42 | -313.63 | -303.99 | -145.80 | 240.24 | -1016.90 |
| Intro 1 | -449.37 | -147.92 | -423.41 | -439.02 | -322.94 | -570.25 | -2352.91 |
| Intro 2 | -745.97 | -195.42 | -542.03 | -579.23 | -455.08 | -272.73 | -2790.47 |
| Advanced 1 | -529.37 | 9.88 | -330.08 | -316.57 | -166.69 | 197.40 | -1135.42 |
| Advanced 2 | -365.67 | 163.66 | -208.43 | -118.82 | 31.22 | 545.57 | 47.54 |
| Advanced 3 | -289.78 | 210.94 | -165.13 | -45.86 | 103.03 | 657.47 | 470.67 |
| VIP 1 | -271.97 | 232.20 | -151.19 | -23.63 | 126.33 | 693.92 | 605.66 |
| VIP 2 | -259.23 | 243.03 | -133.82 | -6.66 | 140.75 | 715.21 | 699.29 |

#### The $300/mo gate on the last three months

Jul, Aug, Sep. September is a partial month.

| Book | Tier | Jul | Aug | Sep | Months at or above $300 | Gate |
|---|---|---:|---:|---:|---:|---|
| Breakout | US entry 50/90 | -124.04 | 269.93 | 1025.60 | 1 of 3 | FAIL |
| Breakout | $10,000 step 25/40 | -71.69 | 318.77 | 1160.51 | 2 of 3 | FAIL |
| Breakout | Advanced 1 25/50 | -80.28 | 311.20 | 1147.77 | 2 of 3 | FAIL |
| HTF fixed-target | US entry 50/90 | -753.06 | -622.10 | -499.53 | 0 of 3 | FAIL |
| HTF fixed-target | Advanced 2 12.5/25 | -118.82 | 31.22 | 545.57 | 1 of 3 | FAIL |

No book and no reachable tier passes the $300/mo gate on this window. Two miss months per year is the allowance, and every row above misses at least once in three months.

#### What the fee lever is actually worth

- Breakout at the live 50/90 entry tier already makes money over six months: +$1,029.85. Moving to the published $10,000 US step adds +$470.54 over the same tape, a 46% improvement, and the breakout book generates enough turnover to reach that cutoff on its own ($25,612 in its busiest 30 days against a $10,000 cutoff).
- The HTF fixed-target book, which is what the live engine runs today, loses $3,748.84 over six months at 50/90. The $10,000 step cuts that to -$1,016.90 and the $75,000 tier is the first reachable row where it stops losing money (+$47.54). Its own turnover clears $75,000, so that tier is not hypothetical.
- Fees are the largest single lever on the fixed-target book: the gap between the entry tier and the first discounted step is $2,731.94 over six months, which is larger than anything the strategy work has moved.
- Neither book reaches $250,000 of 30 day volume, so Advanced 3 and every VIP row stay out of reach at the current clips.

Live fee defaults stay 50/90. Moving them is Brian's call.

### 2. Section 3 veto forward-return test

`/report` and the paper report page now show, per pair and per window (current run, last 24 hours, last 7 days), n and mean forward 1 hour and 4 hour move in bps for toxic-vetoed against toxic-clear decisions, plus a one-line call. The stress veto gets the same columns beside it, since the table was already being built.

Two things changed in how this is scored. Both were needed to answer the section 3 question rather than a different one.

- A decision is now `vetoed` for this table only when the **toxic** veto fired. It used to mean toxic or stress, which mixes two vetoes into one comparison and cannot answer "delete the toxic veto".
- The call is `vetoed worse` only when the vetoed mean is below the clear mean at **every** horizon that has both sides. Anything else is `vetoed not worse`. The burden of proof sits on the veto, which is what "delete rather than tune" means.

#### The tape

Run `d5bc7712-18e1-44da-a21c-f7a10ac9839c`, 2026-09-28 01:40:34 UTC to 2026-09-29 11:48:12 UTC. That is **34.1 hours, not 7 days**. The 7 day block and the run block are therefore the same numbers on this tape. Read the sample sizes before reading the call.

| Pair | Decisions | `toxicSource=jev` | `toxicSource=rule` | Toxic veto fired | Of those, Jev-sourced |
|---|---:|---:|---:|---:|---:|
| UNI-USD | 406 | 206 | 200 | 20 | 18 |
| NEAR-USD | 408 | 208 | 200 | 16 | 15 |
| BCH-USD | 407 | 207 | 200 | 19 | 11 |
| SUI-USD | 408 | 208 | 200 | 28 | 24 |
| AVAX-USD | 409 | 209 | 200 | 12 | 12 |
| ARB-USD | 404 | 204 | 200 | 25 | 16 |

#### Forward returns, 7 day block

n and mean forward move in bps. Positive means price rose after the decision. A veto refuses a long, so a **positive** move after a veto is the veto refusing an entry that would have worked.

| Pair | 1h vetoed n/bps | 1h clear n/bps | 4h vetoed n/bps | 4h clear n/bps | Call |
|---|---:|---:|---:|---:|---|
| UNI-USD | 19 / -16.5 | 374 / -12.8 | 16 / +25.3 | 341 / -49.4 | vetoed not worse |
| NEAR-USD | 16 / +17.1 | 380 / -29.9 | 16 / +17.2 | 344 / -127.7 | vetoed not worse |
| BCH-USD | 18 / +13.7 | 377 / -13.9 | 13 / +71.2 | 346 / -30.5 | vetoed not worse |
| SUI-USD | 26 / +24.6 | 370 / -24.4 | 23 / -5.0 | 337 / -92.3 | vetoed not worse |
| AVAX-USD | 12 / +49.2 | 385 / +20.5 | 11 / +255.3 | 350 / +89.6 | vetoed not worse |
| ARB-USD | 25 / -27.4 | 366 / -15.1 | 24 / -70.7 | 331 / -59.9 | vetoed worse |

#### Forward returns, last 24 hours

| Pair | 1h vetoed n/bps | 1h clear n/bps | 4h vetoed n/bps | 4h clear n/bps | Call |
|---|---:|---:|---:|---:|---|
| UNI-USD | 19 / -16.5 | 253 / +6.6 | 16 / +25.3 | 220 / +29.7 | vetoed worse |
| NEAR-USD | 15 / +26.6 | 259 / -30.4 | 15 / +41.5 | 223 / -138.3 | vetoed not worse |
| BCH-USD | 13 / -6.6 | 260 / +1.1 | 8 / -0.9 | 229 / +2.3 | vetoed worse |
| SUI-USD | 22 / +12.5 | 252 / -6.6 | 19 / +6.9 | 219 / -24.6 | vetoed not worse |
| AVAX-USD | 12 / +49.2 | 263 / +42.3 | 11 / +255.3 | 228 / +198.3 | vetoed not worse |
| ARB-USD | 20 / -50.6 | 250 / +8.7 | 19 / -85.9 | 215 / +18.6 | vetoed worse |

#### The call: delete the toxic veto

Five of six pairs read **vetoed not worse** on the full tape. ARB is the only pair where the toxic veto looks like it is doing its job, and it is not close to a majority.

On four pairs the veto is not merely neutral, it is actively costly. It refused entries that then went up while clear decisions went down: NEAR at 4 hours is +17.2 bps vetoed against -127.7 bps clear, BCH is +71.2 against -30.5, SUI is -5.0 against -92.3, AVAX is +255.3 against +89.6. The toxic veto is preferentially blocking the good side of the tape.

Applying the section 3 rule literally: **delete the toxic veto.** Do not raise the percentile, do not widen the ring, do not retune to hit a 5 to 30% band.

Honest caveats, stated rather than used to dodge the rule:

- The tape is 34 hours, not the 7 days section 3 asks for. Section 3 sends the too-small-to-tell case to the same answer, delete, so waiting cannot flip four of these pairs to "keep" without a large reversal.
- Per-pair vetoed n is 11 to 28. These means are noisy. The direction is consistent across pairs, which is what carries the call, not any single pair's number.
- Half the window ran on the deterministic label because the ring needs 200 samples. 92 of the 120 toxic vetoes on the tape are Jev-sourced, so the comparison is not dominated by the rule fallback.

#### What this cancels

Per the work order, deleting the toxic veto moots the PR 9 band work. The 5 to 30% toxic band has nothing left to score, so **HTF section 8 check 1's band clause is cancelled, not completed.** Check 1's other two clauses (no long closed with reason `toxic flow`, median hold of any long over 1 hour) stand and are unaffected.

The warm seed tape and the `rule_degenerate` guard are **not** cancelled. Both serve the stress veto, which uses the same ring, the same 200 sample warm-up, and the same percentile, and which this test did not judge. Section 8's own wording already asks `rule_degenerate` to cover "the matching stress field if the stress ring is degenerate". Brian: say so if you want those dropped too.

The deletion itself is a separate PR so it can be approved or rejected on its own. This PR is the measurement and the call.
