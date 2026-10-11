/**
 * The 18 pre-hash defaults, after the architect rulings.
 * Corrections replace the earlier question text. Ratified items keep their meaning.
 */

export interface ResolvedDefault {
  id: number;
  status: "ratified" | "corrected";
  text: string;
}

export const RESOLVED_DEFAULTS: readonly ResolvedDefault[] = [
  { id: 1, status: "corrected", text: "The 30-day sub-1R exit fills at the next 00:00 UTC open minus s_bt." },
  { id: 2, status: "ratified", text: "The 10-day exit's next open is the 15m bar that opens at 00:00 UTC." },
  { id: 3, status: "ratified", text: "B's signal is the Sunday-dated daily bar that closes Monday 00:00. The entry is Monday 01:00." },
  { id: 4, status: "corrected", text: "B's held-set exit fills at the Monday 01:00 open minus s_bt." },
  { id: 5, status: "ratified", text: "A's 10-day exit is first evaluated at the first daily close after the entry date. The lookback still uses the prior 10 daily closes, including days before the entry." },
  { id: 6, status: "corrected", text: "Beta-weighted notional is the sum of max(beta, 0) times notional. A negative beta does not offset long exposure." },
  { id: 7, status: "corrected", text: "A name with fewer than 60 return days takes that month's highest signed member beta. If no member has a beta, the fallback is 1. The cap is never skipped." },
  { id: 8, status: "ratified", text: "After the stop moves, exit cost is one taker leg, 90 plus s_bt, on units times the current stop." },
  { id: 9, status: "corrected", text: "The $1,200 class backstop is the drawdown from the class peak cumulative net dollars, alongside the 20R kill." },
  { id: 10, status: "ratified", text: "The pair backstop is that pair's equity, realized net plus the open mark, at or below -$500." },
  { id: 11, status: "ratified", text: "Daily and weekly halt losses are the drop from equity at the UTC day start and at Monday 00:00." },
  { id: 12, status: "ratified", text: "Average linkage merges two clusters only when every member pair has a 60-day rho and the mean is at least 0.80. An equal mean merges the lexicographically earliest pair of cluster ids." },
  { id: 13, status: "ratified", text: "The $20 paper minimum applies to a null or non-positive lower-80% Kelly bound. A small positive fraction may size below $20." },
  { id: 14, status: "corrected", text: "Pauses may shrink a class to $20 and, for 2b, block new entries. The 1d kill, the 20R kill, and the dollar backstops stop the class at any size. Flag-only at $20 applies to pauses only. Breadth does not resize or block." },
  { id: 15, status: "corrected", text: "SPRT is report-only. Wald bounds are plus or minus ln 4. H0 is +0.25R and H1 is 0. The realized-sigma path and the 1.5R path are both reported. It never acts." },
  { id: 16, status: "ratified", text: "The 2b block is 14 calendar dates beginning on the condition date." },
  { id: 17, status: "ratified", text: "G2 concurrency is measured in the post-hash rerun. The pre-hash field stays empty." },
  { id: 18, status: "ratified", text: "Breadth state uses entry-day membership, the prior close, and hysteresis. It starts off. A share from 25 percent through 35 percent keeps the prior state. Option (c) logs the state and does not use it." },
];
