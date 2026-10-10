# Paper-day backtest summary

Data: Coinbase public 1-minute candles, including BTC-USD for the market proxy. Hash `f049b7a1ab8f513a16345e00899fb4348d40af74659bea9d4394374da9a53e6f`.
Fee tier 50/90. Winner round trip 100 bps (maker target). Loser round trip 140 bps (taker stop or market exit). Haircut 0.5.
Per-trade floor: (T − 100) ≥ 1.5 × (S + 140). Class p* = (S + 140) / (T + S − 40) ≤ 45%. Walk-forward E ≥ +0.15R or ≥ +25 bps in at least 2 of 3 splits.
Required gate: eligible sample (12 / 40 / 100 closed trades), net > $0 in that window, expectancy met, max drawdown < $8,000, pair-loss and daily-loss halts never breached. A configuration passes only when 1m, 3m, and 6m all pass. The intraday arm is excluded.
Target gate (not blocking): 1m ≥ $400, 3m ≥ $1,200, 6m ≥ $2,400, each full quarter ≥ $1,200, partial quarters prorated by days.
sentiment-blind rows are an upper bound. market-proxy rows are a proxy, not an X read.
Jev: blocked: AI_GATEWAY_API_KEY not present. Calls 0, tokens 0, spend $0. No mock was substituted.

