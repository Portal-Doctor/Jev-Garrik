# Paper day

Standalone paper book. It does not import the live `cb` trading loop and it does not place orders.

```bash
bun test paperday
```

`bun run paperday/src/backtest-cli.ts` replays the `jev_off` variant on the Coinbase public candle cache. `jev_veto` and `jev_select` are wired and unit-tested with a mock transport. The backtest does not call them.

Home PC stack: `docker compose -f paperday/compose.yml up -d`. Postgres and the report bind to `127.0.0.1`. Startup throws if `COINBASE_API_*` or another order-capable credential is set.

## Assumptions

- Setups A/B/C were not numerically specified. A is a 5-minute EMA20 pullback above session VWAP. B is a VWAP reclaim. C is a 5-minute Donchian break while the completed 4-hour close is through its prior 20-bar high. All three require the `cb/trend.ts` bias gate (first-value EMA, not the TradingView SMA seed).
- The 50/90 fee gate uses a 3R target and a 1R stop: winner = 3R − 140 bps, loser = 1R + 140 bps, and the winner must be at least twice the loser. A structural stop inside 420 bps is rejected. The stop is not widened to pass the gate.
- Session VWAP (hlc3) resets at 00:00 America/Chicago. The entry window is 08:00–15:00 CT. The weekend idea cap uses the Chicago calendar day. The daily loss stop and the flat-before-midnight rule use UTC.
- Missing macro calendar blocks 07:15–08:00, 08:45–09:15, and 12:45–13:30 CT.
- Sentiment unknown (no X read, including historical backtests) allows only setup A and one open idea.
- Per-pair $500 gate accumulates losing closes. Later winners do not reopen the pair.
- POOL equal share and each SILO bucket are deployable / enabled pairs ($8,000 / 8). POOL ATR-scaled weights are inverse ATR. An idea that does not fit is refused whole.
- Same-bar stop and target: the stop fills. Candle fills use 0.5 × bar volume when the bar trades through the limit. A limit that would cross is canceled.
- Jev's $100 budget is a UTC calendar month. Spend is token count × `jevUsdPerMTok` ($0.042, same value as `cb/config.ts`). A failure falls back to the rules. It does not create a trade the rules rejected.
- The 6-month revenue gate counts every calendar quarter that has a result, including partial quarters.
- TradingView parity is the published default formula (SMA-seeded EMA, Wilder RSI and ATR) checked against an independent batch implementation on 2 pairs × 4 timeframes. There is no live TradingView connection.
- Unit tests and the cloud backtest use the in-memory store. `schema.sql` and compose are the home-PC Postgres database.
