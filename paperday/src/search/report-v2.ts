/**
 * search-v2.md. Holdout v1 is void. The page does not pick Jev over jev_off.
 */

import type { ClauseShare } from "../proxy";
import { btcClauseFlag } from "../proxy";
import type { SearchConfig } from "./grid";
import type { FoldMargin, RankedV2 } from "./rank-v2";

export interface CellWidth {
  cell: string;
  strategy: string;
  stopAtrMult: number | null;
  medianP50: number | null;
  dropped: boolean;
  perPair: Record<string, { n: number; p10: number | null; p50: number | null; p90: number | null }>;
}

export interface JevVariantReport {
  id: string;
  baseId: string;
  variant: "jev_veto" | "jev_select";
  vetoRule: "V1" | "V2" | "V3" | null;
  choiceCount: number;
  selectLabel: string;
  canWin: boolean;
  wins: boolean;
  margins: FoldMargin[];
  passShare: number;
  totalJevAfterCost: number;
  totalTwin: number;
  totalCostUsd: number;
  incomplete: boolean;
}

export interface SideRow {
  label: string;
  id: string;
  oosNetUsd: number | null;
  oosMaxDrawdownUsd: number | null;
  oosTrades: number | null;
  eR: number | null;
  pStar: number | null;
  positiveFolds: string;
  jevSpendUsd: number;
}

export interface SearchV2Report {
  gridVersion: string;
  gridHash: string;
  baseConfigs: number;
  baseBeforeDrops: number;
  droppedCells: string[];
  holdoutV1: string;
  candleHash: string;
  pairStarts: Array<{ pair: string; first: string; bars: number }>;
  foldCount: number;
  foldLines: string[];
  parity: { blind: number; proxy: number; searchBlind: number; searchProxy: number; pass: boolean };
  breakoutTrades: number | null;
  repoReplayNet: number | null;
  repoReplayTrades: number | null;
  repoDocNet: number;
  clauses: ClauseShare;
  cells: CellWidth[];
  ranked: RankedV2[];
  answerId: string | null;
  onlyBreakout: boolean;
  jevStatus: string;
  jevVariants: JevVariantReport[];
  jevCalls: number;
  jevTokens: number;
  jevPaidUsd: number;
  jevHits: number;
  priorProbeUsd: number;
  sides: SideRow[];
  top: RankedV2[];
  fillRate: { attempts: number; fills: number; timeouts: number };
  command: string;
  configHash: string | null;
  plannedStart: string;
}

function money(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "";
  return n.toFixed(2);
}

function num(n: number | null, digits = 3): string {
  if (n == null || !Number.isFinite(n)) return "";
  return n.toFixed(digits);
}

