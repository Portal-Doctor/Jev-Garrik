# High-vol pair screen

Source: Coinbase Advanced Trade public SPOT products, quote USD, venue CBE.
Window: 2026-04-02T12:54:55.118Z to 2026-09-29T12:54:55.118Z (180 days, same as adoption).
Vol: sample stdev of completed 4-hour close-to-close simple returns, in bps, not annualized. Hourly Exchange candles, last open 4-hour bucket dropped.
Liquidity floor: 30-day USD notional (sum of hourly close times base volume) at or above live ARB-USD on this tape ($285,912,439).
Stables, wrappers, disabled listings, and non-USD quotes are dropped. The live six are ranked for reference and are not new candidates.
This file does not add pairs to the running 24h window.

ARB 30-day notional floor: $285,912,439.

The public SPOT index returned 250 products (one page). 113 were USD spot. Listings that are not CBE USD spot were dropped before the tape fetch. Live BCH-USD 30-day notional on this tape is $232,962,437, below the ARB floor. BCH stays because it is already live, not because it would pass a new-candidate liquidity cut.

## Kept candidates, ranked by 4h realized vol

| Rank | Pair | 4h vol bps | 30d notional | 4h bars | Why kept |
|---:|---|---:|---:|---:|---|
| 1 | USELESS-USD | 397.9 | $387,307,215 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 2 | VVV-USD | 312.0 | $376,373,072 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 3 | ZEC-USD | 273.2 | $4,772,140,110 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 4 | QNT-USD | 246.9 | $469,351,326 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 5 | PUMP-USD | 245.6 | $318,128,948 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 6 | ONDO-USD | 211.1 | $352,851,110 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 7 | XLM-USD | 189.3 | $461,305,175 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 8 | TAO-USD | 176.8 | $393,881,642 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 9 | HYPE-USD | 175.0 | $1,190,903,477 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 10 | ADA-USD | 156.9 | $556,623,509 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 11 | HBAR-USD | 140.7 | $381,080,757 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 12 | LINK-USD | 127.1 | $769,680,217 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 13 | XRP-USD | 121.5 | $4,933,518,959 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 14 | DOGE-USD | 121.2 | $689,414,395 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 15 | SOL-USD | 117.3 | $3,293,367,975 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 16 | LTC-USD | 108.4 | $375,687,641 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 17 | ETH-USD | 107.0 | $7,834,194,486 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |
| 18 | BTC-USD | 80.5 | $14,750,221,900 | 1080 | USD spot, not a stable or wrapper, 4h vol ranked, 30-day notional at or above ARB. |

## Live six, same definition

| Pair | 4h vol bps | 30d notional | 4h bars |
|---|---:|---:|---:|
| ARB-USD | 233.4 | $285,912,439 | 1080 |
| NEAR-USD | 227.6 | $1,201,830,366 | 1080 |
| UNI-USD | 198.1 | $657,082,857 | 1080 |
| SUI-USD | 170.8 | $843,234,662 | 1080 |
| BCH-USD | 163.5 | $232,962,437 | 1080 |
| AVAX-USD | 150.3 | $418,173,120 | 1080 |

## Dropped USD spot listings

