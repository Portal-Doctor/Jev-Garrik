# Forward paper (holdout v2)

Paper only. Jev stays at stage 0. The process does not read `COINBASE_API_*` and does not place orders. Postgres is not required.

`SWING_APPROVED` in `paperday/src/config.ts` stays `false`. Brian approved the swing exceptions (48h max hold, $500 overnight cap; 96h is a swing_4h search hold only). The launch turns that approval on for this process.

The 30-day clock starts when the command below is run on the home PC. It does not start in the cloud VM. A second start finds `paperday/results/holdout-v2-clock.json` and exits.

From the repo root, after downloading this branch:

```bash
PAPERDAY_SWING_APPROVED=true PAPERDAY_FORWARD_CONFIRM=1 bun run paperday/src/forward-paper.ts
```

Dry run, no clock, no network:

```bash
bun run paperday/src/forward-paper.ts --dry-run
```

The frozen config is `paperday/results/holdout-v2.json`. If that file has no selected config, the command exits and does not write a start time. Status during the run is `paperday/results/forward-status.json`.