export function renderSearchV2(report: SearchV2Report): string {
  const flag = btcClauseFlag(report.clauses);
  const btcShare = report.clauses.pairDays > 0 ? report.clauses.btcPairDays / report.clauses.pairDays : 0;
  const lines: string[] = [];
  lines.push("# Search v2");
  lines.push("");
  lines.push("Holdout v1 is void: consumed, pre-contaminated. It is not evidence.");
  lines.push(`Grid version \`${report.gridVersion}\`. Hash \`${report.gridHash}\`.`);
  lines.push(`Base configs after the 6b drop: ${report.baseConfigs} (universe 114, cap 120).`);
  lines.push(`Dropped cells: ${report.droppedCells.length ? report.droppedCells.join(", ") : "none"}.`);
  lines.push(`Candle hash \`${report.candleHash}\`. Folds: ${report.foldCount}.`);
  lines.push("");
  lines.push("## Pair history");
  lines.push("");
  lines.push("| pair | first bar | 1m bars |");
  lines.push("|---|---|---:|");
  for (const row of report.pairStarts) lines.push(`| ${row.pair} | ${row.first} | ${row.bars} |`);
  lines.push("");
  lines.push("## Harness parity");
  lines.push("");
  lines.push(
    `Turn-1 6m swing_combined, 2× ATR, turn-1 target band, 48h, POOL equal, Chicago window on: sentiment-blind ${report.parity.blind} trades, market-proxy ${report.parity.proxy} trades. Expected 12 and 11. Search runWindow at the same defaults: blind ${report.parity.searchBlind}, proxy ${report.parity.searchProxy}. Pass: ${report.parity.pass}.`,
  );
  lines.push("");
  lines.push("## Folds");
  lines.push("");
  for (const line of report.foldLines) lines.push(`- ${line}`);
  lines.push("");
  lines.push("## Repo breakout sanity");
  lines.push("");
  lines.push(
    `Search rows closed ${report.breakoutTrades ?? "n/a"} trades across the two breakout allocators' out-of-sample folds (sum of the two rows, so a trade is not double-counted in the answer). Jul–Sep 2026 cb/breakout.ts replay net $${money(report.repoReplayNet)} on ${report.repoReplayTrades ?? "n/a"} trades. The repo doc is $${report.repoDocNet.toFixed(2)} at 50/90 on the book notionals. Gap $${money(report.repoReplayNet == null ? null : report.repoReplayNet - report.repoDocNet)}. Different sizing and fill model; the gap is not a pass/fail.`,
  );
  lines.push("");
  lines.push("## 6b stop widths");
  lines.push("");
  lines.push("Median across pairs of each pair's p50. A cell under 210 bps was dropped before the hash. No P&L was computed in that step.");
  lines.push("");
  lines.push("| cell | median p50 | dropped | per-pair p10 / p50 / p90 |");
  lines.push("|---|---:|---|---|");
  for (const cell of report.cells) {
    const pairs = Object.entries(cell.perPair)
      .map(([pair, w]) => `${pair} ${num(w.p10, 1)}/${num(w.p50, 1)}/${num(w.p90, 1)} (n=${w.n})`)
      .join("; ");
    lines.push(`| ${cell.cell} | ${num(cell.medianP50, 1)} | ${cell.dropped ? "yes" : "no"} | ${pairs} |`);
  }
  lines.push("");
  lines.push("## Proxy clauses");
  lines.push("");
  const share = (n: number) => (report.clauses.pairDays > 0 ? `${((n / report.clauses.pairDays) * 100).toFixed(1)}%` : "n/a");
  lines.push(`Pair-days ${report.clauses.pairDays}. Veto ${share(report.clauses.vetoPairDays)} (${report.clauses.vetoPairDays}). z-score <= -2 ${share(report.clauses.zScorePairDays)} (${report.clauses.zScorePairDays}). Crash candle ${share(report.clauses.crashPairDays)} (${report.clauses.crashPairDays}). BTC < 4h EMA50 with a negative 24h ${share(report.clauses.btcPairDays)} (${report.clauses.btcPairDays}).`);
  lines.push(flag ? "FLAG to Trader: the BTC < 4h EMA50 clause vetoes more than 40% of pair-days. No rule was changed." : `BTC-clause share ${(btcShare * 100).toFixed(1)}% is not above 40%. No flag.`);
  lines.push("");
  lines.push("## Leaderboard");
  lines.push("");
  if (report.onlyBreakout && report.answerId) {
    lines.push(`repo_breakout_4h is the only eligible winner. The answer is \`${report.answerId}\`.`);
  } else if (report.answerId) {
    lines.push(`Rank-1 eligible base: \`${report.answerId}\`.`);
  } else {
    lines.push("No base config passed eligibility. The selected config is null.");
  }
  lines.push("");
  lines.push("| rank | id | eligible | OOS net | DD | trades | qualified | E R | p* | folds + | why not |");
  lines.push("|---:|---|---|---:|---:|---:|---:|---:|---:|---|---|");
  report.top.forEach((row, i) => {
    const s = row.score;
    lines.push(
      `| ${i + 1} | ${s.id} | ${row.eligible ? "yes" : "no"} | ${money(s.oosNetUsd)} | ${money(s.oosMaxDrawdownUsd)} | ${s.oosTrades} | ${s.oosQualified} | ${num(s.eR)} | ${num(s.pStar)} | ${s.positiveFolds}/${s.foldCount} | ${row.eligible ? "" : row.reasons.join("; ")} |`,
    );
  });
  lines.push("");
  lines.push("## Per-fold counts for the top rows");
  lines.push("");
  for (const row of report.top.slice(0, 3)) {
    lines.push(`### ${row.score.id}`);
    lines.push("");
    lines.push("| fold | IS net | OOS net | OOS trades | OOS qualified | IS qualified |");
    lines.push("|---:|---:|---:|---:|---:|---:|");
    for (const fold of row.score.folds) {
      lines.push(`| ${fold.fold} | ${money(fold.isNetUsd)} | ${money(fold.oosNetUsd)} | ${fold.oosTrades} | ${fold.oosQualified} | ${fold.isQualified} |`);
    }
    lines.push("");
  }
  lines.push("## Jev");
  lines.push("");
  lines.push(report.jevStatus);
  lines.push(
    `Paid calls ${report.jevCalls}, tokens ${report.jevTokens}, paid spend $${report.jevPaidUsd.toFixed(8)}, cache hits ${report.jevHits}. Prior probe $${report.priorProbeUsd.toFixed(8)} counts toward the $25 cap and is not a v2 grid call.`,
  );
  lines.push("");
  if (report.jevVariants.length) {
    lines.push("| variant | base | choices | select | margin wins | after-cost net | twin net | cost | incomplete |");
    lines.push("|---|---|---:|---|---|---:|---:|---:|---|");
    for (const row of report.jevVariants) {
      lines.push(
        `| ${row.variant}${row.vetoRule ? " " + row.vetoRule : ""} | ${row.baseId} | ${row.choiceCount} | ${row.selectLabel} | ${row.wins ? "yes" : "no"} | ${money(row.totalJevAfterCost)} | ${money(row.totalTwin)} | ${row.totalCostUsd.toFixed(8)} | ${row.incomplete ? "yes" : "no"} |`,
      );
    }
    lines.push("");
    lines.push("### jev_veto margin versus that fold's inference cost");
    lines.push("");
    for (const row of report.jevVariants.filter((item) => item.variant === "jev_veto")) {
      lines.push(`#### ${row.id}`);
      lines.push("");
      lines.push("| fold | jev gross | twin | fold cost | margin | beats cost |");
      lines.push("|---:|---:|---:|---:|---:|---|");
      for (const fold of row.margins) {
        lines.push(`| ${fold.fold} | ${money(fold.jevGrossUsd)} | ${money(fold.twinUsd)} | ${fold.costUsd.toFixed(8)} | ${money(fold.marginUsd)} | ${fold.beats ? "yes" : "no"} |`);
      }
      lines.push("");
      lines.push(`Pass share ${(row.passShare * 100).toFixed(1)}%. Needs >= 60% and a higher total after cost.`);
      lines.push("");
    }
  }
  lines.push("## Side by side");
  lines.push("");
  lines.push("Best Jev, best jev_off, and the breakout baseline. This page does not pick between Jev and jev_off.");
  lines.push("");
  lines.push("| | id | OOS net | DD | trades | E R | p* | folds + | Jev spend |");
  lines.push("|---|---|---:|---:|---:|---:|---:|---|---:|");
  for (const row of report.sides) {
    lines.push(
      `| ${row.label} | ${row.id} | ${money(row.oosNetUsd)} | ${money(row.oosMaxDrawdownUsd)} | ${row.oosTrades ?? ""} | ${num(row.eR)} | ${num(row.pStar)} | ${row.positiveFolds} | ${row.jevSpendUsd.toFixed(8)} |`,
    );
  }
  lines.push("");
  lines.push("## Entries");
  lines.push("");
  const rate = report.fillRate.attempts > 0 ? report.fillRate.fills / report.fillRate.attempts : 0;
  lines.push(
    `Maker entry attempts ${report.fillRate.attempts}, fills ${report.fillRate.fills} (${(rate * 100).toFixed(1)}%), 120s cancels ${report.fillRate.timeouts}.`,
  );
  lines.push("");
  lines.push("## Holdout v2");
  lines.push("");
  lines.push(`Config hash \`${report.configHash ?? "none"}\`. Planned start: ${report.plannedStart}`);
  lines.push("The 30-day clock has not started. It starts when Brian runs the command on the home PC.");
  lines.push("");
  lines.push("```bash");
  lines.push(report.command);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}