| strategy | sentiment | mode | formula | window | trades | win rate | avg R | E R | E bps | p* | net USD | max DD | sample | required | target |
|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|
| swing_A | sentiment_blind | POOL | equal | 1m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | -23.51 | 94.25 | insufficient_sample | fail | fail |
| swing_A | sentiment_blind | POOL | equal | 3m | 5 | 20.0 | -0.532 | -0.571 | -277.9 | 37.7 | -77.91 | 145.82 | insufficient_sample | fail | fail |
| swing_A | sentiment_blind | POOL | equal | 6m | 7 | 14.3 | -0.718 | -0.803 | -355.9 | 38.6 | -156.97 | 258.47 | insufficient_sample | fail | fail |
| swing_A | market_proxy | POOL | equal | 1m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | -23.51 | 94.25 | insufficient_sample | fail | fail |
| swing_A | market_proxy | POOL | equal | 3m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | -23.51 | 94.25 | insufficient_sample | fail | fail |
| swing_A | market_proxy | POOL | equal | 6m | 6 | 16.7 | -0.615 | -0.713 | -320.5 | 38.5 | -102.58 | 204.07 | insufficient_sample | fail | fail |
| swing_A | sentiment_blind | POOL | atr_scaled | 1m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | 0.26 | 22.56 | insufficient_sample | fail | fail |
| swing_A | sentiment_blind | POOL | atr_scaled | 3m | 5 | 20.0 | -0.532 | -0.571 | -277.9 | 37.7 | -114.33 | 123.65 | insufficient_sample | fail | fail |
| swing_A | sentiment_blind | POOL | atr_scaled | 6m | 7 | 14.3 | -0.718 | -0.803 | -355.9 | 38.6 | -117.93 | 130.88 | insufficient_sample | fail | fail |
| swing_A | market_proxy | POOL | atr_scaled | 1m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | -1.07 | 22.56 | insufficient_sample | fail | fail |
| swing_A | market_proxy | POOL | atr_scaled | 3m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | 0.89 | 22.56 | insufficient_sample | fail | fail |
| swing_A | market_proxy | POOL | atr_scaled | 6m | 6 | 16.7 | -0.615 | -0.713 | -320.5 | 38.5 | -2.71 | 22.56 | insufficient_sample | fail | fail |
| swing_A | sentiment_blind | SILO | equal | 1m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | -23.51 | 94.25 | insufficient_sample | fail | fail |
| swing_A | sentiment_blind | SILO | equal | 3m | 5 | 20.0 | -0.532 | -0.571 | -277.9 | 37.7 | -77.91 | 145.82 | insufficient_sample | fail | fail |
| swing_A | sentiment_blind | SILO | equal | 6m | 7 | 14.3 | -0.718 | -0.803 | -355.9 | 38.6 | -156.97 | 258.47 | insufficient_sample | fail | fail |
| swing_A | market_proxy | SILO | equal | 1m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | -23.51 | 94.25 | insufficient_sample | fail | fail |
| swing_A | market_proxy | SILO | equal | 3m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | -23.51 | 94.25 | insufficient_sample | fail | fail |
| swing_A | market_proxy | SILO | equal | 6m | 6 | 16.7 | -0.615 | -0.713 | -320.5 | 38.5 | -102.58 | 204.07 | insufficient_sample | fail | fail |
| swing_A | sentiment_blind | SILO | atr_scaled | 1m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | -23.51 | 94.25 | insufficient_sample | fail | fail |
| swing_A | sentiment_blind | SILO | atr_scaled | 3m | 5 | 20.0 | -0.532 | -0.571 | -277.9 | 37.7 | -77.91 | 145.82 | insufficient_sample | fail | fail |
| swing_A | sentiment_blind | SILO | atr_scaled | 6m | 7 | 14.3 | -0.718 | -0.803 | -355.9 | 38.6 | -156.97 | 258.47 | insufficient_sample | fail | fail |
| swing_A | market_proxy | SILO | atr_scaled | 1m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | -23.51 | 94.25 | insufficient_sample | fail | fail |
| swing_A | market_proxy | SILO | atr_scaled | 3m | 4 | 25.0 | -0.331 | -0.382 | -193.2 | 37.3 | -23.51 | 94.25 | insufficient_sample | fail | fail |
| swing_A | market_proxy | SILO | atr_scaled | 6m | 6 | 16.7 | -0.615 | -0.713 | -320.5 | 38.5 | -102.58 | 204.07 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | POOL | equal | 1m | 2 | 100.0 | 1.491 | 2.317 | 1265.2 | 36.7 | 170.90 | 42.89 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | POOL | equal | 3m | 3 | 100.0 | 1.611 | 2.333 | 1400.9 | 35.9 | 301.97 | 42.89 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | POOL | equal | 6m | 8 | 62.5 | 0.559 | 1.000 | 613.8 | 35.8 | 322.05 | 115.20 | insufficient_sample | fail | fail |
| swing_B | market_proxy | POOL | equal | 1m | 2 | 100.0 | 1.491 | 2.317 | 1265.2 | 36.7 | 170.90 | 42.89 | insufficient_sample | fail | fail |
| swing_B | market_proxy | POOL | equal | 3m | 3 | 100.0 | 1.611 | 2.333 | 1400.9 | 35.9 | 301.97 | 42.89 | insufficient_sample | fail | fail |
| swing_B | market_proxy | POOL | equal | 6m | 8 | 62.5 | 0.559 | 1.000 | 613.8 | 35.8 | 322.05 | 115.20 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | POOL | atr_scaled | 1m | 2 | 100.0 | 1.491 | 2.317 | 1265.2 | 36.7 | 30.53 | 14.86 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | POOL | atr_scaled | 3m | 3 | 100.0 | 1.611 | 2.333 | 1400.9 | 35.9 | 122.92 | 15.39 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | POOL | atr_scaled | 6m | 8 | 62.5 | 0.559 | 1.000 | 613.8 | 35.8 | 124.78 | 15.39 | insufficient_sample | fail | fail |
| swing_B | market_proxy | POOL | atr_scaled | 1m | 2 | 100.0 | 1.491 | 2.317 | 1265.2 | 36.7 | 30.53 | 14.86 | insufficient_sample | fail | fail |
| swing_B | market_proxy | POOL | atr_scaled | 3m | 3 | 100.0 | 1.611 | 2.333 | 1400.9 | 35.9 | 122.92 | 15.39 | insufficient_sample | fail | fail |
| swing_B | market_proxy | POOL | atr_scaled | 6m | 8 | 62.5 | 0.559 | 1.000 | 613.8 | 35.8 | 124.78 | 15.39 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | SILO | equal | 1m | 2 | 100.0 | 1.491 | 2.317 | 1265.2 | 36.7 | 170.90 | 42.89 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | SILO | equal | 3m | 3 | 100.0 | 1.611 | 2.333 | 1400.9 | 35.9 | 301.97 | 42.89 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | SILO | equal | 6m | 8 | 62.5 | 0.559 | 1.000 | 613.8 | 35.8 | 322.05 | 115.20 | insufficient_sample | fail | fail |
| swing_B | market_proxy | SILO | equal | 1m | 2 | 100.0 | 1.491 | 2.317 | 1265.2 | 36.7 | 170.90 | 42.89 | insufficient_sample | fail | fail |
| swing_B | market_proxy | SILO | equal | 3m | 3 | 100.0 | 1.611 | 2.333 | 1400.9 | 35.9 | 301.97 | 42.89 | insufficient_sample | fail | fail |
| swing_B | market_proxy | SILO | equal | 6m | 8 | 62.5 | 0.559 | 1.000 | 613.8 | 35.8 | 322.05 | 115.20 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | SILO | atr_scaled | 1m | 2 | 100.0 | 1.491 | 2.317 | 1265.2 | 36.7 | 170.90 | 42.89 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | SILO | atr_scaled | 3m | 3 | 100.0 | 1.611 | 2.333 | 1400.9 | 35.9 | 301.97 | 42.89 | insufficient_sample | fail | fail |
| swing_B | sentiment_blind | SILO | atr_scaled | 6m | 8 | 62.5 | 0.559 | 1.000 | 613.8 | 35.8 | 322.05 | 115.20 | insufficient_sample | fail | fail |
| swing_B | market_proxy | SILO | atr_scaled | 1m | 2 | 100.0 | 1.491 | 2.317 | 1265.2 | 36.7 | 170.90 | 42.89 | insufficient_sample | fail | fail |
| swing_B | market_proxy | SILO | atr_scaled | 3m | 3 | 100.0 | 1.611 | 2.333 | 1400.9 | 35.9 | 301.97 | 42.89 | insufficient_sample | fail | fail |
| swing_B | market_proxy | SILO | atr_scaled | 6m | 8 | 62.5 | 0.559 | 1.000 | 613.8 | 35.8 | 322.05 | 115.20 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | POOL | equal | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | POOL | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | POOL | equal | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | POOL | equal | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | POOL | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | POOL | equal | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | POOL | atr_scaled | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | POOL | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | POOL | atr_scaled | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | POOL | atr_scaled | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | POOL | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | POOL | atr_scaled | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | SILO | equal | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | SILO | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | SILO | equal | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | SILO | equal | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | SILO | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | SILO | equal | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | SILO | atr_scaled | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | SILO | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | sentiment_blind | SILO | atr_scaled | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | SILO | atr_scaled | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | SILO | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_C | market_proxy | SILO | atr_scaled | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | POOL | equal | 1m | 5 | 40.0 | -0.036 | 0.147 | 72.4 | 37.6 | 25.77 | 120.83 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | POOL | equal | 3m | 7 | 42.9 | 0.048 | 0.259 | 132.2 | 37.2 | 102.44 | 145.82 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | POOL | equal | 6m | 12 | 41.7 | -0.002 | 0.237 | 131.8 | 36.5 | 122.53 | 145.82 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | POOL | equal | 1m | 5 | 40.0 | -0.036 | 0.147 | 72.4 | 37.6 | 25.77 | 120.83 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | POOL | equal | 3m | 6 | 50.0 | 0.278 | 0.522 | 275.4 | 37.0 | 156.84 | 120.83 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | POOL | equal | 6m | 11 | 45.5 | 0.119 | 0.377 | 215.1 | 36.3 | 176.92 | 120.83 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | POOL | atr_scaled | 1m | 5 | 40.0 | -0.036 | 0.147 | 72.4 | 37.6 | 17.33 | 32.53 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | POOL | atr_scaled | 3m | 7 | 42.9 | 0.048 | 0.259 | 132.2 | 37.2 | -4.88 | 124.38 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | POOL | atr_scaled | 6m | 12 | 41.7 | -0.002 | 0.237 | 131.8 | 36.5 | -3.01 | 124.38 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | POOL | atr_scaled | 1m | 5 | 40.0 | -0.036 | 0.147 | 72.4 | 37.6 | 16.00 | 32.53 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | POOL | atr_scaled | 3m | 6 | 50.0 | 0.278 | 0.522 | 275.4 | 37.0 | 110.35 | 32.53 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | POOL | atr_scaled | 6m | 11 | 45.5 | 0.119 | 0.377 | 215.1 | 36.3 | 112.21 | 32.53 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | SILO | equal | 1m | 5 | 40.0 | -0.036 | 0.147 | 72.4 | 37.6 | 25.77 | 120.83 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | SILO | equal | 3m | 7 | 42.9 | 0.048 | 0.259 | 132.2 | 37.2 | 102.44 | 145.82 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | SILO | equal | 6m | 12 | 41.7 | -0.002 | 0.237 | 131.8 | 36.5 | 122.53 | 145.82 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | SILO | equal | 1m | 5 | 40.0 | -0.036 | 0.147 | 72.4 | 37.6 | 25.77 | 120.83 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | SILO | equal | 3m | 6 | 50.0 | 0.278 | 0.522 | 275.4 | 37.0 | 156.84 | 120.83 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | SILO | equal | 6m | 11 | 45.5 | 0.119 | 0.377 | 215.1 | 36.3 | 176.92 | 120.83 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | SILO | atr_scaled | 1m | 5 | 40.0 | -0.036 | 0.147 | 72.4 | 37.6 | 25.77 | 120.83 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | SILO | atr_scaled | 3m | 7 | 42.9 | 0.048 | 0.259 | 132.2 | 37.2 | 102.44 | 145.82 | insufficient_sample | fail | fail |
| swing_combined | sentiment_blind | SILO | atr_scaled | 6m | 12 | 41.7 | -0.002 | 0.237 | 131.8 | 36.5 | 122.53 | 145.82 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | SILO | atr_scaled | 1m | 5 | 40.0 | -0.036 | 0.147 | 72.4 | 37.6 | 25.77 | 120.83 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | SILO | atr_scaled | 3m | 6 | 50.0 | 0.278 | 0.522 | 275.4 | 37.0 | 156.84 | 120.83 | insufficient_sample | fail | fail |
| swing_combined | market_proxy | SILO | atr_scaled | 6m | 11 | 45.5 | 0.119 | 0.377 | 215.1 | 36.3 | 176.92 | 120.83 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | POOL | equal | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | POOL | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | POOL | equal | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | POOL | equal | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | POOL | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | POOL | equal | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | POOL | atr_scaled | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | POOL | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | POOL | atr_scaled | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | POOL | atr_scaled | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | POOL | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | POOL | atr_scaled | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | SILO | equal | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | SILO | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | SILO | equal | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | SILO | equal | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | SILO | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | SILO | equal | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | SILO | atr_scaled | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | SILO | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | sentiment_blind | SILO | atr_scaled | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | SILO | atr_scaled | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | SILO | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| repo_breakout_4h | market_proxy | SILO | atr_scaled | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | insufficient_sample | fail | fail |
| intraday_research | sentiment_blind | POOL | equal | 1m | 1 | 0.0 | -0.677 | -1.617 | -367.1 | 42.3 | -15.37 | 32.53 | research_excluded | fail | fail |
| intraday_research | sentiment_blind | POOL | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | sentiment_blind | POOL | equal | 6m | 1 | 100.0 | 0.293 | 2.592 | 635.9 | 40.9 | 7.19 | 19.11 | research_excluded | fail | fail |
| intraday_research | market_proxy | POOL | equal | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | market_proxy | POOL | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | market_proxy | POOL | equal | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | sentiment_blind | POOL | atr_scaled | 1m | 1 | 0.0 | -0.677 | -1.617 | -367.1 | 42.3 | -5.48 | 11.60 | research_excluded | fail | fail |
| intraday_research | sentiment_blind | POOL | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | sentiment_blind | POOL | atr_scaled | 6m | 1 | 100.0 | 0.293 | 2.592 | 635.9 | 40.9 | 0.94 | 2.49 | research_excluded | fail | fail |
| intraday_research | market_proxy | POOL | atr_scaled | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | market_proxy | POOL | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | market_proxy | POOL | atr_scaled | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | sentiment_blind | SILO | equal | 1m | 1 | 0.0 | -0.677 | -1.617 | -367.1 | 42.3 | -15.37 | 32.53 | research_excluded | fail | fail |
| intraday_research | sentiment_blind | SILO | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | sentiment_blind | SILO | equal | 6m | 1 | 100.0 | 0.293 | 2.592 | 635.9 | 40.9 | 7.19 | 19.11 | research_excluded | fail | fail |
| intraday_research | market_proxy | SILO | equal | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | market_proxy | SILO | equal | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | market_proxy | SILO | equal | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | sentiment_blind | SILO | atr_scaled | 1m | 1 | 0.0 | -0.677 | -1.617 | -367.1 | 42.3 | -15.37 | 32.53 | research_excluded | fail | fail |
| intraday_research | sentiment_blind | SILO | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | sentiment_blind | SILO | atr_scaled | 6m | 1 | 100.0 | 0.293 | 2.592 | 635.9 | 40.9 | 7.19 | 19.11 | research_excluded | fail | fail |
| intraday_research | market_proxy | SILO | atr_scaled | 1m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | market_proxy | SILO | atr_scaled | 3m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |
| intraday_research | market_proxy | SILO | atr_scaled | 6m | 0 |  |  |  |  |  | 0.00 | 0.00 | research_excluded | fail | fail |

