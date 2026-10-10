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

Public exchange endpoints only. `RESEARCH_DATA_DIR` overrides the data directory (default `research/data`). `RESEARCH_REQUEST_INTERVAL_MS` defaults to 150.

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

`download` refuses to resume after `seal-snapshot`. The owner froze this download on 2026-10-10. Do not start it again against this manifest.

P1 task 9, the 24h revision check, was dropped by Brian on 2026-10-10 18:16 CT. `research/src/data/revision.ts` and its tests remain in the tree unused. The CLI names `revision-sample` and `revision-check` exit without fetching or writing a sample. The revision check is not an open item for the hash.

## Where the data lives

| Path | In git | What |
|---|---|---|
| `research/data/products/exchange-products.raw.json` | yes | Exact exchange `/products` response bytes |
| `research/data/products/usd-spot.json` | yes | USD quote rows: status, base, quote, current `quote_increment`, listing date null |
| `research/data/candles/<PAIR>/<YYYY-MM>.sqlite` | no | One file per pair-month. Empty minutes are stored as empty |
| `research/data/data-manifest.json` | yes | Per-file SHA-256, the root hash, and the freeze record |
| `research/data/derived/` | no | 1h, 4h, and daily bars derived from the 1m files |
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

1-minute candles from 2023-10-01T00:00:00.000Z through 00:00 UTC of the day the download ran (the latest completed UTC day). The exchange product payload has no listing timestamp, so this run did not start any product later than 2023-10-01.

The frozen root hash covers 58 complete pair-month files: `00-USD` from 2023-10 through 2026-10, and `1INCH-USD` from 2023-10 through 2025-06. An incomplete `1INCH-USD/2025-07.partial.sqlite` was left on the download host when the process stopped. It is not in the root hash. Coverage lists that month as incomplete. The other 490 USD products in the snapshot have no candle files.

## Snapshot freeze

`data-manifest.json` field `snapshot` records `downloadStartedAt`, `downloadUpdatedAt`, and `frozenAt`. The same block is copied into `research/data/reports/p1-report.json`.
