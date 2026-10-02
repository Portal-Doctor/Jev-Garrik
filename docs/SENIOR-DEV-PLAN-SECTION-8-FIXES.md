---
name: Section 8 live-check fixes
overview: "The paid 24h window on run d5bc7712 failed the 5 to 30% toxic band and the 80% maker take-profit check. Warm the veto ring across restarts and resets, refuse a degenerate probability ring, and amend the two live checks Brian signed off. Do not retune fees, stops, clips, or the 4 sigma target."
todos:
  - id: seed-ring
    content: Seed each pair's 7-day veto ring from decisions across runs, keep that tape through a paper reset, and test that a restart and a reset leave the ring warm
    status: completed
  - id: degenerate-rule
    content: If a warm ring has fewer than 20 distinct toxicPHigh values, veto from the deterministic label and record toxicSource=rule_degenerate. Add a test. Do not retune the percentile
    status: completed
  - id: amend-check-1
    content: Score the 5 to 30% toxic band only on warm Jev-sourced decisions, at least 100 per pair. Keep the rest of HTF section 8 check 1
    status: cancelled
  - id: amend-check-2
    content: In 24h, require a resting post-only take-profit on every filled long within one tick. Score 80% maker share over 7 days with at least 5 take-profit fills, else no sample
    status: completed
  - id: rerun-24h
    content: Deploy with docker compose up -d --build cb, confirm GET /health, then run a fresh 24h live window that starts warm
    status: in_progress
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

### Code landed

Sections 2, 3, and 5 are implemented with unit tests. Section 4 is cancelled, see below. Sections 6's re-run windows are not run yet: they need Brian to merge and redeploy.

**Section 2, warm the ring.** `vetoRingForPair` still reads the last 7 days of `decisions` for the pair with no `run_id` filter, unchanged. The gap was `POST /reset`, which deletes every paper decision and so cold-started the ring even though the query was cross-run. A new `veto_samples` table mirrors `(pair, ts, toxic_p_high, stress_p_stressed)` on every decide. `resetVenue` and `resetAll` leave it alone, for the same reason they already leave `bars` alone: calibration is not trading state. `seedVetoes` merges both sources by timestamp, so a restart warms from decisions, a reset warms from the mirror, and either alone is enough. Samples older than 7 days are pruned at boot so the table cannot grow without bound.

**Section 3, degenerate probabilities.** A warm ring with fewer than 20 distinct values falls back to the deterministic label and records `rule_degenerate`. Toxic and stress are judged on their own rings, so a tied toxic ring does not drag the stress veto onto the fallback with it. `VETO_PERCENTILE` is still 0.85 and `VETO_WARM_SAMPLES` is still 200. Neither was touched.

**Section 5, check 2.** Both halves are now scored measurements on `/report` and on the paper report page rather than prose. The 24 hour half counts filled longs that carry a resting post-only ask created within one 1 second tick of the fill that completed their entry, grouping partial entry legs by order so a three-leg entry is one long. The 7 day half reports maker share over take-profit fills and returns **no sample** under 5 fills instead of FAIL.

### Diagnostics re-run on 2026-09-29

Read-only SQL against run `d5bc7712-18e1-44da-a21c-f7a10ac9839c`. Nothing reset, restarted, or mutated. The run row and all its decisions are intact. Every number in section 1 reproduces exactly. The per-pair and per-long tables behind section 1's ranges were added in a separate doc PR.

Which hypothesis actually caused the failure:

| Theory | Verdict | Evidence |
|---|---|---|
| Tied probabilities crush the warm veto rate | **Dead** | The ring held 37 to 58 distinct values at all 1,248 warm decisions and never fell under 20. `rule_degenerate` would have fired zero times. |
| Boot seed scoped to `run_id` | **Dead** | `vetoRingForPair` has no `run_id` predicate. |
| Cold ring | **Confirmed** | 16.5 to 16.9 hours to warm, so roughly 70% of the scored window ran on the deterministic label at 0.0% to 4.5% while warm Jev rates were 5.7% to 15.7%. |

The seed fix is the fix. The degenerate guard is insurance against a ring this tape did not produce.

### Section 4 is cancelled, not completed

