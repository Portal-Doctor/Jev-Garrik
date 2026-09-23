# Jev-Garrik — Coinbase paper-trading harness

**Maintainer runbook.** This repo runs a Coinbase spot paper trader (`cb/`) that measures whether a
model has real, *after-fee* directional edge — with **no capital at risk**. It does not place live
orders. Nothing goes live until the promotion gate passes on real data (see
[docs/SPEC-COINBASE.md](docs/SPEC-COINBASE.md)).

Every ~300s the model (`mock` heuristic or the real `jev` model) classifies SOL-USD. A fee gate
then approves or refuses the entry. Decisions, simulated fills, and outcomes at 1h/4h/24h horizons
are persisted to Postgres; a Bun server exposes REST + SSE, and a Next.js dashboard (`/paper`)
renders it live.

> The original Monad/Kuru demo (`src/`) still lives here — see [Legacy: Monad demo](#legacy-monad-demo-src) at the end.

---

## System at a glance

| Component | Runs as | Port | Notes |
|---|---|---|---|
| Trading engine (`cb/`) | Docker container `cb-app` | `3001` | Coinbase WS feed, decide/resolve loops, paper broker, REST+SSE. Always-on. SOL-USD. |
| Postgres | Docker container `cb-postgres` | `5432` | Data in named volume `cb-pgdata`. |
| Dashboard (`web/`) | Next.js dev, on demand | `3000` | Viewer only; reads `NEXT_PUBLIC_PAPER_API_URL`. |
| Kuru paper (`src/`) | Compose profile `kuru` | `3002` | **Stopped.** Not in `docker compose up`. |

Backend and DB use `restart: unless-stopped`, so they survive crashes and reboots (given Docker
Desktop autostart). Full hosting details, including a cloud alternative, are in
[docs/DEPLOY.md](docs/DEPLOY.md).

---

## Decision cadence — how often, and what drives it

**Time-driven, one model call per pair every `CB_DECIDE_SEC` (default 300s / 5 min).** The engine
(`cb/engine.ts`) does not ask Jev on every tick. Each book and trade event updates an O(1) feature
accumulator (`cb/features.ts`). On the wall-clock cadence the engine sends that summary to Jev once.

The call is four choices: regime, long or flat, toxic flow, and liquidity stress. Confidence is the
long probability. A deterministic gate (`cb/gate.ts`) then approves a long only when the bias is
long, flow is clean, the book is normal, the regime is expansion, and expected yield clears
maker plus taker plus half the spread. Otherwise the vector is still stored and nothing is bought.
Size follows near-touch depth, capped at `CB_NOTIONAL_USD`.

- **Per-pair, staggered.** Pairs are offset evenly across the interval (`CB_DECIDE_SEC / n` apart) so
  their model calls don't bunch. The live book is **SOL-USD only**, so one decision fires every
  **300s**. Extra pairs in history stay in Postgres for tax; they are not traded.
- **One-in-flight guard.** If a pair's previous decision is still running when the next tick arrives,
  that tick is skipped (model latency is normally far under the interval, so this is rare).
- **Book-ready gate.** A decision is skipped silently until that pair's order book has a mid
  (`buildState` returns nothing), so early ticks after startup don't produce garbage.
- **Traded vs. observed.** An approved long targets a depth-sized entry. A flatten targets flat.
  *Every* decision is persisted and scored, but only one that **changes** the target position is
  marked `traded` and emits an order intent to the paper broker.
- **Guards do not wait 300s.** While a pair is long, the paper broker checks the fee-inclusive
  entry every second. A 150 bp stop or a 250 bp take-profit cancels the resting order and flattens
  as a taker immediately, even if the last classification was still long.

**Cadence is not the horizon.** `CB_DECIDE_SEC` is how often it *decides*; `CB_HORIZON_SEC`
(default 14400s / 4h) is the forward window the features and the gate are scaled to. Regardless of
cadence, the resolver scores every decision's outcome at **1h / 4h / 24h** later. Entries rest one
tick inside the touch and cancel if they do not fill. They do not cross the spread.

To change the rhythm, set `CB_DECIDE_SEC` (and/or `CB_PAIRS`) in `.env`, then
`docker compose up -d --build`. Note that with `MODEL=jev`, faster cadence ⇒ more inference cost.

---

## Prerequisites

- **Docker Desktop** — enable *Settings → General → "Start Docker Desktop when you sign in"* so the
  stack returns after a reboot.
- **Bun** (`bun --version`) — for the dashboard and tests. Install: `powershell -c "irm bun.sh/install.ps1 | iex"`.
- **Root `.env`** — copy from `.env.example`, then set at least:
  - `MODEL=jev` (or `mock` for the free heuristic)
  - `AI_GATEWAY_API_KEY=…` — Vercel AI Gateway key (routes model `typesafe-ai/jev`; needs a card on file at Vercel).

`compose.yml` overrides `DATABASE_URL` and `PORT` for the container automatically; you do not set them.

---

## Quick start

```powershell
# 1. Start Postgres + the trading engine (builds the cb image on first run)
docker compose up -d --build
docker compose logs -f cb        # expect: model=typesafe-ai/jev … "synced":true

# 2. Start the dashboard (detached on :3000)
bun run ui:start                 # open http://localhost:3000/paper

# 3. Stop the dashboard when done
bun run ui:stop
```

---

## Configuration (`.env`)

Engine knobs (defaults in `cb/config.ts`). Change a value, then `docker compose up -d --build` to apply.

| Var | Default | Meaning |
|---|---|---|
| `MODEL` | `mock` | `mock` heuristic or `jev` (real model). |
| `AI_GATEWAY_API_KEY` | — | Present ⇒ Jev routes via Vercel AI Gateway as `typesafe-ai/jev`. |
| `CB_PAIRS` | `SOL-USD` | Pairs to trade/measure. Live book is SOL only. |
| `CB_DECIDE_SEC` | `300` | Seconds between decisions per pair. |
| `CB_HORIZON_SEC` | `14400` | Traded horizon (4h). Scored also at 1h/24h. |
| `CB_NOTIONAL_USD` | `1000` | Notional per position. |
| `CB_BANKROLL_USD` | `10000` | Starting bankroll for equity. |
| `CB_MAKER_FEE_BPS` / `CB_TAKER_FEE_BPS` | `50` / `90` | Fee assumptions. |
| `CB_FILL_HAIRCUT` | `0.5` | Optimism haircut on paper fills. |
| `CB_ENTRY_TIMEOUT_SEC` / `CB_REPRICE_TICKS` | `120` / `2` | Post-only entry. Unfilled entries cancel. |
| `CB_BUY_THRESHOLD` / `CB_SELL_THRESHOLD` | `0.6` / `0.4` | Confidence to enter, and to flatten. |
| `CB_FEE_BUFFER` | `1.5` | Multiplier on the post-only round trip (maker + maker + half spread). |
| `CB_STOP_LOSS_BPS` / `CB_TAKE_PROFIT_BPS` | `150` / `250` | Hard guards on the fee-inclusive entry. |
| `CB_DEPTH_PARTICIPATION` / `CB_MIN_SIZE_USD` | `0.25` / `25` | Depth sizing. Dust is refused. |

The dashboard reads `NEXT_PUBLIC_PAPER_API_URL` (default `http://localhost:3001`) from `web/.env`.

---

## Operations

| Task | Command |
|---|---|
| Status | `docker compose ps` |
| Follow engine logs | `docker compose logs -f cb` |
| Restart just the engine | `docker compose restart cb` |
| Apply a code/config change | `docker compose up -d --build` |
| Start / stop dashboard | `bun run ui:start` / `bun run ui:stop` |
| Weekly metrics report | `bun run cb:report` (or `GET /report`) |
| Run tests | `bun test cb` |

The dashboard header shows two live indicators: a **backend chip** polling `GET /health` every 15s
(reachability), and an SSE **connection dot** (live stream state).

---

## Maintenance

Paper-trading state is safe to interrupt: decisions/fills/outcomes are written to Postgres as they
happen, the resolver is restart-idempotent, and order books rebuild from the feed on restart. There
is nothing to flush at the app layer.

**Safe shutdown for a maintenance window:**

```powershell
# 1. (optional) back up the database first
docker exec cb-postgres pg_dump -U cb -d cb -Fc -f /tmp/cb.dump
docker cp cb-postgres:/tmp/cb.dump ".\cb-backup-$(Get-Date -Format yyyyMMdd-HHmm).dump"

# 2. graceful stop — stops cb-app first, then cb-postgres, automatically
docker compose stop

# 3. …do maintenance (reboot, Docker update, Postgres bump)…

# 4. bring it back and verify
docker compose up -d
docker compose logs -f cb        # confirm "synced":true and decisions flowing
```

**Restore a backup** (into the running DB):

```powershell
docker cp ".\cb-backup-<stamp>.dump" cb-postgres:/tmp/restore.dump
docker exec cb-postgres pg_restore -U cb -d cb --clean --if-exists /tmp/restore.dump
```

- `docker compose down` removes containers but **keeps** the `cb-pgdata` volume.
- `docker compose down -v` **wipes all trading data** — only for a deliberate clean baseline.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `bind: 0.0.0.0:3001 … only one usage` on `up` | A stray `bun run cb/index.ts` (or old container) holds 3001. | `netstat -ano \| findstr ":3001"`, then `Stop-Process -Id <pid> -Force`; re-run `docker compose up -d`. |
| Backend chip stays `disconnected` | Container down or wrong `NEXT_PUBLIC_PAPER_API_URL`. | `docker compose ps`; check `GET http://localhost:3001/health`. |
| Jev call fails: *"requires a valid credit card"* | Vercel AI Gateway billing gate. | Add a card in the Vercel dashboard; the free tier still requires it. |
| Feed shows `synced:false` for a pair | WS reconnect/resync in progress. | Transient; watch logs. Persisting ⇒ check `incidentsPerDay` in `/report`. |
| `ui:stop` prints "No UI running" but :3000 is busy | Something other than the dashboard holds 3000. | Identify with `netstat -ano \| findstr ":3000"`. |
| Dashboard reboot doesn't come back | It's on-demand by design (not in Docker). | Run `bun run ui:start` (or add it to Task Scheduler yourself). |

---

## HTTP API (backend on `:3001`)

- `GET /health` — liveness probe (status, runId, uptime); polled by the UI.
- `GET /` — run meta + live per-pair snapshot.
- `GET /events` — SSE: `snapshot` on connect, then `tick` / `decision` / `fill` / `equity` / `ping`.
- `GET /decisions?pair=&limit=` — decision log with outcomes joined.
- `GET /equity?pair=&fromTs=` — equity-curve snapshot series.
- `GET /calibration?pair=&horizon=` — bucketed calibration + Brier.
- `GET /report` — full metrics JSON including promotion-gate booleans.

---

## Repo layout

```
cb/
  config.ts        env-driven config (pairs, cadence, fees, model transport, PORT)
  db/schema.sql    Postgres schema (applied on boot by store.init)
  db/store.ts      Bun.sql store: writes + queries
  feed.ts          Coinbase Advanced Trade WS: per-pair book, tape/CVD, depth, minute bars
  features.ts      tick accumulator: imbalance, vol, EMA, RSI, volume delta
  state.ts         compact MarketState handed to the model
  gate.ts          fee hurdle, depth sizing, stop and take-profit
  model.ts         four-choice Jev call, MockModel
  engine.ts        per-pair decide loop (one-in-flight guard, gate, intents)
  resolver.ts      scores outcomes at 1h/4h/24h, restart-idempotent
  paper.ts         paper broker: inside-touch entries, 1s stop/take-profit, haircut fills
  accounting.ts    fee-inclusive ledger + equity snapshots
  report.ts        accuracy+Wilson, Brier, calibration, capture, sensitivity, promotion gate
  server.ts        Bun.serve REST + SSE
  index.ts         bootstrap: wires feed → engine → paper → resolver → server
  *.test.ts        unit tests (bun test cb)
web/               Next.js dashboard; /paper route + usePaperFeed hook
scripts/           ui-start.ps1 / ui-stop.ps1 (dashboard lifecycle)
docs/              SPEC, SPEC-COINBASE, DEPLOY
compose.yml        Postgres + cb-app (default); Kuru behind profile `kuru`
Dockerfile.cb      image for the cb backend
```

---

## Measurement campaign & promotion gate

The point of the harness is to let the data say no cheaply. Run it unattended, review
`bun run cb:report` (or the dashboard) weekly, and watch: accuracy + Wilson lower bound, Brier /
calibration, cost drag (fees + inference), max drawdown, and the gate booleans. Because the traded
horizon is 4h, gate metrics need **days-to-weeks** of data before they mean anything. Only after the
gate passes do we design a separately-reviewed live adapter — that work is out of scope until then.

---

## Legacy: Monad demo (`src/`)

The original demo posts one post-only limit order per Monad block on Kuru MON-USDC, earning the
spread; a Jev model answers buy/sell each block. It is unrelated to the Coinbase harness and shares
only the repo and the `ai`/model dependencies.

The demo process stays stopped. There is no start script for it.

Deployed dry-run reference: https://jev-trader-production.up.railway.app
Layout: `src/{config,chain,book,market,model,trader,server}.ts`. See the file headers for the
300 ms hot-loop design and the SSE event schema.
