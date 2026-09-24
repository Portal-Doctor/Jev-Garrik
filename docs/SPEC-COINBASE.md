# SPEC: Coinbase paper trading port ("cb")

A longer-horizon directional strategy on Coinbase Advanced Trade, with paper trading, a measurement
harness, a trade-tracking database (SQLite or PostgreSQL), and a dashboard that shows exactly what
is going on.

Status: design, ready to build. Audience: a senior developer. Estimated effort: 7 to 10 dev days
to the end of M4 (paper trading with full UI), live trading explicitly out of scope until the
promotion gate passes.

---

## 1. Why this exists and what it must prove

On Coinbase there is no gas, but US entry-tier fees are
0.50% maker / 0.90% taker (schedule of Sept 16, 2026). A round trip as maker costs ~100 bps.

Volatility scales with sqrt(time). At an 8% daily-volatility pair, the expected 30 second move is
~15 bps, so no sub-minute strategy survives 100 bps of fees. The strategy must hold for hours.
Whether the model has enough edge at multi-hour horizons is an empirical question. This project
exists to answer it with data before any capital is at risk:

> Over N resolved decisions per pair, does (directional accuracy x average favorable move) exceed
> round-trip costs with statistical confidence?

Everything below (paper broker, decision resolver, calibration UI, promotion gate) serves that
question.

### Non-goals and constraints

- Backend code lives in `cb/`. The dashboard lives in `web/`. There is no second venue.
- Spot only, long/flat. US Coinbase spot cannot short. A `buy` decision targets a long position,
  a `sell` decision targets flat. Sell-call accuracy is still measured even when already flat.
- No live orders in this phase. The live adapter is a thin, separately reviewed follow-up (M5)
  gated on measured results.
- Bun everywhere: `Bun.serve`, `bun:sqlite`, `Bun.sql` (Postgres), `bun test`. No express, no
  better-sqlite3, no pg.
- UI style rules carry over from the demo: no middle dots, em dashes or en dashes in rendered
  text; no blinking or pulsing indicators.

---

## 2. Strategy specification

### 2.1 Pairs

Chosen for volatility relative to the fee hurdle, real retail taker flow (the model's signals are
CVD, book imbalance, and momentum, which are retail-flow signals), and Coinbase liquidity
(volumes as of Sept 2026):

| Pair | 4h sigma | Stop / take-profit | Notional | Role |
|------|-----------|--------------------|----------|------|
| UNI-USD | 295 bps | 295 / 1180 | $600 | Liquid tape. Trades when the average stack is up. |
| NEAR-USD | 331 bps | 331 / 1324 | $600 | Same class, slightly larger move. |
| BCH-USD | 242 bps | 242 / 968 | $500 | Large tape, quieter than UNI. |
| SUI-USD | 219 bps | 219 / 876 | $400 | Tightest after-fee payoff. Still above 2 to 1 at 50 and 90. |
| AVAX-USD | 227 bps | 227 / 908 | $400 | Same class as SUI. |
| ARB-USD | 390 bps | 390 / 1560 | $300 | Largest liquid 4h move. Smallest clip. |

Stop is 1.0 sigma and take-profit is 4.0 sigma (`cb/books.ts`). The table is the risk book.
`CB_PAIRS` selects which enabled rows run. A name missing from the table refuses boot.

Excluded: SOL-USD, ETH-USD, and BTC-USD (typical 4h sigma sits under the fee hurdle), XRP-USD
(needs a near-certain call), and thin meme tapes where a post-only clip is the book.

Pairs are config (`CB_PAIRS`), not code. Every module is written per-pair and the engine runs one
instance per pair against a shared feed process.

### 2.2 Cadence, horizon, and the decision

- Trade cadence stays one model call per pair every `CB_DECIDE_SEC` (default 300 s). Features
  update on each Coinbase tick. Jev's classify time is the only sub-second work. There is no
  per-block loop. The live book is UNI, NEAR, BCH, SUI, AVAX, and ARB. Calls are staggered by
  `decideSec / n` (50 s at six pairs). The 25 s decide deadline stays under that stagger.
- The call is one classification with four choices: `market_regime` (expansion, balance,
  contraction), `direction_bias` (`long` or `flat`; spot cannot short), `toxic_flow_risk`
  (`low` or `high`), and `liquidity_stress` (`normal` or `stressed`). Confidence is the `long`
  probability on `direction_bias`. Jev does not place orders and does not compute fees.
