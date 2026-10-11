# research

Paper-only research code for build plan v3. `cb/` is not part of this tree.

## Tests

From the repo root:

```
bun test research
bunx tsc --noEmit -p research/tsconfig.json
```

## Start guard

`bun run research/src/index.ts` refuses to start when an order-capable credential is set (`COINBASE_API_*`, `COINBASE_KEY`, `COINBASE_SECRET`, `COINBASE_PASSPHRASE`, `CDP_API_*`, `CDP_PROJECT_ID`, `EXCHANGE_API_*`). It prints `no order-capable credential` and exits 0 when none of those are set.

`TYPESAFE_AI_API_KEY` is not read in P0 or P1.

## Commands

Public exchange endpoints only. `RESEARCH_DATA_DIR` overrides the data directory (default `research/data`). Download uses `RESEARCH_REQUEST_INTERVAL_MS` (default 100) and `RESEARCH_DOWNLOAD_CONCURRENCY` (default 10). Probe and other commands that take the interval use the same variable, and probe still defaults to 100 when it is unset.

```
bun run research/src/cli.ts snapshot
bun run research/src/cli.ts probe
bun run research/src/cli.ts ticks
bun run research/src/cli.ts stats-fetch
bun run research/src/cli.ts stats-convert
bun run research/src/cli.ts universe-cut
bun run research/src/cli.ts download
bun run research/src/cli.ts derive
bun run research/src/cli.ts coverage
bun run research/src/cli.ts seal-snapshot
bun run research/src/cli.ts p1-report
bun run research/src/cli.ts refresh-reports
```

Stamping reads `HEAD` only when `git status --porcelain` is empty. A dirty tree refuses the stamp.

`stats-fetch` writes `reports/product-stats.json` (raw response bodies plus `fetchedAt`). It refuses to replace an existing file unless `RESEARCH_STATS_REFETCH=1`. This freeze does not re-fetch. `stats-convert` wraps the original bare array in that envelope without inventing wire bytes. `universe-cut` reads that file and writes `reports/owner-decision.json`.

`download` resumes an in-progress manifest. A completed freeze stays frozen unless `RESEARCH_LIFT_COMPLETED_FREEZE=1`, which records the previous root on `snapshotLift` and keeps the earlier lift on `priorSnapshotLift`. The lift used for the 56-name add-back pins the window clock at `2026-10-11T12:00:00.000Z`.

Public candle requests stay at or under Coinbase's sustained public limit of 10 requests per second per IP (`RESEARCH_REQUEST_INTERVAL_MS` defaults to 100). `RESEARCH_DOWNLOAD_CONCURRENCY` defaults to 10 so that many requests can be in flight without raising the start rate. Each request aborts after 20 seconds and retries. Remove `research/data/STOP` before resuming. The candle files under `research/data/candles/` have to still be on this machine; the manifest records their hashes and does not contain the bytes.

```
bun run research/src/cli.ts download
```

P1 task 9, the 24h revision check, was dropped by Brian on 2026-10-10 18:16 CT. `research/src/data/revision.ts` and its tests remain in the tree unused. The CLI names `revision-sample` and `revision-check` exit without fetching or writing a sample. The revision check is not an open item for the hash.

## Where the data lives

| Path | In git | What |
|---|---|---|
| `research/data/products/exchange-products.raw.json` | yes | Exact exchange `/products` response bytes |
| `research/data/products/usd-spot.json` | yes | USD quote rows: status, base, quote, current `quote_increment`, listing date null |
| `research/data/candles/<PAIR>/<YYYY-MM>.sqlite` | no | One file per pair-month. Empty bars are stored as empty |
| `research/data/data-manifest.json` | yes | Per-file SHA-256, the candle root hash, the freeze record, and a pointer to the derived manifest |
| `research/data/derived-manifest.json` | yes | Per-file SHA-256 and the root hash of the 1h, 4h, and daily files |
| `research/data/derived/` | no | 1h, 4h, and daily bars derived from the stored candles |
| `research/data/reports/` | yes | Product stats, owner decision, delisted probe, tick flags, coverage, P1 report |

Candle and derived files are gitignored by `research/.gitignore`. The pair-month files live on the download host and are not in git. `data-manifest.json` records each candle path, byte size, and SHA-256. `derived-manifest.json` does the same for derived bars. The candle root hash does not include derived files. Recomputing either hash needs those files on disk.

## Root hash

`dataRootHash` is the SHA-256 of the sorted file-hash list:

1. Take each canonical pair-month file `candles/<PAIR>/<YYYY-MM>.sqlite` (not `*.partial.sqlite`).
2. SHA-256 the file bytes.
3. Sort by relative path (`candles/AAA-USD/2023-10.sqlite` before `candles/AAA-USD/2023-11.sqlite`).
4. Hash the UTF-8 text formed by one line per file: `relativePath`, tab, hex sha256, newline.

The writer is version `1` (`research/src/data/store.ts`): bun:sqlite, `page_size` 4096, meta then minutes in timestamp order, then `VACUUM`. Two writes of the same minutes match byte for byte on bun 1.4.3, which produced this snapshot. A different bun or SQLite build can change file bytes even when the minute rows match.

To recompute the root hash from the candle files named in `data-manifest.json`:

```
python3 - << 'PY'
import hashlib, pathlib
root = pathlib.Path("research/data")
manifest = __import__("json").loads((root / "data-manifest.json").read_text())
lines = "".join(f"{item['path']}\t{hashlib.sha256((root / item['path']).read_bytes()).hexdigest()}\n" for item in sorted(manifest["files"], key=lambda item: item["path"]))
print(hashlib.sha256(lines.encode()).hexdigest())
print(manifest["dataRootHash"])
PY
```

That checks the files on disk against the frozen manifest. It does not re-download.

## Window

Candles use `BAR_SEC` in `research/src/data/time.ts`. This snapshot is fifteen-minute bars (`900`). The window is 365 days ending at 00:00 UTC of the latest completed day. Empty bars at that spacing are stored as empty. The exchange product payload has no listing timestamp. `effectiveListing` is the first nonempty bar inside the window and is not a listing-date decision.

The download covers every USD product in the snapshot, including delisted products that return candles, unless an owner decision recorded in `reports/owner-decision.json` cuts the universe. A 404 does not invent empty bars; that product is marked unavailable and the rest of its months are skipped. Coverage `expectedMinutes` and `storedMinutes` count bars at the file's `granularity_sec`, and `pctNonempty` is the share of those bars that have a price.

Coverage leaves `listingDate` null. When a product has a nonempty candle, `effectiveListing` is `first available candle`. That flag is not a listing-date decision. The listing-date questions stay open.

## Snapshot

An earlier freeze of the partial 58-file 1-minute download was lifted. Its root `67b8963191a52383657fff6bd6bc505327aa540fe4009de6d264e2c4cd2799d8` stays on `snapshotLift` as the superseded hash. The frozen snapshot is one year of fifteen-minute candles for the USD names kept by the owner rule in `reports/owner-decision.json`. Download start stays `createdAt` on the manifest. The seal sets `snapshot.status` to `frozen` with `universeComplete: true`, the final root hash, the download start, the last update, and the freeze timestamp. The same block is copied into `research/data/reports/p1-report.json`.
