/**
 * Items the v3.1 delta does not settle. Each one stays on the default named here.
 * They are questions, not tuning choices.
 */
export const OPEN_QUESTIONS = [
  "F2 restates the 10-day exit only. The 30-day sub-1R exit still fills at that day's last 15m close.",
  "The 10-day exit's next open is the 15m bar that opens at the daily close timestamp, 00:00 UTC, rather than the 00:15 bar.",
  "Daily bars in this store are dated by their open. F7's Monday 00:00 close is the Sunday-dated bar, and the entry is Monday 01:00. The Monday-dated bar closes Tuesday 00:00 and is not the signal.",
  "F7 does not restate B's exit. Leaving the held set still fills at the rebalance close, the 15m close at the next Monday 00:00, rather than at Monday 01:00.",
  "A's 10-day exit still ignores daily bars dated on or before the entry calendar date. With the 01:00 entry, that bar's close is the next midnight.",
  "OLS beta is signed. It is not the absolute value and it is not floored at 0.",
  "A name with fewer than 60 return days takes that month's highest signed member beta. If no member has a beta, the cap is not applied to that name and the name is not treated as beta 0.",
  "After the stop moves, exit cost is one taker leg, 90 plus s_bt, on units times the last close. It is not the round-trip C, and the entry price in that formula is the entry fill.",
  "The $1,200 class backstop is cumulative class net dollars at or below -1200. The 20R kill is the drawdown from the peak of the class cumulative net R. The dollar backstop is not itself a peak drawdown.",
  "The pair backstop is that pair's equity, realized net plus open mark, at or below -$500. It is not a drawdown from the pair's own peak.",
  "Daily and weekly halt losses are the drop from equity at the UTC day start and at Monday 00:00 week start. They are not measured from an intraday trough.",
  "Average linkage merges two clusters only when every member pair has a 60-day rho and the mean is at least 0.80. An equal mean merges the lexicographically earliest pair of cluster ids.",
  "A positive Kelly fraction is not raised to $20. Only a null fraction, or a non-positive bankroll, returns the $20 paper minimum.",
  "1b and 1c shrink a class to $20 and still allow entries. 2a and 2b shrink to $20 and block new entries. Overlapping pauses stay at $20. A class already at $20 is left there by 1b, 1c, and the forward A/B kill.",
  "SPRT boundaries are not in the delta. The report-only function counts observations and never pauses.",
  "The 2b block is 14 calendar dates beginning on the condition date. The condition dates and those blocked dates are both reported.",
  "G2's realized maximum concurrent positions needs the capped book. That book is the rerun and was not run, so the field is empty.",
  "The v3.1 source notes named by G3 are not in this workspace, so their hashes are not invented.",
] as const;
