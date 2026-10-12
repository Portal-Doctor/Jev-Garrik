> **STATUS: FINAL (Oct 11 2026).** Amendment 2: report definitions only. The joint resolution and the Architect finalization sections at the end supersede any earlier text that conflicts with them.

# P6 forward-paper metric definitions (stats lane): proposed amendment 2
Author: Quant, 2026-10-11, about 8:10 PM CT. Status: DRAFT for Brian's approval before P7. Items marked **[pending Trader]** touch trading-facing levels and need Trader's confirmation.

**Scope and non-change statement:**
- These are **report definitions only**. They change no registered gate, rule, threshold, family or N.
- Where a registered definition exists, it governs, and this file only references it:
  - TDF (`trading-design-final.md`) §1, §6, §7, §8;
  - ADD (`trading-design-15m-addendum.md`) §5 and the Architect Delta 1 confirmations;
  - `v3.1-bear-guards.md` (agreed package);
  - P5 rulings a/b/c (`p5-gap-rulings.md`);
  - `v3.1-registration-delta.md` S1–S6, R1–R13, §5;
  - the approved v3.1 registration `p5-v31-registration.json` (resolvedDefaults; approval record `p5-v31-approval.json`, sha `f4f76573…`, approved by Brian 2026-10-11 7:22 PM CT).
- If anything here conflicts with those, they win, and this file is corrected.

**Brian's metric names:** the repo README's review list is: "accuracy + Wilson lower bound, Brier / calibration, cost drag (fees + inference), max drawdown, and the gate booleans". Those names are used below.
- **Accuracy** = hit rate (M1).
- **Cost drag** = M2. Inference cost is reported as its own line, since Jev runs about $2/month (delta S1) and is never inside trade costs.
- **Max drawdown** = M8.
- **Gate booleans** = G0.
- Brier and calibration of Jev reads are out of scope for this amendment.

---
## 0. Common conventions (apply to every metric)
- **Review cutoff:** Monday 00:00 UTC. Every statistic is **cumulative from forward bar 1** (the first bar after the v3.1 hash) to the cutoff, so all weeks are complete.
- **Per-trade R:** R_i = net$_i / risk$_i.
  - risk$_i is the trade's sized risk at entry, fees inside (R4): $60 at full size, $20 at minimum size, or the Kelly-sized amount if smaller (resolvedDefault 13).
  - Minimum-size trades count in R (package §0, delta S3).
- **Gross and cost per trade:** gross$_i = net$_i + cost$_i (M2). gross R_i = gross$_i / risk$_i.
- **Bootstrap (P5 ruling c / R8, as implemented in P5 `stats.ts`):**
  - Non-overlapping 7-day blocks aligned to Monday 00:00 UTC, resampled with replacement, **2,000 draws**.
  - A trade's week is its **entry** week (P5 convention).
  - **Per-trade means** (`oneSided80TradeMean`): an empty week adds no trades, and a draw that picks no trades is omitted.
  - **Dollar means** (`oneSided80`): weekly net $ with **empty weeks = $0**, scaled by 365.25/12/7 weeks per month.
  - Bounds are one-sided: **L80 = p20, U80 = p80**. Seeds per §5.
- **Percentiles:** see M4. One method everywhere.
- **Colours:** GREEN / YELLOW / RED for scored metrics, **GREY** for diagnostic or not-yet-scorable ones (§9).

## n. Definition of n
- **n_c (class c)** = the number of class c **paper trades closed** (exit timestamp ≤ cutoff) that were **entered at or after forward bar 1** under the approved v3.1 hash, at any size.
- **Excluded from n and from every gate statistic:**
  - open positions;
  - Jev guard twins and placebo exits;
  - X2/X3 shadow orders;
  - anything simulated rather than paper-traded.
- **Open marks (reported, never gated):** each open position's unrealized net R at the last completed 15m close, with exit costs charged (R3 basis). The report shows the count and Σ open net R.
- **Forward days** = calendar days since forward bar 1, which feeds the registered "≥ 90 days and n ≥ 30" minimum (TDF §8 / ADD §5).

## M1. Accuracy and its Wilson lower bound
- **Success** = a closed trade with **net R_i > 0** after all costs. Net R_i = 0 exactly counts as a **failure**.
- k = number of successes; hit rate p̂ = k / n.
- **Wilson score lower bound** (one-sided), same algebra as the repo's `wilson()` in `cb/report.ts` but with a one-sided z:

  L_z = [ p̂ + z²/(2n) − z · √( p̂(1−p̂)/n + z²/(4n²) ) ] / (1 + z²/n), floored at 0.

  - **L80:** z = **0.8416** (one-sided 80%, matching the L80 convention). This is the headline figure.
  - **L95:** z = **1.645** (one-sided 95%), reported alongside.
  - The repo's legacy z = 1.96 (two-sided 95%) is **not** used in v3.1 reports.
