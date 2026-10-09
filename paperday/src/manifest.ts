import {
  BOOK_DRAWDOWN_HALT_USD,
  DEPLOYABLE_USD,
  FILL_HAIRCUT,
  JEV_MONTHLY_BUDGET_USD,
  JEV_USD_PER_MTOK,
  MAKER_FEE_BPS,
  PAIR_LOSS_HALT_USD,
  RESERVE_USD,
  STARTING_BUDGET_USD,
  TAKER_FEE_BPS,
  type JevStage,
} from "./config";

export interface RunManifest {
  startedAt: string;
  gitSha: string;
  jevStage: JevStage;
  feeTier: "50/90";
  makerFeeBps: number;
  takerFeeBps: number;
  haircut: number;
  budgetUsd: number;
  reserveUsd: number;
  deployableUsd: number;
  drawdownHaltUsd: number;
  pairLossHaltUsd: number;
  jevMonthlyBudgetUsd: number;
  jevUsdPerMTok: number;
  mode: string;
  formula: string;
  strategy: string;
  variant: string;
  paper: true;
}

export function buildManifest(opts: {
  gitSha?: string;
  jevStage: JevStage;
  mode: string;
  formula: string;
  strategy: string;
  variant: string;
  now?: Date;
}): RunManifest {
  return {
    startedAt: (opts.now ?? new Date()).toISOString(),
    gitSha: opts.gitSha ?? "unknown",
    jevStage: opts.jevStage,
    feeTier: "50/90",
    makerFeeBps: MAKER_FEE_BPS,
    takerFeeBps: TAKER_FEE_BPS,
    haircut: FILL_HAIRCUT,
    budgetUsd: STARTING_BUDGET_USD,
    reserveUsd: RESERVE_USD,
    deployableUsd: DEPLOYABLE_USD,
    drawdownHaltUsd: BOOK_DRAWDOWN_HALT_USD,
    pairLossHaltUsd: PAIR_LOSS_HALT_USD,
    jevMonthlyBudgetUsd: JEV_MONTHLY_BUDGET_USD,
    jevUsdPerMTok: JEV_USD_PER_MTOK,
    mode: opts.mode,
    formula: opts.formula,
    strategy: opts.strategy,
    variant: opts.variant,
    paper: true,
  };
}
