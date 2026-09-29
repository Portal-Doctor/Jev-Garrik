---
name: Section 8 live-check fixes
overview: "The paid 24h window on run d5bc7712 failed the 5 to 30% toxic band and the 80% maker take-profit check. Warm the veto ring across restarts and resets, refuse a degenerate probability ring, and amend the two live checks Brian signed off. Do not retune fees, stops, clips, or the 4 sigma target."
todos:
  - id: seed-ring
    content: Seed each pair's 7-day veto ring from decisions across runs, keep that tape through a paper reset, and test that a restart and a reset leave the ring warm
    status: pending
  - id: degenerate-rule
    content: If a warm ring has fewer than 20 distinct toxicPHigh values, veto from the deterministic label and record toxicSource=rule_degenerate. Add a test. Do not retune the percentile
    status: pending
  - id: amend-check-1
    content: Score the 5 to 30% toxic band only on warm Jev-sourced decisions, at least 100 per pair. Keep the rest of HTF section 8 check 1
    status: pending
  - id: amend-check-2
    content: In 24h, require a resting post-only take-profit on every filled long within one tick. Score 80% maker share over 7 days with at least 5 take-profit fills, else no sample
    status: pending
  - id: rerun-24h
    content: Deploy with docker compose up -d --build cb, confirm GET /health, then run a fresh 24h live window that starts warm
    status: pending
  - id: rerun-7d
    content: After the 24h window, run 7 days for take-profit maker share and the vetoed versus clear forward-return comparison from HTF section 3
    status: pending
isProject: false
---

# Section 8 live-check fixes

The live process stays [cb/](cb/index.ts). The Kuru demo in [src/](src/index.ts) stays stopped. Do not start the `kuru` compose profile. Do not change fees, `CB_FEE_BUFFER`, clips, the stop table in [cb/books.ts](cb/books.ts), the 4 sigma take-profit, the payoff 2 to 1 check, the 5 minute decide cadence, or the locked breakout knobs.

Jev still classifies. Code still owns the order. No middle dots, em dashes, or en dashes in any rendered text. No blinking or pulsing indicators.

Brian approved this work order on 2026-09-29 from the store plan `docs/section-8-fix-plan.md`. Check 1 and check 2 amendments below are signed off. The senior dev executes the code in a later pass. This file is the work order only.

## 1. Findings

Source: GitHub PR #8, paid TypeSafe run `d5bc7712-18e1-44da-a21c-f7a10ac9839c`, 2026-09-28 01:53:19 to 2026-09-29 01:54:04 UTC, 1713 decisions, model `jev-latest`. Diagnostics below are read-only SQL on that run's 24h window (`ts` 1790560399080 inclusive to 1790646799080 exclusive). The engine was not reset.

PR #8 live table:

| Pair | Decisions | Toxic veto | Band | Hold median h | TP maker | TP taker | Stop | Trend down |
|---|---:|---:|---|---:|---:|---:|---:|---:|
| UNI-USD | 285 | 4.2% | out | - | 0 | 0 | 0 | 0 |
| NEAR-USD | 287 | 3.8% | out | 2.17 | 0 | 0 | 1 | 0 |
| BCH-USD | 285 | 4.6% | out | - | 0 | 0 | 0 | 0 |
| SUI-USD | 286 | 6.3% | in | 1.07 | 0 | 0 | 3 | 0 |
| AVAX-USD | 287 | 2.8% | out | 1.43 | 0 | 0 | 1 | 2 |
| ARB-USD | 283 | 7.8% | in | 1.48 | 0 | 0 | 1 | 3 |

| Check | Result |
|---|---|
| Toxic veto 5% to 30% on every pair | FAIL |
| No close reason `toxic flow` | PASS |
| Median hold of any long over 1 hour | PASS on the four pairs with a hold sample |
| At least 80% of take-profit fills are maker | FAIL. Zero take-profit fills |

### Veto band

`cb/vetoes.ts` uses the rolling 85th percentile after 200 samples and the deterministic label before that.

The 200th decision on this run landed 16.6 to 17.1 hours in (18:26 to 18:57 UTC on 2026-09-28). First `toxicSource=jev` is one decide cycle earlier because boot already had 2 or 3 samples from run `62cff319`. About 70% of the 24h window was `rule`.

