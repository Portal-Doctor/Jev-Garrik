# Paper-day backtest summary

Data: Coinbase public 1-minute candles. Hash `279c8ef19c9bb39929c38dd3acd2d38bdcd777897038fb722144f4a9765359b8`.
Fee tier 50/90, haircut 0.5. Sentiment unknown, so the rule engine keeps setup A only.
jev_veto and jev_select: not run: needs paid Jev reviews.

| strategy | variant | mode | formula | window | net USD | max drawdown USD | gate |
|---|---|---|---|---|---:|---:|---|
| combined | jev_off | POOL | equal | 1m | 0.00 | 0.00 | fail |
| combined | jev_veto | POOL | equal | 1m |  |  | not run |
| combined | jev_select | POOL | equal | 1m |  |  | not run |
| combined | jev_off | POOL | equal | 3m | 0.00 | 0.00 | fail |
| combined | jev_veto | POOL | equal | 3m |  |  | not run |
| combined | jev_select | POOL | equal | 3m |  |  | not run |
| combined | jev_off | POOL | equal | 6m | 0.00 | 0.00 | fail |
| combined | jev_veto | POOL | equal | 6m |  |  | not run |
| combined | jev_select | POOL | equal | 6m |  |  | not run |
| combined | jev_off | POOL | atr_scaled | 1m | 0.00 | 0.00 | fail |
| combined | jev_veto | POOL | atr_scaled | 1m |  |  | not run |
| combined | jev_select | POOL | atr_scaled | 1m |  |  | not run |
| combined | jev_off | POOL | atr_scaled | 3m | 0.00 | 0.00 | fail |
| combined | jev_veto | POOL | atr_scaled | 3m |  |  | not run |
| combined | jev_select | POOL | atr_scaled | 3m |  |  | not run |
| combined | jev_off | POOL | atr_scaled | 6m | 0.00 | 0.00 | fail |
| combined | jev_veto | POOL | atr_scaled | 6m |  |  | not run |
| combined | jev_select | POOL | atr_scaled | 6m |  |  | not run |
| combined | jev_off | SILO | equal | 1m | 0.00 | 0.00 | fail |
| combined | jev_veto | SILO | equal | 1m |  |  | not run |
| combined | jev_select | SILO | equal | 1m |  |  | not run |
| combined | jev_off | SILO | equal | 3m | 0.00 | 0.00 | fail |
| combined | jev_veto | SILO | equal | 3m |  |  | not run |
| combined | jev_select | SILO | equal | 3m |  |  | not run |
| combined | jev_off | SILO | equal | 6m | 0.00 | 0.00 | fail |
| combined | jev_veto | SILO | equal | 6m |  |  | not run |
| combined | jev_select | SILO | equal | 6m |  |  | not run |
| A | jev_off | POOL | equal | 1m | 0.00 | 0.00 | fail |
| A | jev_veto | POOL | equal | 1m |  |  | not run |
| A | jev_select | POOL | equal | 1m |  |  | not run |
| A | jev_off | POOL | equal | 3m | 0.00 | 0.00 | fail |
| A | jev_veto | POOL | equal | 3m |  |  | not run |
| A | jev_select | POOL | equal | 3m |  |  | not run |
| A | jev_off | POOL | equal | 6m | 0.00 | 0.00 | fail |
| A | jev_veto | POOL | equal | 6m |  |  | not run |
| A | jev_select | POOL | equal | 6m |  |  | not run |
| A | jev_off | POOL | atr_scaled | 1m | 0.00 | 0.00 | fail |
| A | jev_veto | POOL | atr_scaled | 1m |  |  | not run |
| A | jev_select | POOL | atr_scaled | 1m |  |  | not run |
| A | jev_off | POOL | atr_scaled | 3m | 0.00 | 0.00 | fail |
| A | jev_veto | POOL | atr_scaled | 3m |  |  | not run |
| A | jev_select | POOL | atr_scaled | 3m |  |  | not run |
| A | jev_off | POOL | atr_scaled | 6m | 0.00 | 0.00 | fail |
| A | jev_veto | POOL | atr_scaled | 6m |  |  | not run |
| A | jev_select | POOL | atr_scaled | 6m |  |  | not run |
| A | jev_off | SILO | equal | 1m | 0.00 | 0.00 | fail |
| A | jev_veto | SILO | equal | 1m |  |  | not run |
| A | jev_select | SILO | equal | 1m |  |  | not run |
| A | jev_off | SILO | equal | 3m | 0.00 | 0.00 | fail |
| A | jev_veto | SILO | equal | 3m |  |  | not run |
| A | jev_select | SILO | equal | 3m |  |  | not run |
| A | jev_off | SILO | equal | 6m | 0.00 | 0.00 | fail |
| A | jev_veto | SILO | equal | 6m |  |  | not run |
| A | jev_select | SILO | equal | 6m |  |  | not run |
| B | jev_off | POOL | equal | 1m | 0.00 | 0.00 | fail |
| B | jev_veto | POOL | equal | 1m |  |  | not run |
| B | jev_select | POOL | equal | 1m |  |  | not run |
| B | jev_off | POOL | equal | 3m | 0.00 | 0.00 | fail |
| B | jev_veto | POOL | equal | 3m |  |  | not run |
| B | jev_select | POOL | equal | 3m |  |  | not run |
| B | jev_off | POOL | equal | 6m | 0.00 | 0.00 | fail |
| B | jev_veto | POOL | equal | 6m |  |  | not run |
| B | jev_select | POOL | equal | 6m |  |  | not run |
| B | jev_off | POOL | atr_scaled | 1m | 0.00 | 0.00 | fail |
| B | jev_veto | POOL | atr_scaled | 1m |  |  | not run |
| B | jev_select | POOL | atr_scaled | 1m |  |  | not run |
| B | jev_off | POOL | atr_scaled | 3m | 0.00 | 0.00 | fail |
| B | jev_veto | POOL | atr_scaled | 3m |  |  | not run |
| B | jev_select | POOL | atr_scaled | 3m |  |  | not run |
| B | jev_off | POOL | atr_scaled | 6m | 0.00 | 0.00 | fail |
| B | jev_veto | POOL | atr_scaled | 6m |  |  | not run |
| B | jev_select | POOL | atr_scaled | 6m |  |  | not run |
| B | jev_off | SILO | equal | 1m | 0.00 | 0.00 | fail |
| B | jev_veto | SILO | equal | 1m |  |  | not run |
| B | jev_select | SILO | equal | 1m |  |  | not run |
| B | jev_off | SILO | equal | 3m | 0.00 | 0.00 | fail |
| B | jev_veto | SILO | equal | 3m |  |  | not run |
| B | jev_select | SILO | equal | 3m |  |  | not run |
| B | jev_off | SILO | equal | 6m | 0.00 | 0.00 | fail |
| B | jev_veto | SILO | equal | 6m |  |  | not run |
| B | jev_select | SILO | equal | 6m |  |  | not run |
| C | jev_off | POOL | equal | 1m | 0.00 | 0.00 | fail |
| C | jev_veto | POOL | equal | 1m |  |  | not run |
| C | jev_select | POOL | equal | 1m |  |  | not run |
| C | jev_off | POOL | equal | 3m | 0.00 | 0.00 | fail |
| C | jev_veto | POOL | equal | 3m |  |  | not run |
| C | jev_select | POOL | equal | 3m |  |  | not run |
| C | jev_off | POOL | equal | 6m | 0.00 | 0.00 | fail |
| C | jev_veto | POOL | equal | 6m |  |  | not run |
| C | jev_select | POOL | equal | 6m |  |  | not run |
| C | jev_off | POOL | atr_scaled | 1m | 0.00 | 0.00 | fail |
| C | jev_veto | POOL | atr_scaled | 1m |  |  | not run |
| C | jev_select | POOL | atr_scaled | 1m |  |  | not run |
| C | jev_off | POOL | atr_scaled | 3m | 0.00 | 0.00 | fail |
| C | jev_veto | POOL | atr_scaled | 3m |  |  | not run |
| C | jev_select | POOL | atr_scaled | 3m |  |  | not run |
| C | jev_off | POOL | atr_scaled | 6m | 0.00 | 0.00 | fail |
| C | jev_veto | POOL | atr_scaled | 6m |  |  | not run |
| C | jev_select | POOL | atr_scaled | 6m |  |  | not run |
| C | jev_off | SILO | equal | 1m | 0.00 | 0.00 | fail |
| C | jev_veto | SILO | equal | 1m |  |  | not run |
| C | jev_select | SILO | equal | 1m |  |  | not run |
| C | jev_off | SILO | equal | 3m | 0.00 | 0.00 | fail |
| C | jev_veto | SILO | equal | 3m |  |  | not run |
| C | jev_select | SILO | equal | 3m |  |  | not run |
| C | jev_off | SILO | equal | 6m | 0.00 | 0.00 | fail |
| C | jev_veto | SILO | equal | 6m |  |  | not run |
| C | jev_select | SILO | equal | 6m |  |  | not run |

## Reading the jev_off cells

Sentiment is unknown: there is no point-in-time X history, so the rule engine keeps setup A and a one-idea caution cap. Setups B and C therefore qualify nothing in this matrix.
Setup A did qualify. The hard 50/90 fee gate rejected those candidates. A 3R target is at least twice a 1R loser after 140 bps only when the stop is at least 420 bps, and the 5-minute structural stops were tighter. Stops were not widened to force a pass.
The 6-month gate also requires every calendar quarter the window touches, including partial quarters and quarters with no closes, to net at least $1,200.
jev_veto and jev_select were not run: needs paid Jev reviews.
