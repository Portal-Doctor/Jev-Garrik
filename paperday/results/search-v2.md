# Search v2

Holdout v1 is void: consumed, pre-contaminated. It is not evidence.
Grid version `v2`. Hash `83dcf3dff0bd47de9832a667edfa2e43a74a74989553bef9c87400e9a6f29ce2`.
Base configs after the 6b drop: 114 (universe 114, cap 120).
Dropped cells: none.
Candle hash `fcd7391e0efd5ec545e526df598f98c4d12bfc089c89d5535a19e50b9fa82a81`. Folds: 8.

## Pair history

| pair | first bar | 1m bars |
|---|---|---:|
| UNI-USD | 2025-04-09T00:00:00.000Z | 676216 |
| NEAR-USD | 2025-04-09T00:00:00.000Z | 675243 |
| BCH-USD | 2025-04-09T00:00:00.000Z | 706488 |
| SUI-USD | 2025-04-09T00:00:00.000Z | 769152 |
| AVAX-USD | 2025-04-09T00:00:00.000Z | 635587 |
| ARB-USD | 2025-04-09T00:00:00.000Z | 540545 |
| VVV-USD | 2025-04-09T00:09:00.000Z | 393175 |
| ZEC-USD | 2025-04-09T00:00:00.000Z | 649157 |
| BTC-USD | 2025-04-09T00:00:00.000Z | 788288 |

## Harness parity

Turn-1 6m swing_combined, 2× ATR, the 2.5R–4R band, 48h, POOL equal, Chicago window on: sentiment-blind 12 trades, market-proxy 11 trades. Expected 12 and 11. Search runWindow at 2× / 3R / 48h uses that same band for every 1h 3R row: blind 12, proxy 11. A fixed 3R multiple on this window produced 1 and 1, so it is not the harness. 4R stays a fixed multiple. swing_4h 3R stays the fixed multiple or the nearer daily swing high. Pass: true.

## Folds

- fold 1: IS 2025-11-09 to 2026-02-09, OOS 2026-02-09 to 2026-03-09
- fold 2: IS 2025-12-09 to 2026-03-09, OOS 2026-03-09 to 2026-04-09
- fold 3: IS 2026-01-09 to 2026-04-09, OOS 2026-04-09 to 2026-05-09
- fold 4: IS 2026-02-09 to 2026-05-09, OOS 2026-05-09 to 2026-06-09
- fold 5: IS 2026-03-09 to 2026-06-09, OOS 2026-06-09 to 2026-07-09
- fold 6: IS 2026-04-09 to 2026-07-09, OOS 2026-07-09 to 2026-08-09
- fold 7: IS 2026-05-09 to 2026-08-09, OOS 2026-08-09 to 2026-09-09
- fold 8: IS 2026-06-09 to 2026-09-09, OOS 2026-09-09 to 2026-10-09

## Repo breakout sanity

Out-of-sample breakout trades by allocator: repo_breakout_4h|locked|POOL|atr_scaled|market_proxy|jev_off 64; repo_breakout_4h|locked|SILO|equal|market_proxy|jev_off 63. Jul–Sep 2026 cb/breakout.ts replay net $1186.35 on 87 trades. The repo doc is $1171.80 at 50/90 on the book notionals. Gap $14.55. Different sizing and fill model; the gap is not a pass/fail.

## 6b stop widths

Median across pairs of each pair's p50. A cell under 210 bps was dropped before the hash. No P&L was computed in that step.