| Pair | Reason | 4h vol bps | 30d or 24h USD | Note |
|---|---|---:|---:|---|
| AVT-USD | illiquid | 780.6 | $5,413,077 | 30-day notional below ARB-USD floor ($285912439). |
| NEON-USD | illiquid | 774.7 | $19,263,373 | 30-day notional below ARB-USD floor ($285912439). |
| KAIO-USD | illiquid | 672.0 | $8,773,297 | 30-day notional below ARB-USD floor ($285912439). |
| BLUECHIP-USD | illiquid | 636.2 | $6,875,486 | 30-day notional below ARB-USD floor ($285912439). |
| POND-USD | illiquid | 579.7 | $12,953,181 | 30-day notional below ARB-USD floor ($285912439). |
| CAP-USD | illiquid | 490.9 | $19,959,840 | 30-day notional below ARB-USD floor ($285912439). |
| APR-USD | illiquid | 473.5 | $11,666,084 | 30-day notional below ARB-USD floor ($285912439). |
| QI-USD | illiquid | 440.1 | $19,125,503 | 30-day notional below ARB-USD floor ($285912439). |
| DRV-USD | illiquid | 407.8 | $82,636,170 | 30-day notional below ARB-USD floor ($285912439). |
| AURORA-USD | illiquid | 371.5 | $37,486,009 | 30-day notional below ARB-USD floor ($285912439). |
| HOPR-USD | illiquid | 349.5 | $1,574,410 | 30-day notional below ARB-USD floor ($285912439). |
| HNT-USD | illiquid | 345.0 | $80,992,226 | 30-day notional below ARB-USD floor ($285912439). |
| COTI-USD | illiquid | 342.0 | $45,518,619 | 30-day notional below ARB-USD floor ($285912439). |
| EDGE-USD | illiquid | 334.3 | $15,978,397 | 30-day notional below ARB-USD floor ($285912439). |
| ORCA-USD | illiquid | 328.8 | $18,322,712 | 30-day notional below ARB-USD floor ($285912439). |
| KEYCAT-USD | illiquid | 305.0 | $3,888,955 | 30-day notional below ARB-USD floor ($285912439). |
| LIGHTER-USD | illiquid | 293.6 | $178,038,666 | 30-day notional below ARB-USD floor ($285912439). |
| GRASS-USD | illiquid | 286.0 | $11,507,637 | 30-day notional below ARB-USD floor ($285912439). |
| JTO-USD | illiquid | 281.8 | $37,375,723 | 30-day notional below ARB-USD floor ($285912439). |
| APE-USD | illiquid | 281.5 | $26,863,623 | 30-day notional below ARB-USD floor ($285912439). |
| WLD-USD | illiquid | 281.2 | $103,289,622 | 30-day notional below ARB-USD floor ($285912439). |
| DIMO-USD | illiquid | 278.9 | $2,629,561 | 30-day notional below ARB-USD floor ($285912439). |
| MET-USD | illiquid | 274.6 | $17,768,062 | 30-day notional below ARB-USD floor ($285912439). |
| XPL-USD | illiquid | 270.7 | $66,297,215 | 30-day notional below ARB-USD floor ($285912439). |
| CFG-USD | illiquid | 264.1 | $18,222,522 | 30-day notional below ARB-USD floor ($285912439). |
| STRK-USD | illiquid | 247.4 | $33,817,153 | 30-day notional below ARB-USD floor ($285912439). |
| ENA-USD | illiquid | 244.6 | $221,577,850 | 30-day notional below ARB-USD floor ($285912439). |
| TRUMP-USD | illiquid | 242.6 | $119,623,124 | 30-day notional below ARB-USD floor ($285912439). |
| DASH-USD | illiquid | 240.5 | $186,515,054 | 30-day notional below ARB-USD floor ($285912439). |
| FARTCOIN-USD | illiquid | 240.1 | $101,262,773 | 30-day notional below ARB-USD floor ($285912439). |
| ZORA-USD | illiquid | 237.0 | $49,124,121 | 30-day notional below ARB-USD floor ($285912439). |
| PLUME-USD | illiquid | 234.2 | $17,001,727 | 30-day notional below ARB-USD floor ($285912439). |
| RAY-USD | illiquid | 230.6 | $66,125,379 | 30-day notional below ARB-USD floor ($285912439). |
| ZRO-USD | illiquid | 228.7 | $38,571,329 | 30-day notional below ARB-USD floor ($285912439). |
| XCN-USD | illiquid | 226.7 | $50,967,577 | 30-day notional below ARB-USD floor ($285912439). |
| AKT-USD | illiquid | 225.9 | $25,880,300 | 30-day notional below ARB-USD floor ($285912439). |
| PYTH-USD | illiquid | 221.4 | $28,318,682 | 30-day notional below ARB-USD floor ($285912439). |
| ETHFI-USD | illiquid | 220.1 | $18,771,327 | 30-day notional below ARB-USD floor ($285912439). |
| AERO-USD | illiquid | 217.7 | $232,268,353 | 30-day notional below ARB-USD floor ($285912439). |
| INJ-USD | illiquid | 217.4 | $120,289,016 | 30-day notional below ARB-USD floor ($285912439). |
| MON-USD | illiquid | 216.8 | $70,829,550 | 30-day notional below ARB-USD floor ($285912439). |
| AMP-USD | illiquid | 213.8 | $13,308,945 | 30-day notional below ARB-USD floor ($285912439). |
| PRIME-USD | illiquid | 212.7 | $3,451,830 | 30-day notional below ARB-USD floor ($285912439). |
| KMNO-USD | illiquid | 209.5 | $7,966,761 | 30-day notional below ARB-USD floor ($285912439). |
| JUPITER-USD | illiquid | 209.2 | $29,097,233 | 30-day notional below ARB-USD floor ($285912439). |
| ZEN-USD | illiquid | 205.8 | $25,494,442 | 30-day notional below ARB-USD floor ($285912439). |
| MINA-USD | illiquid | 205.1 | $11,902,229 | 30-day notional below ARB-USD floor ($285912439). |
| PENDLE-USD | illiquid | 204.9 | $49,699,649 | 30-day notional below ARB-USD floor ($285912439). |
| LDO-USD | illiquid | 203.3 | $16,327,649 | 30-day notional below ARB-USD floor ($285912439). |
| TIA-USD | illiquid | 202.0 | $41,599,267 | 30-day notional below ARB-USD floor ($285912439). |
| VIRTUAL-USD | illiquid | 200.8 | $16,178,801 | 30-day notional below ARB-USD floor ($285912439). |
| WIF-USD | illiquid | 199.5 | $33,043,016 | 30-day notional below ARB-USD floor ($285912439). |
| PENGU-USD | illiquid | 198.2 | $126,024,326 | 30-day notional below ARB-USD floor ($285912439). |
| BONK-USD | illiquid | 196.7 | $69,852,427 | 30-day notional below ARB-USD floor ($285912439). |
| FET-USD | illiquid | 196.6 | $131,828,936 | 30-day notional below ARB-USD floor ($285912439). |
| FIL-USD | illiquid | 195.4 | $110,618,463 | 30-day notional below ARB-USD floor ($285912439). |
| OP-USD | illiquid | 193.9 | $42,552,967 | 30-day notional below ARB-USD floor ($285912439). |
| MORPHO-USD | illiquid | 191.5 | $49,929,088 | 30-day notional below ARB-USD floor ($285912439). |
| IP-USD | illiquid | 190.1 | $10,413,952 | 30-day notional below ARB-USD floor ($285912439). |
| SYRUP-USD | illiquid | 187.9 | $35,246,118 | 30-day notional below ARB-USD floor ($285912439). |
| PEPE-USD | illiquid | 182.9 | $121,587,206 | 30-day notional below ARB-USD floor ($285912439). |
| CRV-USD | illiquid | 182.8 | $75,753,387 | 30-day notional below ARB-USD floor ($285912439). |
| ICP-USD | illiquid | 182.0 | $114,541,733 | 30-day notional below ARB-USD floor ($285912439). |
| CVX-USD | illiquid | 179.1 | $12,078,746 | 30-day notional below ARB-USD floor ($285912439). |
| TON-USD | illiquid | 179.0 | $27,310,372 | 30-day notional below ARB-USD floor ($285912439). |
| APT-USD | illiquid | 176.0 | $59,999,821 | 30-day notional below ARB-USD floor ($285912439). |
| AAVE-USD | illiquid | 175.3 | $154,006,561 | 30-day notional below ARB-USD floor ($285912439). |
| CGLD-USD | illiquid | 171.2 | $3,308,454 | 30-day notional below ARB-USD floor ($285912439). |
| ALGO-USD | illiquid | 170.1 | $65,735,617 | 30-day notional below ARB-USD floor ($285912439). |
| GRT-USD | illiquid | 168.7 | $26,794,779 | 30-day notional below ARB-USD floor ($285912439). |
| RENDER-USD | illiquid | 165.5 | $73,838,914 | 30-day notional below ARB-USD floor ($285912439). |
| NMR-USD | illiquid | 164.2 | $13,350,220 | 30-day notional below ARB-USD floor ($285912439). |
| SEI-USD | illiquid | 162.9 | $62,885,212 | 30-day notional below ARB-USD floor ($285912439). |
| JASMY-USD | illiquid | 159.8 | $30,731,564 | 30-day notional below ARB-USD floor ($285912439). |
| VET-USD | illiquid | 155.6 | $28,136,257 | 30-day notional below ARB-USD floor ($285912439). |
| DOT-USD | illiquid | 152.1 | $153,505,846 | 30-day notional below ARB-USD floor ($285912439). |
| POL-USD | illiquid | 143.8 | $41,483,012 | 30-day notional below ARB-USD floor ($285912439). |
| SKY-USD | illiquid | 142.6 | $19,034,555 | 30-day notional below ARB-USD floor ($285912439). |
| SHIB-USD | illiquid | 140.7 | $28,288,949 | 30-day notional below ARB-USD floor ($285912439). |
| ATOM-USD | illiquid | 132.2 | $36,673,159 | 30-day notional below ARB-USD floor ($285912439). |
| ETC-USD | illiquid | 132.1 | $43,711,294 | 30-day notional below ARB-USD floor ($285912439). |
| MNDE-USD | illiquid | 130.1 | $3,421,209 | 30-day notional below ARB-USD floor ($285912439). |
| ASTER-USD | illiquid | 130.0 | $46,542,426 | 30-day notional below ARB-USD floor ($285912439). |
| CRO-USD | illiquid | 126.3 | $35,104,860 | 30-day notional below ARB-USD floor ($285912439). |
| FLR-USD | illiquid | 112.8 | $20,438,856 | 30-day notional below ARB-USD floor ($285912439). |
| BNB-USD | illiquid | 81.7 | $93,837,932 | 30-day notional below ARB-USD floor ($285912439). |
| PAXG-USD | illiquid | 47.5 | $49,811,954 | 30-day notional below ARB-USD floor ($285912439). |
| USDT-USD | stable | - | $85,015,925 | Stable or cash-pegged base. |
| CBETH-USD | wrapper | - | $1,382,771 | Wrapped, staked, or receipt token. |
