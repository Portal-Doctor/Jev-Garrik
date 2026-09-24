# P&L Revenue Review, Follow-up: Jev Trading Bot (cb/ paper campaign)

Prepared by: Senior Finance Officer review (agent-assisted)
Date: 2026-09-19 (evening)
Scope: The fresh paper campaign started 17:22 UTC today, the code changes shipped since the
morning review (`PL-REVENUE-REVIEW.md`), and remaining code changes recommended to the senior dev.

---

## 1. Executive summary

**Revenue booked to date: still $0**, and by design: this remains a paper-trading measurement
harness. The database was reset this morning, so the campaign is young (~4 hours at review time)
and every number below carries a small-sample caveat.

**Headline paper numbers (live Postgres, campaign since 17:22 UTC):**

| Metric | Value |
|---|---|
| Paper bankroll | $10,000 |
| Mark-to-market equity (21:04 UTC snapshot) | $9,866.51 (-1.3%) |
| Realized P&L | -$133.48 |
| Simulated fees paid | $111.02 |
| Inference cost | ~$0.01 |
| Model | `typesafe-ai/jev` (real model, both runs today) |
| Promotion gate | 0 of 4 pairs (see section 3: one criterion is currently unpassable) |

**The loss is still a fee story.** Fees ($111) account for 83% of the realized loss; the pure
price P&L across the fills ledger is roughly -$19. The morning review's diagnosis stands: the
model has signal on some pairs, and the cost structure destroys it.

**Signal check at the only resolved horizon so far (1h, n = 26-29 per pair):**

| Pair | 1h accuracy | Wilson 95% lower | Read |
|---|---|---|---|
| DOGE-USD | 72.4% | 54.3% | Genuine signal; lower bound clears the 52% gate bar |
| SUI-USD | 46.4% | 29.5% | No demonstrated edge; also the biggest fee burner ($61 of $111) |
| SOL-USD | 42.3% | 25.5% | No edge, but hysteresis kept it from trading at all ($0 fees) |
| XRP-USD | 23.1% | 11.0% | Consistently inverted, as in the prior campaign; pure fee drag |

The traded horizon is 4h; its first outcomes resolve from ~21:23 UTC and the n >= 200 gate sample
needs roughly a day of continuous uptime. No promotion judgment should be made before then.

## 2. Status of the morning review's recommendations

| Rec | Status | Evidence |
|---|---|---|
| 3.1 Realistic fee tier | **Not done.** Still 50/90 bps in `.env` | Sensitivity grid shows every pair still negative even at 0 bps maker on today's sample, but the sample is 4 hours |
| 3.2 Confidence-band hysteresis | **Shipped** (`cb/engine.ts targetFor`, thresholds 0.60/0.40) | Working as intended: SOL traded 0 of 42 decisions, DOGE 2 of 45. SUI still churns (10 of 44) because its p(buy) oscillates across the band |
| 3.3 Cut losers / add candidates | **Partially done today.** AVAX-USD and TAO-USD added (see section 4). XRP still running | Keep XRP through the 4h measurement; bench it if the inversion holds |
| 3.4 Reduce taker fallback | **Instrumented, not enforced.** `neverCrossEntry` exists but is off | 8 of 18 orders (44%) taker-converted; taker fills are 43% of all fees ($47.56) despite being ~5% of fill count |
| 3.5 Fix `pnlFromFills` MTM + per-run gate | **Shipped** | Open inventory now marked at last mid; gate scoped to the current run |

## 3. New finding: the incidents gate criterion is unpassable (code change needed)

The gate requires "feed incidents < 1/day". The only thing that increments `Feed.incidents`
(`cb/feed.ts`) is the once-a-minute REST cross-check flagging local-book-vs-REST divergence
over a fixed 5 bps. On volatile, wide-spread pairs (SUI especially) ordinary timing skew between
the WS book and the REST snapshot exceeds 5 bps constantly. Measured rate today: **~528
incidents/day**, i.e. every pair fails the gate regardless of trading performance, forever.