| cell | median p50 | dropped | per-pair p10 / p50 / p90 |
|---|---:|---|---|
| swing_A|stop=1.5 | 282.2 | no | UNI-USD 159.5/300.0/508.8 (n=28); NEAR-USD 160.8/261.3/559.6 (n=38); BCH-USD 136.1/197.0/348.1 (n=15); SUI-USD 253.3/286.6/489.0 (n=14); AVAX-USD 125.0/206.5/294.6 (n=19); ARB-USD 180.4/371.7/483.8 (n=14); VVV-USD 269.2/377.6/532.5 (n=40); ZEC-USD 199.8/277.8/564.0 (n=29) |
| swing_A|stop=2 | 371.8 | no | UNI-USD 212.7/392.2/605.5 (n=28); NEAR-USD 191.7/310.0/734.6 (n=38); BCH-USD 163.5/237.5/388.2 (n=15); SUI-USD 337.7/382.1/500.3 (n=14); AVAX-USD 156.3/249.6/336.7 (n=19); ARB-USD 240.5/406.6/645.1 (n=14); VVV-USD 353.0/476.6/693.6 (n=40); ZEC-USD 263.4/361.5/733.6 (n=29) |
| swing_A|stop=2.5 | 449.4 | no | UNI-USD 265.9/446.9/686.6 (n=28); NEAR-USD 232.8/387.6/918.2 (n=38); BCH-USD 204.3/296.8/482.6 (n=15); SUI-USD 409.9/463.7/546.7 (n=14); AVAX-USD 195.4/309.2/359.7 (n=19); ARB-USD 286.1/500.2/806.4 (n=14); VVV-USD 432.1/595.7/867.0 (n=40); ZEC-USD 323.5/451.8/897.3 (n=29) |
| swing_B|stop=1.5 | 307.8 | no | UNI-USD 168.4/283.0/631.2 (n=12); NEAR-USD 170.4/286.8/458.3 (n=9); BCH-USD 137.0/184.1/252.7 (n=6); SUI-USD 222.2/347.5/962.2 (n=5); AVAX-USD 175.8/254.0/341.1 (n=8); ARB-USD 229.0/328.7/595.7 (n=5); VVV-USD 276.0/346.7/531.8 (n=21); ZEC-USD 244.0/379.9/600.9 (n=12) |
| swing_B|stop=2 | 329.0 | no | UNI-USD 223.8/310.6/660.7 (n=12); NEAR-USD 227.2/307.0/458.3 (n=9); BCH-USD 177.1/219.3/306.4 (n=6); SUI-USD 296.3/347.5/962.2 (n=5); AVAX-USD 232.2/274.0/341.1 (n=8); ARB-USD 262.2/438.3/595.7 (n=5); VVV-USD 367.9/462.3/709.0 (n=21); ZEC-USD 325.4/410.5/737.4 (n=12) |
| swing_B|stop=2.5 | 388.9 | no | UNI-USD 279.8/388.3/825.9 (n=12); NEAR-USD 284.1/372.4/540.6 (n=9); BCH-USD 216.7/268.2/382.9 (n=6); SUI-USD 361.1/389.6/962.2 (n=5); AVAX-USD 290.3/315.5/351.8 (n=8); ARB-USD 295.5/451.2/720.7 (n=5); VVV-USD 459.9/577.9/886.3 (n=21); ZEC-USD 401.0/491.5/921.7 (n=12) |
| swing_C|stop=1.5 | 491.4 | no | UNI-USD 275.4/334.0/392.7 (n=2); NEAR-USD 242.5/485.4/672.3 (n=12); BCH-USD 479.7/497.4/515.0 (n=2); SUI-USD // (n=0); AVAX-USD 213.6/240.3/402.3 (n=3); ARB-USD // (n=0); VVV-USD 353.9/585.9/1091.4 (n=11); ZEC-USD 588.0/766.9/817.3 (n=3) |
| swing_C|stop=2 | 491.4 | no | UNI-USD 275.4/334.0/392.7 (n=2); NEAR-USD 248.0/485.4/676.7 (n=12); BCH-USD 479.7/497.4/515.0 (n=2); SUI-USD // (n=0); AVAX-USD 213.6/240.3/402.3 (n=3); ARB-USD // (n=0); VVV-USD 419.2/585.9/1091.4 (n=11); ZEC-USD 588.0/766.9/817.3 (n=3) |
| swing_C|stop=2.5 | 510.6 | no | UNI-USD 313.0/354.9/396.9 (n=2); NEAR-USD 296.8/506.6/676.7 (n=12); BCH-USD 484.2/514.6/545.0 (n=2); SUI-USD // (n=0); AVAX-USD 213.6/240.3/402.3 (n=3); ARB-USD // (n=0); VVV-USD 419.2/691.2/1091.4 (n=11); ZEC-USD 588.0/766.9/817.3 (n=3) |
| swing_combined|stop=1.5 | 300.3 | no | UNI-USD 166.8/299.4/554.9 (n=42); NEAR-USD 172.0/301.2/576.9 (n=59); BCH-USD 133.2/197.0/457.4 (n=23); SUI-USD 229.9/287.0/793.3 (n=19); AVAX-USD 126.5/216.2/340.2 (n=30); ARB-USD 170.6/354.3/539.0 (n=19); VVV-USD 273.8/393.8/655.4 (n=72); ZEC-USD 220.7/326.0/673.8 (n=44) |
| swing_combined|stop=2 | 385.9 | no | UNI-USD 222.5/377.7/660.7 (n=42); NEAR-USD 208.7/390.1/713.9 (n=59); BCH-USD 156.8/237.5/458.0 (n=23); SUI-USD 306.5/381.6/793.3 (n=19); AVAX-USD 167.9/250.0/340.2 (n=30); ARB-USD 227.5/418.2/672.6 (n=19); VVV-USD 354.7/476.6/856.6 (n=72); ZEC-USD 275.3/398.3/758.2 (n=44) |
| swing_combined|stop=2.5 | 436.4 | no | UNI-USD 278.1/416.6/825.9 (n=42); NEAR-USD 233.2/400.6/892.4 (n=59); BCH-USD 196.0/296.8/483.3 (n=23); SUI-USD 364.8/456.3/793.3 (n=19); AVAX-USD 206.2/309.3/374.3 (n=30); ARB-USD 284.2/490.7/834.9 (n=19); VVV-USD 426.6/595.7/1012.2 (n=72); ZEC-USD 344.1/468.6/915.6 (n=44) |
| swing_4h|stop=1 | 484.0 | no | UNI-USD 222.3/438.4/831.5 (n=40); NEAR-USD 256.8/549.8/1286.2 (n=60); BCH-USD 192.5/376.4/780.6 (n=26); SUI-USD 312.0/498.0/692.9 (n=13); AVAX-USD 192.2/470.0/752.3 (n=27); ARB-USD 232.2/395.5/979.4 (n=23); VVV-USD 400.7/684.9/1200.2 (n=77); ZEC-USD 285.9/572.3/1147.1 (n=39) |
| swing_4h|stop=1.5 | 492.9 | no | UNI-USD 328.7/464.1/831.5 (n=40); NEAR-USD 329.2/596.3/1286.2 (n=60); BCH-USD 261.4/378.0/780.6 (n=26); SUI-USD 385.6/498.0/692.9 (n=13); AVAX-USD 285.1/487.8/752.3 (n=27); ARB-USD 330.6/404.9/979.4 (n=23); VVV-USD 482.3/797.6/1200.2 (n=77); ZEC-USD 407.6/580.3/1158.7 (n=39) |
| repo_breakout_4h|locked | 284.0 | no | UNI-USD 295.0/295.0/295.0 (n=89); NEAR-USD 331.0/331.0/331.0 (n=111); BCH-USD 242.0/242.0/242.0 (n=67); SUI-USD 219.0/219.0/219.0 (n=85); AVAX-USD 227.0/227.0/227.0 (n=79); ARB-USD 390.0/390.0/390.0 (n=84); VVV-USD 312.0/312.0/312.0 (n=119); ZEC-USD 273.0/273.0/273.0 (n=93) |

