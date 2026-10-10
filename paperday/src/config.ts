/**
 * Locked paper-day configuration (architecture v2, sections 10 and 11).
 * Jev's per-million-token price matches cb/config.ts `jevUsdPerMTok`.
 * This module does not read Coinbase order credentials.
 */

/** Repo value: cb/config.ts jevUsdPerMTok. A test asserts the two stay equal. */
export const JEV_USD_PER_MTOK = 0.042;

export const MAKER_FEE_BPS = 50;
export const TAKER_FEE_BPS = 90;
export const FILL_HAIRCUT = 0.5;
export const ENTRY_TIMEOUT_MS = 120_000;

export const STARTING_BUDGET_USD = 10_000;
export const RESERVE_USD = 2_000;
export const DEPLOYABLE_USD = 8_000;
export const BOOK_DRAWDOWN_HALT_USD = 8_000;
export const PAIR_LOSS_HALT_USD = 500;
export const DAILY_LOSS_HALT_USD = 900;

export const MAX_CONCURRENT = 2;
export const MAX_IDEAS_WEEKDAY = 3;
export const MAX_IDEAS_WEEKEND = 2;
export const CAUTION_MAX_CONCURRENT = 1;

export const TIME_STOP_MS = 60 * 60_000;
export const FLAT_BUFFER_MS = 60 * 60_000;
export const DATA_GAP_EXIT_SEC = 120;

/** Swing max hold and the overnight loss-to-stop cap. Forward paper stays off until Brian approves. */
export const SWING_MAX_HOLD_MS = 48 * 60 * 60_000;
export const OVERNIGHT_RISK_CAP_USD = 500;
export const SWING_APPROVED = false;

/** Repo 4h breakout knobs (Donchian / EMA / ATR / trail / 14-day hold). Not fitted. */
export const BREAKOUT_BARS = 20;
export const BREAKOUT_EMA_BARS = 50;
export const BREAKOUT_ATR_BARS = 14;
export const BREAKOUT_TRAIL_ATR = 3;
export const BREAKOUT_MAX_HOLD_MS = 1_209_600_000;

/**
 * Initial stop distances from the repo pair book. The breakout still has no
 * resting maker target, so these do not by themselves clear the fee floor.
 */
export const REPO_BREAKOUT_STOP_BPS: Record<string, number> = {
  "UNI-USD": 295,
  "NEAR-USD": 331,
  "BCH-USD": 242,
  "SUI-USD": 219,
  "AVAX-USD": 227,
  "ARB-USD": 390,
  "VVV-USD": 312,
  "ZEC-USD": 273,
};

export const JEV_MONTHLY_BUDGET_USD = 100;
export const JEV_TIMEOUT_MS = 8_000;

/** Stage 0 SHADOW is the only default. 1 and 2 are config, never implied. */
export type JevStage = 0 | 1 | 2;

export type AllocatorMode = "POOL" | "SILO";
export type ShareFormula = "equal" | "atr_scaled";
export type StrategyId = "combined" | "A" | "B" | "C";
export type RunStrategy =
  | "swing_A"
  | "swing_B"
  | "swing_C"
  | "swing_combined"
  | "repo_breakout_4h"
  | "intraday_research";
export type SentimentMode = "sentiment_blind" | "market_proxy";
export type VariantId = "jev_off" | "jev_veto" | "jev_select";

export function swingEntryAllowed(approved: boolean = SWING_APPROVED): boolean {
  return approved === true;
}

export const ENABLED_PAIRS = [
  "UNI-USD",
  "NEAR-USD",
  "BCH-USD",
  "SUI-USD",
  "AVAX-USD",
  "ARB-USD",
  "VVV-USD",
  "ZEC-USD",
] as const;

/**
 * Promotion thresholds written down before any forward sample is collected.
 * They are not fitted to the 2,182-row sample that failed.
 */
export const JEV_PROMOTION = {
  writtenAt: "2026-10-09",
  minClosedTradesEachVariant: 100,
  jevOnNetMustBeStrictlyGreater: true,
  jevOnMaxDrawdownMustNotWorsen: true,
  sample: "fresh forward paper only",
  excluded: "not the 2,182-row sample that failed",
} as const;

export const REPORT_HOST = "127.0.0.1";
export const REPORT_PORT = 3099;

export interface PaperConfig {
  jevStage: JevStage;
  /** Pinned model id. A different id on a review drops the stage to 0. */
  jevModelPinned: string;
  mode: AllocatorMode;
  formula: ShareFormula;
  strategy: StrategyId;
  kill: boolean;
  pairs: readonly string[];
}

export function defaultConfig(): PaperConfig {
  return {
    jevStage: 0,
    jevModelPinned: "jev-latest",
    mode: "POOL",
    formula: "equal",
    strategy: "combined",
    kill: false,
    pairs: [...ENABLED_PAIRS],
  };
}

export function feeRoundTripBps(): number {
  return MAKER_FEE_BPS + TAKER_FEE_BPS;
}
