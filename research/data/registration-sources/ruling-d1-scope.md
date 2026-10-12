# Architect ruling: what pre-window D1 may feed (2026-10-11)
Basis: trading-design-15m-addendum.md P3-4 (F5 tolerances), the Trader refinement (lines ~312-321) and the joint acceptance; QA turn 3 (/workspace/qa-pr30-notes.md). This applies the agreed text. Only rule 4 fills a gap, and Quant/Trader may override it before the hash.

1. In-window (2025-10-11 onward): daily bars always come from 15m-derived bars, for every name and every use. D1 is never read in-window. (Unchanged.)

2. Names that PASS the price-group tolerance: pre-window D1 OHLC may feed the pre-window lookback of any daily-bar quantity the design defines: EMA50/EMA200, daily ATR14, the 20/55-day closing highs, the 10-day low, the 28-day-skip-3 return, C's 24h-return z-score (30-day window) and 20-day volume average, the 60-day return correlations, D's daily bias and D's daily swing-high scan (rule 4). If the volume group also passes, D1 volume feeds the 90-day median volume. Listing proxy = first D1 candle.

3. The 7 boundary-saved names (AVNT, FIL, IP, LIGHTER, TRUMP, VVV, WIF): these failed the price group and were saved by the <= 10 bps boundary convention test. Per the Trader refinement, they keep pre-window D1 CLOSES ONLY, and only for daily EMA50/EMA200 and the listing proxy. Everything else starts from in-window 15m-derived bars and stays undefined until enough in-window bars exist:
   - daily ATR14 (needs high/low): from 15m-derived bars only. For D and C on these names, which also means C's stop/skip rule and D's ATR stop use in-window ATR only.
   - 20/55-day closing highs, the 10-day low and 28-day returns: in-window only.
   - C's z-score and 20-day volume average: in-window only.
   - D's daily swing-high scan: in-window daily bars only. The D1 highs the scan reads are price data outside the refinement's scope.
   - 60-day correlation: in-window only. Until 60 in-window days exist, the cluster cap treats the name as its own cluster (pending Quant/Trader if they prefer otherwise).
   WIF and LIGHTER also take the volume-group fallback: no pre-window D1 volume (WIF loses its 2025-11-10 and 2025-12-01 memberships, as already agreed).
   Fix needed: D must honor the same per-name group flags (QA: D currently ignores dropPrices). One code path decides which bars each indicator may read, keyed by the name's group-pass flags, and D, C and A all go through it.

4. D's swing-high lookback (gap-fill; Quant/Trader may override before the hash). 87b35d0's nearestSwingHighAbove scans all loaded daily history, so D's candidates depend on how much history is loaded (QA: NEAR 2026-09-25 and SUI 2026-01-14 change with D1 depth). To make D deterministic and reproducible forward:
   - D's daily history starts at a fixed date recorded in the registration: the D1 snapshot start for each name (root 76c41956...; that pair's first D1 candle, or the window start for the 7 names under rule 3).
   - The forward engine loads exactly the same start date per name, plus all bars since, so forward and backtest scans see identical history.
   - The vendored 87b35d0 function is unchanged. Only the input history is pinned.
   - NEAR/SUI-type differences vs PR #29's 18-month run are expected and are not a parity failure: the faithful behavior on the pinned history.

5. Registration additions: the per-name group-pass flags (price, volume, boundary-saved), the D history start date per name, the bar-access rule above, and the listing-proxy source per name.

QA checks:
- No indicator for the 7 names reads pre-window D1 highs, lows or volume, except EMA50/200 and listing from closes (test with the names' flags).
- D, C and A use the shared bar-access path.
- D's candidates are identical between a backtest replay and a forward-style load from the registered start dates.
- The registration lists the flags and start dates.