## Proxy clauses

Pair-days 4392. Veto 57.9% (2541). z-score <= -2 8.3% (363). Crash candle 8.3% (364). BTC < 4h EMA50 with a negative 24h 54.1% (2376).
FLAG to Trader: the BTC < 4h EMA50 clause vetoes more than 40% of pair-days. No rule was changed.

## Leaderboard

No base config passed eligibility. The selected config is null.

| rank | id | eligible | OOS net | DD | trades | qualified | E R | p* | folds + | why not |
|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|
| 1 | swing_4h|stop=1.5|target=4|hold=48|SILO|equal|market_proxy|jev_off | no | 476.20 | 75.60 | 3 | 13 | 3.798 | 0.235 | 3/8 | trades 3 < 100; positive OOS folds 3/8 < 60% |
| 2 | swing_4h|stop=1.5|target=4|hold=96|SILO|equal|market_proxy|jev_off | no | 426.33 | 190.97 | 3 | 13 | 2.151 | 0.235 | 2/8 | trades 3 < 100; positive OOS folds 2/8 < 60% |
| 3 | swing_4h|stop=1.5|target=3|hold=48|SILO|equal|market_proxy|jev_off | no | 401.07 | 75.60 | 3 | 13 | 2.899 | 0.288 | 3/8 | trades 3 < 100; positive OOS folds 3/8 < 60% |
| 4 | swing_4h|stop=1|target=4|hold=48|SILO|equal|market_proxy|jev_off | no | 386.06 | 75.60 | 4 | 22 | 2.573 | 0.243 | 3/8 | trades 4 < 100; positive OOS folds 3/8 < 60% |
| 5 | swing_4h|stop=1.5|target=3|hold=96|SILO|equal|market_proxy|jev_off | no | 351.19 | 190.97 | 3 | 13 | 1.553 | 0.288 | 2/8 | trades 3 < 100; positive OOS folds 2/8 < 60% |
| 6 | swing_4h|stop=1|target=3|hold=48|SILO|equal|market_proxy|jev_off | no | 342.28 | 75.60 | 3 | 21 | 2.890 | 0.292 | 3/8 | trades 3 < 100; positive OOS folds 3/8 < 60% |
| 7 | swing_4h|stop=1|target=4|hold=96|SILO|equal|market_proxy|jev_off | no | 336.19 | 190.97 | 4 | 22 | 1.318 | 0.243 | 2/8 | trades 4 < 100; positive OOS folds 2/8 < 60% |
| 8 | swing_4h|stop=1|target=3|hold=96|SILO|equal|market_proxy|jev_off | no | 292.41 | 190.97 | 3 | 21 | 1.542 | 0.292 | 2/8 | trades 3 < 100; positive OOS folds 2/8 < 60% |
| 9 | swing_B|stop=2|target=3|hold=48|SILO|equal|market_proxy|jev_off | no | 189.68 | 140.97 | 13 | 45 | 0.666 | 0.367 | 3/8 | trades 13 < 40; positive OOS folds 3/8 < 60% |
| 10 | swing_B|stop=2.5|target=3|hold=48|SILO|equal|market_proxy|jev_off | no | 141.46 | 153.50 | 15 | 54 | 0.421 | 0.363 | 4/8 | trades 15 < 40; positive OOS folds 4/8 < 60% |

