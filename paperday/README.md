# Paper day

Standalone paper book. It does not import the live `cb` trading loop and it does not place orders.

```bash
bun test paperday
```

`bun run paperday/src/backtest-cli.ts` replays the `jev_off` variant on the Coinbase public candle cache. `jev_veto` and `jev_select` are wired and unit-tested with a mock transport. The backtest does not call them.

`bun run paperday/src/search-cli.ts` runs the pre-registered walk-forward search in `paperday/search/grid-v1.json`. The grid hash is locked before the run. The last month is a holdout and is opened once.

Home PC stack: `docker compose -f paperday/compose.yml up -d`. Postgres and the report bind to `127.0.0.1`. Startup throws if `COINBASE_API_*` or another order-capable credential is set.

## Assumptions

- Setups A/B/C were not numerically specified. A is a 5-minute EMA20 pullback above session VWAP. B is a VWAP reclaim. C is a 5-minute Donchian break while the completed 4-hour close is through its prior 20-bar high. All three require the `cb/trend.ts` bias gate (first-value EMA, not the TradingView SMA seed).
- Fees stay 50/90. A resting target is maker, so the winner's round trip is 100 bps. Stop, time, invalidation, rollover, data-gap, and an unfilled target sold at market are taker, so the loser's round trip is 140 bps. The per-trade floor is (T − 100) ≥ 1.5 × (S + 140). Class acceptance is walk-forward: p* = (S + 140) / (T + S − 40) ≤ 45%, and out-of-sample expectancy ≥ +0.15R or ≥ +25 bps in at least two of three time splits. Stops and targets are not widened to pass.
- Session VWAP (hlc3) resets at 00:00 America/Chicago. The entry window is 08:00–15:00 CT. The weekend idea cap uses the Chicago calendar day. The daily loss stop and the flat-before-midnight rule use UTC.
- Missing macro calendar blocks 07:15–08:00, 08:45–09:15, and 12:45–13:30 CT.
- Forward paper still reads X as a veto only. Backtests label two modes: sentiment-blind (filter neutral, an upper bound) and market-proxy (return z-score, shock candle, BTC 4h trend). Swing entries are behind SWING_APPROVED, which defaults to false.
- Per-pair $500 gate accumulates losing closes. Later winners do not reopen the pair.
- POOL equal share and each SILO bucket are deployable / enabled pairs ($8,000 / 8). POOL ATR-scaled weights are inverse ATR. An idea that does not fit is refused whole.
- Same-bar stop and target: the stop fills. Candle fills use 0.5 × bar volume when the bar trades through the limit. A limit that would cross is canceled.
- Jev's $100 budget is a UTC calendar month. Spend is token count × `jevUsdPerMTok` ($0.042, same value as `cb/config.ts`). A failure falls back to the rules. It does not create a trade the rules rejected.
- The 6-month revenue gate counts every calendar quarter that has a result, including partial quarters.
- TradingView parity is the published default formula (SMA-seeded EMA, Wilder RSI and ATR) checked against an independent batch implementation on 2 pairs × 4 timeframes. There is no live TradingView connection.
- Unit tests and the cloud backtest use the in-memory store. `schema.sql` and compose are the home-PC Postgres database.