## Rejects

| strategy | sentiment | mode | formula | window | rejects |
|---|---|---|---|---|---|
| swing_A | sentiment_blind | POOL | equal | 1m | outside_session:41 below_fee_floor:9 no_structure:2 macro_blackout:2 |
| swing_A | sentiment_blind | POOL | equal | 3m | outside_session:60 below_fee_floor:33 macro_blackout:5 no_structure:3 |
| swing_A | sentiment_blind | POOL | equal | 6m | outside_session:73 below_fee_floor:71 no_structure:12 macro_blackout:9 |
| swing_A | market_proxy | POOL | equal | 1m | sentiment:230 outside_session:36 below_fee_floor:9 macro_blackout:2 no_structure:1 |
| swing_A | market_proxy | POOL | equal | 3m | sentiment:550 outside_session:54 below_fee_floor:31 macro_blackout:5 no_structure:2 |
| swing_A | market_proxy | POOL | equal | 6m | sentiment:1113 below_fee_floor:67 outside_session:58 no_structure:11 macro_blackout:7 |
| swing_A | sentiment_blind | POOL | atr_scaled | 1m | outside_session:41 below_fee_floor:9 no_structure:2 macro_blackout:2 total_cap:1 |
| swing_A | sentiment_blind | POOL | atr_scaled | 3m | outside_session:60 below_fee_floor:33 macro_blackout:5 no_structure:3 total_cap:1 |
| swing_A | sentiment_blind | POOL | atr_scaled | 6m | outside_session:73 below_fee_floor:71 no_structure:12 macro_blackout:9 |
| swing_A | market_proxy | POOL | atr_scaled | 1m | sentiment:230 outside_session:36 below_fee_floor:9 macro_blackout:2 total_cap:1 no_structure:1 |
| swing_A | market_proxy | POOL | atr_scaled | 3m | sentiment:550 outside_session:54 below_fee_floor:31 macro_blackout:5 no_structure:2 |
| swing_A | market_proxy | POOL | atr_scaled | 6m | sentiment:1113 below_fee_floor:67 outside_session:58 no_structure:11 macro_blackout:7 |
| swing_A | sentiment_blind | SILO | equal | 1m | outside_session:41 below_fee_floor:9 no_structure:2 macro_blackout:2 |
| swing_A | sentiment_blind | SILO | equal | 3m | outside_session:60 below_fee_floor:33 macro_blackout:5 no_structure:3 |
| swing_A | sentiment_blind | SILO | equal | 6m | outside_session:73 below_fee_floor:71 no_structure:12 macro_blackout:9 |
| swing_A | market_proxy | SILO | equal | 1m | sentiment:230 outside_session:36 below_fee_floor:9 macro_blackout:2 no_structure:1 |
| swing_A | market_proxy | SILO | equal | 3m | sentiment:550 outside_session:54 below_fee_floor:31 macro_blackout:5 no_structure:2 |
| swing_A | market_proxy | SILO | equal | 6m | sentiment:1113 below_fee_floor:67 outside_session:58 no_structure:11 macro_blackout:7 |
| swing_A | sentiment_blind | SILO | atr_scaled | 1m | outside_session:41 below_fee_floor:9 no_structure:2 macro_blackout:2 |
| swing_A | sentiment_blind | SILO | atr_scaled | 3m | outside_session:60 below_fee_floor:33 macro_blackout:5 no_structure:3 |
| swing_A | sentiment_blind | SILO | atr_scaled | 6m | outside_session:73 below_fee_floor:71 no_structure:12 macro_blackout:9 |
| swing_A | market_proxy | SILO | atr_scaled | 1m | sentiment:230 outside_session:36 below_fee_floor:9 macro_blackout:2 no_structure:1 |
| swing_A | market_proxy | SILO | atr_scaled | 3m | sentiment:550 outside_session:54 below_fee_floor:31 macro_blackout:5 no_structure:2 |
| swing_A | market_proxy | SILO | atr_scaled | 6m | sentiment:1113 below_fee_floor:67 outside_session:58 no_structure:11 macro_blackout:7 |
| swing_B | sentiment_blind | POOL | equal | 1m | outside_session:5 below_fee_floor:5 |
| swing_B | sentiment_blind | POOL | equal | 3m | below_fee_floor:15 outside_session:11 macro_blackout:2 no_structure:1 |
| swing_B | sentiment_blind | POOL | equal | 6m | below_fee_floor:26 outside_session:16 macro_blackout:2 no_structure:1 |
| swing_B | market_proxy | POOL | equal | 1m | sentiment:230 below_fee_floor:5 outside_session:3 |
| swing_B | market_proxy | POOL | equal | 3m | sentiment:550 below_fee_floor:14 outside_session:6 macro_blackout:2 no_structure:1 |
| swing_B | market_proxy | POOL | equal | 6m | sentiment:1113 below_fee_floor:22 outside_session:8 macro_blackout:2 no_structure:1 |
| swing_B | sentiment_blind | POOL | atr_scaled | 1m | outside_session:5 below_fee_floor:5 total_cap:1 |
| swing_B | sentiment_blind | POOL | atr_scaled | 3m | below_fee_floor:15 outside_session:11 macro_blackout:2 no_structure:1 |
| swing_B | sentiment_blind | POOL | atr_scaled | 6m | below_fee_floor:26 outside_session:16 macro_blackout:2 no_structure:1 |
| swing_B | market_proxy | POOL | atr_scaled | 1m | sentiment:230 below_fee_floor:5 outside_session:3 |
| swing_B | market_proxy | POOL | atr_scaled | 3m | sentiment:550 below_fee_floor:14 outside_session:6 macro_blackout:2 no_structure:1 |
| swing_B | market_proxy | POOL | atr_scaled | 6m | sentiment:1113 below_fee_floor:22 outside_session:8 macro_blackout:2 no_structure:1 |
| swing_B | sentiment_blind | SILO | equal | 1m | outside_session:5 below_fee_floor:5 |
| swing_B | sentiment_blind | SILO | equal | 3m | below_fee_floor:15 outside_session:11 macro_blackout:2 no_structure:1 |
| swing_B | sentiment_blind | SILO | equal | 6m | below_fee_floor:26 outside_session:16 macro_blackout:2 no_structure:1 |
| swing_B | market_proxy | SILO | equal | 1m | sentiment:230 below_fee_floor:5 outside_session:3 |
| swing_B | market_proxy | SILO | equal | 3m | sentiment:550 below_fee_floor:14 outside_session:6 macro_blackout:2 no_structure:1 |
| swing_B | market_proxy | SILO | equal | 6m | sentiment:1113 below_fee_floor:22 outside_session:8 macro_blackout:2 no_structure:1 |
| swing_B | sentiment_blind | SILO | atr_scaled | 1m | outside_session:5 below_fee_floor:5 |
| swing_B | sentiment_blind | SILO | atr_scaled | 3m | below_fee_floor:15 outside_session:11 macro_blackout:2 no_structure:1 |
| swing_B | sentiment_blind | SILO | atr_scaled | 6m | below_fee_floor:26 outside_session:16 macro_blackout:2 no_structure:1 |
| swing_B | market_proxy | SILO | atr_scaled | 1m | sentiment:230 below_fee_floor:5 outside_session:3 |
| swing_B | market_proxy | SILO | atr_scaled | 3m | sentiment:550 below_fee_floor:14 outside_session:6 macro_blackout:2 no_structure:1 |
| swing_B | market_proxy | SILO | atr_scaled | 6m | sentiment:1113 below_fee_floor:22 outside_session:8 macro_blackout:2 no_structure:1 |
| swing_C | sentiment_blind | POOL | equal | 1m | outside_session:11 |
| swing_C | sentiment_blind | POOL | equal | 3m | outside_session:14 below_fee_floor:2 macro_blackout:1 |
| swing_C | sentiment_blind | POOL | equal | 6m | outside_session:18 below_fee_floor:7 macro_blackout:1 |
| swing_C | market_proxy | POOL | equal | 1m | sentiment:230 outside_session:10 |
| swing_C | market_proxy | POOL | equal | 3m | sentiment:550 outside_session:12 below_fee_floor:2 macro_blackout:1 |
| swing_C | market_proxy | POOL | equal | 6m | sentiment:1113 outside_session:14 below_fee_floor:7 macro_blackout:1 |
| swing_C | sentiment_blind | POOL | atr_scaled | 1m | outside_session:11 |
| swing_C | sentiment_blind | POOL | atr_scaled | 3m | outside_session:14 below_fee_floor:2 macro_blackout:1 |
| swing_C | sentiment_blind | POOL | atr_scaled | 6m | outside_session:18 below_fee_floor:7 macro_blackout:1 |
| swing_C | market_proxy | POOL | atr_scaled | 1m | sentiment:230 outside_session:10 |
| swing_C | market_proxy | POOL | atr_scaled | 3m | sentiment:550 outside_session:12 below_fee_floor:2 macro_blackout:1 |
| swing_C | market_proxy | POOL | atr_scaled | 6m | sentiment:1113 outside_session:14 below_fee_floor:7 macro_blackout:1 |
| swing_C | sentiment_blind | SILO | equal | 1m | outside_session:11 |
| swing_C | sentiment_blind | SILO | equal | 3m | outside_session:14 below_fee_floor:2 macro_blackout:1 |
| swing_C | sentiment_blind | SILO | equal | 6m | outside_session:18 below_fee_floor:7 macro_blackout:1 |
| swing_C | market_proxy | SILO | equal | 1m | sentiment:230 outside_session:10 |
| swing_C | market_proxy | SILO | equal | 3m | sentiment:550 outside_session:12 below_fee_floor:2 macro_blackout:1 |
| swing_C | market_proxy | SILO | equal | 6m | sentiment:1113 outside_session:14 below_fee_floor:7 macro_blackout:1 |
| swing_C | sentiment_blind | SILO | atr_scaled | 1m | outside_session:11 |
| swing_C | sentiment_blind | SILO | atr_scaled | 3m | outside_session:14 below_fee_floor:2 macro_blackout:1 |
| swing_C | sentiment_blind | SILO | atr_scaled | 6m | outside_session:18 below_fee_floor:7 macro_blackout:1 |
| swing_C | market_proxy | SILO | atr_scaled | 1m | sentiment:230 outside_session:10 |
| swing_C | market_proxy | SILO | atr_scaled | 3m | sentiment:550 outside_session:12 below_fee_floor:2 macro_blackout:1 |
| swing_C | market_proxy | SILO | atr_scaled | 6m | sentiment:1113 outside_session:14 below_fee_floor:7 macro_blackout:1 |
| swing_combined | sentiment_blind | POOL | equal | 1m | outside_session:53 below_fee_floor:14 no_structure:2 macro_blackout:2 |
| swing_combined | sentiment_blind | POOL | equal | 3m | outside_session:81 below_fee_floor:50 macro_blackout:8 no_structure:4 |
| swing_combined | sentiment_blind | POOL | equal | 6m | below_fee_floor:104 outside_session:102 no_structure:13 macro_blackout:12 |
| swing_combined | market_proxy | POOL | equal | 1m | sentiment:230 outside_session:45 below_fee_floor:14 macro_blackout:2 no_structure:1 |
| swing_combined | market_proxy | POOL | equal | 3m | sentiment:550 outside_session:68 below_fee_floor:47 macro_blackout:8 no_structure:3 |
| swing_combined | market_proxy | POOL | equal | 6m | sentiment:1113 below_fee_floor:96 outside_session:75 no_structure:12 macro_blackout:10 |
| swing_combined | sentiment_blind | POOL | atr_scaled | 1m | outside_session:53 below_fee_floor:14 total_cap:2 no_structure:2 macro_blackout:2 |
| swing_combined | sentiment_blind | POOL | atr_scaled | 3m | outside_session:81 below_fee_floor:50 macro_blackout:8 no_structure:4 total_cap:1 |
| swing_combined | sentiment_blind | POOL | atr_scaled | 6m | below_fee_floor:104 outside_session:102 no_structure:13 macro_blackout:12 |
| swing_combined | market_proxy | POOL | atr_scaled | 1m | sentiment:230 outside_session:45 below_fee_floor:14 macro_blackout:2 total_cap:1 no_structure:1 |
| swing_combined | market_proxy | POOL | atr_scaled | 3m | sentiment:550 outside_session:68 below_fee_floor:47 macro_blackout:8 no_structure:3 |
| swing_combined | market_proxy | POOL | atr_scaled | 6m | sentiment:1113 below_fee_floor:96 outside_session:75 no_structure:12 macro_blackout:10 |
| swing_combined | sentiment_blind | SILO | equal | 1m | outside_session:53 below_fee_floor:14 no_structure:2 macro_blackout:2 |
| swing_combined | sentiment_blind | SILO | equal | 3m | outside_session:81 below_fee_floor:50 macro_blackout:8 no_structure:4 |
| swing_combined | sentiment_blind | SILO | equal | 6m | below_fee_floor:104 outside_session:102 no_structure:13 macro_blackout:12 |
| swing_combined | market_proxy | SILO | equal | 1m | sentiment:230 outside_session:45 below_fee_floor:14 macro_blackout:2 no_structure:1 |
| swing_combined | market_proxy | SILO | equal | 3m | sentiment:550 outside_session:68 below_fee_floor:47 macro_blackout:8 no_structure:3 |
| swing_combined | market_proxy | SILO | equal | 6m | sentiment:1113 below_fee_floor:96 outside_session:75 no_structure:12 macro_blackout:10 |
| swing_combined | sentiment_blind | SILO | atr_scaled | 1m | outside_session:53 below_fee_floor:14 no_structure:2 macro_blackout:2 |
| swing_combined | sentiment_blind | SILO | atr_scaled | 3m | outside_session:81 below_fee_floor:50 macro_blackout:8 no_structure:4 |
| swing_combined | sentiment_blind | SILO | atr_scaled | 6m | below_fee_floor:104 outside_session:102 no_structure:13 macro_blackout:12 |
| swing_combined | market_proxy | SILO | atr_scaled | 1m | sentiment:230 outside_session:45 below_fee_floor:14 macro_blackout:2 no_structure:1 |
| swing_combined | market_proxy | SILO | atr_scaled | 3m | sentiment:550 outside_session:68 below_fee_floor:47 macro_blackout:8 no_structure:3 |
| swing_combined | market_proxy | SILO | atr_scaled | 6m | sentiment:1113 below_fee_floor:96 outside_session:75 no_structure:12 macro_blackout:10 |
| repo_breakout_4h | sentiment_blind | POOL | equal | 1m | below_fee_floor:83 |
| repo_breakout_4h | sentiment_blind | POOL | equal | 3m | below_fee_floor:251 |
| repo_breakout_4h | sentiment_blind | POOL | equal | 6m | below_fee_floor:450 |
| repo_breakout_4h | market_proxy | POOL | equal | 1m | below_fee_floor:83 |
| repo_breakout_4h | market_proxy | POOL | equal | 3m | below_fee_floor:251 |
| repo_breakout_4h | market_proxy | POOL | equal | 6m | below_fee_floor:450 |
| repo_breakout_4h | sentiment_blind | POOL | atr_scaled | 1m | below_fee_floor:83 |
| repo_breakout_4h | sentiment_blind | POOL | atr_scaled | 3m | below_fee_floor:251 |
| repo_breakout_4h | sentiment_blind | POOL | atr_scaled | 6m | below_fee_floor:450 |
| repo_breakout_4h | market_proxy | POOL | atr_scaled | 1m | below_fee_floor:83 |
| repo_breakout_4h | market_proxy | POOL | atr_scaled | 3m | below_fee_floor:251 |
| repo_breakout_4h | market_proxy | POOL | atr_scaled | 6m | below_fee_floor:450 |
| repo_breakout_4h | sentiment_blind | SILO | equal | 1m | below_fee_floor:83 |
| repo_breakout_4h | sentiment_blind | SILO | equal | 3m | below_fee_floor:251 |
| repo_breakout_4h | sentiment_blind | SILO | equal | 6m | below_fee_floor:450 |
| repo_breakout_4h | market_proxy | SILO | equal | 1m | below_fee_floor:83 |
| repo_breakout_4h | market_proxy | SILO | equal | 3m | below_fee_floor:251 |
| repo_breakout_4h | market_proxy | SILO | equal | 6m | below_fee_floor:450 |
| repo_breakout_4h | sentiment_blind | SILO | atr_scaled | 1m | below_fee_floor:83 |
| repo_breakout_4h | sentiment_blind | SILO | atr_scaled | 3m | below_fee_floor:251 |
| repo_breakout_4h | sentiment_blind | SILO | atr_scaled | 6m | below_fee_floor:450 |
| repo_breakout_4h | market_proxy | SILO | atr_scaled | 1m | below_fee_floor:83 |
| repo_breakout_4h | market_proxy | SILO | atr_scaled | 3m | below_fee_floor:251 |
| repo_breakout_4h | market_proxy | SILO | atr_scaled | 6m | below_fee_floor:450 |
| intraday_research | sentiment_blind | POOL | equal | 1m | below_fee_floor:800 outside_session:26 ideas_per_day:22 macro_blackout:4 flat_before_utc_midnight:4 |
| intraday_research | sentiment_blind | POOL | equal | 3m | below_fee_floor:2189 outside_session:47 ideas_per_day:38 macro_blackout:8 flat_before_utc_midnight:4 |
| intraday_research | sentiment_blind | POOL | equal | 6m | below_fee_floor:3572 ideas_per_day:96 outside_session:71 macro_blackout:12 flat_before_utc_midnight:4 |
| intraday_research | market_proxy | POOL | equal | 1m | sentiment:25310 below_fee_floor:665 outside_session:18 ideas_per_day:7 macro_blackout:2 |
| intraday_research | market_proxy | POOL | equal | 3m | sentiment:68699 below_fee_floor:1716 outside_session:32 ideas_per_day:7 macro_blackout:6 |
| intraday_research | market_proxy | POOL | equal | 6m | sentiment:150892 below_fee_floor:2760 outside_session:43 ideas_per_day:18 macro_blackout:7 |
| intraday_research | sentiment_blind | POOL | atr_scaled | 1m | below_fee_floor:800 outside_session:26 ideas_per_day:22 macro_blackout:4 flat_before_utc_midnight:4 |
| intraday_research | sentiment_blind | POOL | atr_scaled | 3m | below_fee_floor:2189 outside_session:47 ideas_per_day:38 macro_blackout:8 flat_before_utc_midnight:4 |
| intraday_research | sentiment_blind | POOL | atr_scaled | 6m | below_fee_floor:3572 ideas_per_day:96 outside_session:71 macro_blackout:12 flat_before_utc_midnight:4 |
| intraday_research | market_proxy | POOL | atr_scaled | 1m | sentiment:25310 below_fee_floor:665 outside_session:18 ideas_per_day:7 macro_blackout:2 |
| intraday_research | market_proxy | POOL | atr_scaled | 3m | sentiment:68699 below_fee_floor:1716 outside_session:32 ideas_per_day:7 macro_blackout:6 |
| intraday_research | market_proxy | POOL | atr_scaled | 6m | sentiment:150892 below_fee_floor:2760 outside_session:43 ideas_per_day:18 macro_blackout:7 |
| intraday_research | sentiment_blind | SILO | equal | 1m | below_fee_floor:800 outside_session:26 ideas_per_day:22 macro_blackout:4 flat_before_utc_midnight:4 |
| intraday_research | sentiment_blind | SILO | equal | 3m | below_fee_floor:2189 outside_session:47 ideas_per_day:38 macro_blackout:8 flat_before_utc_midnight:4 |
| intraday_research | sentiment_blind | SILO | equal | 6m | below_fee_floor:3572 ideas_per_day:96 outside_session:71 macro_blackout:12 flat_before_utc_midnight:4 |
| intraday_research | market_proxy | SILO | equal | 1m | sentiment:25310 below_fee_floor:665 outside_session:18 ideas_per_day:7 macro_blackout:2 |
| intraday_research | market_proxy | SILO | equal | 3m | sentiment:68699 below_fee_floor:1716 outside_session:32 ideas_per_day:7 macro_blackout:6 |
| intraday_research | market_proxy | SILO | equal | 6m | sentiment:150892 below_fee_floor:2760 outside_session:43 ideas_per_day:18 macro_blackout:7 |
| intraday_research | sentiment_blind | SILO | atr_scaled | 1m | below_fee_floor:800 outside_session:26 ideas_per_day:22 macro_blackout:4 flat_before_utc_midnight:4 |
| intraday_research | sentiment_blind | SILO | atr_scaled | 3m | below_fee_floor:2189 outside_session:47 ideas_per_day:38 macro_blackout:8 flat_before_utc_midnight:4 |
| intraday_research | sentiment_blind | SILO | atr_scaled | 6m | below_fee_floor:3572 ideas_per_day:96 outside_session:71 macro_blackout:12 flat_before_utc_midnight:4 |
| intraday_research | market_proxy | SILO | atr_scaled | 1m | sentiment:25310 below_fee_floor:665 outside_session:18 ideas_per_day:7 macro_blackout:2 |
| intraday_research | market_proxy | SILO | atr_scaled | 3m | sentiment:68699 below_fee_floor:1716 outside_session:32 ideas_per_day:7 macro_blackout:6 |
| intraday_research | market_proxy | SILO | atr_scaled | 6m | sentiment:150892 below_fee_floor:2760 outside_session:43 ideas_per_day:18 macro_blackout:7 |

