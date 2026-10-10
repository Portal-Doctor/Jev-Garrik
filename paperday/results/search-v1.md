# Search v1

Holdout v1 is void: consumed, pre-contaminated. It is not evidence for selection.

Grid sha256 `fc6067e78e5c0c5865aaff83abb2b42275b60997e11b299a3d63dda21dca9e31`.
Configs in the pre-registered file: 372.
Full cross is 4 strategies x 3 stops x 3 targets x 2 holds x 4 allocators x 5 Jev variants, plus 4 breakout allocators x 5 Jev variants = 1460. Cap 500. jev_off uses the full structural cross (288 swing + 4 breakout). jev_veto V1/V2/V3 and jev_select are registered only at stop 2, target 3R, hold 48h, for every strategy and allocator (64 swing + 16 breakout). Total 372. sentiment_blind is not in the grid.
jev_off configs executed: 292.
sentiment_blind is not in the grid. It is an upper bound from the turn-1 matrix, not a selectable mode.
Hard limits were not search dimensions: 50/90 fees, maker target and taker stop billing, haircut 0.5, drawdown halt $8,000, pair halt $500, daily halt $900, one position per pair, 2 concurrent, 3 ideas per weekday, long only, overnight risk cap $500, paper only, the enabled pair list.
Jev veto and jev_select rows are registered only at stop 2, target 3R, and hold 48h. Those rows have no one-step neighbors inside the grid, so the stability guard cannot select them.

## Leaderboard

No config passed eligibility and the neighbor stability guard. The selected config is null.
Every one of the 292 executed configs closed 0 OOS trades, so every OOS net is $0. The table is the id tie-break of that tie, not a revenue ranking.

Highest OOS net among executed configs (not eligible):

| rank | id | OOS net | max DD | trades | E R | E bps | p* | IS net | decay |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | repo_breakout_4h|locked|POOL|atr_scaled|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |  | 0.00 | 0.00 |
| | trades 0 < 100; E below +0.15R and +25 bps; p* > 45%; positive OOS folds 0 < 2 | | | | | | | | |
| 2 | repo_breakout_4h|locked|POOL|equal|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |  | 0.00 | 0.00 |
| | trades 0 < 100; E below +0.15R and +25 bps; p* > 45%; positive OOS folds 0 < 2 | | | | | | | | |
| 3 | repo_breakout_4h|locked|SILO|atr_scaled|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |  | 0.00 | 0.00 |
| | trades 0 < 100; E below +0.15R and +25 bps; p* > 45%; positive OOS folds 0 < 2 | | | | | | | | |
| 4 | repo_breakout_4h|locked|SILO|equal|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |  | 0.00 | 0.00 |
| | trades 0 < 100; E below +0.15R and +25 bps; p* > 45%; positive OOS folds 0 < 2 | | | | | | | | |
| 5 | swing_A|stop=1.5|target=2.5|hold=24|POOL|atr_scaled|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |  | 0.00 | 0.00 |
| | trades 0 < 40; E below +0.15R and +25 bps; p* > 45%; positive OOS folds 0 < 2 | | | | | | | | |
| 6 | swing_A|stop=1.5|target=2.5|hold=24|POOL|equal|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |  | 0.00 | 0.00 |
| | trades 0 < 40; E below +0.15R and +25 bps; p* > 45%; positive OOS folds 0 < 2 | | | | | | | | |
| 7 | swing_A|stop=1.5|target=2.5|hold=24|SILO|atr_scaled|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |  | 0.00 | 0.00 |
| | trades 0 < 40; E below +0.15R and +25 bps; p* > 45%; positive OOS folds 0 < 2 | | | | | | | | |
| 8 | swing_A|stop=1.5|target=2.5|hold=24|SILO|equal|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |  | 0.00 | 0.00 |
| | trades 0 < 40; E below +0.15R and +25 bps; p* > 45%; positive OOS folds 0 < 2 | | | | | | | | |
| 9 | swing_A|stop=1.5|target=2.5|hold=48|POOL|atr_scaled|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |  | 0.00 | 0.00 |
| | trades 0 < 40; E below +0.15R and +25 bps; p* > 45%; positive OOS folds 0 < 2 | | | | | | | | |
| 10 | swing_A|stop=1.5|target=2.5|hold=48|POOL|equal|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |  | 0.00 | 0.00 |
| | trades 0 < 40; E below +0.15R and +25 bps; p* > 45%; positive OOS folds 0 < 2 | | | | | | | | |

## In-sample picks

Each fold picks the executed config with the highest in-sample net, then records that config's OOS net for the fold. A config's OOS score used for ranking is the sum of its own three OOS months.

| fold | id | IS net | OOS net |
|---:|---|---:|---:|
| 1 | swing_combined|stop=1.5|target=3|hold=48|POOL|equal|market_proxy|jev_off | 88.96 | 0.00 |
| 2 | swing_C|stop=1.5|target=3|hold=24|POOL|equal|market_proxy|jev_off | 12.72 | 0.00 |
| 3 | repo_breakout_4h|locked|POOL|atr_scaled|market_proxy|jev_off | 0.00 | 0.00 |

## Selected config

Selected config: null.
No eligible config survived the neighbor guard. That is the result of the pre-registered procedure.

## Jev vs jev_off vs baseline

The best Jev config and the best jev_off config are side by side. This report does not pick between them. Brian decides if jev_off wins.

Best jev_off by OOS net: `repo_breakout_4h|locked|POOL|atr_scaled|market_proxy|jev_off` (not eligible).
Best repo_breakout_4h by OOS net: `repo_breakout_4h|locked|POOL|atr_scaled|market_proxy|jev_off` (not eligible).
Best Jev config: not run. No Jev row is filled in.
The jev_off and baseline columns name the same config because every OOS net tied at $0 and the id order placed this row first. That is not a choice between them. Jev was not run, so there is no Jev result to set beside them.

| | best Jev | best jev_off | best repo_breakout_4h |
|---|---|---|---|
| OOS net | not run | 0.00 | 0.00 |
| holdout net | not run | 0.00 | 0.00 |
| max DD | not run | 0.00 | 0.00 |
| trades | not run | 0 | 0 |
| E | not run |  |  |
| Jev spend | 0.0000 | 0.0000 | 0.0000 |

No selected config, so the breakout comparison has nothing to score.

## Holdout

Holdout opened once at 2026-10-10T12:36:02.935Z.
The month is 2026-09-09 through 2026-10-09. Search code did not read those bars.

| run | id | net | max DD | trades | E R | p* |
|---|---|---:|---:|---:|---:|---:|
| selected | | not run | | | | |
| best jev_off | repo_breakout_4h|locked|POOL|atr_scaled|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |
| | holdout net > 0, DD < 8000, halts clear: miss | | | | | |
| best repo_breakout_4h | repo_breakout_4h|locked|POOL|atr_scaled|market_proxy|jev_off | 0.00 | 0.00 | 0 |  |  |
| | holdout net > 0, DD < 8000, halts clear: miss | | | | | |

## Selected config, 1m / 3m / 6m

N/A. No config was selected, so the 1m, 3m, and 6m windows were not run.
The $1,200 per quarter pace is N/A.

## Jev spend and coverage

Model id `typesafe-ai/jev`. Cap $25. Spent $0.0000. Calls 0. Cache hits 0. Tokens 0.
Jev configs in the grid: 80. Executed: 0. Cap stopped the run: no.
blocked: TYPESAFE_AI_API_KEY not present
No mock review was written into a reported row.

## Forward paper

Jev stage stays 0 and SWING_APPROVED stays false. A blocked Jev run does not change those defaults.
