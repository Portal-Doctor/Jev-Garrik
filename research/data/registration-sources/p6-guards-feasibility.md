# Architect: feasibility of forward bear-case guards and the Jev guard (2026-10-11)
Sources: TDF §6, §8, §9 and gap 18; ADD §5; registration 49bc5060 (jev: jev-latest direct, gap-18 packet, Fallback B); QA jev-smoke (jev-1.13.0, ~170 ms; design-v3: 369 tokens, $0.0000155 per call).

## Jev exit guard and market pause
Feasibility: YES, with the same packet. Fallback B sends only the live 1m MarketState snapshot plus the 4 repo questions. P6 already builds that from the live L2 and trade feed for candidate shadow calls, so polling it at each completed 15m bar for each open A/B position, plus BTC-USD, needs no new builder.
- Keep position = 0, as frozen in gap 18. Sending position = 1 changes the packet, which needs registration.
- The regime question must have an option that literally means risk-off. Check the repo's option list. Mapping some other label onto "risk-off" is the label inversion §9 bans.
- Outage, timeout or budget hit: no guard action. The position runs on its class rules and the pause doesn't engage, mirroring §9's "outage never adds a trade".
- Reads use a 4h horizon (frozen) polled every 15m, so consecutive reads overlap heavily. "2 in a row" means about 30 minutes of persistence, not two independent signals.
Main risk, which Quant should check before freezing thresholds: the repo's base rates put toxic_flow = high on 89% of decisions and liquidity_stress = stressed on 68% (TDF §9), and neither label is significant (toxic p = 0.056). If P >= 0.70 is as common as those labels, the OR guard fires on nearly every position within about 30 minutes, which turns A/B into a taker round trip that captures nothing. Measure the P >= 0.70 frequency in shadow from bar 1 before any authority, and add a pre-set degenerate-guard fail: if it fires on more than X% of position-days, it's not testable.
Cost: one call per packet, all 4 questions in one call, as in the repo and smoke test. Worst case 8 open positions plus BTC, at 96 bars a day for 30 days, is about 26,000 calls, roughly $0.40 a month. At the realistic 2-3 positions (cluster cap) it's about 8,600-11,500 calls, roughly $0.15 a month. Even if each question were a separate call (x4), that's under $2 against the $100 budget. Latency of 100-200 ms is fine on a 15m cadence.
Taker cost: a guard exit swaps the class exit for a taker exit at 90 + s, a similar cost, so the real cost is the forgone trend tail. That's what the 25% top-3 tail fail (4) measures. It's feasible because both twins are simulated on identical positions (§9 ablation pattern). The random-exit placebo at the same trigger rate is feasible too.
Rules to pin down: does a guard exit count as a stop for the 24h no-re-entry rule (recommend yes)? Does the pause cover D (the BTC veto covers A/B/D)?

## Registration status
- Shadow logging of extra calls changes no trade and no registered result, so it can start as a logged post-hash amendment.
- Testing it, or ever giving it authority, can't be an amendment. §9 freezes Jev's uses to V2, V2-AND and select ("new questions" banned; same 4 questions here, but new uses and thresholds), the forward Jev Holm family is 4, and §8 says any post-hash change is a new registration with its own N.
- The cheap route: forward paper hasn't started, and it is the holdout. Freeze one amendment registration (call it v3.1) before forward bar 1, containing the Jev guard tests, Quant's guards, Trader's bear trigger and any cluster-cap change. Re-hash, and Brian approves. That's no contamination and no lost data. The Jev family grows from 4 to 6 (or the guard tests form a separate family of 2, Quant's call).

## Quant's guards: feasibility and conflicts
All are trivially computable in P6 from the forward trade log; none needs new data.
1. SPRT, H0 +0.25R vs H1 0, alpha = beta = 0.2: feasible, but it's not early. With per-trade SD of about 1.5R (TDF/ADD), the expected sample under H1 is about 100 trades, versus the registered n >= 30 kill screen. Normal-likelihood SPRT on positively skewed trend R (35% win, 20-loss streaks are normal per TDF) will also pause healthy A runs, and alpha = 0.2 pauses a true +0.25R class 1 time in 5. Quant should state the R model (bootstrap or robust LLR) and a resume rule.
2. 10R class drawdown pause: no conflict. It sits under the registered 20R class kill (TDF §6, ADD forward kills). It needs a resume rule, otherwise a pause is just a kill at 10R.
3. Kill at n >= 30 if ex-top-3 net < 0 AND L80 of $/month < 0: no mechanical conflict (it adds to the gross-based kill screen, OR'd). Strategy flag: a positive-skew trend class is expected to be negative without its top 3 at n = 30, so this likely kills A by design. Quant and Trader should confirm that's intended. The concentration flag (>= 80% of gross from <= 2 pairs) is fine.
4. Median R, hit rate and ex-top-3 at each review: fine, reporting only.
Registered halts (§6) stop new entries only. The Jev exit guard is the first rule that closes positions outside class exits, which changes A/B's exit rules (TDF §3), so it needs the registration route above, not a halt-style amendment.
