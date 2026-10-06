# Jev revenue review

Date: 2026-10-06  
Scope: split breakout 20/3/50, Coinbase paper run `5f55b8ab`, and the locked
2026-07-01 through 2026-10-01 five-minute replay.

## Executive conclusion

The premise "Jev improves trades" is not supported. The strongest measured Jev field,
`direction_bias`, is backwards on this sample: decisions labeled `long` had a mean four-hour
forward move 24.4 bps below decisions labeled `flat` (2,182 long labels, naive permutation
`p=0.002`). Liquidity stress and the effective rolling stress veto were not significant at one or
four hours. Market-regime classes are extremely imbalanced and do not support a contraction veto.

Jev should therefore be telemetry only on split breakout. It should not gate entry, exit, or size,
and it should not rank capital until a genuinely out-of-sample label study shows incremental
breakout-trade expectancy. The trading edge being tested is the deterministic completed-bar
Donchian 20 breakout above EMA 50 with a 3 ATR trail, not Jev.

The risk premise also needed correction. The current locked replay does not reproduce VVV or PUMP
as rule-3 drawdown failures. VVV is profitable and below 15% drawdown at both fee schedules. ZEC is
the actual failure at the old $600 clip. PUMP and XLM have no economic case:

- PUMP is negative net and approximately zero or negative gross alpha.
- XLM is net negative and cannot pass the 2-to-1 payoff boot at the account's actual Intro
  50/90 fee tier.
- ZEC at $500 is the smallest tested $100 clip step that clears 15% at both fee schedules.

The implemented book is therefore the original six plus VVV and ZEC, with VVV unchanged at $400,
ZEC reduced from $600 to $500, and PUMP/XLM disabled. The gross cap remains $3,000.

## 1. What actually controls a split-breakout trade

### Deterministic TA edge

1. `cb/poolbook.ts`, `snapFromFourHour`: completed four-hour buckets only; candidate means the last
   close is above the prior 20 completed highs and above EMA 50. Wilder ATR 14 is warmed here.
2. `cb/engine.ts`, `evaluateSplitBreakout`: a flat pair may enter only when the snapshot is known
   and is a candidate. Kill, feed health, gross room, and minimum size remain deterministic guards.
3. `cb/books.ts`: code selects the fixed pair clip, one-sigma initial stop, and four-sigma payoff
   boot values. Jev never computes them.
4. `cb/paper.ts`, `enforceGuards`: an open split-breakout long exits at
   `max(initial stop, 3 ATR ratcheting trail)` or the 14-day hold cap. Jev does not exit it.
5. `cb/paper.ts`, `processOrder`: entries rest post-only and cancel if not filled. Stops cross as
   taker. The fill model, fee debit, slippage block, and $3,000 gross cap are code-owned.

### Jev's actual role

`cb/model.ts` asks Jev for market regime, direction bias, toxic-flow risk, and liquidity stress
every decision cycle. `cb/engine.ts` persists the raw vector and rolling veto observations in each
decision. `cb/resolver.ts` later attaches 1h and 4h outcomes.

Before this change, split breakout still hard-refused a flat candidate when the effective stress
veto fired or when Jev labeled contraction. Direction bias was annotation only. Toxic veto had
already been deleted. The four newer pairs were also still on the deterministic stress fallback
until their rings reached 200 samples, so some purported "Jev" behavior was actually
`classifyDeterministic`.

After this change, all Jev labels and both rolling veto observations are telemetry on split
breakout. They remain stored. `cb/report.ts` now also publishes mean 1h/4h forward moves and sample
sizes for every raw label. HTF and the failed pooled experiment are not silently redefined by this
change.

## 2. Forward-return evidence

Data: all resolved `jev-latest` decisions retained in Postgres, 2026-09-29 through the analysis
cut, joined to 1h/4h outcomes. There were 6,587 usable 1h decisions and 6,376 usable 4h decisions.
The four newer pairs had only about 96 to 143 resolved 4h outcomes each and their rolling rings were
still below 200.

Statistics below compare each focal label with all other values of that field. Confidence
intervals are 500-replicate IID bootstrap intervals; `p` is a 500-replicate two-sided permutation
test. These are exploratory, not confirmatory: five-minute decisions and overlapping forward
horizons are serially dependent, so IID significance is optimistic. No threshold was tuned.

### Pooled label results

| Field | Horizon | Focal n | Focal mean | Other mean | Difference | Bootstrap 95% | Permutation p |
|---|---:|---:|---:|---:|---:|---|---:|
| direction `long` | 1h | 2,242 | -4.2 bps | +5.9 bps | -10.1 bps | -14.3 to -5.6 | 0.002 |
| direction `long` | 4h | 2,182 | -17.8 bps | +6.6 bps | -24.4 bps | -31.1 to -18.7 | 0.002 |
| stress `stressed` | 1h | 4,481 | +2.3 bps | +2.7 bps | -0.4 bps | -5.0 to +3.6 | 0.866 |
| stress `stressed` | 4h | 4,336 | -2.7 bps | +0.3 bps | -3.0 bps | -9.8 to +3.5 | 0.389 |
| effective stress veto | 1h | 785 | +0.9 bps | +2.7 bps | -1.7 bps | -9.4 to +4.7 | 0.591 |
| effective stress veto | 4h | 748 | -6.6 bps | -1.1 bps | -5.5 bps | -16.0 to +5.1 | 0.277 |
| toxic `high` | 1h | 5,882 | +2.3 bps | +3.7 bps | -1.4 bps | -5.7 to +3.7 | 0.697 |
| toxic `high` | 4h | 5,693 | -2.8 bps | +7.2 bps | -10.0 bps | -18.2 to -1.2 | 0.056 |

