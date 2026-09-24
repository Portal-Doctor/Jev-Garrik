# P&L Revenue Review: Jev Trading Bot (Jev-Garrik)

Prepared by: Senior Finance Officer review (agent-assisted)
Date: 2026-09-19
Scope: All trading activity and revenue-relevant code in this repository, plus live Postgres data from the running Coinbase paper stack.

---

## 1. Executive summary (the honest part)

**Real revenue booked to date: $0.** There is no revenue line in this project today, and under current configuration there cannot be one:

- The active system (`cb/`) is a **paper-trading measurement harness** against Coinbase market data. No live order placement is implemented (live auth is an M5 scaffold in `cb/auth.ts`).
- The Monad/Kuru trader (`src/`) can place real on-chain orders but is documented as legacy and typically runs dry-run. Its economic purpose is the demo, not P&L.
- Even the simulated book is **losing money**. This is not a profitable strategy being held back by paper mode; it is an unprofitable strategy correctly being kept in paper mode.

**Headline paper numbers (live Postgres, current run):**

| Metric | Value |
|---|---|
| Paper bankroll | $10,000 |
| Mark-to-market equity | ~$9,761 (about -2.4%) |
| Realized P&L (current run) | ~-$224 |
| Simulated fees paid (current run) | ~$212 |
| Inference cost to date | ~$0.03 |
| Promotion gate (prerequisite for live) | **FAIL, 0 of 4 pairs** |

**Cumulative fills-ledger report (all runs, `GET /report`):** roughly -$9,500 "net". This number should not be presented to anyone as a loss figure without a caveat: `pnlFromFills` in `cb/report.ts` treats the cost basis of open positions and abandoned-run inventory as pure cash outflow, so it overstates losses badly. Use the mark-to-market equity above for any honest statement of position. Even so, closed round-trips are net negative.

**Where the money goes:** fees. Round-trip simulated fees are ~140 bps on a $1,000 clip (~$14 per round trip at 50 bps maker / 90 bps taker). Directional accuracy at the traded 4h horizon is genuinely interesting on some pairs (DOGE 72%, SUI 62% on n of ~68), but the edge after the fee hurdle is negative (roughly -105 to -158 bps per trade). The model may have signal; the execution and cost structure destroy it.

**Verdict:** This is an R&D cost center, and appropriately so. Costs are near zero (inference is pennies, hosting is local Docker plus optional free-tier deploys), so the burn is tolerable. But there is no path to revenue without the changes below.

---

## 2. What the books actually show

### 2.1 Accounting quality: good

The core ledger (`cb/accounting.ts`) is sound: fee-inclusive cost basis, fee-net proceeds, single subtraction, weighted-average entry, long/flat invariant enforced. Equity = bankroll + realized + unrealized - inference. I have no concerns about the per-run accounting integrity. Snapshots persist every 60s to Postgres.

### 2.2 Reporting quality: one material defect

`pnlFromFills` (`cb/report.ts`) computes net as sum of (proceeds - cost basis) across all fills in the database. Open longs and inventory stranded by restarted runs are counted as realized losses. The all-runs "-$9,503 net" is therefore not a P&L number; it is a cashflow number with unclosed positions. **Any external reporting must use MTM equity.** This defect also makes the promotion gate's "net > 0" check harsher than intended across runs.

### 2.3 Per-pair picture (current run, $2,500 allocated each)

| Pair | State | Realized | Fees | Equity | 4h accuracy |
|---|---|---|---|---|---|
| SOL-USD | flat | -$45.60 | $41.05 | $2,454 | 53% |
| DOGE-USD | long | -$52.49 | $66.84 | $2,433 | 72% |
| SUI-USD | flat | -$79.06 | $62.10 | $2,421 | 62% |
| XRP-USD | flat | -$47.35 | $42.37 | $2,453 | 35% |

Read: realized losses roughly track fees paid. The strategy is churning its edge away. XRP has no demonstrated signal and is pure fee drag.

### 2.4 Cost side

- **Inference:** ~$0.03 total at $0.042/MTok (`config.jevUsdPerMTok`), ~4 calls per 300s. Negligible.
- **Hosting:** local Docker (Postgres 17 + cb-app). Optional Railway for the Monad demo. Negligible.
- **Gas (Monad, if run live):** ~0.03 MON per block at 300ms cadence is a real cost line - order of hundreds of MON per hour always-on. The demo economics only work as a demo.
- **Market data:** free public Coinbase WS. No API costs.

---

## 3. Revenue enhancement recommendations

Ordered by expected impact per unit of effort. Items 3.1-3.4 attack the single largest P&L destroyer (fees and churn); items 3.5+ are longer-horizon.

### 3.1 Fix the fee assumption to match reality (near term, high impact)

The paper harness charges 50 bps maker / 90 bps taker. Coinbase Advanced Trade fees at even modest 30-day volume tiers are materially lower, and the maker rate falls quickly. The dashboard already includes a maker-fee sensitivity grid (50/25/10/0 bps) - use it. Action: set `CB_MAKER_FEE_BPS` / `CB_TAKER_FEE_BPS` to the actual tier we would trade at, and re-run the gate. If the strategy only works at 10 bps maker, that is a volume-tier business plan question, not a code question, but it should be decided on correct numbers.