## Required gate across 1m, 3m, and 6m

No swing or baseline configuration meets the required gate on all three windows.

Target-gate result for those configurations is in the table above. None are listed when the required gate is empty.

## Stop-width distribution (bps)

Swing stops from the 6-month swing_combined, sentiment-blind, POOL equal run. This is max(1h swing-low distance, 2 × 1h ATR14), recorded before the fee floor, and it is not retuned.

| pair | n | min | p25 | p50 | p75 | max | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| ARB-USD | 19 | 166.4 | 262.8 | 323.1 | 443.5 | 749.7 | 388.2 |
| AVAX-USD | 35 | 126.2 | 153.5 | 242.4 | 263.0 | 442.7 | 231.5 |
| BCH-USD | 11 | 72.5 | 113.1 | 279.9 | 383.3 | 480.5 | 254.9 |
| NEAR-USD | 41 | 143.8 | 264.5 | 401.6 | 568.5 | 1573.4 | 431.3 |
| SUI-USD | 31 | 152.0 | 190.8 | 334.8 | 388.1 | 1131.1 | 358.8 |
| UNI-USD | 32 | 165.3 | 235.6 | 293.4 | 402.5 | 1116.4 | 358.7 |
| VVV-USD | 51 | 223.8 | 413.1 | 469.2 | 560.5 | 1470.4 | 535.4 |
| ZEC-USD | 29 | 216.9 | 327.6 | 407.1 | 539.0 | 829.9 | 449.5 |

