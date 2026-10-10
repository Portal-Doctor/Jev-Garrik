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
bun run research/src/cli.ts download
bun run research/src/cli.ts derive
bun run research/src/cli.ts coverage
bun run research/src/cli.ts seal-snapshot
bun run research/src/cli.ts p1-report
```

`download` resumes an in-progress manifest. A freeze that was applied before every USD product was stored is lifted and the reason is written to `snapshotLift`. A freeze with `universeComplete: true` stays frozen and download refuses to resume.

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
| `research/data/data-manifest.json` | yes | Per-file SHA-256, the root hash, and the freeze record |
| `research/data/derived/` | no | 1h, 4h, and daily bars derived from the stored candles |
| `research/data/reports/` | yes | Delisted probe, tick flags, coverage, P1 report |

Candle and derived files are gitignored. This snapshot's pair-month files were written under `research/data/candles/` on the download host and are not in git. `data-manifest.json` is the committed record of each path, byte size, and SHA-256. Recomputing the root hash requires those sqlite files.

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

Candles use `BAR_SEC` in `research/src/data/time.ts` (300 for five-minute, 900 for fifteen-minute). The window is 365 days ending at 00:00 UTC of the day the download started. Empty bars at that spacing are stored as empty. The exchange product payload has no listing timestamp. `effectiveListing` is the first nonempty bar inside the window and is not a listing-date decision.

The download covers every USD product in the snapshot, including delisted products that return candles, unless an owner decision recorded in `reports/owner-decision.json` cuts the universe. A 404 does not invent empty bars; that product is marked unavailable and the rest of its months are skipped.

Coverage leaves `listingDate` null. When a product has a nonempty candle, `effectiveListing` is `first available candle`. That flag is not a listing-date decision. The listing-date questions stay open.

## Snapshot

An earlier freeze of the partial 58-file download was lifted. Its root `67b8963191a52383657fff6bd6bc505327aa540fe4009de6d264e2c4cd2799d8` is the superseded hash recorded on `snapshotLift` until a completed download replaces it. Download start stays `createdAt` on the manifest. When every product has been processed, download seals `snapshot.status` as `frozen` with `universeComplete: true`, the final root hash, the download start, the last update, and the freeze timestamp. The same block is copied into `research/data/reports/p1-report.json`.
