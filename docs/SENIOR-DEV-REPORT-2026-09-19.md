# Senior Dev Report: Paper-Trading P&L Findings and Requested Changes

Date: 2026-09-19
From: Finance review of the cb/ paper-trading campaign (see `.claude/PL-REVENUE-REVIEW.md` and
`.claude/PL-REVENUE-REVIEW-FOLLOWUP.md` for the full P&L analysis)
Audience: Senior dev. This document is the engineering work order distilled from those reviews:
what to change, where, why, and how we will know it worked.

## Context in three sentences

The paper book loses money almost entirely through simulated fees: at the 21:04 UTC snapshot,
equity was $9,866.51 on a $10,000 bankroll, with $111 of the -$133 realized P&L being fees. The
model shows real directional signal on at least one pair (DOGE 1h accuracy 72.4%, Wilson lower
bound 54.3%, n=29) but the 140 bps round-trip fee assumption and taker fallbacks destroy it.
Nothing can be promoted to live until the promotion gate is winnable, and today it is not, for a
reason that is a code defect rather than a strategy failure (item 1).

## Work items, in priority order

### 1. P1: The incidents gate criterion is unpassable (bug, `cb/feed.ts`)

The gate requires feed incidents < 1/day (`docs/SPEC-COINBASE.md` section 9, criterion 5). The
only incrementer of `Feed.incidents` is `checkDivergence()` (`cb/feed.ts` ~line 432): once a
minute it compares the local WS book mid against the REST snapshot mid and flags any divergence
over a fixed `DIVERGENCE_BPS = 5`. On volatile, wide-spread pairs (SUI especially) ordinary
timing skew between the two samples exceeds 5 bps routinely. Measured today: **~528
incidents/day**, so `incidentsUnder1PerDay` is false for every pair, forever, regardless of
trading performance.

The spec intended this check as a "feed bug detector". Requested change:

- Count toward `incidents` only signals that indicate an actual feed defect:
  - WS reconnects and heartbeat-gap forced reconnects (already detected in `Feed`, currently not
    counted),
  - book resyncs outside of startup,
  - divergence that **persists across two consecutive checks of the same pair** (a genuinely
    stale book stays diverged; timing skew does not).
- Scale the divergence threshold to the pair's live spread, e.g. `max(5 bps, 2 x current spread)`,
  instead of the fixed 5 bps.
- Keep logging one-off divergences (they are useful diagnostics), just do not count them.

Acceptance: over a 24h soak with healthy feeds, `incidentsPerDay` in `/report` is well under 1;
pulling the network cable / killing the WS still produces incidents.

### 2. P1: Run the harness at the fee tier we would actually trade (config decision)

`.env` still carries `CB_MAKER_FEE_BPS=50` / `CB_TAKER_FEE_BPS=90` (worst-case public tier).
Every P&L number, edge calculation, and the gate's net>0 criterion is computed against a 140 bps
round trip we would not pay in practice. The report's maker-fee sensitivity grid exists precisely
to inform this. Action: agree the realistic tier with finance, set the two env vars, restart.
One line, but it changes every downstream number, so do it before any long measurement window.

### 3. P2: Act on the taker-fallback instrumentation (`CB_NEVER_CROSS_ENTRY`)

Now measured (today's campaign): **8 of 18 orders (44%) taker-converted after the 120s entry
timeout, and taker fills carry 43% of all fees ($47.56 of $111) despite being ~5% of fill count.**
A missed entry costs nothing; a taker entry costs roughly the entire per-trade edge. The
`neverCrossEntry` policy is already implemented in `cb/paper.ts` (exits still always
taker-convert, which is correct for measurement integrity). Action: set
`CB_NEVER_CROSS_ENTRY=true` and re-measure taker fill share and net P&L for a week.

### 4. P2: Distinguish "pending" from zero in horizon metrics

Fixed on the dashboard already (renders "—" when n=0) and the new `nextReads` countdown shipped
today covers the "when will data arrive" question. Remaining nit: the CLI report
(`bun run cb:report`) still prints literal zeros for unresolved horizons, which is how today's
"are Accuracy/Wilson/Brier/Edge even calculated?" confusion started. Print "pending" when n=0.

### 5. P3: Bench XRP once the 4h horizon confirms (config, needs data first)

XRP is at 23.1% 1h accuracy this campaign (n=26) after 35% in the previous one - consistently
inverted, paying fees for the privilege. Do not act yet: the traded horizon is 4h and its first
outcomes only began resolving at ~21:23 UTC today. If the 4h data confirms (n >= 200,
Wilson upper bound below 50%), remove XRP-USD from `CB_PAIRS` and let its bankroll slice flow to
the remaining pairs automatically (allocation is `bankroll / pairs.length`).

### 6. P3: Prerequisites for any future live promotion (new code)

Neither a kill switch nor a daily loss limit exists in `cb/`. Both are hard prerequisites for
M5/live per the reviews, and both belong in the broker layer where fills and equity are already
tracked. Scope: a config-driven max daily realized loss per pair and global, which flattens
positions and halts intents when breached, plus an admin endpoint to halt/resume. No urgency
until the gate is winnable (items 1-2), but do not let live work start without them.

## Shipped today (already in main, container rebuilt, run `0cf18b21`)

- **Next-read countdown**: `Store.earliestUnresolvedTs()` (`cb/db/store.ts`), `nextReads` on the
  `/report` payload (`cb/report.ts`), `fmtNextRead()` helper, dashboard stats on
  `web/src/app/paper/report/page.tsx`, CLI line. Answers "when does the next 4h/24h read land".
- **Two pairs added** for volatility and sector diversity: AVAX-USD (high-beta L1, ~$27M daily
  volume) and TAO-USD (AI sector, structurally volatile, ~$20M daily volume), selected from the
  live Coinbase products feed ranked by 24h move with a $5M volume floor. Updated `.env`,
  `.env.example`, `cb/config.ts` default, README. Per-pair bankroll is now $1,666.67; the $1,000
  clip still fits (one open position per pair, unchanged behavior).
- Test suite green: 38 pass, 0 fail.

## What finance will watch

1. Fees as a percent of gross edge (today >100%; target <50%).
2. 4h-horizon accuracy per pair once n grows (first read landed ~21:23 UTC today; n >= 200 needs
   roughly a day of uptime per pair).
3. Taker fill share after item 3 flips on.
4. Gate status per pair once item 1 makes the incidents criterion meaningful.
