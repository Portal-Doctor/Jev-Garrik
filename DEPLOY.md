# P6 paper on Vercel

Paper only. This process does not place orders, hold Coinbase API keys, or sign requests. Do not set `COINBASE_API_*`. The soak itself is Brian's deployment. Nothing in this repo deploys it.

The engine stays a library. Vercel runs it as a relay of 1,800 s Node functions. Redis is the book. The Marketplace vendor is not chosen: the client speaks Redis (`REDIS_URL`) through a `Kv` interface.

## Environment

| Name | Required | Purpose |
| --- | --- | --- |
| `CRON_SECRET` | yes | `Authorization: Bearer` on `/api/engine` and on `/p6`. The route checks this before it looks at `REDIS_URL`. A missing secret is 401, including when Redis is unset. Vercel Cron sends this. |
| `REDIS_URL` | yes | `rediss://` for any host other than localhost. `redis://` is only for `localhost`, `127.0.0.1`, or `::1`. Username and password are both sent when the URL has them. Commands time out after `REDIS_TIMEOUT_MS` (default 5s). Any Marketplace Redis. There is no gitignored store on Vercel. |
| `REDIS_TIMEOUT_MS` | | Command timeout in milliseconds. Default 5000. |
| `P6_PRODUCTS` | yes | Comma-separated product ids, including `BTC-USD`. At most 10 per socket. |
| `VERCEL_PROJECT` | | The Next app is `web/`. Set the project root to `web`. |

Do not set `COINBASE_API_KEY`, `COINBASE_API_SECRET`, or any other `COINBASE_API_*` name.

## Cron

`web/vercel.json` schedules `GET /api/engine` at minutes 1, 16, 31, and 46. The route is `web/src/app/api/engine/route.ts` with `runtime = "nodejs"` and `maxDuration = 1800`. Vercel Pro and the 1,800 s beta are required. Hobby is a no-go.

Each invocation warms from Redis, or from public REST when Redis has no snapshot. Daily, 1h, and 4h series are seeded from public REST or from research history so classes D and B are not cold. A 4h seed from REST 1h candles is flagged `seed_src=rest_1h`, and a product with fewer than 200 contiguous 4h bars is flagged short. EMA200 stays marked seeded until 200 of those bars have been built live. Redis keeps one connection and authenticates once. The overlap watcher reads the lease every 500 ms. There is no local store on Vercel. The next cron warms and subscribes while the current lease is still held, and only then takes the lease, so a normal handover is about 0s of feed gap. It samples until `getDeadline()` minus 60 s and releases the lease then, not at the start. The live lease key's TTL is 3 minutes. The 60 s heartbeat renews that TTL on its own, and only then writes `p6:hot` if the lease token still matches. A failed save does not drop the lease. A lost lease stops the holder, and a save whose token does not match does not write. A crash therefore drops the key within 3 minutes, and the overlap watcher can take over without waiting for the function deadline. The release checks the holder token. A socket closed at that deadline is not a gap on the next instance. A second fire of the same cron does not apply bars. One missed cron is still covered by the 1,800 s holder. A missed cron, a crash, and the handover itself are written onto the snapshot. A handover under 1 second is `handover_micro`, and excluded from the 1% gap cap, only when the incoming socket ran 60 seconds with no sequence hole, the buffer did not overflow, and the cut matches an exchange trade id (or time, price, and size). Sequence numbers are not compared across sockets. The weekly `handover_micro` count is still logged. A buffer overflow is an uncovered gap for that product and is counted per day. After an uncovered takeover the book is rebuilt from a REST level-2 snapshot and later updates resync on top, flagged until a live snapshot. The overlap buffer is capped. A final save that still fails inside the last 10 seconds releases with `save_failed` and is uncovered. The context files are read by module-relative path. There is no walk up to `.git`. The dashboard computes the V6 caps from those gaps, the vol hours, the D counts, and the weekly `handover_micro` count.

## Redis

Keys:

- `p6:hot` — book, guards, halts, cursors, and the feed cursor. Target under 256 KB. Written on the heartbeat and at a state change, only while the lease token matches. A failed write is an incident. A write over 256 KB is an incident and is not sent. No value over 1 MB is sent. Upstash's published caps (checked 2026-10-12) are a 10 MB request and a 100 MB record on Free and PAYG; this layout stays under both.
- `p6:bar15:{product}:{day}` — that UTC day's 15m bars, appended, 9-day TTL. 15m history in the book is 8 UTC days. A duplicate bar is a no-op.
- `p6:bar4h:{product}`, `p6:bar1h:{product}`, `p6:d1:{product}` — capped lists (220, 48, and 260), appended when the span closes from settled 15m bars. Clusters and betas read the daily series.
- `p6:ring1m:{product}`, `p6:tape:{product}:{minute}` — appended, 2-hour TTL. They are not part of the heartbeat payload.
- `p6:bar:{product}:{startSec}` — written once and never mutated. A repeated bar is a no-op.
- `p6:warmup:{product}` — that product's daily warmup. Each value stays under 1 MB. A failed warmup write does not skip bar appends. An old monolithic `p6:warmup` is read once if a product key is empty.
- `p6:lease` — holder, token, and expiry. `PX` is 3 minutes, renewed by the heartbeat, and the renew checks the token. A kill drops it inside that window. `saveFailed` is set when the final save could not be stored.
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
5. Jev packets are built from the 1m mid bars for every member plus BTC at each 15m close. A missing 1m bar skips those packets. Flag the week if more than 5% are skipped. The cumulative spend cap is $5 and the month cap is $100. Live Jev calls are not made from this build; Brian enters the key himself. D orders whose 120 s window touches a gap are indeterminate. Both show on that week's Jev and D stats.
6. The stale-feed kill (a gap over 2 minutes) and the 5% missing-1m kill stay as registered.
7. A deadline socket close must not add a gap by itself. A crash or two missed crons must.
8. If any week trips G0, stop. Vercel-only is a no-go. The always-on host remains the fallback.
