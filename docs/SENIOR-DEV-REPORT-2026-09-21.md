# Senior Dev Report: SOL-only Coinbase, Kuru paper shutdown

Date: 2026-09-21
From: Finance / CTO review of both paper books
Audience: Senior dev. This is the work order. What to change, where, why, and how we will know it worked.
Companion: CFO and CTO review canvas (`cfo-cto-review.canvas.tsx`) from this morning.

## Decision in four lines

1. Coinbase paper continues. **SOL-USD only.**
2. **Kuru paper is shut down.** Stop the container. Do not start it again from the default stack.
3. Do not go live. Do not flip `DRY_RUN=false`. Do not implement Coinbase live orders.
4. Do not wipe Postgres. The SOL 4h sample and the tax ledger stay.

## Context

Both books lost money in paper. Coinbase mark-to-market was about $9,830 on a $10,000 bankroll. Gross price P and L was about +$54. Simulated fees were about $223. Kuru already papers maker at 0 bps and still lost: this soak's gross was about $0, gas and Jev did the rest.

SOL is the only Coinbase pair with a real 4h read this campaign (accuracy 80.6%, Wilson lower 63.7%, n=31). XRP is inverted. DOGE did not repeat last campaign's 1h print. SUI is the fee incinerator. Kuru inventory caps were not a P and L lever.

The tweet demo code in `src/` stays in the repo. The Kuru **process** stops. This work order is the paper soak, not a public launch.

## Hard do-nots

- Do not `docker compose down -v`.
- Do not POST `/reset` on either engine.
- Do not `store.resetAll()` / `resetVenue("paper")` / `resetVenue("kuru")`.
- Do not set `DRY_RUN=false` or send a live Monad tx.
- Do not speed `KURU_DECIDE_BLOCKS` (irrelevant once Kuru is down; do not "one last" speed-up).
- Do not add pairs back to `CB_PAIRS`.
- Do not keep retuning `MARGIN_MON` / `MAX_POSITION_MON`.
- Do not flatten SOL. Leave the SOL book running through the pair-list change.

## Work items, in priority order

### 1. P1: Stop Kuru and keep it off the default stack

The running experiment is `kuru-app` (`compose.yml` service `kuru`, port 3002, `restart: unless-stopped`). Stopping it once is not enough: Docker Desktop start-on-login and `bun run engines:up` will bring it back.

Do all of the following:

1. `docker compose stop kuru`
2. Take `kuru` out of the default compose path. Preferred: add `profiles: ["kuru"]` on the `kuru` service so `docker compose up -d` and `docker compose up -d --build` start **db + cb only**. Do not add a command that starts Kuru.
3. Change package.json so default engine scripts do not start Kuru:
   - `engines:up` -> `docker compose up -d --build` (db + cb only, after the profile change)
   - `engines:down` -> `docker compose stop cb`
   - Keep `kuru:stop`. Do not add a start, deploy, or restart script for Kuru.
4. Confirm `docker compose ps` shows `kuru-app` not running, and that it stays down after a compose up of the default stack.

Do not delete `src/`, `Dockerfile.kuru`, `/kuru` dashboard routes, or tax/kuru pages. The dashboard may show the engine disconnected. That is correct.

Acceptance: default `docker compose up -d` does not start `kuru-app`. `GET http://localhost:3002/health` fails. `cb-app` and Postgres stay up. `data/` and `cb-pgdata` are untouched.

### 2. P1: Coinbase trades SOL-USD only

Pairs are config, not code (`cb/config.ts` `pairs`, env `CB_PAIRS`).

1. Set `CB_PAIRS=SOL-USD` in `.env` and `.env.example`.
2. Change the `list()` fallback in `cb/config.ts` to `"SOL-USD"`.
3. Recreate the Coinbase container so it reloads env (`docker compose up -d cb`). A restart is not enough. This **will** mint a new `run_id` because `cb/index.ts` calls `crypto.randomUUID()` at boot. That is expected. Do not try to reuse the old run.
4. Bankroll stays `CB_BANKROLL_USD=10000`. With one pair, the whole $10,000 allocates to SOL (`perPairBankroll = bankroll / pairs.length`). Clip stays `CB_NOTIONAL_USD=1000`. Do not silently shrink the bankroll.
5. Keep `CB_NEVER_CROSS_ENTRY=true`, hysteresis 0.60/0.40, `MODEL=jev`. Do not change fee bps in this ticket (item 5).

