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

export const JEV_MONTHLY_BUDGET_USD = 100;
export const JEV_TIMEOUT_MS = 8_000;

/** Stage 0 SHADOW is the only default. 1 and 2 are config, never implied. */
export type JevStage = 0 | 1 | 2;

export type AllocatorMode = "POOL" | "SILO";
export type ShareFormula = "equal" | "atr_scaled";
export type StrategyId = "combined" | "A" | "B" | "C";
export type VariantId = "jev_off" | "jev_veto" | "jev_select";

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