- An approved entry is stored as action `buy` because code entered. Jev's own `direction_bias`
  and confidence stay on `decisions.state`. Every vector is recorded, including ones the gate
  refuses.
- Traded horizon: `CB_HORIZON_SEC` (default 86,400 s = 24 h). That is the position timer. The
  decide cadence stays 300 s. A long is not closed because the next classify lost confidence.
- Measured horizons: every decision is also resolved (scored, not traded) at 30 m, 1 h, 2 h, 4 h,
  and 24 h. 30 m, 1 h, 2 h, and 4 h are not the hold clock.
- Position model: target-position, long/flat. An approved entry is sized from near-touch depth,
  capped at the pair notional. A flatten sells the open position. The hold clock starts at the
  entry fill and is not extended by a later buy. The position closes on stop, take-profit, toxic
  flow, contraction, halt, or the 24 hour clock.
- One decision in flight per pair (same guard pattern as `Trader.busy` in `src/trader.ts`).

### 2.3 Fee gate and execution policy

Entry is approved only when all of these hold. The gate is code (`cb/gate.ts`). Jev does not see it.

- `emaCross` is `above`. Otherwise the reason is `trend`.
- `toxic_flow_risk` is not `high`, `liquidity_stress` is not `stressed`, and `market_regime` is
  not `contraction`. Those three are vetoes. Direction and confidence are recorded and do not
  open or close the trade.
- The 4 hour return is not already past that pair's stop. Otherwise the reason is `chase`.
- After-fee winner is at least twice the after-fee loser at the configured maker and taker fees:
  `winner = takeProfit - maker - taker`, `loser = stop + maker + taker`. Otherwise the reason is
  `payoff`. A book that booted has already passed this at 50 and 90.
- Size is `min(pair notional, CB_DEPTH_PARTICIPATION * USD depth on levels 1 to 3 of the bid, remaining gross)`.
  Default participation is 0.25. Below `CB_MIN_SIZE_USD` (default $25) the entry is refused as dust.
  If the residual under `CB_MAX_GROSS_USD` (default $3,000) is under that minimum, the reason is `gross cap`.
- Halt and a blocked feed still refuse.

`expectedYieldBps` is still computed and stored. It does not approve or refuse.

Exits while long: toxic flow, contraction, the kill switch, the 24 hour clock, or a stop or
take-profit guard. A confidence dip does not flatten.

Stop and take-profit are hard guards on the 1 second tick, measured from the fee-inclusive
average cost (`costBasisUsd / positionBase`), not the raw fill. Each pair uses its own stop and
take-profit from `cb/books.ts`. Boot refuses a pair missing from that table, a take-profit at or
below maker plus taker, a stop below the hurdle at a 2 bp spread, or an after-fee winner under
twice the after-fee loser. A later `long` cannot keep the position open once a guard has fired. The guard cancels
any resting order and flattens immediately as a taker, tagged `stop` or `take_profit`. A flat pair
never trips either guard.

Two circuits cancel a resting entry and block new entries. Exits still flatten.

- A fill whose price is more than `CB_MAX_SLIPPAGE_BPS` (default 10) from the mid at placement.
- The book is unsynced or the websocket is down. A quiet stretch on the public Coinbase tape is
  not treated as a fault.

Execution, paper now:

- Entry: post-only, one tick inside the touch, clamped so a buy never reaches the ask and a sell
  never reaches the bid. Reprice if that quote moves more than `CB_REPRICE_TICKS`. Unfilled after
  `CB_ENTRY_TIMEOUT_SEC` (default 120 s), the entry is canceled. Entries never taker-convert. A
  missed entry costs nothing.
- A signal or horizon exit rests post-only first. If it is still open at the timeout it may cross,
  so inventory does not stick. That cross is the taker cost the gate already required the entry to beat.
- Stop and take-profit skip the maker rest and cross immediately.
- Fees: applied per fill from config (`CB_MAKER_FEE_BPS` default 50, `CB_TAKER_FEE_BPS` default
  90). Fee tier is config, not hardcoded. The report shows P&L under the configured tier and under
  0 bps maker as an upper bound. Both legs record their liquidity flag. `takerFillShare` stays on
  `/report`.

