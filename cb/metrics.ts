/**
 * Backtest scorecard. Decision quality ignores fees. Execution compares net and gross.
 * Risk uses the equity path. Sub-second prints are not in the public candle tape.
 */

export interface HitRate {
  rate: number | null;
  n: number;
}

export interface EdgeScore {
  ratio: number | null;
  winRate: number | null;
  avgWin: number;
  avgLoss: number;
  n: number;
}

export interface DrawdownScore {
  /** Peak to trough, as a fraction of the peak. */
  maxDrawdown: number | null;
  /** Bars from that trough until equity retakes the peak. Null if it never does. */
  recoveryBars: number | null;
}

export interface CheckRow {
  area: string;
  metric: string;
  target: string;
  value: string;
  status: "pass" | "fail" | "unscored";
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

/** Correct direction over `ahead` bars. A long is correct when price rises. A flat is correct when it does not. */
export function directionalHitRate(long: boolean[], closes: number[], ahead: number): HitRate {
  if (ahead < 1) return { rate: null, n: 0 };
  let n = 0;
  let correct = 0;
  for (let i = 0; i + ahead < closes.length; i++) {
    const now = closes[i];
    const fut = closes[i + ahead];
    if (now == null || fut == null || !(now > 0)) continue;
    const up = fut > now;
    n += 1;
    if (long[i] ? up : !up) correct += 1;
  }
  return { rate: n > 0 ? correct / n : null, n };
}

/**
 * (average win * win rate) / (average loss * loss rate) on long calls, before fees.
 * Forward move is in bps of the close. Losses are stored as positive bps.
 */
export function predictiveEdge(long: boolean[], closes: number[], ahead: number): EdgeScore {
  const wins: number[] = [];
  const losses: number[] = [];
  if (ahead >= 1) {
    for (let i = 0; i + ahead < closes.length; i++) {
      if (!long[i]) continue;
      const now = closes[i];
      const fut = closes[i + ahead];
      if (now == null || fut == null || !(now > 0)) continue;
      const bps = ((fut - now) / now) * 10_000;
      if (bps > 0) wins.push(bps);
      else losses.push(-bps);
    }
  }
  const n = wins.length + losses.length;
  if (n === 0) return { ratio: null, winRate: null, avgWin: 0, avgLoss: 0, n: 0 };
  const winRate = wins.length / n;
  const lossRate = losses.length / n;
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = losses.length ? mean(losses) : 0;
  const den = avgLoss * lossRate;
  const ratio = den > 0 ? (avgWin * winRate) / den : wins.length > 0 ? Number.POSITIVE_INFINITY : null;
  return { ratio, winRate, avgWin, avgLoss, n };
}

/** 1 - fake-break entries / breakout signals. Null when there is no breakout signal. */
export function adverseAvoidance(breakoutSignals: number, fakeBreakEntries: number): number | null {
  if (!(breakoutSignals > 0)) return null;
  return 1 - fakeBreakEntries / breakoutSignals;
}

/** Net closed-trade pnl / gross closed-trade pnl. Null when gross is not positive. */
export function netToGross(netUsd: number, grossUsd: number): number | null {
  if (!(grossUsd > 0) || !Number.isFinite(netUsd)) return null;
  return netUsd / grossUsd;
}

/**
 * (mean bar return) / (downside deviation) * sqrt(bars per year). Risk-free rate is 0.
 * Downside deviation uses every bar, with positive returns contributing 0.
 */
export function sortinoRatio(equity: number[], barSec: number): number | null {
  if (equity.length < 3 || !(barSec > 0)) return null;
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1]!;
    const cur = equity[i]!;
    if (!(prev > 0)) continue;
    rets.push((cur - prev) / prev);
  }
  if (rets.length < 2) return null;
  const mu = mean(rets);
  const down = Math.sqrt(mean(rets.map((r) => (r < 0 ? r * r : 0))));
  if (!(down > 0)) return null;
  const periods = (365 * 24 * 3600) / barSec;
  return (mu / down) * Math.sqrt(periods);
}

export function maxDrawdown(equity: number[]): DrawdownScore {
  if (equity.length === 0) return { maxDrawdown: null, recoveryBars: null };
  let peak = equity[0]!;
  let maxDd = 0;
  let troughAt = 0;
  let peakForDd = peak;
  for (let i = 0; i < equity.length; i++) {
    const e = equity[i]!;
    if (e >= peak) peak = e;
    const dd = peak > 0 ? (peak - e) / peak : 0;
    if (dd > maxDd) {
      maxDd = dd;
      troughAt = i;
      peakForDd = peak;
    }
  }
  let recoveryBars: number | null = null;
  for (let j = troughAt + 1; j < equity.length; j++) {
    if (equity[j]! >= peakForDd) {
      recoveryBars = j - troughAt;
      break;
    }
  }
  return { maxDrawdown: maxDd, recoveryBars };
}

/** sqrt(N) * mean trade pnl / sample standard deviation. Null below 2 trades. */
export function systemQuality(pnls: number[]): number | null {
  if (pnls.length < 2) return null;
  const mu = mean(pnls);
  let acc = 0;
  for (const x of pnls) acc += (x - mu) ** 2;
  const sd = Math.sqrt(acc / (pnls.length - 1));
  if (!(sd > 0)) return null;
  return Math.sqrt(pnls.length) * (mu / sd);
}