| Pair | Rule n | Rule veto | Rule rate | Jev n | Jev veto | Jev rate | Warm at UTC |
|---|---:|---:|---:|---:|---:|---:|---|
| UNI-USD | 198 | 2 | 1.0% | 87 | 10 | 11.5% | 2026-09-28 18:43 |
| NEAR-USD | 197 | 0 | 0.0% | 89 | 11 | 12.4% | 2026-09-28 18:29 |
| BCH-USD | 197 | 8 | 4.1% | 88 | 5 | 5.7% | 2026-09-28 18:35 |
| SUI-USD | 197 | 4 | 2.0% | 89 | 14 | 15.7% | 2026-09-28 18:31 |
| AVAX-USD | 197 | 0 | 0.0% | 90 | 8 | 8.9% | 2026-09-28 18:27 |
| ARB-USD | 198 | 9 | 4.5% | 85 | 13 | 15.3% | 2026-09-28 18:52 |

Hypothesis "200 samples takes about 16.7 hours, so the band is scored mostly on the rule fallback": **held**. Rule rates sit under 5% on every pair. Warm Jev rates sit inside 5% to 30% on every pair (5.7% to 15.7%), but each pair has only 85 to 90 Jev decisions, under the 100 floor in the amended check.

Hypothesis "boot seed is scoped to the current `run_id`": **did not hold**. `Store.vetoRingForPair` selects `decisions` by pair and `ts >= since`, with no `run_id` filter. At this boot the 7-day lookback only found 2 or 3 rows per pair from `62cff319` (the previous recreate). That is why the ring was still cold. `POST /reset` deletes all paper `decisions`, so a reset still starts the ring empty even though the query is cross-run.

Hypothesis "warm `toxicPHigh` is tied near one value, so p85 vetoes well under 15%": **did not hold** on this paid tape. Warm rings had 30 to 41 distinct values. Modal share 6.7% to 9.2%. p85 was 0.90 to 0.92 except BCH at 0.61. Warm Jev veto rates were not crushed by ties.

Per pair, over the warm Jev-sourced decisions inside the 24h window:

| Pair | Warm n | Distinct `toxicPHigh` | Modal value | Modal count | Modal share | p85 | Min | Max |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| UNI-USD | 87 | 34 | 0.86 | 8 | 9.2% | 0.9010 | 0.52 | 0.96 |
| NEAR-USD | 89 | 30 | 0.83 | 8 | 9.0% | 0.9100 | 0.49 | 0.95 |
| BCH-USD | 88 | 41 | 0.38 | 6 | 6.8% | 0.6095 | 0.07 | 0.82 |
| SUI-USD | 89 | 41 | 0.83 | 6 | 6.7% | 0.9000 | 0.55 | 0.97 |
| AVAX-USD | 90 | 34 | 0.80 | 6 | 6.7% | 0.9100 | 0.51 | 0.95 |
| ARB-USD | 85 | 34 | 0.91 | 7 | 8.2% | 0.9240 | 0.60 | 0.96 |

And the 200 sample ring itself, as it stood at the moment each pair first went warm (the cross-run read `vetoRingForPair` performs):

| Pair | Ring n | Distinct `toxicPHigh` | Modal value | Modal count | Modal share | p85 |
|---|---:|---:|---:|---:|---:|---:|
| UNI-USD | 200 | 43 | 0.69 | 10 | 5.0% | 0.9100 |
| NEAR-USD | 200 | 41 | 0.85 | 18 | 9.0% | 0.9115 |
| BCH-USD | 200 | 54 | 0.42 | 9 | 4.5% | 0.6915 |
| SUI-USD | 200 | 42 | 0.87 | 13 | 6.5% | 0.8915 |
| AVAX-USD | 200 | 38 | 0.83 | 12 | 6.0% | 0.9200 |
| ARB-USD | 200 | 38 | 0.72 | 12 | 6.0% | 0.9100 |

BCH is the outlier on both readings. Its probabilities sit far lower than the other five (0.07 to 0.82 against 0.49 to 0.97), which is why its p85 lands at 0.61 rather than 0.90, not because its ring is tied.

### Take-profit

The target is fee-inclusive entry times `1 + takeProfitBps / 10_000` (UNI 1180 bps, NEAR 1324, BCH 968, SUI 876, AVAX 908, ARB 1560).

