export type TaxKind = "open" | "close" | "flip";

export interface TaxLine {
  id: string;
  tradedAt: number;
  pair: string;
  side: "buy" | "sell";
  size: number;
  price: number;
  notionalUsd: number;
  feeUsd: number;
  realizedUsd: number;
  kind: TaxKind;
  liquidity: "maker" | "taker";
  source: string;
}

export interface TaxLot {
  pair: string;
  openedAt: number;
  closedAt: number;
  side: "long" | "short";
  size: number;
  costBasisUsd: number;
  proceedsUsd: number;
  realizedUsd: number;
  holdMs: number;
}

export interface TaxPair {
  pair: string;
  fills: number;
  proceedsUsd: number;
  costBasisUsd: number;
  feesUsd: number;
  realizedUsd: number;
  openSize: number;
  openSide: "long" | "short" | "flat";
  openCostUsd: number;
}

export interface TaxMonth {
  month: string;
  fills: number;
  proceedsUsd: number;
  costBasisUsd: number;
  feesUsd: number;
  realizedUsd: number;
}

export interface TaxReport {
  generatedAt: number;
  venue: "paper";
  paper: boolean;
  firstTs: number | null;
  lastTs: number | null;
  inferenceUsd: number;
  gasUsd: number;
  totals: {
    fills: number;
    proceedsUsd: number;
    costBasisUsd: number;
    feesUsd: number;
    realizedUsd: number;
    openLots: number;
    openCostUsd: number;
  };
  pairs: TaxPair[];
  months: TaxMonth[];
  lots: TaxLot[];
  lines: TaxLine[];
}
