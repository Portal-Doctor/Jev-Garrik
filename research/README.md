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
bun run research/src/cli.ts revision-sample
bun run research/src/cli.ts revision-check
```

`download` is resumable. Create `research/data/STOP` to finish the current request and exit. Delete that file before resuming.

## Where the data lives

| Path | In git | What |
|---|---|---|
| `research/data/products/exchange-products.raw.json` | yes | Exact exchange `/products` response bytes |
| `research/data/products/usd-spot.json` | yes | USD quote rows: status, base, quote, current `quote_increment`, listing date null |
| `research/data/candles/<PAIR>/<YYYY-MM>.sqlite` | no | One file per pair-month. Empty minutes are stored as empty |
| `research/data/data-manifest.json` | yes | Per-file SHA-256 and the root hash |
| `research/data/derived/` | no | 1h, 4h, and daily bars derived from the 1m files |
| `research/data/reports/` | yes | Delisted probe, tick flags, coverage, revision sample |

Candle and derived files are gitignored. Reproduce them with the commands above; do not expect them in the clone.

## Root hash

`dataRootHash` is the SHA-256 of the sorted file-hash list:

1. Take each canonical pair-month file `candles/<PAIR>/<YYYY-MM>.sqlite` (not `*.partial.sqlite`).
2. SHA-256 the file bytes.
3. Sort by relative path (`candles/AAA-USD/2023-10.sqlite` before `candles/AAA-USD/2023-11.sqlite`).
4. Hash the UTF-8 text formed by one line per file: `relativePath`, tab, hex sha256, newline.

The writer is version `1` (`research/src/data/store.ts`): bun:sqlite, `page_size` 4096, meta then minutes in timestamp order, then `VACUUM`. Two writes of the same minutes match byte for byte on the same bun version. This run uses bun 1.4.3. A different bun or SQLite build can change file bytes even when the minute rows match.

An independent re-download reproduces the root hash when it uses this writer on the same bun version, the same pair-month windows recorded in each file's `file_meta`, and the exchange returns the same candle tokens. `revision-check` re-fetches the recorded sample with those stored windows. It refuses to run until 24 hours after `research/data/reports/revision-sample.json` `createdAt`.

## Window

1-minute candles from 2023-10-01T00:00:00.000Z, or from a listing timestamp when one is supplied, through 00:00 UTC of the current day (the latest completed UTC day). The exchange product payload used here has no listing timestamp, so this run starts every product at 2023-10-01. The CLI does not invent one.
