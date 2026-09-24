# Running the Coinbase paper trader

The trading engine (`cb/`) is an always-on, stateful process: a 24/7 outbound Coinbase
WebSocket, in-memory order books, `setInterval` decide/resolve/snapshot loops, and a
long-lived SSE stream. That rules out serverless — it runs as a **local Docker container**
alongside Postgres. The `/paper` dashboard is a plain Next.js app you start on demand.

| Component | Where | Notes |
|---|---|---|
| `cb/` backend | **Local Docker** (`cb-app`) | `restart: unless-stopped`; SOL-USD paper. Rebuilds books from the feed on start. |
| Postgres | **Local Docker** (`cb-postgres`) | Data in the named volume `cb-pgdata`. |
| `web/` dashboard | **On demand** (`bun run dev`) | Viewer only; reads `NEXT_PUBLIC_PAPER_API_URL`. |

## Prerequisites

- Docker Desktop, with **Settings → General → "Start Docker Desktop when you sign in"** enabled
  so the stack returns after a reboot.
- Root `.env` with at least `MODEL=jev` and `AI_GATEWAY_API_KEY=…` (Vercel AI Gateway key).
  `compose.yml` overrides `DATABASE_URL` and `PORT` for the container automatically.

## Start / build

```powershell
docker compose up -d --build     # build the cb image + start DB and Coinbase backend
docker compose logs -f cb        # watch it boot: expect model=typesafe-ai/jev, "synced":true
```

Default compose is Postgres + Coinbase paper.

cb and db use `restart: unless-stopped`, so they auto-restart on crash and return after a
reboot (given Docker Desktop autostart). The schema is applied on boot by `store.init()`.

## View the dashboard (on demand)

```powershell
cd web
bun run dev
# open http://localhost:3000/paper
```

## Everyday operations

| Task | Command |
|---|---|
| Follow engine logs | `docker compose logs -f cb` |
| Restart just the backend | `docker compose restart cb` |
| Apply a code change | `docker compose up -d --build` |
| Check status | `docker compose ps` |

## Safe shutdown for maintenance

Paper-trading state is safe to interrupt: decisions, fills, and outcomes are persisted to
Postgres as they occur, the resolver is restart-idempotent, and order books rebuild from the
feed on restart. There is nothing to flush at the app layer.

1. (Optional, before risky maintenance) back up the database:
   ```powershell
   docker exec cb-postgres pg_dump -U cb -d cb -Fc -f /tmp/cb.dump
   docker cp cb-postgres:/tmp/cb.dump ".\cb-backup-$(Get-Date -Format yyyyMMdd-HHmm).dump"
   ```
2. Graceful stop (stops `cb-app` first, then `cb-postgres`, automatically):
   ```powershell
   docker compose stop
   ```
3. Do the maintenance (host reboot, Docker update, Postgres image bump, etc.).
4. Bring it back:
   ```powershell
   docker compose up -d
   docker compose logs -f cb        # confirm "synced":true and decisions flowing
   ```

Restore a backup into a fresh volume (only if needed):
```powershell
docker cp ".\cb-backup-<stamp>.dump" cb-postgres:/tmp/restore.dump
docker exec cb-postgres pg_restore -U cb -d cb --clean --if-exists /tmp/restore.dump
```

- `docker compose down` removes the containers but **keeps** the `cb-pgdata` volume; `up -d` recreates them.
- `docker compose down -v` **wipes all trading data** — only use it for a deliberate clean baseline.

## Notes

- `MODEL=jev` runs real inferences continuously (one SOL-USD decision every 300s) — a small
  but ongoing gateway cost while the stack is up.
- Production cadence is 300s decide / 4h horizon, so promotion-gate metrics need **days** of data
  before they mean anything.

---

## Appendix: cloud hosting (not used, kept for reference)

If you ever move off local Docker, the same split applies: the backend needs an always-on host
(Railway/Fly/Render) using `Dockerfile.cb`, and the dashboard deploys to Vercel with
**Root Directory = `web`** and `NEXT_PUBLIC_PAPER_API_URL` pointed at the backend's public URL.
Do not set `PORT`/`CB_PORT` on hosts that inject `PORT`; the config binds it automatically.