### 3.2 Raise the decision bar so fewer trades are taken (near term, high impact)

The engine trades whenever the model's target flips. With ~140 bps round-trip cost, a flip should only be actioned when expected move exceeds the hurdle. Concretely: have `cb/engine.ts` require the model's p(up) to clear a configurable confidence band (e.g. only enter above 0.60, only exit below 0.40, hold in between). This directly converts the demonstrated 62-72% directional accuracy on DOGE/SUI into fewer, higher-conviction round trips. This is the cheapest expected-value improvement in the codebase.

### 3.3 Cut the losing pairs, size up the winners (near term)

Pairs are config, not code (`CB_PAIRS`). XRP at 35% accuracy is worse than a coin flip and pays fees for the privilege. Reallocate its $2,500 to DOGE/SUI, or use it to test new candidates. Longer term: make allocation dynamic - size notional per pair proportional to trailing Wilson-lower-bound accuracy minus the fee hurdle, floored at zero (which automatically benches pairs like XRP).

### 3.4 Reduce taker fallback usage (near term)

Entries post at the touch and fall back to taker (90 bps plus book walk) after 120s (`CB_ENTRY_TIMEOUT_SEC`). Every taker fallback is roughly the whole per-trade edge. Instrument what fraction of fills are taker; if material, prefer widening `repriceTicks` behavior or simply cancelling missed entries (a missed entry costs nothing; a taker entry costs 90 bps). A "never cross on entry" mode is a one-line policy with measurable P&L effect.

### 3.5 Fix the fills report before it drives decisions (near term, hygiene)

Change `pnlFromFills` to mark open inventory at last mid rather than expensing it, and to scope the promotion gate per run. Otherwise the gate can never pass across restarts, and we will either mis-report losses or start ignoring our own gate - both bad outcomes for a finance function.

### 3.6 Longer horizon: get to live, small, and gated (3-6 months)

Revenue only exists once real orders are placed. The path already sketched in `docs/SPEC-COINBASE.md` (M5, `cb/auth.ts`) is right:

1. Pass the promotion gate honestly (n >= 200 at 4h, Wilson > 52%, net > 0 after realistic fees, drawdown < 15%) on at least one pair.
2. Go live with a small dedicated bankroll ($1-2k), one pair, maker-only entries, with a kill switch and daily loss limit - neither currently exists in `cb/` and both are prerequisites for putting real capital at risk.
3. Scale notional only as live results confirm paper results.

Realistic expectation to state upfront: even a genuinely working version of this strategy on a $10k book is a hundreds-of-dollars-per-month revenue line, not a business. Its value is as a proven engine.

### 3.7 Longer horizon: alternative revenue models for the same asset (6-12 months)

The strategy P&L may never be large, but the project has two other monetizable assets:

- **The signal, not the trades.** The Postgres `outcomes` table is quietly building a scored track record of Jev's directional calls at 1h/4h/24h horizons. A published, auditable signal feed (paid API or subscription) monetizes accuracy without carrying fee drag, inventory risk, or execution risk. The AgentCash/x402 tooling already available in this environment is a natural distribution channel for a paid per-call prediction endpoint.
- **The demo as marketing.** The Monad/Kuru demo's four tweet claims (Jev decides, real trades, every 300ms block, live dashboard) are a credibility asset. Keep it dry-run-by-default and treat any live demo window as a bounded marketing spend (gas budget capped per session), not as a trading book.

### 3.8 Longer horizon: maker rebate / market-making pivot (exploratory)

The Monad codebase already quotes post-only inside the spread every block. On venues with maker rebates or incentive programs (several on-chain order books run them), the same code is a spread-capture business where high churn is the revenue model instead of the cost model. Worth a scoped investigation before more effort goes into directional trading, since it inverts the fee problem that currently kills the P&L.

---

## 4. Recommended reporting discipline going forward

1. Report **MTM equity per run** as the P&L number; never the raw fills-ledger sum.
2. Track **fees as a percent of gross edge** as the primary KPI until it is under 50%; today it exceeds 100%.
3. Keep inference and hosting on the cost report even while negligible, so the unit economics are ready when live trading starts.
4. No live capital until the promotion gate passes on corrected fee assumptions and the kill switch / daily loss limit exist.

---

## Appendix: key sources in the repo

- Ledger: `cb/accounting.ts` (fee-inclusive basis, equity formula)
- Strategy config: `cb/config.ts` (pairs, $1,000 notional, 300s cadence, 4h horizon, 50/90 bps fees)
- Execution: `cb/paper.ts` (post-only at touch, 120s taker fallback, 0.5 fill haircut)
- Reporting and gate: `cb/report.ts` (`pnlFromFills` caveat in section 2.2)
- Live-trading scaffold: `cb/auth.ts` (M5, not implemented)
- Monad legacy trader: `src/trader.ts`, `src/config.ts` (200 MON clips, gas accounting)
- Dashboards: `web/src/app/paper/page.tsx`, `web/src/app/paper/report/`, `web/src/app/page.tsx`