Market regime is not usable as a gate from this tape. At 4h, expansion had 6,289 observations,
balance 73, and contraction only 14. Balance beat the rest by 36.8 bps (`p=0.020`), while
contraction's 34.1 bps difference was unscored in any robust sense (`p=0.339`). The imbalance and
pair/time confounding make a three-way execution rule unjustified.

### Pair checks

Each cell is `focal n / focal-minus-other mean bps / permutation p`.

| Pair | Long 1h | Long 4h | Stressed 1h | Stressed 4h | Effective stress veto 4h |
|---|---|---|---|---|---|
| UNI | 315 / -13.1 / .006 | 313 / -28.5 / .002 | 671 / +0.7 / .864 | 659 / -2.8 / .729 | 113 / -5.9 / .637 |
| NEAR | 366 / -25.4 / .002 | 352 / -57.5 / .002 | 716 / +9.5 / .279 | 704 / +2.5 / .810 | 110 / -17.6 / .220 |
| BCH | 310 / -7.2 / .052 | 299 / -6.3 / .297 | 575 / -4.0 / .283 | 566 / -7.1 / .216 | 114 / -28.7 / .004 |
| SUI | 269 / -1.4 / .888 | 268 / -15.4 / .208 | 669 / -8.4 / .238 | 651 / -26.1 / .020 | 152 / -14.6 / .333 |
| AVAX | 479 / +2.5 / .599 | 472 / +6.1 / .503 | 628 / +2.4 / .593 | 615 / +19.4 / .068 | 107 / +9.8 / .517 |
| ARB | 236 / -12.6 / .054 | 232 / -23.6 / .010 | 744 / -8.0 / .182 | 725 / -12.6 / .190 | 103 / +16.5 / .206 |
| VVV | 49 / -28.6 / .012 | 42 / -104.7 / .002 | 120 / -11.2 / .389 | 104 / +21.0 / .437 | 7 / -82.9 / .148 |
| ZEC | 55 / -17.2 / .110 | 50 / -17.2 / .259 | 116 / +16.9 / .142 | 101 / +18.3 / .331 | 12 / +41.3 / .114 |
| PUMP | 111 / +4.6 / .705 | 106 / -7.5 / .739 | 129 / +13.4 / .373 | 115 / +4.7 / .860 | 14 / +39.4 / .277 |
| XLM | 52 / -15.3 / .008 | 48 / -45.2 / .002 | 113 / -1.8 / .743 | 96 / +3.7 / .647 | 16 / +2.0 / .908 |

One isolated result, BCH's effective stress-veto 4h row, is negative and nominally significant.
That is one pair among many correlated comparisons and is not enough to justify a production gate.

VVV and PUMP had only `expansion` regime labels in their resolved sample, so no within-pair regime
contrast exists. This is another reason not to promote regime labels to execution.

### Breakout-trade outcome availability

Run `5f55b8ab` had 157 decisions, zero approved entries, zero entry orders, and zero fills at the
analysis cut. There is therefore no honest Jev-by-breakout-trade outcome comparison yet. The
candle backtest can compare the retired deterministic label veto, but no candidate was vetoed on
the locked tape, so its on/off P&L is identical. Claiming a Jev trade-level edge from that replay
would be false.

## 3. Locked replay revenue decomposition

The final replay uses $1,200 per pair, completed four-hour bars, post-only next-bar entry, the
locked 20/3/50/ATR14/14-day settings, and no Jev execution veto. PUMP and XLM are excluded, ZEC is
$500, and all other clips are unchanged.

| Fee schedule | Gross alpha | Fees | Net | Fee drag on gross | Trades | Missed | Worst pair DD | Jul | Aug | Sep | $300 gate |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| 40/80 sensitivity | $1,694.18 | $467.15 | $1,227.02 | 27.6% | 88 | 8 | 13.57% | -$116.38 | $419.60 | $923.80 | pass, 2/3 |
| 50/90 Intro | $1,716.45 | $544.65 | $1,171.80 | 31.7% | 88 | 8 | 13.92% | -$132.14 | $403.04 | $900.90 | pass, 2/3 |

All 88 exits were stop/trail exits; none reached the 14-day cap. Eight of 96 entry opportunities
missed (8.3%). This means revenue is dominated by breakout selection and the stop/trail path, not
Jev or the hold cap.

The month concentration is severe. September contributes $923.80, or 75% of the 40/80 three-month
net. July loses money. Passing two of three months is the predeclared gate, but it is not evidence
of stable monthly income.