## Per-fold counts for the top rows

### swing_4h|stop=1.5|target=4|hold=48|SILO|equal|market_proxy|jev_off

| fold | IS net | OOS net | OOS trades | OOS qualified | IS qualified |
|---:|---:|---:|---:|---:|---:|
| 1 | 16.80 | 270.80 | 1 | 4 | 2 |
| 2 | 287.60 | 190.42 | 1 | 2 | 6 |
| 3 | 478.03 | 0.00 | 0 | 0 | 8 |
| 4 | 461.22 | 0.00 | 0 | 1 | 6 |
| 5 | 190.42 | 0.00 | 0 | 0 | 3 |
| 6 | 0.00 | 0.00 | 0 | 0 | 1 |
| 7 | 0.00 | 0.00 | 0 | 0 | 1 |
| 8 | 0.00 | 14.98 | 1 | 6 | 0 |

### swing_4h|stop=1.5|target=4|hold=96|SILO|equal|market_proxy|jev_off

| fold | IS net | OOS net | OOS trades | OOS qualified | IS qualified |
|---:|---:|---:|---:|---:|---:|
| 1 | 16.80 | 270.80 | 1 | 4 | 2 |
| 2 | 287.60 | 190.42 | 1 | 2 | 6 |
| 3 | 478.03 | 0.00 | 0 | 0 | 8 |
| 4 | 461.22 | 0.00 | 0 | 1 | 6 |
| 5 | 190.42 | 0.00 | 0 | 0 | 3 |
| 6 | 0.00 | 0.00 | 0 | 0 | 1 |
| 7 | 0.00 | 0.00 | 0 | 0 | 1 |
| 8 | 0.00 | -34.89 | 1 | 6 | 0 |

### swing_4h|stop=1.5|target=3|hold=48|SILO|equal|market_proxy|jev_off

| fold | IS net | OOS net | OOS trades | OOS qualified | IS qualified |
|---:|---:|---:|---:|---:|---:|
| 1 | 16.80 | 219.74 | 1 | 4 | 2 |
| 2 | 236.55 | 166.34 | 1 | 2 | 6 |
| 3 | 402.89 | 0.00 | 0 | 0 | 8 |
| 4 | 386.09 | 0.00 | 0 | 1 | 6 |
| 5 | 166.34 | 0.00 | 0 | 0 | 3 |
| 6 | 0.00 | 0.00 | 0 | 0 | 1 |
| 7 | 0.00 | 0.00 | 0 | 0 | 1 |
| 8 | 0.00 | 14.98 | 1 | 6 | 0 |

## Jev

not run: no eligible jev_off twins
Paid calls 0, tokens 0, paid spend $0.00000000, cache hits 0. Prior probe $0.00001701 counts toward the $25 cap and is not a v2 grid call.

## Side by side

Best Jev, best jev_off, and the breakout baseline. This page does not pick between Jev and jev_off.

| | id | OOS net | DD | trades | E R | p* | folds + | Jev spend |
|---|---|---:|---:|---:|---:|---:|---|---:|
| best Jev | none |  |  |  |  |  |  | 0.00000000 |
| best jev_off (not eligible) | swing_4h|stop=1.5|target=4|hold=48|SILO|equal|market_proxy|jev_off | 476.20 | 75.60 | 3 | 3.798 | 0.235 | 3/8 | 0.00000000 |
| baseline | repo_breakout_4h|locked|POOL|atr_scaled|market_proxy|jev_off | 134.18 | 432.58 | 64 | -0.269 | 0.303 | 1/8 | 0.00000000 |

## Entries

Maker entry attempts 2680, fills 1195 (44.6%), 120s cancels 1485.

## Holdout v2

Config hash `none`. Planned start: Starts when Brian runs the forward-paper command on the home PC. The 30-day clock is not running.
The 30-day clock has not started. It starts when Brian runs the command on the home PC.
No config was eligible, so that command refuses and does not start the clock.

```bash
PAPERDAY_SWING_APPROVED=true PAPERDAY_FORWARD_CONFIRM=1 bun run paperday/src/forward-paper.ts
```