Baseline repo_breakout_4h live stop (tighter of the repo book stop and 3 × 4h ATR), 6-month POOL equal, sentiment-blind. Every one of these signals is below_fee_floor because the strategy has no resting maker target.

| pair | n | min | p25 | p50 | p75 | max | mean |
|---|---:|---:|---:|---:|---:|---:|---:|
| ARB-USD | 51 | 390.0 | 390.0 | 390.0 | 390.0 | 390.0 | 390.0 |
| AVAX-USD | 51 | 227.0 | 227.0 | 227.0 | 227.0 | 227.0 | 227.0 |
| BCH-USD | 41 | 242.0 | 242.0 | 242.0 | 242.0 | 242.0 | 242.0 |
| NEAR-USD | 74 | 331.0 | 331.0 | 331.0 | 331.0 | 331.0 | 331.0 |
| SUI-USD | 53 | 219.0 | 219.0 | 219.0 | 219.0 | 219.0 | 219.0 |
| UNI-USD | 63 | 295.0 | 295.0 | 295.0 | 295.0 | 295.0 | 295.0 |
| VVV-USD | 60 | 312.0 | 312.0 | 312.0 | 312.0 | 312.0 | 312.0 |
| ZEC-USD | 57 | 273.0 | 273.0 | 273.0 | 273.0 | 273.0 | 273.0 |