Open DOGE and TAO paper longs will be unmanaged after those pairs leave `config.pairs`. Do not `/reset` to clear them. They stay in Postgres for tax/history.

Acceptance: `cb-app` logs `pairs=SOL-USD`. Snapshot `GET http://localhost:3001/` `pairs` is `["SOL-USD"]`. Engine places no orders on DOGE/SUI/XRP/AVAX/TAO. SOL decisions continue. Postgres row counts for old pairs do not drop.

### 3. P1: Live report and /paper UI are SOL-only

`cb/report.ts` `buildReport` currently does:

```
const pairs = (await store.pairsWithDataForVenue("paper")).filter((p) => p !== "MON-USDC");
```

That will keep emitting DOGE/SUI/XRP/AVAX/TAO forever because they have fills. After item 2, filter to **intersection of venue data and `config.pairs`** (still drop MON-USDC). Gate, nextReads, and maker-fee sensitivity then describe the SOL campaign only.

Check the paper dashboard (`web/src/app/paper/page.tsx`, `usePaperFeed`) uses the snapshot `pairs` list from the engine, not every pair in history. After item 2 that list should already be SOL-only. If any client hardcodes the six names, stop.

Tax pages (`/tax`, `/tax/paper`) may still show historical pairs. Leave that. Tax is a ledger, not the live book.

Acceptance: `GET http://localhost:3001/report` `pairs.length === 1` and `pairs[0].pair === "SOL-USD"`. `/paper` shows one pair card. `/paper/report` totals are SOL only. `/tax/paper` still has the old pairs if they have fills.

### 4. P2: Docs and README match the stack

Update the operator docs so the next person does not start Kuru by habit:

- `README.md` engine table and `docker compose up -d --build` (now db + cb)
- `docs/DEPLOY.md` if it still says both engines
- `compose.yml` header comments
- `.env.example` `CB_PAIRS=SOL-USD`
- `web/.env.example` Kuru URL note: engine is optional / stopped
- `.claude/HUMAN-STEPS-KURU-PAPER.md`: first line, soak is stopped; no Kuru start script

Do not rewrite the tweet demo spec. Do not claim Kuru code is deleted.

Acceptance: a new clone following README starts Postgres + Coinbase paper only.

### 5. P2: Fee tier is a finance decision, not this ticket

`.env` is still `CB_MAKER_FEE_BPS=50` / `CB_TAKER_FEE_BPS=90`. The SOL 4h edge is still negative at that round trip. Do **not** change fees unless finance names the Advanced Trade tier in writing. When they do: set the two env vars, recreate `cb` only, do not reset the DB.

The gate n=200 clock is the new SOL-only run (item 2). Old n=31 does not carry over. Measure SOL to n=200 at whatever fee tier is configured.

### 6. P3: Incidents gate (hygiene, do not block SOL-only)

Still ~81 incidents/day, every pair, so `incidentsUnder1PerDay` is not a strategy signal. The 2026-09-19 work item stands: count only real feed defects (WS reconnects, heartbeat gaps, persistent divergence), scale the threshold to live spread. Do not hold the SOL soak for this. Ignore incidents when reading the promotion gate until it is fixed.

## After you ship

1. `docker compose ps` : `cb-postgres` and `cb-app` up; `kuru-app` absent or exited, not restarting.
2. `curl http://localhost:3001/health` ok. `curl http://localhost:3002/health` fails.
3. `bun run cb:report` prints one pair, SOL-USD.
4. Leave the SOL soak running. Do not babysit Kuru.

## How we will judge SOL

Promotion talk is only allowed if, on the SOL-only run, at the configured fee tier:

- 4h n >= 200
- Wilson lower bound > 52%
- net P and L > 0 (current-run MTM, not the all-fills cash hole)
- max drawdown < 15%

If net is still negative at a realistic fee tier, or Wilson is under 50% at n=200, the Coinbase strategy is done. There is no live step after a fail.