- Worked example: 12 wins in n = 30 gives p̂ = 0.400, L80 = 0.328, L95 = 0.267.
- **Never report accuracy alone.** Positive-skew classes (A trend, B momentum) are designed to win less than half the time. Accuracy is always shown next to the payoff break-even p* and the margin (M3).
- Accuracy is computed from n ≥ 1, but **coloured only at n ≥ 30**.

## M2. Cost drag
**Per-trade cost** (all in $ on the trade's units; same components as TDF §1 and gap 17):
- cost$_i = **fees** + **spread** + **stop-slippage deduction**.
- **Fees:** entry and exit fee bps × leg notional, at the account's Coinbase tier (Intro 50/90, X1 taker = 90 per leg).
- **Spread + slippage per taker leg, forward:** |fill − reference| × units.
  - Reference = the mid in the live L2 snapshot at decision time for entries and rule/time/trail exits.
  - Reference = the **stop price** for stop exits.
  - So the stop leg's deduction captures spread and slippage together: one deduction, matching the gap-17 / F3 "stop − max(s, 0.1 × 1h ATR14)" convention. It is not double-counted.
  - Gap fills (open beyond the stop) use the stop as reference, so the gap is counted as slippage.
- Maker legs (X2/X3 shadows, D's entry) carry no spread term. Their fee is the maker fee.
- **[pending Trader]:** the forward reference prices (decision-time mid for entries and rule exits; stop price for stops). Gross = net + cost is measured against them.

**(i) Cost drag ratio (robust headline):**

  CD = Σ_i cost$_i / Σ_i max(gross$_i, 0)

- That is costs as a share of the **gross positive P&L**. The denominator is never zero or negative while at least one trade has a gross profit.
- If Σ_i gross$_i ≤ 0, report CD as **n/a and RED**: the class has no gross edge to carry costs.
- If no trade has gross > 0, CD is also n/a and RED.
- **Registered companion (not redefined here):** class B's kill "fee drag ≥ 50% of gross" (TDF §3 B) is reported exactly as the registration computes it, next to CD.

**(ii) Mean cost per trade:**
- In R: c̄_R = (1/n) Σ cost$_i / risk$_i.
- In bps: c̄_bps = (1/n) Σ 10⁴ · cost$_i / entry notional$_i.
- Both are shown next to the registered sizing cost C = 190 bps base / 200 stress (R4) and the per-class hurdle (F4: mean of C_i + max(25, 0.15 × S_i)).
- c̄_R and c̄_bps are reported, not coloured.

**Inference:** Jev call cost (USD) is reported per review as its own line, never inside cost$_i.

## M3. Payoff break-even hit rate and margin
- W̄ = mean net R over winners (net R > 0). |L̄| = mean |net R| over non-winners (net R ≤ 0, the same split as M1).
- **p\* = |L̄| / (W̄ + |L̄|).**
- **Margin = p̂ − p\*.** **Wilson margin = L80(p̂) − p\*** (L95 shown alongside).
- **Edge cases:**
  - no winners: p* is n/a, the margin is n/a, RED;
  - no non-winners: p* = 0;
  - all non-winners exactly 0R: |L̄| = 0 and p* = 0.
- **Interpretation note:** with zeros counted as failures, p̂ > p* is algebraically the same as mean net R > 0. The margin adds no new sign information. It shows **how far** the hit rate sits from break-even in hit-rate units, and the Wilson margin shows the **binomial uncertainty**, treating the average payoffs as fixed.
  - It understates the total uncertainty, because W̄ and L̄ are estimated too. The bootstrap L80 of mean net R (G2) is the one tied to the gate.
- Example: W̄ = 2.5R and |L̄| = 1.0R give p* = 0.286. At 12/30 wins, the margin is +0.114 and the Wilson margin is +0.042.

## M4. Percentile method (one method everywhere)
**NumPy `method="linear"` = Hyndman–Fan type 7:** for a sorted sample x₍₀₎…x₍ₘ₋₁₎ and probability q,
- h = (m−1)·q;
- Q(q) = x₍⌊h⌋₎ + (h − ⌊h⌋)·(x₍⌈h⌉₎ − x₍⌊h⌋₎).

This is identical to P5's `percentileLinear` ("linear, index (n−1)·p", R8). It applies to:
- bootstrap bounds (L80 = Q(0.20), U80 = Q(0.80));
- Jev's trailing 30-day per-pair and pooled percentiles (3a 95th, 3b 99th: Q(0.95), Q(0.99));
- the backtest 5th percentile in the forward kill (Q(0.05));
- placebo p-values' reference distributions;
- any reported median (Q(0.5)).

## M5. Seeds (placebo and bootstrap)
**Master seed:** the integer value of the **first 8 hex digits of the approved v3.1 registration sha-256**. For `f4f76573…` (`p5-v31-approval.json`), that is **4,109,854,067**.
- If the registration is re-hashed and re-approved before forward bar 1, the master seed follows the final approved sha by this same rule. The rule is fixed, not the number.

**Sub-seed derivation:** seed(stream, purpose) = int( first 8 hex of SHA-256( UTF-8 "‹master›:‹stream›:‹purpose›" ), 16 ). PRNG = mulberry32 (as P5 `stats.ts`). The same seed is used at every review, so results are reproducible and only the data changes.

| Stream:purpose | Sub-seed (for master 4109854067) |
|---|---|
| 3a:placebo | 2,613,899,018 |
| 3b:placebo | 3,177,882,488 |
| A:bootstrap | 422,918,504 |
| B:bootstrap | 3,151,362,213 |
| C:bootstrap | 1,047,788,147 |
| D:bootstrap | 821,766,163 |
| E:bootstrap | 2,319,709,643 |
| book:bootstrap | 921,260,057 |

- **2,000 draws** for every placebo and every bootstrap.
- Every report prints the master seed, each sub-seed used, the draw count, the number of draws used (P5's `drawsUsed`), and the interpolation string.

**Placebo construction (3e, delta S2):**
- **3a:** each placebo draw gives every trigger event (M6) a **random exit bar**, chosen uniformly from that position's own eligible bars (completed 15m bars after entry and before its actual exit, where the trade is at or below +1R unrealized: the package's placebo constraint).
  - It exits at taker on the next 15m open, with the same costs as the guard.
  - The statistic is the mean paired Δnet R (twin − unguarded) across events.
- **3b:** each draw places the same number of 4h blocks at random 15m bar starts within the review window, and scores the A/B candidates they would have blocked.
- **One-sided p** = (1 + #{placebo statistic ≥ guard statistic}) / (2,000 + 1).
- The "beats the twin by more than the taker cost" test (3e) is reported separately, as the registration states it.

## M6. n for a Jev-guard p-value
- **3a exit guard:** the unit is the **trigger event**, i.e. a position whose guarded-twin exit **differs** from the unguarded twin's exit.
  - Count **one per position**, at its **first** qualifying trigger.
  - Later triggers on a position the twin has already exited don't count, and neither do triggers on positions above +1R (they can't act).
  - Triggers during the warm-up (days 1–6 log only) don't count. "Pooled baseline" triggers (days 7–29, per pair) count, but are reported separately as well.
- **3b market pause:** the unit is the **paused-entry candidate**, i.e. an A/B entry candidate that would have been blocked inside a firing 4h window. Each candidate counts once, even if blocks overlap.
- **Minimum:** each guard needs ≥ **30** units (3e). Below 30, the guard is "not testable", and it enters its Holm family of 2 with p = 1 (R9).
- The degenerate-guard fails (3d: 3a on > 10% of position-days, 3b on > 15% of hours, over the first 60 days after warm-up) are judged on their own denominators:
  - position-days = Σ over open A/B positions of the UTC days they were open;
  - hours = clock hours after warm-up.

## M7. Indeterminate share
- Per class, per review window and cumulatively:

  IS_c = (indeterminate orders) / (all orders submitted in class c, including indeterminate ones).

  An order is indeterminate if the trade feed had a gap at any point while it was live (ADD, Architect Delta 1).
- It applies to orders whose fill is judged by trade-through: X2/X3 shadow orders (A/B/C signals) and D's maker entries. For classes with no such orders it's n/a (GREY).
- **Flag:** **IS_c > 10%** means that class's fill statistics are unreliable at that review (agreed in ADD).
  - D treats indeterminate as no fill, but D's indeterminate count is always reported (Trader's addition).

---
## 8. Other review metrics (as registered; computed per §0)
- **G1 Mean net R and its L80:** the per-trade mean of R_i, with the one-sided weekly-block L80 (`oneSided80TradeMean`, class bootstrap sub-seed).
- **G2 Net $/month and its L80:** `oneSided80` over weekly net $ with empty weeks = $0, scaled to months (TDF §7; 1d kill input).
- **M8 Max drawdown (R):** peak-to-trough on the class's cumulative net R curve. This is **the same series the registered 10R pause and 20R kill use** (S3 / F5).
  - An MTM-inclusive figure (open marks added) is shown alongside, unscored.
  - The book-level dollar drawdown is reported on the R3 equity basis against −$1,600 / $8K.
- **M9 Rolling-20 net R sum:** the sum of the last 20 closed trades' R (1b). Scorable once n ≥ 20.
- **M10 Concentration (1d flags):**
  - ex-top-3 net = Σ net$ minus the 3 largest net$ trades;
  - top-2-pair share = the largest 2 pairs' Σ gross$ / Σ max(gross$, 0);
  - largest-trade share = max net$ / Σ net$ (n/a if Σ net$ ≤ 0);
  - median net R (Q(0.5)).
- **M11 SPRT:** both LLR paths per resolvedDefault 15 (σ = 1.5R until trade 20, then frozen at the realized SD of trades 1–20; Wald ±ln 4). Report-only, GREY.
- **M12 Breadth:** the share of members above daily EMA50 and its on/off state (S4, resolvedDefault 18; option (c) report-only). Always GREY.
- **G0 Gate booleans:** the registered forward promote, kill and pause booleans, printed exactly as the engine evaluates them.

## 9. GREEN / YELLOW / RED thresholds (fixed before any forward data)
**Principles:**
- Every RED sits **at or before** the matching registered trigger, never looser.
- GREEN and YELLOW cut points are judgment levels, fixed now and never retuned. The YELLOW/GREEN cut points are **[pending Trader]**; the RED levels are tied to registered gates.
- A metric that isn't scorable yet (below its minimum n, or n/a for that class) is **GREY** and left out of the counts.

**Class panel** (per class, A–E):

| Metric | Scorable when | GREEN | YELLOW | RED | Registered anchor |
|---|---|---|---|---|---|
| n progress | always | n ≥ 30 AND ≥ 90 forward days | otherwise | never | TDF §8 / ADD §5 minimum |
| Mean net R and L80 (G1) | n ≥ 30 | mean > 0 AND L80 > 0 | mean > 0, L80 ≤ 0 | mean ≤ 0 | promote needs mean > 0 and L80 > 0; 1d kill needs mean < 0 |
| Net $/month L80 (G2) | n ≥ 30 | L80 > 0 | L80 ≤ 0 and point estimate > 0 | point estimate ≤ 0 | 1d kill: $/month L80 < 0 (with mean < 0) |
| Wilson margin (M3) | n ≥ 30 | L80(p̂) > p* | p̂ ≥ p* ≥ L80(p̂) | p̂ < p* or p* n/a | equivalent to the sign of mean net R |
| Cost drag CD (M2 i) | n ≥ 10 | < 25% | 25% to < 50% | ≥ 50%, or Σ gross ≤ 0 (n/a) | B kill: fee drag ≥ 50% of gross |
| Concentration: ex-top-3 (M10) | n ≥ 30 | ex-top-3 net > 0 | ex-top-3 net ≤ 0 (expected for skewed A/B; flag) | ex-top-3 net < 0 AND median net R < −0.5R | 1d flags; never a kill input |
| Concentration: top-2 pairs (M10) | n ≥ 30 | ≤ 50% | > 50% to 80%, or largest trade > 60% of net | > 80% of gross from ≤ 2 pairs | 1d flag |
| Max drawdown, R (M8) | n ≥ 1 | < 5R | 5R to < 10R | ≥ 10R (pause); ≥ 20R also shows KILLED | 1c pause 10R; 20R kill |
| Rolling-20 sum (M9) | n ≥ 20 | > 0 | −5R < sum ≤ 0 | ≤ −5R (pause) | 1b |
| Indeterminate share (M7) | ≥ 10 orders | ≤ 5% | > 5% to 10% | > 10% | ADD flag 10% |
| SPRT (M11), breadth (M12), cost per trade (M2 ii), open marks, accuracy alone | n/a | GREY | GREY | GREY | report-only |

**Jev panel** (book-level, shadow):

| Metric | Scorable when | GREEN | YELLOW | RED | Registered anchor |
|---|---|---|---|---|---|
| 3a fire rate (fires per position-day) | after warm-up, ≥ 20 position-days | ≤ 5% | > 5% to 10% | > 10% | 3d degenerate fail |
| 3b blocked-hour share | after warm-up, ≥ 7 days | ≤ 7.5% | > 7.5% to 15% | > 15% | 3d degenerate fail |
| Trigger units vs 30 (M6) | always | ≥ 30 | < 30 | never | 3e minimum |

A GREEN Jev fire rate only means the guard is **testable**, not useful. Usefulness is decided only by 3e.

**Book panel:**

| Metric | GREEN | YELLOW | RED | Anchor |
|---|---|---|---|---|
| Weekly halts in the last 6 weeks | 0 | 1–2 | ≥ 3 (kill) | TDF §8 forward kill |
| Book equity drawdown (R3 basis) | < $800 | $800 to < $1,600 | ≥ $1,600 | −$1,600 book halt |
| 7-day parity (forward engine vs replay) | match | n/a | any break (kill) | TDF §8 |

**"Mostly green", defined:**
- For a class, all of these hold:
  - (1) **no RED** on any scored metric in its class panel or the book panel;
  - (2) **GREEN on at least two-thirds** of the scored metrics in its class panel, rounded up (for example 6 of 9);
  - (3) **at least 6 metrics are scorable**, so it can't be "mostly green" on a handful of early metrics. In practice that requires n ≥ 30.
- For the Jev panel: no RED and GREEN on 2 of 3.

**Statement for Brian:** a colour is a reading aid. **GREEN status never promotes a class, and RED never kills one.** Only the registered gates do that:
- promote: ≥ 90 days, n ≥ 30, mean net R > 0, L80 > 0, Holm over 5;
- kills: 1d, 20R, the backtest 5th percentile, 3 halts in 6 weeks, parity;
- pauses: 1b, 1c, 2b.

The colours are computed from the same numbers and can only flag earlier.

## 10. Open questions for Architect
1. M8: confirm that the 20R kill and 10R pause series (S3 / F5) is the **closed-trade** cumulative net R curve. If the engine includes open MTM, this report follows the engine, and the label changes.
2. M2: confirm that the forward paper engine logs the decision-time mid and the stop price per leg, which the cost decomposition needs.
3. M5: confirm that the final approved v3.1 sha (and therefore the master seed) is `f4f76573…`. The registration file carries `approved: false` with a re-hash note, while `p5-v31-approval.json` records Brian's approval of `f4f76573…`.

## Joint resolution (Quant + Trader, Oct 11 2026)
Everything is AGREED. Quant accepts all three of Trader's counters, and they supersede the text above where it differs:
1. **Cost reference price:** entries and rule, trail and time exits are measured against the **arrival mid**, the live L2 mid when the taker order is sent (for X1, the next 1h open). Stop exits are measured against the stop price, with gap fills beyond the stop counted as slippage. Decision-to-arrival drift is reported separately as **'delay' (bps, GREY)**, outside cost$. This matches the backtest, where gross runs from the next 1h open and s_bt is the only spread term.
2. **Max drawdown cut points for A/B:** GREEN <7R, YELLOW 7R to <10R, RED at the registered 10R pause / 20R kill. C/D/E keep GREEN <5R.
3. **Ex-top-3 for A/B:** an ex-top-3 net ≤0 scores GREY, with the flag shown, and is excluded from the 2/3-GREEN count. RED is unchanged (ex-top-3 <0 AND median <−0.5R). C/D/E stay as written.
Confirmed: the master seed derivation uses the final approved v3.1 sha f4f7657329237bd29a3fe8f752daca82d4ef2a2b887346772e112146e7272c1d (approval record research/data/reports/p5-v31-approval.json, commit bc558c4), giving seed 4,109,854,067.
Still open for Architect: (a) whether the 10R/20R series uses the closed-trade net R curve or includes open marks; (b) whether the engine logs the arrival mid and stop price per order leg.

## Architect finalization (applied by Quant, FINAL)
Architect found no conflicts with the registered texts. These supersede any earlier wording:
- **(a) Drawdown series:** the 10R class pause, 20R class kill and $1,200 class backstop use the **CLOSED-trade net R curve only**. Open mark-to-market (MTM) applies only to the book halts, the −$1,600/$8K drawdown and the pair backstop. M8 therefore shows the class MTM drawdown as an **unscored reading only**.
- **(b) M2 cost reference:** the **arrival mid** (live L2 mid when the taker order is sent). The decision-time mid is also logged so the decision-to-arrival lag ('delay', GREY) can be computed.
- **(c) Jev panel 3a, metric 3d:** the share of **position-days with ≥1 fire**, not fires per position-day. The 3d verdict (the degenerate fail at >10% and the colour) is judged on the **first 60 days after warm-up**. The cumulative colour after that is a reading aid only.
