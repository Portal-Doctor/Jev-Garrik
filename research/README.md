# research

Paper-only research code for build plan v3. `cb/` is not part of this tree.

## Tests

From the repo root:

```
bun test research
```

Type check:

```
bunx tsc --noEmit -p research/tsconfig.json
```

## Start guard

`bun run research/src/index.ts` refuses to start when an order-capable credential is set (`COINBASE_API_*`, `COINBASE_KEY`, `COINBASE_SECRET`, `COINBASE_PASSPHRASE`, `CDP_API_*`, `CDP_PROJECT_ID`, `EXCHANGE_API_*`). It prints `no order-capable credential` and exits 0 when none of those are set.

`TYPESAFE_AI_API_KEY` is not read in P0 or P1.

## Artifact stamp

Every artifact records `commitSha`, `dataRootHash` (null until the candle manifest exists), `createdAt` (UTC), and `phaseId`.