---

## 3. Architecture

```
cb/                          new Bun package area (same repo, imported by root package.json scripts)
  index.ts                   bootstrap: config, store, feed, engines, resolver, server
  config.ts                  env-driven settings, mirrors src/config.ts style
  feed.ts                    Coinbase WS: level2 + market_trades + heartbeats, reconnect, per-pair books
  state.ts                   MarketState builder: rolling mids, returns, CVD, depth bands
  model.ts                   Model interface, JevModel (experimental_evaluate), MockModel
  engine.ts                  per-pair loop: schedule decisions, compute target position, emit order intents
  paper.ts                   paper broker: simulates maker/taker fills against the live book and prints
  accounting.ts              position, fee-inclusive cost basis, realized/unrealized P&L
  resolver.ts                scores decisions when their horizons pass (1h/4h/24h)
  report.ts                  metrics: accuracy + Wilson CI, Brier, calibration, capture rate, promotion gate
  server.ts                  Bun.serve REST + SSE, same shape as src/server.ts
  db/
    schema.sql               portable DDL (SQLite and Postgres)
    store.ts                 Store interface + factory (DATABASE_URL decides backend)
    sqlite.ts                bun:sqlite implementation
    postgres.ts              Bun.sql implementation
  *.test.ts                  bun test (accounting, paper fills, resolver, fees, calibration)

web/src/app/paper/page.tsx   new dashboard route (Kuru demo homepage untouched)
web/src/components/paper/    Header, PairCards, EquityChart, DecisionLog, Calibration, HorizonTable, FillTape
web/src/lib/usePaperFeed.ts  SSE hook, adapted from useFeed.ts
```

Code reuse from `src/` is by pattern, not import: the one-in-flight guard, the SSE server shape,
the `TradeState`-style compact model input, and the fill simulation approach from
`Trader.simFills`. Keeping `cb/` import-free of `src/` guarantees the demo cannot break.

### 3.1 Data flow

```
Coinbase WS (level2, market_trades)
    v
feed.ts: per-pair book (best bid/ask, depth bands) + trade tape (CVD)
    v                                       every CB_DECIDE_SEC per pair
engine.ts: state.ts builds MarketState -> model.decide() -> store.insertDecision()
    v                target position vs actual
paper.ts: place/reprice/convert simulated orders; prints from the tape trigger maker fills
    v
accounting.ts: fills ledger (fee-inclusive cost basis), position, realized/unrealized
    v
store (SQLite/Postgres): decisions, orders, fills, snapshots
    v                                        resolver.ts scores decisions as horizons pass
server.ts: REST + SSE ------------------------> web /paper dashboard
```

---

## 4. Coinbase integration (`cb/feed.ts`)

- Endpoint: `wss://advanced-trade-ws.coinbase.com`, channels `level2`, `market_trades`,
  `heartbeats`, subscribed per product id. Authentication: implement CDP API key JWT signing
  (ES256) behind a small `auth.ts` helper; market data channels currently work unauthenticated
  but the helper is required for the later live/user channel and costs little now. Verify channel
  auth requirements against current docs at build time; they have changed before.
- Maintain per pair: top-of-book, mid, spread, cumulative depth within 10/25/50 bps per side
  (from level2 snapshots + updates), and a rolling trade tape (side, size, price, ts) for CVD and
  prints. This mirrors what `src/book.ts` + `src/trades.ts` feed the Kuru model, so the
  MarketState the model sees is structurally familiar.
- Mid history: ring buffer of (ts, mid) sampled once per second per pair, capped at 26 h
  (covers the 24 h measured horizon). Also persisted via minute-bar inserts into `bars` so the
  resolver works across restarts.
- Reconnect with backoff, resubscribe, and full book resync on `level2` snapshot. A gap in
  `heartbeats` beyond 15 s forces reconnect (same staleness pattern as `useFeed.ts`).
- Sanity cross-check once a minute per pair: REST `GET /api/v3/brokerage/market/products/{id}`
  best bid/ask vs local book; log divergence > 5 bps as an incident (feed bug detector).

## 5. Model layer (`cb/model.ts`, `cb/features.ts`, `cb/state.ts`)

