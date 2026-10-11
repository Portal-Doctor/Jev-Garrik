# Architect: P5 registration-gap rulings (2026-10-11)
Sources: approved registration p4-registration.json (sha 49bc5060..., verified), trading-design-final.md (TDF), trading-design-15m-addendum.md (ADD), design-v3.md.

## Answers
1. A's in-sample selection statistic: COVERED. TDF §7 makes the selection metric "the lower 80% one-sided block-bootstrap bound of mean net $/month at fixed caps, after fees". TDF §8 (walk-forward) says the config is chosen in-sample per fold and never ranked by max OOS. Read together: for each fold, compute the §7 statistic on that fold's IS trades for each of A's 6 configs, using weekly blocks (TDF §8 gate 2), with caps applied, and pick the highest. The tie-break is silent (amendment a).
2. Holm alpha: COVERED. TDF §8 gate 3: Holm-adjusted p < 0.05, family-wise; BH q < 0.10 reported. ADD §5 table: first step = 0.05/5 = 0.01. Historically, Holm is reported as exploratory, never pass/fail (ADD §5).
3. C in a return-based Holm family: COVERED, it isn't in one. Registration classCGate: meetsRule=false, historicalRow=false, so C is forward-only. validation.historicalFamily = [A, B], maxOfN = 7 (ADD §5: "A, B (2) if C goes forward-only"). C enters only the forward 5-stream promotion family (gap 16, ADD §5), using its forward net-R series. How to treat a stream with no forward p yet is silent (amendment b).
4. Trail ATR: COVERED. Only A has an ATR trail: a chandelier at the highest daily close since entry minus 3 x daily ATR (TDF §3 A), with ATR = Wilder ATR14 on the stated timeframe (TDF §2), so daily Wilder ATR14. Completed 15m bars only check the trail and move it (ADD §4). Nothing uses a 15m ATR. B has only a disaster stop (entry - 3 x daily ATR). C has none (72h max hold). D's trail is 87b35d0 stepPosition (confirmed 1h swing low) and D is forward-only. E has a break-even move, not a trail, and is forward-only.
5. Cluster rho: COVERED. TDF §6: single linkage at 60-day daily-return rho >= 0.8, recomputed monthly, max 2 open per cluster. Registration risk.clusterRule adds the boundary-saved-name rule.
6. N: the REGISTRATION GOVERNS. maxOfN = 7, nCum = 135, with 154 reported as sensitivity. This is ADD §5's no-C case ("N = 7 without C", "135 if C goes forward-only"). 8/136 was the with-C case and doesn't apply.

## Senior's caveats: not acceptable as the registered result
The missing trails, slot and cluster caps and $ halts are not just "likely optimistic". The run is not the registered strategy:
- §7's metric is defined "at fixed caps".
- A's exits include the trail (TDF §3 A).
- Item 1's IS choice must use the same capped simulation.
Label results sha 608c52b8 as an uncapped diagnostic. Senior must rerun with the trail, slots (A3/B4, 1 per pair, 24h no re-entry), $480 open risk, $1,500 notional, $6K gross, clusters, beta cap and halts ($240/$480/-$1,600; backstops $900/$500/$8K). This implements the registration, so it is not an amendment.

## Assumption checks
- X1 taker = s_bt + 90 per taker leg: CORRECT (gap 17 plus the Intro 50/90 tier). Base s_bt = 5, stress = 10.
- Stop fills: must be stop - max(s_bt, 0.1 x 1h ATR14), or the open on a gap, plus 90. That's one deduction, not s_bt alone (gap 17, registration execution.stopModel). Senior should confirm the code uses the max.
- Stops, rule exits and time exits taker: CORRECT (TDF §1 and §3 A/B). Window-end marks: the registration says mark to the last 15m close and FLAG. Charging taker on a mark is fine and conservative, but keep the flag.
- 1h Wilder ATR14: CORRECT for the stop-fill deduction only. A's stop and trail and B's disaster stop use DAILY Wilder ATR14, so check they aren't using 1h.
- U80 = p90 of 2,000 weekly-block draws: the 2,000 draws and weekly blocks are fine (the draw count is silent; record the seed). The p90 doesn't fit: TDF §7 states its 80% bound as one-sided, so the consistent reading is U80 = p80 and L80 = p20. p90 is the two-sided upper bound and makes the kill screen harder to trigger. Proposed as amendment c; Quant to confirm.

## Post-hash amendments for Brian (registered docs silent)
a. A IS tie-break: if two configs tie exactly on the IS statistic, take the higher IS total net $, then the earlier config in registration order. (Quant/Trader to confirm.)
b. Forward 5-stream Holm: a stream without a valid forward p (n < 30) enters with p = 1, so the family stays 5. That is conservative and never shrinks the correction. (Quant to confirm.)
c. Bootstrap bounds: every "80% bound" (kill screen, Kelly, §7, forward promote) is one-sided: U80 = p80, L80 = p20. Use weekly 7-day blocks and 2,000 draws with a recorded seed. (Quant to confirm.)
None of these change rules, grids or N.

CORRECTION (3:40 PM CT Oct 11): ruling 2's "first step 0.01" applies only to the forward 5-stream family. For the historical family {A, B}, the first step is 0.025 (0.05/2), as stated in p5-capped-rulings.md ruling 3 (3:09 PM CT). See v3.1-registration-delta.md §5a.
