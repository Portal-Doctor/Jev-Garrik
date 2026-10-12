/**
 * Points the locked spec still does not settle. Amendment 2 closed the report
 * definitions. The engine does not invent a rule for what remains.
 */

export interface OpenQuestion {
  id: string;
  topic: string;
  note: string;
}

export const CLOSED_QUESTIONS: readonly OpenQuestion[] = [
  {
    id: "amendment-1",
    topic: "Which file is amendment 1",
    note: "Confirmed: research/data/reports/p4-amendment-1.json, sha256 e0948e26f2bbe2ec7c113d23db8b4dbb9daed70a9d2cef0e3f0a0c49f70d7760, approved by Brian at 2026-10-11T19:45:00Z.",
  },
  {
    id: "wilson",
    topic: "Wilson lower bound",
    note: "Amendment 2 M1. One-sided z 0.8416 and 1.645. Success is net R > 0.",
  },
  {
    id: "cost-drag",
    topic: "Cost drag",
    note: "Amendment 2 M2 and the joint resolution. Arrival mid for entries and rule exits. Stop price for stops. Inference is outside cost.",
  },
  {
    id: "break-even",
    topic: "Payoff-implied break-even",
    note: "Amendment 2 M3. p* = |L| / (W + |L|).",
  },
  {
    id: "quantile",
    topic: "Percentile index",
    note: "Amendment 2 M4. percentileLinear, Hyndman-Fan type 7.",
  },
  {
    id: "placebo-seed",
    topic: "Placebo and bootstrap seeds",
    note: "Amendment 2 M5. Master 4109854067 from the approved registration sha, then SHA-256 sub-seeds.",
  },
  {
    id: "guard-p",
    topic: "Jev guard p-values",
    note: "Amendment 2 M6. n is trigger events for 3a and paused-entry candidates for 3b. n < 30 enters at p = 1.",
  },
  {
    id: "gap-share",
    topic: "Indeterminate share",
    note: "Amendment 2 M7. Denominator is every submitted order in the class, including indeterminate. D's count is always reported.",
  },
  {
    id: "rearm",
    topic: "10R pause re-arm",
    note: "Confirmed in amendment 2. The forward book uses stepClassPause. It is not a flag.",
  },
];

export const OPEN_QUESTIONS: readonly OpenQuestion[] = [
  {
    id: "rest-settle",
    topic: "REST 15-minute settle delay",
    note: "Architect said a short settle delay and did not give seconds. strategyFetchAt takes the delay as an argument.",
  },
  {
    id: "s-live",
    topic: "How s_live is taken from the L2 snapshot",
    note: "The registration names the snapshot and not the transform. The engine uses the raw bid-ask spread in bps. Half-spread and the historical cap are not applied.",
  },
  {
    id: "d-round-trip",
    topic: "Class D round-trip cost",
    note: "D is sized with the maker fee, not 190 bps taker. Whether the taker exit leg is added to that cost is not specified.",
  },
  {
    id: "forward-bankroll",
    topic: "Bankroll for half-Kelly dollars",
    note: "Risk after promotion is the capped fraction times a bankroll. The forward bankroll is not specified. Callers pass bankrollUsd.",
  },
  {
    id: "default-13",
    topic: "Architect's '(default 13)'",
    note: "The phrase is ambiguous. It is the named parameter default13Usd. The size does not read it. Resolved default 13 is a different sentence and was not used to guess this one.",
  },
  {
    id: "l2-shard",
    topic: "Level2 products per socket",
    note: "The exchange limit is not specified. shardProducts takes the size as an argument.",
  },
  {
    id: "live-tape",
    topic: "Historical tape for a real-day replay",
    note: "This checkout has no 1m candle store. The forward engine replays injected events. An exchange-day replay is still outstanding.",
  },
];