export interface YieldSample {
  expectedBps: number;
  hurdleBps: number;
}

export interface HurdleProximity {
  refusals: number;
  cleared: number;
  /** Smallest amount a refused setup fell short, in bps. */
  closestGapBps: number | null;
  closest: YieldSample | null;
  medianGapBps: number | null;
}

export interface FeeTierResult {
  name: string;
  makerBps: number;
  takerBps: number;
  buffer: number;
  cleared: number;
}

/** How far yield-checked setups sat from the strict hurdle. */
export function hurdleProximity(samples: YieldSample[]): HurdleProximity {
  const refused = samples.filter((s) => !(s.expectedBps > s.hurdleBps));
  const gaps = refused.map((s) => s.hurdleBps - s.expectedBps).sort((a, b) => a - b);
  const closest = refused.reduce<YieldSample | null>((best, s) => {
    const gap = s.hurdleBps - s.expectedBps;
    if (!best || gap < best.hurdleBps - best.expectedBps) return s;
    return best;
  }, null);
  const mid = gaps.length ? gaps[Math.floor((gaps.length - 1) / 2)]! : null;
  return {
    refusals: refused.length,
    cleared: samples.length - refused.length,
    closestGapBps: gaps.length ? gaps[0]! : null,
    closest,
    medianGapBps: mid,
  };
}

/** Round-trip fee bps the median expected yield can pay at this buffer, after half the spread. */
export function breakevenRoundTripBps(expectedBps: number[], buffer: number, halfSpreadBps: number): number | null {
  if (!expectedBps.length || !(buffer > 0)) return null;
  const sorted = expectedBps.slice().sort((a, b) => a - b);
  const median = sorted[Math.floor((sorted.length - 1) / 2)]!;
  return median / buffer - halfSpreadBps;
}

export function feeTierClears(
  expectedBps: number[],
  tiers: Array<{ name: string; makerBps: number; takerBps: number; buffer: number; spreadBps: number }>,
): FeeTierResult[] {
  return tiers.map((tier) => {
    const hurdle = (tier.makerBps + tier.makerBps + Math.max(0, tier.spreadBps) / 2) * tier.buffer;
    return {
      name: tier.name,
      makerBps: tier.makerBps,
      takerBps: tier.takerBps,
      buffer: tier.buffer,
      cleared: expectedBps.filter((y) => y > hurdle).length,
    };
  });
}

function pct(rate: number | null): string {
  if (rate == null || !Number.isFinite(rate)) return "n/a";
  return `${(rate * 100).toFixed(1)}%`;
}

function num(x: number | null, d = 2): string {
  if (x == null || !Number.isFinite(x)) return "n/a";
  return x.toFixed(d);
}

export function evaluationChecklist(input: {
  hitRate1s: number | null;
  edge: number | null;
  netToGross: number | null;
  makerFillRate: number | null;
  sortino: number | null;
  sqn: number | null;
  trades: number;
}): CheckRow[] {
  const edgePass = input.edge != null && input.edge > 1.3;
  const netPass = input.netToGross != null && input.netToGross > 0.6;
  const sortinoPass = input.sortino != null && input.sortino > 2;
  const sqnPass = input.sqn != null && input.sqn > 2 && input.trades >= 100;
  return [
    {
      area: "Prediction",
      metric: "Directional hit rate, 1 second",
      target: "> 55%",
      value: input.hitRate1s == null ? "not in the candle tape" : pct(input.hitRate1s),
      status: input.hitRate1s == null ? "unscored" : input.hitRate1s > 0.55 ? "pass" : "fail",
    },
    {
      area: "Model edge",
      metric: "Expectancy ratio",
      target: "> 1.30",
      value: input.edge != null && !Number.isFinite(input.edge) ? "no losses" : num(input.edge),
      status: input.edge == null ? "unscored" : edgePass || input.edge === Number.POSITIVE_INFINITY ? "pass" : "fail",
    },
    {
      area: "Cost hurdle",
      metric: "Net to gross",
      target: "> 60% kept",
      value: input.trades === 0 ? "no trades cleared the hurdle" : pct(input.netToGross),
      status: input.trades === 0 ? "unscored" : netPass ? "pass" : "fail",
    },
    {
      area: "Execution",
      metric: "Post-only maker fill rate",
      target: "> 80%",
      value: input.makerFillRate == null ? "not in the candle tape" : pct(input.makerFillRate),
      status: input.makerFillRate == null ? "unscored" : input.makerFillRate > 0.8 ? "pass" : "fail",
    },
    {
      area: "Risk",
      metric: "Sortino ratio",
      target: "> 2.0",
      value: num(input.sortino),
      status: input.sortino == null ? "unscored" : sortinoPass ? "pass" : "fail",
    },
    {
      area: "Consistency",
      metric: "System quality number",
      target: "> 2.0 over at least 100 trades",
      value: input.sqn == null ? "n/a" : `${num(input.sqn)} over ${input.trades} trades`,
      status: input.sqn == null ? "unscored" : sqnPass ? "pass" : "fail",
    },
  ];
}
