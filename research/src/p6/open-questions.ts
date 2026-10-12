/**
 * Points the locked P6 spec does not settle. The engine does not pick a rule for these.
 * Breadth option (c) is not in this list: the approved registration already made it report-only.
 */

export interface OpenQuestion {
  id: string;
  topic: string;
  note: string;
}

export const OPEN_QUESTIONS: readonly OpenQuestion[] = [
  {
    id: "amendment-1",
    topic: "Which attached file is amendment 1",
    note: "None of the four attached notes is amendment 1. The approved registration cites research/data/reports/p4-amendment-1.json (e0948e26). This turn did not treat an attachment as that amendment.",
  },
  {
    id: "ws-host",
    topic: "Public WebSocket host",
    note: "The spec asks for the live Coinbase public WebSocket for 1m candles, L2, and trades, and does not name the host. The client targets wss://advanced-trade-ws.coinbase.com because that public socket has candles, level2, and market_trades without credentials. REST backfill stays on api.exchange.coinbase.com, which has no candle channel.",
  },
  {
    id: "wilson",
    topic: "Wilson lower bound",
    note: "The v3.1 package does not define the successes or the z for a Wilson bound. The forward review leaves it unset. The cb accuracy gate is not used.",
  },
  {
    id: "cost-drag",
    topic: "Cost drag",
    note: "The v3.1 package does not define cost drag. The forward review leaves it unset.",
  },
  {
    id: "break-even",
    topic: "Payoff-implied break-even",
    note: "1e asks for hit rate versus the payoff-implied break-even and does not give the formula. Hit rate is reported. The break-even figure is unset.",
  },
  {
    id: "quantile",
    topic: "Trailing percentile index",
    note: "3a uses the 95th percentile and 3b the 99th. The package does not name the quantile type. empiricalQuantile uses index ceil(p * n) - 1. That index is not a registered rule.",
  },
  {
    id: "placebo-seed",
    topic: "Random-exit placebo seed",
    note: "The placebo draws only from bars at or below +1R. The production seed is not specified, so the draw takes an injected RNG.",
  },
  {
    id: "guard-p",
    topic: "Jev guard p-values",
    note: "A stream with n < 30 enters at p = 1. What counts as n for 3a and 3b is not specified, so the family of 2 is reported at p = 1.",
  },
  {
    id: "gap-share",
    topic: "Indeterminate share denominator",
    note: "A share above 10 percent is flagged. The denominator is not spelled out. The flag uses resolved X2/X3 orders (filled or indeterminate), which excludes class D no-fills and orders still working.",
  },
  {
    id: "live-tape",
    topic: "Historical tape for parity",
    note: "This checkout has no 1m candle store. Turn 1 replays synthetic days through the P5 signal functions. A trade-for-trade replay of exchange days waits on that store.",
  },
];
