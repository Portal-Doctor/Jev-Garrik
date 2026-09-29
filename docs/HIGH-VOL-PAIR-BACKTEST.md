# Candidate breakout backtest

Locked breakout 20/3/50, live fees 50/90. HTF fixed-target is comparison only. Live path stays breakout. The running 24h window was not given these pairs.
New pairs that fail adoption rule 3 (drawdown at or above 15%) are not added to the combined book.

## New candidates, breakout

| Pair | n | Accuracy | Wilson 95% | Brier | Edge bps | Net | DD |
|---|---:|---:|---|---:|---:|---:|---:|
| USELESS-USD | 26 | 19.23% | 8.5-37.9% | 0.8077 | 612.8 | $637.33 | 19.35% |
| VVV-USD | 24 | 16.67% | 6.7-35.9% | 0.8333 | 131.8 | $126.48 | 13.45% |
| ZEC-USD | 21 | 33.33% | 17.2-54.6% | 0.6667 | 507.6 | $639.61 | 8.47% |
| QNT-USD | 19 | 15.79% | 5.5-37.6% | 0.8421 | 741.5 | $563.54 | 23.54% |
| PUMP-USD | 28 | 10.71% | 3.7-27.2% | 0.8929 | -185.9 | -$156.14 | 10.64% |
| ONDO-USD | 30 | 6.67% | 1.8-21.3% | 0.9333 | -132.4 | -$158.91 | 18.99% |
| XLM-USD | 21 | 19.05% | 7.7-40.0% | 0.8095 | 13.7 | $11.52 | 7.05% |
| TAO-USD | 23 | 13.04% | 4.5-32.1% | 0.8696 | -129.4 | -$119.04 | 9.25% |
| HYPE-USD | 32 | 12.50% | 5.0-28.1% | 0.8750 | -67.2 | -$129.06 | 16.35% |
| ADA-USD | 18 | 27.78% | 12.5-50.9% | 0.7222 | 138.2 | $124.42 | 6.87% |
| HBAR-USD | 23 | 13.04% | 4.5-32.1% | 0.8696 | -130.6 | -$120.18 | 6.37% |
| LINK-USD | 35 | 5.71% | 1.6-18.6% | 0.9429 | -101.3 | -$212.82 | 13.73% |
| XRP-USD | 32 | 3.13% | 0.6-15.7% | 0.9688 | -198.0 | -$380.11 | 19.01% |
| DOGE-USD | 29 | 3.45% | 0.6-17.2% | 0.9655 | -201.8 | -$351.13 | 17.56% |
| SOL-USD | 29 | 10.34% | 3.6-26.4% | 0.8966 | -103.9 | -$180.73 | 10.28% |
| LTC-USD | 35 | 2.86% | 0.5-14.5% | 0.9714 | -158.8 | -$222.26 | 11.11% |
| ETH-USD | 34 | 2.94% | 0.5-14.9% | 0.9706 | -184.0 | -$377.42 | 19.27% |
| BTC-USD | 43 | 2.33% | 0.4-12.1% | 0.9767 | -157.6 | -$406.58 | 20.33% |

## New candidates, HTF fixed target