## Notes

Parameters, the pair list, and the fee floor were frozen before this run. Nothing was changed after seeing the results.
The repo 4h breakout exits on a 3×ATR trail or a 14-day market flat. Both are taker. There is no T in (T − 100), so those signals are rejected as below_fee_floor and are not given an invented target.
Swing replaces the 60-minute time stop and the flat-by-midnight rule with a 48-hour max hold and a $500 overnight loss-to-stop cap. SWING_APPROVED stays false for forward paper.
blocked: AI_GATEWAY_API_KEY not present

<details><summary>Why each configuration missed the required gate</summary>

- swing_A|sentiment_blind|POOL|equal: 1m insufficient sample: 4 closed < 12; net -23.51 <= 0; expectancy criteria not met | 3m insufficient sample: 5 closed < 40; net -77.91 <= 0; expectancy criteria not met | 6m insufficient sample: 7 closed < 100; net -156.97 <= 0; expectancy criteria not met
- swing_A|market_proxy|POOL|equal: 1m insufficient sample: 4 closed < 12; net -23.51 <= 0; expectancy criteria not met | 3m insufficient sample: 4 closed < 40; net -23.51 <= 0; expectancy criteria not met | 6m insufficient sample: 6 closed < 100; net -102.58 <= 0; expectancy criteria not met
- swing_A|sentiment_blind|POOL|atr_scaled: 1m insufficient sample: 4 closed < 12; expectancy criteria not met | 3m insufficient sample: 5 closed < 40; net -114.33 <= 0; expectancy criteria not met | 6m insufficient sample: 7 closed < 100; net -117.93 <= 0; expectancy criteria not met
- swing_A|market_proxy|POOL|atr_scaled: 1m insufficient sample: 4 closed < 12; net -1.07 <= 0; expectancy criteria not met | 3m insufficient sample: 4 closed < 40; expectancy criteria not met | 6m insufficient sample: 6 closed < 100; net -2.71 <= 0; expectancy criteria not met
- swing_A|sentiment_blind|SILO|equal: 1m insufficient sample: 4 closed < 12; net -23.51 <= 0; expectancy criteria not met | 3m insufficient sample: 5 closed < 40; net -77.91 <= 0; expectancy criteria not met | 6m insufficient sample: 7 closed < 100; net -156.97 <= 0; expectancy criteria not met
- swing_A|market_proxy|SILO|equal: 1m insufficient sample: 4 closed < 12; net -23.51 <= 0; expectancy criteria not met | 3m insufficient sample: 4 closed < 40; net -23.51 <= 0; expectancy criteria not met | 6m insufficient sample: 6 closed < 100; net -102.58 <= 0; expectancy criteria not met
- swing_A|sentiment_blind|SILO|atr_scaled: 1m insufficient sample: 4 closed < 12; net -23.51 <= 0; expectancy criteria not met | 3m insufficient sample: 5 closed < 40; net -77.91 <= 0; expectancy criteria not met | 6m insufficient sample: 7 closed < 100; net -156.97 <= 0; expectancy criteria not met
- swing_A|market_proxy|SILO|atr_scaled: 1m insufficient sample: 4 closed < 12; net -23.51 <= 0; expectancy criteria not met | 3m insufficient sample: 4 closed < 40; net -23.51 <= 0; expectancy criteria not met | 6m insufficient sample: 6 closed < 100; net -102.58 <= 0; expectancy criteria not met
- swing_B|sentiment_blind|POOL|equal: 1m insufficient sample: 2 closed < 12; expectancy criteria not met | 3m insufficient sample: 3 closed < 40 | 6m insufficient sample: 8 closed < 100
- swing_B|market_proxy|POOL|equal: 1m insufficient sample: 2 closed < 12; expectancy criteria not met | 3m insufficient sample: 3 closed < 40 | 6m insufficient sample: 8 closed < 100
- swing_B|sentiment_blind|POOL|atr_scaled: 1m insufficient sample: 2 closed < 12; expectancy criteria not met | 3m insufficient sample: 3 closed < 40 | 6m insufficient sample: 8 closed < 100
- swing_B|market_proxy|POOL|atr_scaled: 1m insufficient sample: 2 closed < 12; expectancy criteria not met | 3m insufficient sample: 3 closed < 40 | 6m insufficient sample: 8 closed < 100
- swing_B|sentiment_blind|SILO|equal: 1m insufficient sample: 2 closed < 12; expectancy criteria not met | 3m insufficient sample: 3 closed < 40 | 6m insufficient sample: 8 closed < 100
- swing_B|market_proxy|SILO|equal: 1m insufficient sample: 2 closed < 12; expectancy criteria not met | 3m insufficient sample: 3 closed < 40 | 6m insufficient sample: 8 closed < 100
- swing_B|sentiment_blind|SILO|atr_scaled: 1m insufficient sample: 2 closed < 12; expectancy criteria not met | 3m insufficient sample: 3 closed < 40 | 6m insufficient sample: 8 closed < 100
- swing_B|market_proxy|SILO|atr_scaled: 1m insufficient sample: 2 closed < 12; expectancy criteria not met | 3m insufficient sample: 3 closed < 40 | 6m insufficient sample: 8 closed < 100
- swing_C|sentiment_blind|POOL|equal: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- swing_C|market_proxy|POOL|equal: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- swing_C|sentiment_blind|POOL|atr_scaled: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- swing_C|market_proxy|POOL|atr_scaled: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- swing_C|sentiment_blind|SILO|equal: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- swing_C|market_proxy|SILO|equal: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- swing_C|sentiment_blind|SILO|atr_scaled: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- swing_C|market_proxy|SILO|atr_scaled: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- swing_combined|sentiment_blind|POOL|equal: 1m insufficient sample: 5 closed < 12; expectancy criteria not met | 3m insufficient sample: 7 closed < 40 | 6m insufficient sample: 12 closed < 100
- swing_combined|market_proxy|POOL|equal: 1m insufficient sample: 5 closed < 12; expectancy criteria not met | 3m insufficient sample: 6 closed < 40 | 6m insufficient sample: 11 closed < 100
- swing_combined|sentiment_blind|POOL|atr_scaled: 1m insufficient sample: 5 closed < 12; expectancy criteria not met | 3m insufficient sample: 7 closed < 40; net -4.88 <= 0 | 6m insufficient sample: 12 closed < 100; net -3.01 <= 0
- swing_combined|market_proxy|POOL|atr_scaled: 1m insufficient sample: 5 closed < 12; expectancy criteria not met | 3m insufficient sample: 6 closed < 40 | 6m insufficient sample: 11 closed < 100
- swing_combined|sentiment_blind|SILO|equal: 1m insufficient sample: 5 closed < 12; expectancy criteria not met | 3m insufficient sample: 7 closed < 40 | 6m insufficient sample: 12 closed < 100
- swing_combined|market_proxy|SILO|equal: 1m insufficient sample: 5 closed < 12; expectancy criteria not met | 3m insufficient sample: 6 closed < 40 | 6m insufficient sample: 11 closed < 100
- swing_combined|sentiment_blind|SILO|atr_scaled: 1m insufficient sample: 5 closed < 12; expectancy criteria not met | 3m insufficient sample: 7 closed < 40 | 6m insufficient sample: 12 closed < 100
- swing_combined|market_proxy|SILO|atr_scaled: 1m insufficient sample: 5 closed < 12; expectancy criteria not met | 3m insufficient sample: 6 closed < 40 | 6m insufficient sample: 11 closed < 100
- repo_breakout_4h|sentiment_blind|POOL|equal: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- repo_breakout_4h|market_proxy|POOL|equal: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- repo_breakout_4h|sentiment_blind|POOL|atr_scaled: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- repo_breakout_4h|market_proxy|POOL|atr_scaled: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- repo_breakout_4h|sentiment_blind|SILO|equal: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- repo_breakout_4h|market_proxy|SILO|equal: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- repo_breakout_4h|sentiment_blind|SILO|atr_scaled: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met
- repo_breakout_4h|market_proxy|SILO|atr_scaled: 1m insufficient sample: 0 closed < 12; net 0.00 <= 0; expectancy criteria not met | 3m insufficient sample: 0 closed < 40; net 0.00 <= 0; expectancy criteria not met | 6m insufficient sample: 0 closed < 100; net 0.00 <= 0; expectancy criteria not met

</details>