The profitability work order's section 3 forward-return test ran and read **vetoed not worse on five of six pairs**. Applying that rule deletes the toxic veto, which leaves the 5 to 30% toxic band with nothing to score. Check 1's band clause is therefore cancelled rather than amended. Its other two clauses (no long closed with reason `toxic flow`, median hold of any long over 1 hour) stand unchanged. Tables and the call are in [docs/SENIOR-DEV-PLAN-PROFITABILITY.md](docs/SENIOR-DEV-PLAN-PROFITABILITY.md) Result section 2.

The section 2 seed fix and the section 3 degenerate guard are **not** cancelled by that deletion. Both serve the stress veto, which uses the same ring, the same 200 sample warm-up, and the same percentile, and which the forward-return test did not judge. Section 3 already asked the guard to cover the stress field.

### Section 6 window is running

Deployed from `origin/main` `b9f7167` (six-PR stack through #16). `bun test cb` was 200 pass. `web` `bunx tsc --noEmit` passed after clearing a stale local `.next` that still named deleted kuru routes. Merged tip was not broken.

The previous container was still the 2026-09-28 01:53 UTC image, run `d5bc7712`. It was not this tip. Only `cb` and `cb-postgres` were up. No kuru profile.

`veto_samples` was empty because that binary never wrote it. The 7-day `decisions` tape was intact (414 to 419 rows per pair). After `docker compose up -d --build cb` created the table, those rows were copied into `veto_samples` (2504 inserts), then `POST /reset` started the scored window. Reset wiped runs, decisions, orders, fills, and snapshots. It left `veto_samples` and `bars` alone.

Window run `cb05dd41-9af2-4f30-984f-3946c4962c8a`, started 2026-09-29 12:41:19 UTC. `GET /health` returned `status=ok`. Pairs are still UNI-USD, NEAR-USD, BCH-USD, SUI-USD, AVAX-USD, ARB-USD. Do not add pairs to this window. Do not rebuild `cb` until the 24 hours finish.

Ring n at t=0 (after reset, first decide still pending) and the first decide's `toxicSource`:

| Pair | Ring n | First toxicSource | First gate reason |
|---|---:|---|---|
| UNI-USD | 418 | jev | trend |
| NEAR-USD | 420 | jev | trend |
| BCH-USD | 418 | jev | trend |
| SUI-USD | 418 | jev | trend |
| AVAX-USD | 419 | jev | approved long |
| ARB-USD | 414 | jev | trend |

All six started warm (n >= 200). None started cold. First-cycle split: jev 6, rule 0, rule_degenerate 0.

The toxic entry veto is gone from the live gate path. ARB's first print recorded `toxicVeto=true` as an observation and still refused for `trend`, not `toxic flow`. AVAX filled an approved long on the first cycle.

Amended check 1 band clause stays cancelled. The 2026-10-02 score is below. It is not a finished 24 hour window.

### Section 6 score 2026-10-02 (incomplete)

Read-only. No `/reset`, no rebuild, no pair or fee change, no merge of PR 20 into the live stack. Live `.env` is still the original six pairs at 50/90.

**Stack.** Docker Engine 29.8.1. `cb-app` and `cb-postgres` up. `GET /health` `status=ok`. Pairs UNI-USD, NEAR-USD, BCH-USD, SUI-USD, AVAX-USD, ARB-USD. Model `jev-latest`.

**A restart minted a new run id.** Expected window `d2c71811-b657-4ba7-af24-9a2b95206a6b` started 2026-10-01 11:09:30.210 UTC, matching the id Brian named. Its decide tape stopped after **1.8054 hours** (131 decisions, last 2026-10-01 12:57:50.774 UTC). `cb-app` then shows `RestartCount=3`. Live process started 2026-10-02 10:40:56.939 UTC.

**Scored run is the live id** `9bf0fa81-47db-48ed-8bb1-f8564b6a5b60`, started 2026-10-02 10:40:57.478 UTC. Score snapshot 2026-10-02 12:14:20.252 UTC. `GET /health` `uptimeMs=5602782` = **1.5563 hours**. 113 decisions. This is not a finished 24 hour window.

`d2c71811` wall time to this snapshot would have been 25.05 hours if the process had stayed on that id. It did not. Do not treat 25 hours of calendar time as 25 hours of decide tape.

#### Live run `9bf0fa81` per pair

| Pair | Decisions | Toxic src jev/rule/degen | Ring n at t=0 | Warm | First reason | Hold median h | Open age h | TP maker | TP taker | Stop | Trend down | Resting ask |
|---|---:|---|---:|---|---|---:|---:|---:|---:|---:|---:|---|
| UNI-USD | 19 | 19/0/0 | 801 | yes | regime | - | 1.374 | 0 | 0 | 0 | 0 | 1/1 pass, lag 0 ms |
| NEAR-USD | 19 | 19/0/0 | 804 | yes | trend | - | - | 0 | 0 | 1 | 0 | no sample |
| BCH-USD | 19 | 19/0/0 | 802 | yes | approved long | - | - | 0 | 0 | 0 | 0 | no sample |
| SUI-USD | 19 | 19/0/0 | 799 | yes | approved long | - | - | 0 | 0 | 0 | 0 | no sample |
| AVAX-USD | 19 | 19/0/0 | 801 | yes | approved long | - | 1.490 | 0 | 0 | 0 | 0 | 1/1 pass, lag 0 ms |
| ARB-USD | 18 | 18/0/0 | 795 | yes | trend | - | - | 0 | 0 | 0 | 0 | no sample |

All six first `toxicSource=jev` and first `stressSource=jev`. Run totals: toxic jev 113, rule 0, `rule_degenerate` 0. Stress same. Seed fix held: rings were warm at boot (795 to 804 samples, 47 to 72 distinct `toxicPHigh` now). BCH and SUI printed approved long and did not fill (entries canceled).

NEAR's one stop is not a live filled long. Restart flattened 2.5145 NEAR left over from `d2c71811` at 2026-10-02 10:40:58.665 UTC, purpose `stop`, taker. Reason is not `toxic flow`.

Filled longs on this run, fee-inclusive target = cost basis / size times (1 + book take-profit bps / 10_000). Check 2's signed-off tick is the 1 second time tick in `scoreRestingAsk`.

| Pair | Entry filled (UTC) | Fill legs | Cost-basis entry | Resting ask | Lag | Book target bps | Closed by |
|---|---|---:|---:|---:|---:|---:|---|
| AVAX-USD | 2026-10-02 10:44:55.124 | 1 | 11.245995 | 12.26708226 | 0 ms | 908 | still open |
| UNI-USD | 2026-10-02 10:51:53.734 | 3 | 9.092575 | 10.16580307 | 0 ms | 1180 | still open |

AVAX ask equals that target. UNI ask is the engine `guardPrice` at the completing fill (0.30 bps above the post-hoc cost-basis VWAP). Both asks are post-only `take_profit`.

| Check | Result |
|---|---|
| Toxic veto 5% to 30% band | Cancelled. Toxic entry veto is deleted. Observation rates on this short tape: ARB 5.6%, NEAR 21.1%, SUI 26.3%, UNI 31.6%, AVAX 31.6%, BCH 36.8%. |
| No close reason `toxic flow` | PASS. 0 decisions with that reason. 0 flatten fills with that reason. |
| Median hold of any long over 1 hour | No closed-long sample on this run. Official hold median uses closed entry-to-exit only, same as prior Result tables. Two longs are still open: AVAX 1.490 h, UNI 1.374 h at the snapshot. If open age counts, both are already over 1 hour. Ask Brian which reading he wants on an unfinished window. |
| Check 2, 24h: resting post-only take-profit within one 1 second tick | PASS on the two filled longs (UNI, AVAX). no sample on NEAR, BCH, SUI, ARB. |
| Check 2, 7d: 80% maker take-profit fills, n>=5 | no sample on every pair. 0 take-profit fills in 7 days. Not FAIL. |

#### Expected run `d2c71811` (dead tape, not the live score)

Started 2026-10-01 11:09:30.210 UTC. 131 decisions over 1.8054 hours, then silence. First-cycle sources all `jev`, rings 774 to 782. One NEAR long filled 2026-10-01 11:11:17.683 UTC (2 legs), take-profit rested at lag 0 ms, ask 5.84646331. That position was still open when the decide loop died and was stop-flattened on the later restart. No toxic-flow close. Closed hold median: none (the 57.24 NEAR stop at 11:10:04.583 UTC was a leftover from `5a27eb06`, not an entry on `d2c71811`).

#### Does this unblock applying PR 20 to the live engine?

No. Elapsed on the scored live run is **1.5563 hours**, not 24. The 7 day maker-share half has no sample. GitHub already shows PR 20 merged. This pass did not merge it, did not change live pairs, and did not change live fees. Wait for a continuous 24 hour decide tape on one run id before treating section 6 as done.

### Section 6 score 2026-10-02 post-reboot (incomplete)

Read-only. No `/reset`, no rebuild, no pair or fee change, no merge of PR 20 into the live stack. Live `.env` is still `CB_PAIRS=UNI-USD,NEAR-USD,BCH-USD,SUI-USD,AVAX-USD,ARB-USD` and `CB_MAKER_FEE_BPS=50` / `CB_TAKER_FEE_BPS=90`. Decision `feeBps` prints the same 50/90.

**Host power (not changed).** `powercfg /a` lists Standby (S0 Low Power Idle) as unavailable: "The system firmware does not support this standby state." S1, S2, and S3 are also unavailable. Hibernate is not enabled. Balanced `STANDBYIDLE` AC=0 DC=0 and `HIBERNATEIDLE` AC=0 DC=0 (never sleep, never hibernate). S0 Modern Standby is gone.

**Stack.** Docker Engine 29.8.1. After the host reboot, `cb-app` and `cb-postgres` were already up. No `docker compose up -d`. No kuru profile. `GET /health` `status=ok`. UI `:3000` was empty; `bun run ui:start` then served `/paper` 200. Model `jev-latest`.

`cb-postgres` `RestartCount=0`, started 2026-10-02 20:21:42.504 UTC, healthy. `cb-app` `RestartCount=3` (same inspect field as the pre-reboot score; container created 3 days ago), `StartedAt` 2026-10-02 20:21:46.740 UTC. Boot logs show three `PostgresError: the database system is starting up` before the live process stuck.

**A reboot minted new run ids.** `9bf0fa81` continued after the 1.5563 hour snapshot to **3.1942 hours** / 231 decisions (last 2026-10-02 13:52:37.299 UTC), then died. `80013751-7db5-4a6a-876d-887cfce4930a` started 2026-10-02 13:53:34.153 UTC, 225 decisions over **3.1109 hours**, 0 fills. First-cycle `toxicSource` all `jev`. AVAX leftover from `9bf0fa81` (6.55859833) stayed open through that fragment.

Host reboot then minted `a6788e16-f7da-4ddf-9174-19d68e14ad14` at 2026-10-02 20:06:41.417 UTC (13 decisions, 0.1667 hours). That process stop-flattened the leftover AVAX at 20:06:42.615 UTC, purpose `stop`, taker, reason is not `toxic flow`. It then filled a new AVAX long at 20:15:04.289 to 20:15:19.319 UTC (17 maker legs, completing size 32.00421535509792, cost basis $340.7704151160543). Post-only `take_profit` rested at lag **0 ms**, ask 11.614481551392956, still `open`. Ask equals fee-inclusive cost-basis entry times (1 + 908 / 10_000).

**Scored run is the live id** `5b892748-cc42-4365-a5f1-3cfc617a940a`, started 2026-10-02 20:21:47.425 UTC. Score snapshot 2026-10-02 20:37:50.977 UTC. `GET /health` `uptimeMs=963552` = **0.2677 hours**. 20 decisions. First-to-last decide tape **0.2639 hours**. This is not a finished 24 hour window.

`d2c71811` wall time to this snapshot is **33.47 hours**. Summed decide tape across `d2c71811` + `9bf0fa81` + `80013751` + `a6788e16` + live `5b892748` is **8.54 hours**. Do not treat 33 hours of calendar time as 33 hours of decide tape. On this live id, tape length matches the 5 minute cadence (19 then 20 decisions over ~16 minutes).

#### Live run `5b892748` per pair

| Pair | Decisions | Toxic src jev/rule/degen | Ring n at t=0 | Distinct toxicPHigh | Warm | First reason | Hold median h | Open age h | TP maker | TP taker | Stop | Trend down | Resting ask |
|---|---:|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---|
| UNI-USD | 4 | 4/0/0 | 881 | 54 | yes | trend | - | - | 0 | 0 | 0 | 0 | no sample |
| NEAR-USD | 4 | 4/0/0 | 883 | 48 | yes | trend | - | - | 0 | 0 | 0 | 0 | no sample |
| BCH-USD | 3 | 3/0/0 | 881 | 72 | yes | liquidity stress | - | - | 0 | 0 | 0 | 0 | no sample |
| SUI-USD | 3 | 3/0/0 | 876 | 50 | yes | approved long | - | - | 0 | 0 | 0 | 0 | no sample |
| AVAX-USD | 3 | 3/0/0 | 878 | 48 | yes | hold (already long) | - | 0.375 | 0 | 0 | 0 | 0 | no sample on this run |
| ARB-USD | 3 | 3/0/0 | 872 | 49 | yes | trend | - | - | 0 | 0 | 0 | 0 | no sample |

All six first `toxicSource=jev` and first `stressSource=jev`. Run totals: toxic jev 20, rule 0, `rule_degenerate` 0. Stress same. Seed fix held: rings were warm at boot (872 to 883 samples, 48 to 72 distinct `toxicPHigh`). None started cold. First-cycle split: jev 6, rule 0, rule_degenerate 0.

This run has **0 orders and 0 fills**. SUI printed approved long on every cycle (`sizeUsd=400`) and did not persist an entry. BCH later printed approved in the log and also has no order. AVAX printed `hold` with `sizeUsd=0` because the book is already long from `a6788e16`.

The open AVAX 32.00421535509793 at snapshot entry 10.647672856062483 is that leftover fill, not an entry on `5b892748`. Official closed-hold median uses entry-to-exit on this run only: no sample. Open age of the inherited long at the snapshot is **0.375 hours**. The resting ask from `a6788e16` is still open (lag 0 ms on that fill). Check 2 on the live runId has no filled long, so no sample.

No decision on this run has reason `toxic flow`. No flatten fill on this run exists, so none is a toxic-flow flatten. The 20:06 AVAX stop is on `a6788e16`, purpose `stop`, not `toxic flow`.

| Check | Result |
|---|---|
| Toxic veto 5% to 30% band | Cancelled. Toxic entry veto is deleted. Observation rates on this short tape: BCH 33.3% (1/3), UNI 0% (0/4), NEAR 0% (0/4), SUI 0% (0/3), AVAX 0% (0/3), ARB 0% (0/3). |
| No close reason `toxic flow` | PASS. 0 decisions with that reason. 0 flatten fills with that reason on the live run. |
| Median hold of any long over 1 hour | Closed p50: no sample (0 closed longs on this run). Open age: inherited AVAX 0.375 h, under 1 hour. |
| Check 2, 24h: resting post-only take-profit within one 1 second tick | no sample on every pair for this runId (0 filled longs). The inherited AVAX ask from `a6788e16` is still open at lag 0 ms. |
| Check 2, 7d: 80% maker take-profit fills, n>=5 | no sample on every pair. 0 take-profit fills in 7 days. Not FAIL. |

#### Does this unblock applying PR 20 to the live engine?

No. Elapsed on the scored live run is **0.2677 hours**, not 24. The 7 day maker-share half has no sample. GitHub already shows PR 20 merged. This pass did not merge it, did not change live pairs, and did not change live fees. Wait for a continuous 24 hour decide tape on one run id before treating section 6 as done. S0 is gone and AC/DC sleep/hibernate are 0, so the tape can survive if power and Docker stay up.

### 7 day window not started yet

The 7 day take-profit maker-share window starts after a finished 24h window, not in parallel.

### Rule 3

Section 8's two options are now resolved by evidence rather than by amendment. Option (b) is unnecessary: halving the NEAR clip from $600 to $300 takes NEAR's breakout drawdown from 15.05% to 8.22%, and all five adoption rules pass with the 15% limit untouched. The table is in the profitability work order's Result section 3. Phase 2 still needs its own plan.