| Pair | n | Accuracy | Wilson 95% | Brier | Edge bps | Net | DD |
|---|---:|---:|---|---:|---:|---:|---:|
| USELESS-USD | 234 | 27.35% | 22.0-33.4% | 0.7265 | -44.8 | -$419.22 | 25.57% |
| VVV-USD | 226 | 25.66% | 20.4-31.7% | 0.7434 | -80.7 | -$729.12 | 37.25% |
| ZEC-USD | 181 | 29.28% | 23.1-36.3% | 0.7072 | -32.5 | -$352.57 | 26.09% |
| QNT-USD | 180 | 18.89% | 13.8-25.2% | 0.8111 | -118.6 | -$853.76 | 43.84% |
| PUMP-USD | 246 | 26.83% | 21.7-32.7% | 0.7317 | -77.5 | -$572.11 | 31.18% |
| ONDO-USD | 235 | 22.55% | 17.7-28.3% | 0.7745 | -85.8 | -$806.34 | 41.12% |
| XLM-USD | 0 | - | - | - | - | $0.00 | 0.00% |
| TAO-USD | 0 | - | - | - | - | $0.00 | 0.00% |
| HYPE-USD | 0 | - | - | - | - | $0.00 | 0.00% |
| ADA-USD | 0 | - | - | - | - | $0.00 | 0.00% |
| HBAR-USD | 0 | - | - | - | - | $0.00 | 0.00% |
| LINK-USD | 0 | - | - | - | - | $0.00 | 0.00% |
| XRP-USD | 0 | - | - | - | - | $0.00 | 0.00% |
| DOGE-USD | 0 | - | - | - | - | $0.00 | 0.00% |
| SOL-USD | 0 | - | - | - | - | $0.00 | 0.00% |
| LTC-USD | 0 | - | - | - | - | $0.00 | 0.00% |
| ETH-USD | 0 | - | - | - | - | $0.00 | 0.00% |
| BTC-USD | 0 | - | - | - | - | $0.00 | 0.00% |

## Per-pair adoption (new)

| Pair | Clip | Rule1 net>0 | Beats HTF | Rule3 DD<15% | Miss rate | Trades |
|---|---:|---|---|---|---:|---:|
| USELESS-USD | $400 | yes | yes | NO | 10.34% | 26 |
| VVV-USD | $400 | yes | yes | yes | 7.69% | 24 |
| ZEC-USD | $600 | yes | yes | yes | 8.70% | 21 |
| QNT-USD | $400 | yes | yes | NO | 5.00% | 19 |
| PUMP-USD | $300 | no | yes | yes | 12.50% | 28 |
| ONDO-USD | $400 | no | yes | NO | 14.29% | 30 |
| XLM-USD | $400 | yes | yes | yes | 16.00% | 21 |
| TAO-USD | $400 | no | no | yes | 14.81% | 23 |
| HYPE-USD | $600 | no | no | NO | 11.11% | 32 |
| ADA-USD | $500 | yes | yes | yes | 10.00% | 18 |
| HBAR-USD | $400 | no | no | yes | 11.54% | 23 |
| LINK-USD | $600 | no | no | yes | 2.78% | 35 |
| XRP-USD | $600 | no | no | NO | 5.88% | 32 |
| DOGE-USD | $600 | no | no | NO | 0.00% | 29 |
| SOL-USD | $600 | no | no | yes | 12.12% | 29 |
| LTC-USD | $400 | no | no | yes | 12.50% | 35 |
| ETH-USD | $600 | no | no | NO | 2.78% | 34 |
| BTC-USD | $600 | no | no | NO | 0.00% | 43 |

Passing rule 3: VVV-USD, ZEC-USD, PUMP-USD, XLM-USD, TAO-USD, ADA-USD, HBAR-USD, LINK-USD, SOL-USD, LTC-USD.

## Combined book (original six plus rule-3 passers)

1. Pass. Combined breakout net is $659.47.
2. Pass. Breakout beats the fixed target on 11 of 16 pairs (not TAO-USD, HBAR-USD, LINK-USD, SOL-USD, LTC-USD).
3. Pass. Worst pair drawdown is 13.73%.
4. Pass. Missed 46 of 419 signals (10.98%), and no pair at or above half.
5. Pass. 372 closed breakout trades.
All five: PASS

### Monthly nets, combined breakout

| Month | Net |
|---|---:|
| 2026-04 | -$531.65 |
| 2026-05 | $499.10 |
| 2026-06 | -$371.88 |
| 2026-07 | -$371.23 |
| 2026-08 | $865.59 |
| 2026-09 | $576.34 |

