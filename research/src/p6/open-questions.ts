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
    id: "live-tape",
    topic: "Historical tape for a real-day replay",
    note: "This checkout has no 1m candle store. The forward engine replays injected events. An exchange-day replay is still outstanding.",
  },
  {
    id: "at-product-cap",
    topic: "Advanced Trade products per subscribe message",
    note: "Architect capped a socket at 10 products. The public Advanced Trade pages do not publish a products-per-message maximum. The Exchange limit of 10 is subscriptions per product per channel, and one subscribe per product per channel stays inside it.",
  },
];
