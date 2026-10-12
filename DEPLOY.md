# P6 paper on Vercel

Paper only. This process does not place orders, hold Coinbase API keys, or sign requests. Do not set `COINBASE_API_*`. The soak itself is Brian's deployment. Nothing in this repo deploys it.

The engine stays a library. Vercel runs it as a relay of 1,800 s Node functions. Redis is the book. The Marketplace vendor is not chosen: the client speaks Redis (`REDIS_URL`) through a `Kv` interface.

## Environment

| Name | Required | Purpose |
| --- | --- | --- |
| `CRON_SECRET` | yes | `Authorization: Bearer` on `/api/engine` and on `/p6`. The route checks this before it looks at `REDIS_URL`. A missing secret is 401, including when Redis is unset. Vercel Cron sends this. |
| `REDIS_URL` | yes | `redis://` or `rediss://`. Username and password are both sent when the URL has them. Commands time out after `REDIS_TIMEOUT_MS` (default 5s). Any Marketplace Redis. There is no gitignored store on Vercel. |
| `REDIS_TIMEOUT_MS` | | Command timeout in milliseconds. Default 5000. |
| `P6_PRODUCTS` | yes | Comma-separated product ids, including `BTC-USD`. At most 10 per socket. |
| `VERCEL_PROJECT` | | The Next app is `web/`. Set the project root to `web`. |

Do not set `COINBASE_API_KEY`, `COINBASE_API_SECRET`, or any other `COINBASE_API_*` name.

## Cron

`web/vercel.json` schedules `GET /api/engine` at minutes 1, 16, 31, and 46. The route is `web/src/app/api/engine/route.ts` with `runtime = "nodejs"` and `maxDuration = 1800`. Vercel Pro and the 1,800 s beta are required. Hobby is a no-go.

Each invocation warms from Redis, or from public REST when Redis has no snapshot. Daily candles and 1h candles are fetched into Redis. There is no local store on Vercel. The next cron warms and subscribes while the current lease is still held, and only then takes the lease, so a normal handover is about 0s of feed gap. It samples until `getDeadline()` minus 60 s and releases the lease then, not at the start. The lease is `SET` with `NX` and `PX` through a compare-and-swap, and the release checks the holder token. A socket closed at that deadline is not a gap on the next instance. A second fire of the same cron does not apply bars. One missed cron is still covered by the 1,800 s holder. A missed cron, a crash, and the handover itself are written onto the snapshot. The dashboard computes the V6 caps from those gaps, the vol hours, and the D submitted and indeterminate counts.

## Redis

Keys:

- `p6:state` — latest snapshot (book, orders, 15m bars, B weeks, mid rings, trade tape, cursors, Jev counts).
- `p6:bar:{product}:{startSec}` — written once. A repeated bar is a no-op.
- `p6:lease` — holder, token, and expiry. `PX` drops it if the function is killed. The release record has no TTL.
- `p6:lease-meta` — the same record, kept after the live key expires, so a crash is still visible.
- `p6:cron` — last cron timestamp, used to tell a covered miss from an uncovered one.

## Dashboard

`web/src/app/p6/page.tsx` is read only. There is no write and no reset. `/p6` and `GET /api/engine?read=1` both require `Authorization: Bearer $CRON_SECRET`. Without it the dashboard is 401 and does not read Redis. The JSON view returns positions, gates, G0, the lease holder, incidents, and the V6 gap caps computed from the snapshot.

## Seven-day soak

Run this on Brian's deployment after the function is live. Do not start it from this repo.

1. Confirm Pro, the 1,800 s beta, the cron above, and a Redis URL. Confirm no `COINBASE_API_*` value is set.
2. Note the start time. The soak is at least 7 days.
3. Each week, read the dashboard. G0 means that week is no-go.
4. Caps, unchanged from V6: at most 1% of the week gapped; no single gap over 15 minutes; no-go if the gap rate in top-decile realized-vol hours is more than twice the overall rate.
5. Jev packets with a missing 1m bar are skipped and count as indeterminate. Flag the week if more than 5% are skipped. D orders whose 120 s window touches a gap are indeterminate. Both show on that week's Jev and D stats.
6. The stale-feed kill (a gap over 2 minutes) and the 5% missing-1m kill stay as registered.
7. A deadline socket close must not add a gap by itself. A crash or two missed crons must.
8. If any week trips G0, stop. Vercel-only is a no-go. The always-on host remains the fallback.