$300/mo gate Jul/Aug/Sep, two miss months per year allowed: PASS. 2 of 3 months at or above $300 (misses 1, 2 allowed per year): 2026-07 -$371.23, 2026-08 $865.59, 2026-09 $576.34.

Pair bankroll in the tables above is $2,000 (the live six-pair split of $12,000). That is the same denominator the adoption rules already use. Rule 3 for adding a name is scored there. Ten names stay under 15%: VVV, ZEC, PUMP, XLM, TAO, ADA, HBAR, LINK, SOL, LTC. Eight fail rule 3 and are out: USELESS, QNT, ONDO, HYPE, XRP, DOGE, ETH, BTC.

If the $12,000 book is split across 16 names ($750 each), dollar drawdowns are unchanged and rule 3 fails on 15 of 16 names (ARB is the exception at 14.20%). The 15% limit was not moved. This pass does not add names to `CB_PAIRS` or rebuild the live engine.

HTF n=0 on the quieter names is a real run, not a skip. At 50/90 and buy threshold 0.70 those tapes never clear the HTF entry hurdle, so there are no fixed-target trades to score. Breakout still trades them.

HBAR, LINK, SOL, and LTC stops sit at 1.0 times 6-month 4h vol, which is under the ~151.5 bps entry hurdle. `assertPairBooks` would refuse them on boot. They are not live candidates even though rule 3 passes at $2,000.

Brier on the breakout rows is the closed-trade mean squared error of p=1 versus a winning close. Breakout is a rule, not a probability.

## New candidates, breakout net by UTC month

| Pair | 2026-04 | 2026-05 | 2026-06 | 2026-07 | 2026-08 | 2026-09 |
|---|---:|---:|---:|---:|---:|---:|
| USELESS-USD | -$97.65 | $236.89 | -$87.93 | -$58.42 | $37.70 | $606.74 |
| VVV-USD | -$80.24 | $221.75 | -$64.19 | -$11.65 | $65.10 | -$4.30 |
| ZEC-USD | $133.60 | $357.10 | -$29.33 | -$18.40 | $105.22 | $91.42 |
| QNT-USD | -$25.97 | -$36.44 | -$40.37 | -$53.83 | -$10.16 | $730.32 |
| PUMP-USD | -$60.53 | $11.69 | -$50.32 | -$60.38 | $19.11 | -$15.71 |
| ONDO-USD | -$36.07 | $123.79 | -$48.10 | -$84.17 | -$18.17 | -$96.19 |
| XLM-USD | $25.25 | $27.20 | $18.36 | -$33.44 | $52.19 | -$78.03 |
| TAO-USD | -$53.35 | -$64.02 | $16.35 | $0.00 | -$69.52 | $51.49 |
| HYPE-USD | -$111.19 | -$62.14 | -$15.35 | -$63.54 | $98.72 | $24.44 |
| ADA-USD | -$24.68 | $11.07 | -$37.02 | $38.52 | $140.60 | -$4.06 |
| HBAR-USD | -$36.94 | -$46.18 | -$9.24 | -$19.25 | $39.99 | -$48.56 |
| LINK-USD | -$104.13 | -$32.15 | -$52.06 | -$81.11 | $186.79 | -$130.16 |
| XRP-USD | -$89.02 | -$63.59 | -$25.43 | -$7.75 | -$89.02 | -$105.30 |
| DOGE-USD | -$58.27 | -$50.63 | -$12.66 | -$50.63 | -$101.26 | -$77.69 |
| SOL-USD | -$74.51 | $15.69 | -$74.51 | -$49.67 | $59.82 | -$57.55 |
| LTC-USD | -$63.36 | -$39.60 | -$34.78 | -$30.65 | $16.00 | -$69.87 |
| ETH-USD | -$82.75 | -$47.28 | -$47.28 | -$79.15 | -$59.11 | -$59.84 |
| BTC-USD | -$92.41 | -$61.60 | -$51.34 | -$112.94 | -$45.30 | -$43.00 |