### Pair contribution at 40/80

| Pair | Clip | Gross | Fees | Net | Trades | DD |
|---|---:|---:|---:|---:|---:|---:|
| UNI | $600 | $450.28 | $82.80 | $367.48 | 11 | 11.96% |
| BCH | $500 | $264.34 | $56.11 | $208.23 | 9 | 9.95% |
| NEAR | $300 | $223.69 | $34.19 | $189.50 | 9 | 7.31% |
| ARB | $300 | $206.53 | $37.65 | $168.88 | 10 | 8.18% |
| ZEC | $500 | $244.40 | $85.96 | $158.45 | 14 | 13.57% |
| VVV | $400 | $114.32 | $58.51 | $55.80 | 12 | 11.35% |
| AVAX | $400 | $101.35 | $58.41 | $42.94 | 12 | 8.97% |
| SUI | $400 | $89.26 | $53.51 | $35.74 | 11 | 8.37% |

The pre-change ten-name replay returned $1,143.25 at 40/80 and $1,075.19 at 50/90, but ZEC
breached rule 3 at 16.00% and 16.42%, respectively. VVV did not fail (11.35% and 11.57%).
PUMP lost $61.51 at 40/80 with -$3.94 gross alpha, and lost $67.05 at 50/90 with only $0.16 gross
alpha. XLM lost $53.95 and $59.28 and also fails the 50/90 payoff boot.

Thus the old statement "VVV/PUMP fail rule 3" is not reproducible from the current code and locked
tape. The implemented risk change follows the measured bottlenecks rather than preserving that
premise.

## 4. Fee honesty

40/80 is not honest live economics while the Coinbase account is still on Intro 50/90. It is a
sensitivity row only. The backtest generates about $25,765 of average monthly filled notional, but
paper turnover does not move the real account's trailing-volume tier and public candles overstate
fill certainty. The cook must therefore use 50/90 until Coinbase itself shows the next tier.

Once real trailing 30-day volume clears $10,000 and Coinbase displays the lower tier, 40/80 is a
conservative sensitivity relative to 35/75, not a fact to apply early.

## 5. Ranked revenue improvements

| Rank | Change | Expected revenue effect | Evidence | Implementation risk |
|---:|---|---|---|---|
| 1 | Keep 20/3/50 as the edge; make Jev telemetry only | Avoids blocking deterministic breakout entries with unsupported labels | Direction is significantly inverted; stress is insignificant | Low; implemented with tests |
| 2 | Exclude PUMP and XLM | Removes negative books and makes 50/90 boot economically valid | Both net negative; PUMP has no gross edge; XLM fails 2-to-1 at 50/90 | Low; reversible config |
| 3 | Reduce ZEC $600 to $500 | Keeps its positive contribution while clearing rule 3 | DD falls to 13.57% at 40/80 and 13.92% at 50/90 | Low |
| 4 | Use 50/90 for the 24h cook | Prevents overstating live revenue before the real fee tier changes | $77.49 more fees than 40/80 over the replay | Low |
| 5 | Continue raw-label outcome collection | Establishes whether any Jev field has incremental breakout-conditioned value | Current live run has no trades; cold-pair samples are small | Low |
| 6 | Consider ranking/sizing only after a preregistered out-of-sample test | Potential capital allocation gain, but currently unsupported | Pooled rotation lost $100.12 and failed all three gate months | Medium to high |

No new Jev probability threshold, label inversion, rank weight, or sizing multiplier is justified.
Inverting `direction_bias` now would be threshold fitting to this sample.

## 6. Verification and 24h cook procedure

Completed without touching the running container:

- Merged `origin/main` into the working branch, no rebase.
- Focused strategy tests: 47 pass, 0 fail.
- Full backend: 236 pass, 0 fail.
- Web TypeScript: pass.
- Locked Jul/Aug/Sep replays: pass at both 40/80 sensitivity and 50/90 Intro.
- Current `/health`: run `5f55b8ab`, `book=breakout`, ten pre-change pairs, 40/80. The live process
  was not rebuilt.

After approval and merge, use these exact host steps for an honest 24h cook:

```powershell
# In .env, set exactly:
CB_BOOK=breakout
CB_PAIRS=UNI-USD,NEAR-USD,BCH-USD,SUI-USD,AVAX-USD,ARB-USD,VVV-USD,ZEC-USD
CB_MAKER_FEE_BPS=50
CB_TAKER_FEE_BPS=90

docker compose up -d --build cb
Invoke-RestMethod http://localhost:3001/health | ConvertTo-Json -Depth 5
docker compose logs --since 10m cb
```

Do not call `/reset`: retained decisions/outcomes are needed for the label comparison. Confirm
`book=breakout`, eight pairs, and 50/90 in `/health`; then leave the process running for 24 hours.
At the end, compare raw `market_regime`, `direction_bias`, `liquidity_stress`, and
`toxic_flow_risk` through `labelForwardH1`/`labelForwardH4`, plus the observed stress-veto fields.
Do not promote any label to execution from a single 24h read.