`cb/features.ts` updates on every book or trade event: top-5 and top-20 imbalance, spread, Welford
realized vol scaled to the horizon, Parkinson vol on 1 minute candles, EMA fast/slow, RSI, and
volume delta. `buildState` sends only that summary. `recentMids` is not in the payload. The mid
ring in the feed still feeds the resolver. `JSON.stringify(state)` stays under about 1,600
characters.

`JevModel` calls `experimental_evaluate` once, with the four choice questions in section 2.2.
`MockModel` builds the same vector from momentum, imbalance, and CVD, plus regime from realized
vol and stress from the spread versus its EMA. `Bun.sleep(150)` stands in for inference latency.

```ts
export interface MarketState {
  pair: string;
  ts: number;
  horizonSec: number;
  mid: number;
  spreadBps: number;
  spreadEmaBps: number;
  imbalance5: number;           // -1..1, top 5 levels
  imbalance20: number;          // -1..1, top 20 levels
  volBps: number;               // Welford, scaled to the horizon
  parkinsonBps: number;
  emaGapBps: number;
  emaCross: "above" | "below" | "flat";
  rsi: number | null;
  volumeDelta: number;
  volumeGross: number;
  returnsBps: { m5: number; m30: number; h1: number; h4: number; h24: number };
  feeBps: { maker: number; taker: number };  // shown, not applied by the model
  position: "long" | "flat";
}
```

## 6. Paper broker (`cb/paper.ts`)

Simulates the execution policy in section 2.3 against the real feed.

- A simulated maker order rests one tick inside the touch. It becomes eligible one second after
  placement (models propagation), then fills when a print crosses it: taker sell at <= p for our
  bid, taker buy at >= p for our ask. Fill size = min(order remainder, print size x
  `CB_FILL_HAIRCUT`).
- `CB_FILL_HAIRCUT` (default 0.5) is the honesty knob: we cannot know our queue position, so
  paper fills only take half of each crossing print. The report also computes P&L at haircut 1.0
  and 0.25 to bound the sensitivity. This optimism bias is the single biggest paper-vs-live gap;
  it is stated on the dashboard.
- An unfilled entry is canceled at `CB_ENTRY_TIMEOUT_SEC`. It does not cross. A signal or horizon
  exit may cross at that timeout, walking the local book, at the taker fee. Stop and take-profit
  cross on the same 1 second tick that breaches the fee-inclusive entry, and the order purpose
  is `stop` or `take_profit`.
- Every simulated fill gets `venue = "paper"`, a synthetic `external_id`
  (`paper-{runId}-{seq}`), its liquidity flag, and the fee actually charged, then flows through
  the same accounting as a real fill would. Live fills later arrive as `venue = "coinbase"` with
  real trade ids; nothing downstream changes.

## 7. Accounting (`cb/accounting.ts`)

Rules copied deliberately from Polytrage (`C:\Projects\Node\Polytrage\src\db\store.ts`), which
got this right:

- Fee-inclusive cost basis, fee-net proceeds, single subtraction:
  buy fill: `cost_basis_usd = notional + fee`, `proceeds_usd = 0`;
  sell fill: `cost_basis_usd = 0`, `proceeds_usd = notional - fee`.
  Realized P&L = sum(proceeds) - sum(cost basis) over closed size. Never subtract fees again.
- Idempotent fills: `UNIQUE(venue, external_id)` upsert, so replays, reconnects, and the future
  live sync job can never double count.
- Position and unrealized P&L: weighted-average entry from open fills (long/flat only, so no
  flip complexity; `Trader.applyFill` in `src/trader.ts` is the reference for the general case).
- Equity: `bankroll + realized + unrealized - inference costs`. Snapshot per pair and TOTAL every
  60 s into `snapshots` for the equity curve.

## 8. Database

Backend selected by env: `DATABASE_URL=postgres://...` uses `Bun.sql`; anything else (or unset)
uses `bun:sqlite` at `CB_DB_PATH` (default `data/cb.db`). One portable DDL file, applied with
`CREATE TABLE IF NOT EXISTS` plus additive migrations; types restricted to TEXT / REAL / INTEGER,
timestamps as INTEGER epoch ms, booleans as 0/1, JSON as TEXT.