UNI and BCH never went long. The other four pairs rest a `take_profit` ask on the completing entry fill at lag 0 ms. Partial fills before the entry is done have no ask yet, which matches `restTakeProfit` in [cb/paper.ts](cb/paper.ts). Ten `take_profit` orders, zero fills.

Max snapshot mid while each ask rested stayed 721 to 1382 bps short of the ask. Holds were 1.07h to 2.17h, then stop or `trend down`. Hypothesis "zero take-profits in 24h is expected at 4 sigma, not a missing resting ask": **held**. The 80% maker-share check has no denominator, so it reports FAIL instead of no sample.

Every filled long on the run, one row each. `Lag` is the gap between the completing entry fill and the `take_profit` order being created. `Short of ask` is how far the best snapshot mid while the ask rested stayed below the ask.

| Pair | Entry filled (UTC) | Fill legs | Avg fill px | Resting ask | Lag | Ask px | Target distance | Rested | Max mid while resting | Short of ask | Closed by |
|---|---|---:|---:|---|---:|---:|---:|---:|---:|---:|---|
| NEAR-USD | 2026-09-28 01:54:21 | 1 | 5.32810 | yes | 0 ms | 6.06371 | 1380.6 bps | 2.17h | 5.33970 | 1194.0 bps | stop |
| SUI-USD | 2026-09-28 02:55:52 | 2 | 1.24990 | yes | 0 ms | 1.36619 | 930.4 bps | 1.09h | 1.25500 | 813.9 bps | stop |
| ARB-USD | 2026-09-28 03:39:08 | 3 | 0.21708 | yes | 0 ms | 0.25220 | 1617.8 bps | 1.48h | 0.21734 | 1382.4 bps | exit |
| AVAX-USD | 2026-09-28 03:42:11 | 10 | 10.77471 | yes | 0 ms | 11.80979 | 960.7 bps | 1.43h | 10.80250 | 852.9 bps | exit |
| SUI-USD | 2026-09-28 04:11:31 | 2 | 1.22850 | yes | 0 ms | 1.34280 | 930.4 bps | 1.04h | 1.24600 | 720.9 bps | stop |

Five filled longs, five with a resting post-only ask, all at lag 0 ms. The ten `take_profit` orders are those five longs' asks split across fill legs (ARB 3, AVAX 4, NEAR 1, SUI 2). Zero filled. UNI and BCH never went long, so they have no row.

The closest any of them came was SUI at 720.9 bps short of a 930.4 bps target. Max favorable excursion from the fill was 21.8 to 142.4 bps against targets of 930 to 1618 bps. The resting ask is not the problem; a 4 sigma target is simply not reached inside a 1 to 2 hour hold.

## 2. Warm the veto ring at boot

In [cb/engine.ts](cb/engine.ts) `seedVetoes` and [cb/db/store.ts](cb/db/store.ts) `vetoRingForPair`:

- Keep reading the last 7 days of `decisions` for the pair across runs. Do not add a `run_id` filter.
- `POST /reset` must not wipe the 7-day seed tape. A paper reset may clear fills, orders, positions, and the current run, but the last 7 days of decision rows (or an equivalent ring snapshot) have to survive so `seedVetoes` still loads 200 samples when they exist.
- At boot, if a pair still has fewer than 200 samples after seed, it stays on the deterministic label until warm. That is unchanged.

Tests:

- Restart the process (new `runId`) with 200 persisted samples for a pair: the first live decide on that pair uses `toxicSource=jev`.
- Paper reset after those 200 samples exist: the next process still loads a warm ring and the first decide is `jev`, not `rule`.

## 3. Degenerate probabilities

If a pair's ring is warm (`>= 200` samples) and the ring has fewer than 20 distinct `toxicPHigh` values, it cannot be calibrated. Veto from the deterministic label and persist `toxicSource=rule_degenerate` (and the matching stress field if the stress ring is degenerate). Do not change `VETO_PERCENTILE`. Tuning the percentile to force the 5 to 30% band is not allowed.

Add a test: 200 identical `toxicPHigh` values, current value equal to that constant, `ruleToxic=false`: no Jev percentile veto, source is `rule_degenerate`.

This paid run would not have tripped that rule (30 to 41 distinct values). The rule is still required so a tied ring cannot silently under-veto.

Checked against every warm decision on the run, not just the moment each pair went warm. The ring held 37 to 58 distinct `toxicPHigh` values at all 1,248 warm decisions and never fell under 20, so `rule_degenerate` would have fired zero times.