The spec (section 4) intended this check as a "feed bug detector"; what it currently detects is
volatility. Recommended change for the senior dev, in priority order:

1. Count as incidents only events that indicate feed defects: WS reconnects, heartbeat gaps,
   book resyncs, and divergence that **persists across two consecutive checks** of the same pair
   (a real stale book stays diverged; timing skew does not).
2. Scale the divergence threshold to the pair's current spread (e.g. `max(5 bps, 2 x spread)`)
   instead of a fixed 5 bps.
3. Keep logging one-off divergences for diagnostics, but do not feed them into the gate.

Until this ships, the gate's `incidentsUnder1PerDay` boolean should be disregarded when reading
the report, and must not be cited as "the strategy failed the gate".

## 4. Changes shipped this session

- **Next-read countdown on the P&L report** (requested by finance): `/report` now returns
  `nextReads` (when the next 1h/4h/24h outcome becomes resolvable, from the oldest unresolved
  decision), the dashboard summary strip shows "Next 4h read in Xm" and "Next 24h read in Xh Ym",
  and the CLI report prints the same line. This removes the ambiguity that prompted today's
  "are Accuracy/Wilson/Brier/Edge even calculated?" question - empty horizons were rendering
  as zeros with no indication that data was simply pending.
- **Two pairs added for volatility and sector diversity** (config in `.env`, mirrored in
  `.env.example`, `cb/config.ts`, README): **AVAX-USD** (+17.9% on the day at selection time,
  ~$27M daily volume, high-beta L1 with a deep book) and **TAO-USD** (~$20M daily volume,
  structurally among the most volatile large caps, adds an AI-sector leg no current pair covers).
  Selection was made from the live Coinbase products feed ranked by 24h move with a $5M minimum
  daily volume; ENA/INJ moved more but have thinner books and overlap DeFi, PEPE overlaps DOGE's
  meme exposure. Note the per-pair bankroll slice is now $1,666.67 (was $2,500); with $1,000
  notional per clip each pair still supports exactly one open position, so behavior is unchanged.
- All 38 tests pass; the container was rebuilt and the new run (`0cf18b21`) is live on all six
  pairs with the real Jev model.

## 5. Remaining recommendations to drive revenue (for the senior dev, in order)

1. **Fix the incidents metric (section 3).** It is the only gate criterion that no amount of
   trading skill can satisfy. Nothing else matters until the gate is winnable.
2. **Set fees to the real Coinbase tier** (`CB_MAKER_FEE_BPS` / `CB_TAKER_FEE_BPS` in `.env`).
   A one-line config change; every P&L number in the harness is currently computed against a
   worst-case 140 bps round trip that we would not actually pay.
3. **Act on the taker-fallback data.** The instrumentation now shows 44% of orders convert to
   taker and carry 43% of all fees. Flip `CB_NEVER_CROSS_ENTRY=true` for entries (a missed entry
   is free; a taker entry costs ~the whole per-trade edge) and re-measure for a week.
4. **Bench XRP if the 4h horizon confirms the 1h inversion** (two campaigns running at 23-35%
   accuracy is a strong prior). Its bankroll slice goes to the best Wilson-lower-bound pair.
5. **Longer horizon, unchanged from the morning review:** dynamic per-pair sizing by trailing
   Wilson lower bound minus the fee hurdle; the gated live path (M5) with kill switch and daily
   loss limit; and the signal-feed monetization route (the outcomes table is an auditable
   track record of Jev's calls - a paid prediction endpoint monetizes accuracy without carrying
   fee drag or inventory risk).

## 6. Reporting discipline (restated)

1. Report MTM equity per run; never the raw fills-ledger sum.
2. Primary KPI until further notice: fees as a percent of gross edge (today: >100%).
3. No live capital until the gate passes on corrected fee assumptions, with the incidents metric
   fixed, and kill switch plus daily loss limit implemented.
4. Judge the new pairs (AVAX, TAO) and any XRP bench decision only on resolved 4h data with
   n >= 200, not on day-one P&L.