```sql
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,            -- uuid
  mode TEXT NOT NULL,             -- paper | live
  model TEXT NOT NULL,            -- mock | jev model id
  pairs TEXT NOT NULL,            -- comma separated
  config TEXT NOT NULL,           -- full config JSON at start (fee bps, haircut, sizes)
  git_sha TEXT,
  started_at INTEGER NOT NULL,
  stopped_at INTEGER
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  pair TEXT NOT NULL,
  ts INTEGER NOT NULL,
  action TEXT NOT NULL,           -- buy | sell
  p_buy REAL NOT NULL,
  p_sell REAL NOT NULL,
  mid REAL NOT NULL,
  spread_bps REAL NOT NULL,
  state TEXT NOT NULL,            -- MarketState JSON as given to the model
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  inference_usd REAL NOT NULL DEFAULT 0,
  traded INTEGER NOT NULL DEFAULT 0   -- 1 if it changed the target position
);
CREATE INDEX IF NOT EXISTS idx_decisions_pair_ts ON decisions(pair, ts);

-- One row per (decision, measured horizon). Written by the resolver when ts + horizon passes.
CREATE TABLE IF NOT EXISTS outcomes (
  decision_id TEXT NOT NULL,
  horizon_sec INTEGER NOT NULL,   -- 1800 | 3600 | 7200 | 14400 | 86400
  resolved_at INTEGER NOT NULL,
  mid_then REAL NOT NULL,
  mid_at_horizon REAL NOT NULL,
  move_bps REAL NOT NULL,         -- signed, from decision mid
  correct INTEGER NOT NULL,       -- sign(move) matched the call
  PRIMARY KEY (decision_id, horizon_sec)
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  decision_id TEXT,
  pair TEXT NOT NULL,
  side TEXT NOT NULL,             -- buy | sell
  purpose TEXT NOT NULL,          -- entry | exit
  price REAL NOT NULL,
  size_base REAL NOT NULL,
  status TEXT NOT NULL,           -- open | filled | partial | canceled | converted_taker | expired
  venue_order_id TEXT,            -- null in paper mode
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_pair_status ON orders(pair, status);

CREATE TABLE IF NOT EXISTS fills (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  order_id TEXT,
  venue TEXT NOT NULL,            -- paper | coinbase
  external_id TEXT NOT NULL,      -- synthetic in paper, venue trade id live
  pair TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  size_base REAL NOT NULL,
  notional_usd REAL NOT NULL,
  fee_usd REAL NOT NULL,
  liquidity TEXT NOT NULL,        -- maker | taker
  cost_basis_usd REAL NOT NULL,   -- buys: notional + fee, else 0
  proceeds_usd REAL NOT NULL,     -- sells: notional - fee, else 0
  source TEXT NOT NULL,           -- paper_sim | coinbase_sync
  traded_at INTEGER NOT NULL,
  recorded_at INTEGER NOT NULL,
  raw TEXT,
  UNIQUE (venue, external_id)
);
CREATE INDEX IF NOT EXISTS idx_fills_pair_traded ON fills(pair, traded_at);

CREATE TABLE IF NOT EXISTS snapshots (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  pair TEXT NOT NULL,             -- pair or TOTAL
  ts INTEGER NOT NULL,
  mid REAL,
  position_base REAL NOT NULL,
  entry_price REAL,
  realized_usd REAL NOT NULL,
  unrealized_usd REAL NOT NULL,
  fees_usd REAL NOT NULL,
  inference_usd REAL NOT NULL,
  equity_usd REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snapshots_pair_ts ON snapshots(pair, ts);

-- Minute bars so the resolver and charts survive restarts.
CREATE TABLE IF NOT EXISTS bars (
  pair TEXT NOT NULL,
  ts INTEGER NOT NULL,            -- minute start
  open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL, close REAL NOT NULL,
  volume_base REAL NOT NULL,
  PRIMARY KEY (pair, ts)
);
```

`store.ts` exposes a thin interface (`insertDecision`, `upsertFill`, `resolveDue`,
`equitySeries`, `calibration`, ...) with the two backends behind it. Keep it split by concern
(schema / writes / queries) from day one; Polytrage's single 2,300-line store module is the
anti-pattern to avoid. All queries used by the report and UI are indexed above.

## 9. Resolver and measurement (`cb/resolver.ts`, `cb/report.ts`)

Resolver: every 60 s, `SELECT` decisions where `ts + horizon <= now` lacking an `outcomes` row
for that horizon, look up `mid_at_horizon` from `bars` (nearest minute close), write the outcome.
Restart-safe by construction because bars are persisted.