| Pair | Warm decisions | Fewest distinct in ring | Most distinct in ring | Would be `rule_degenerate` |
|---|---:|---:|---:|---:|
| UNI-USD | 207 | 40 | 46 | 0 |
| NEAR-USD | 209 | 37 | 42 | 0 |
| BCH-USD | 208 | 48 | 58 | 0 |
| SUI-USD | 209 | 42 | 46 | 0 |
| AVAX-USD | 210 | 37 | 43 | 0 |
| ARB-USD | 205 | 37 | 40 | 0 |

The tie theory is dead on this tape. The cold-ring theory is the live one: 16.5 to 16.9 hours to warm, so roughly 70% of the scored window ran on the deterministic label at 0.0% to 4.5%, while warm Jev rates were 5.7% to 15.7%. Section 2's seed fix is the fix; this guard is insurance.

## 4. Amend check 1 (Brian signed off)

[docs/SENIOR-DEV-PLAN-HOLD-THE-TREND.md](docs/SENIOR-DEV-PLAN-HOLD-THE-TREND.md) section 8 check 1 today scores toxic veto rate on every decision in 24h.

Replace only the band clause:

- Score the 5% to 30% band on warm, Jev-sourced decisions only (`toxicSource=jev`).
- Require at least 100 such decisions per pair. Below that, report no sample, not FAIL.
- Keep: no long closed with reason `toxic flow`.
- Keep: median hold of any long over 1 hour.

On this tape the Jev-only rates would have been in band, but n is 85 to 90, so the amended check is no sample until a window that starts warm.

## 5. Amend check 2 (Brian signed off)

Replace the 24h 80% maker take-profit pass/fail with two measurements:

- **24h, can be scored now:** every filled long (entry order done) has a resting post-only `take_profit` at the fee-inclusive target within one 1 second tick of that completing fill. This paid run would **pass** that check on NEAR, SUI, AVAX, and ARB. UNI and BCH had no long.
- **7 days:** at least 80% of take-profit fills are maker, with at least 5 take-profit fills. Until then, report no sample, not FAIL. This paid 24h window had 0 fills, so no sample.

## 6. Re-run

Then `docker compose up -d --build cb` with no `--profile kuru`, and confirm `GET /health`.

1. Fresh 24h live window on the paid TypeSafe path. The ring should start warm if 7 days of seed tape exist. Score amended check 1 and the 24h resting-ask check.
2. After that, a 7-day window for take-profit maker share (amended check 2) and the vetoed versus non-vetoed 1 hour and 4 hour forward returns that [docs/SENIOR-DEV-PLAN-HOLD-THE-TREND.md](docs/SENIOR-DEV-PLAN-HOLD-THE-TREND.md) section 3 already requires.

Record both windows under Result in this file. Do not retune parameters to force a pass.

## 7. What not to change

- Fees, `CB_FEE_BUFFER`, clips, stops, the 4 sigma take-profit, the payoff 2 to 1 check, the gross cap, the kill switch.
- The 5 minute decide cadence and the 24 hour hold clock.
- Locked breakout defaults: `CB_BREAKOUT_BARS=20`, `CB_TRAIL_ATR=3`, `CB_TREND_EMA_BARS=50`, `CB_BREAKOUT_MAX_HOLD_SEC=1209600`.
- Do not start Breakout phase 2 in this work.
- Do not re-run with new risk parameters to force a section 8 pass.

## 8. Rule 3 (options only, not executed)

Passing section 8 does not reach $300/mo. The live engine runs the HTF fixed-target paper book. That book fails the 3-month gate in backtest (Jul -778.59, Aug -636.81, Sep -333.23). The only book that passes the gate is breakout Donchian 20 / trail 3 ATR / EMA 50 / hold 14d. Its live switch (breakout phase 2) is blocked by adoption rule 3: NEAR drawdown 15.05% against a 15% limit.

Two options, no choice in this pass:

- (a) Keep rule 3 strict, so breakout stays backtest-only.
- (b) Brian amends rule 3, for example by excluding NEAR from the live trail or setting the limit at 15.5% or below. Phase 2 then gets its own plan.

## Result

Not started. Code, deploy, and the new 24h / 7-day windows land in a later PR after Brian approves this work order.