Report metrics, per pair and per horizon, each with the exact definition the UI will render:

- Directional accuracy: mean(correct), with a Wilson 95% interval; n shown always.
- Brier score: mean((p_buy - up)^2) where up = 1 if move > 0.
- Calibration: decile buckets of p_buy vs realized up-frequency (the UI's calibration chart).
- Edge per decision: mean(move_bps signed by the call) minus round-trip cost estimate.
- Realized strategy P&L: from the fills ledger (the authoritative money record), split into
  price P&L, fees, and inference cost. Settlement-scoped by close time (Polytrage pattern: an
  entry and its exit always land in the same reporting window).
- Capture rate: realized P&L divided by oracle P&L (what the same entries/exits earn if every
  traded decision were correct). Grades execution quality separately from prediction quality.
- Sensitivity grid: P&L recomputed under maker fee {50, 25, 10, 0} bps and fill haircut
  {0.25, 0.5, 1.0}.

Promotion gate (all must hold before any live discussion, evaluated by `GET /report`):

1. >= 200 resolved decisions at the traded horizon for the pair.
2. Wilson lower bound of accuracy > 52%.
3. Net paper P&L positive at the configured fee tier and haircut 0.5.
4. Max drawdown < 15% of the pair bankroll.
5. Feed incidents (divergence, gaps) below 1 per day over the window.

## 10. Server (`cb/server.ts`)

`Bun.serve` on `CB_PORT` (default 3001), same CORS/SSE conventions as `src/server.ts`:

- `GET /` run meta + per-pair latest (position, open order, last decision, equity).
- `GET /events` SSE: `snapshot` on connect, then `tick` (pair, mid, spread, 1/s), `decision`,
  `order`, `fill`, `equity` (60 s), `ping`.
- `GET /decisions?pair=&limit=&horizon=` decision log with outcomes joined.
- `GET /equity?pair=&fromTs=` snapshot series.
- `GET /calibration?pair=&horizon=` bucketed calibration data.
- `GET /report` full metrics JSON including the promotion gate booleans.

## 11. UI: `web/app/paper` (the measurement dashboard)

New route in the existing Next.js app; same design tokens, CSS Modules, custom SVG charts in the
style of `FlowChart` (no chart library). `usePaperFeed.ts` copies the reducer/reconnect/staleness
structure of `useFeed.ts` with the new event types. `NEXT_PUBLIC_PAPER_API_URL` points at the cb
server.

Layout, top to bottom:

1. Header: PAPER badge (amber; a LIVE badge would be green), run id, model name, uptime, total
   equity, total P&L split (price / fees / inference), connection state.
2. Pair cards (one per pair): price and spread, position (side, size, entry, unrealized), open
   order (price, purpose, resting/converted state, age), last decision (action, p_buy as a
   two-color probability bar, time until horizon), pair P&L.
3. Equity curve: TOTAL plus per-pair toggles, with fee and inference overlays so the cost drag is
   visible, not hidden in a net line. Time range 24h / 7d / all.
4. Decision log: time, pair, action, p_buy, mid at decision, then one cell per horizon (1h/4h/24h)
   showing signed move in bps, green when the call was correct, red when wrong, gray pending.
   This table is the single most important surface: it shows exactly what the model said and
   what the market then did.
5. Calibration panel: per horizon, predicted-probability deciles vs realized frequency with the
   diagonal reference line, plus Brier score and n. A model can have a good hit rate and terrible
   calibration; both are visible here.
6. Horizon comparison: accuracy with confidence intervals, edge per decision in bps, and
   hypothetical net P&L per horizon, answering "should CB_HORIZON_SEC change" from data.
7. Promotion gate: the five criteria from section 9 as explicit pass/fail rows with current
   values. No ambiguity about whether this is ready for money (it starts all red).
8. Fill tape: recent fills with liquidity flag, fee, and source, plus the haircut disclaimer line
   ("paper fills assume 50% queue capture; see sensitivity in the report").

## 12. Configuration

Additions to `.env.example` (root) and `web/.env.example`:

```
# cb (Coinbase paper trading)
CB_PAIRS=UNI-USD,NEAR-USD,BCH-USD,SUI-USD,AVAX-USD,ARB-USD
CB_DECIDE_SEC=300
CB_HORIZON_SEC=86400
CB_NOTIONAL_USD=1000
CB_BANKROLL_USD=12000
CB_MAX_GROSS_USD=3000
CB_MAKER_FEE_BPS=50
CB_TAKER_FEE_BPS=90
CB_FILL_HAIRCUT=0.5
CB_ENTRY_TIMEOUT_SEC=120
CB_REPRICE_TICKS=2
CB_NEVER_CROSS_ENTRY=false
CB_BUY_THRESHOLD=0.70
CB_SELL_THRESHOLD=0.4
CB_PORT=3001
CB_DB_PATH=data/cb.db
# DATABASE_URL=postgres://user:pass@host:5432/cb   # optional, replaces sqlite
# COINBASE_API_KEY_NAME= / COINBASE_API_PRIVATE_KEY=   # CDP key, only needed for user channel / live
MODEL=mock                       # mock | jev (shared with the demo)
# web/.env.example: NEXT_PUBLIC_PAPER_API_URL=http://localhost:3001
```

Root `package.json` scripts: `"cb": "bun run cb/index.ts"`, `"cb:dev": "bun --watch cb/index.ts"`,
`"cb:report": "bun run cb/report.ts"` (prints the report JSON as a table to stdout).

## 13. Testing (`bun test`, first tests in this repo)

- `accounting.test.ts`: buy/sell/partial-close sequences; fee-inclusive basis; realized equals
  proceeds minus cost exactly once; long/flat invariant.
- `paper.test.ts`: scripted print sequences against resting orders (crossing, non-crossing,
  partial via haircut, eligibility delay, taker conversion slippage from depth).
- `resolver.test.ts`: seeded bars and decisions; correct move_bps sign and `correct` flag;
  restart idempotency (resolving twice writes once).
- `fees.test.ts`: maker/taker application, sensitivity grid math.
- `report.test.ts`: Wilson interval, Brier, calibration bucketing on known fixtures.
- `store.test.ts`: runs against SQLite always, against Postgres when `DATABASE_URL` is set (CI
  can spin one up later); asserts `UNIQUE(venue, external_id)` dedupe.

## 14. Build workflow (milestones with acceptance criteria)

- M0, scaffold (0.5 d): `cb/` skeleton, config, schema, store with both backends, `bun test`
  green on store + accounting stubs. Accept: `bun run cb` starts, creates the DB, serves `GET /`.
- M1, feed (1.5 d): WS book + tape for all pairs, minute bars persisted, REST divergence check.
  Accept: 24 h soak with zero unnoticed gaps (incidents logged), books match REST within 5 bps.
- M2, decisions (1 d): state builder, MockModel end to end, decisions persisted, resolver writing
  outcomes at all three horizons. Accept: decision log fills in and outcomes appear on schedule
  across a restart.
- M3, paper broker (2 d): full execution policy, fills ledger, snapshots, equity. Accept: paper
  P&L reconciles with the fills ledger to the cent; `bun test` covers the fill rules.
- M4, server + UI (2-3 d): all endpoints, the `/paper` dashboard complete per section 11.
  Accept: a stranger can read the dashboard and state the model's accuracy, cost drag, and gate
  status without asking questions.
- M5, JevModel + measurement campaign: switch `MODEL=jev`, run 3-4 weeks unattended (Railway,
  same Dockerfile pattern as the demo, with `data/` on a volume or Postgres). Weekly
  `cb:report` review. Only after the gate passes: design review for a live adapter (real order
  placement, venue fill sync as source of truth, Polytrage-style `*_sync` preference) and tax
  tracking, as a separate spec.

## 15. Risks and honesty notes

- Paper fill optimism is the dominant risk; the haircut plus sensitivity grid bound it but do not
  eliminate it. Treat paper P&L as an upper bound.
- The fee sensitivity grid is not a promise: entry-tier US fees are 50 bps maker, and volume
  tiers should be earned, not assumed.
- Coinbase WS schemas and fee schedules change; `feed.ts` and fee config are isolated so changes
  stay local. Verify current channel auth requirements when building M1.
- Every live fill would be a US taxable event; the fills ledger is designed to be the tax record
  (Polytrage's approach), but live-mode tax reporting is out of scope for this spec.
- Nothing here is investment advice; the entire point of the harness is to let the data say no
  cheaply.
