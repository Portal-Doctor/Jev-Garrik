/**
 * search-v1.md. The best Jev config and the best jev_off config are shown
 * side by side. This file does not pick a winner.
 */

import type { SearchConfig } from "./grid";
import type { JevCoverage } from "./jev";
import { decayOf, eligibility, type ConfigScore, type FoldPick, type Ranked } from "./rank";

export interface EvalSnap {
  id: string;
  netUsd: number;
  maxDrawdownUsd: number;
  trades: number;
  eR: number | null;
  eBps: number | null;
  pStar: number | null;
  jevSpendUsd: number;
  requiredPass: boolean | null;
  requiredReasons: string[];
  targetPass: boolean | null;
  targetReasons: string[];
  pairHalt: boolean;
  dailyHalt: boolean;
}

export interface SearchReportInput {
  gridHash: string;
  configCount: number;
  bounding: string;
  jevOffExecuted: number;
  ranked: Ranked[];
  ineligibleTop: ConfigScore[];
  selected: Ranked | null;
  bestJevOff: ConfigScore | null;
  bestBreakout: ConfigScore | null;
  foldPicks: FoldPick[];
  holdoutOpenedAt: string | null;
  holdout: {
    selected: EvalSnap | null;
    jevOff: EvalSnap | null;
    breakout: EvalSnap | null;
  };
  selectedWindows: Record<"1m" | "3m" | "6m", EvalSnap> | null;
  coverage: JevCoverage & { reason: string | null };
  droppedForStability: Array<{ id: string; neighborMean: number | null; oosNetUsd: number }>;
}

function num(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "";
  return n.toFixed(digits);
}

function pct(n: number | null): string {
  return n == null ? "" : `${(n * 100).toFixed(1)}%`;
}

function cell(score: ConfigScore | null, field: "oos" | "dd" | "trades" | "e" | "spend"): string {
  if (!score) return "not run";
  if (field === "oos") return num(score.oosNetUsd);
  if (field === "dd") return num(score.oosMaxDrawdownUsd);
  if (field === "trades") return String(score.oosTrades);
  if (field === "spend") return num(score.jevSpendUsd, 4);
  const e = score.eR == null ? "" : `${num(score.eR, 3)}R`;
  const bps = score.eBps == null ? "" : `${num(score.eBps, 1)} bps`;
  return [e, bps].filter(Boolean).join(" / ");
}

function holdCell(snap: EvalSnap | null): string {
  if (!snap) return "not run";
  return num(snap.netUsd);
}

export function renderSearchReport(input: SearchReportInput): string {
  const lines: string[] = [];
  lines.push("# Search v1");
  lines.push("");
  lines.push(`Grid sha256 \`${input.gridHash}\`.`);
  lines.push(`Configs in the pre-registered file: ${input.configCount}.`);
  lines.push(input.bounding);
  lines.push(`jev_off configs executed: ${input.jevOffExecuted}.`);
  lines.push("sentiment_blind is not in the grid. It is an upper bound from the turn-1 matrix, not a selectable mode.");
  lines.push("Hard limits were not search dimensions: 50/90 fees, maker target and taker stop billing, haircut 0.5, drawdown halt $8,000, pair halt $500, daily halt $900, one position per pair, 2 concurrent, 3 ideas per weekday, long only, overnight risk cap $500, paper only, the enabled pair list.");
  lines.push("Jev veto and jev_select rows are registered only at stop 2, target 3R, and hold 48h. Those rows have no one-step neighbors inside the grid, so the stability guard cannot select them.");
  lines.push("");
  lines.push("## Leaderboard");
  lines.push("");
  if (input.ranked.length === 0) {
    lines.push("No config passed eligibility and the neighbor stability guard. The selected config is null.");
    if (input.ineligibleTop.length > 0 && input.ineligibleTop.every((score) => score.oosTrades === 0 && score.oosNetUsd === 0)) {
      lines.push("Every row in this table has 0 closed OOS trades and an OOS net of $0. The order is the id tie-break, not a revenue ranking.");
    }
    lines.push("");
    lines.push("Highest OOS net among executed configs (not eligible):");
    lines.push("");
    lines.push("| rank | id | OOS net | max DD | trades | E R | E bps | p* | IS net | decay |");
    lines.push("|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|");
    input.ineligibleTop.slice(0, 10).forEach((score, i) => {
      const d = decayOf(score);
      const why = eligibility(score).reasons.join("; ");
      lines.push(
        `| ${i + 1} | ${score.id} | ${num(score.oosNetUsd)} | ${num(score.oosMaxDrawdownUsd)} | ${score.oosTrades} | ${num(score.eR, 3)} | ${num(score.eBps, 1)} | ${pct(score.pStar)} | ${num(d.isNetUsd)} | ${num(d.decayUsd)} |`,
      );
      if (why) lines.push(`| | ${why} | | | | | | | | |`);
    });
  } else {
    lines.push("| rank | id | OOS net | max DD | trades | E R | E bps | p* | IS net | decay | neighbor mean | param changes |");
    lines.push("|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    input.ranked.slice(0, 10).forEach((row, i) => {
      const d = decayOf(row.score);
      lines.push(
        `| ${i + 1} | ${row.score.id} | ${num(row.score.oosNetUsd)} | ${num(row.score.oosMaxDrawdownUsd)} | ${row.score.oosTrades} | ${num(row.score.eR, 3)} | ${num(row.score.eBps, 1)} | ${pct(row.score.pStar)} | ${num(d.isNetUsd)} | ${num(d.decayUsd)} | ${num(row.neighborMeanOos)} | ${row.paramChanges} |`,
      );
    });
  }
  lines.push("");
  lines.push("## In-sample picks");
  lines.push("");
  lines.push("Each fold picks the executed config with the highest in-sample net, then records that config's OOS net for the fold. A config's OOS score used for ranking is the sum of its own three OOS months.");
  lines.push("");
  lines.push("| fold | id | IS net | OOS net |");
  lines.push("|---:|---|---:|---:|");
  for (const pick of input.foldPicks) {
    lines.push(`| ${pick.fold} | ${pick.id} | ${num(pick.isNetUsd)} | ${num(pick.oosNetUsd)} |`);
  }
  lines.push("");
  lines.push("## Selected config");
  lines.push("");
  if (!input.selected) {
    lines.push("Selected config: null.");
    lines.push("No eligible config survived the neighbor guard. That is the result of the pre-registered procedure.");
  } else {
    lines.push(`Selected config: \`${input.selected.score.id}\`.`);
    lines.push(`OOS net ${num(input.selected.score.oosNetUsd)}, max DD ${num(input.selected.score.oosMaxDrawdownUsd)}, trades ${input.selected.score.oosTrades}, neighbor mean ${num(input.selected.neighborMeanOos)}.`);
  }
  if (input.droppedForStability.length) {
    lines.push("");
    lines.push("Eligible configs dropped by the neighbor guard:");
    for (const row of input.droppedForStability.slice(0, 10)) {
      lines.push(`- ${row.id}: neighbor mean ${row.neighborMean == null ? "none" : num(row.neighborMean)}, OOS net ${num(row.oosNetUsd)}`);
    }
  }
  lines.push("");
  lines.push("## Jev vs jev_off vs baseline");
  lines.push("");
  lines.push("The best Jev config and the best jev_off config are side by side. This report does not pick between them. Brian decides if jev_off wins.");
  lines.push("");
  const offEligible = input.bestJevOff ? eligibility(input.bestJevOff).pass : false;
  const brkEligible = input.bestBreakout ? eligibility(input.bestBreakout).pass : false;
  lines.push(`Best jev_off by OOS net: ${input.bestJevOff ? `\`${input.bestJevOff.id}\`` : "none"} (${offEligible ? "eligible" : "not eligible"}).`);
  lines.push(`Best repo_breakout_4h by OOS net: ${input.bestBreakout ? `\`${input.bestBreakout.id}\`` : "none"} (${brkEligible ? "eligible" : "not eligible"}).`);
  lines.push("Best Jev config: not run. No Jev row is filled in.");
  if (input.bestJevOff && input.bestBreakout && input.bestJevOff.id === input.bestBreakout.id) {
    lines.push("The jev_off and baseline columns name the same config because the OOS nets tied and the id order placed this row first. That is not a choice between them.");
  }
  lines.push("");
  lines.push("| | best Jev | best jev_off | best repo_breakout_4h |");
  lines.push("|---|---|---|---|");
  lines.push(`| OOS net | not run | ${cell(input.bestJevOff, "oos")} | ${cell(input.bestBreakout, "oos")} |`);
  lines.push(`| holdout net | not run | ${holdCell(input.holdout.jevOff)} | ${holdCell(input.holdout.breakout)} |`);
  lines.push(`| max DD | not run | ${cell(input.bestJevOff, "dd")} | ${cell(input.bestBreakout, "dd")} |`);
  lines.push(`| trades | not run | ${cell(input.bestJevOff, "trades")} | ${cell(input.bestBreakout, "trades")} |`);
  lines.push(`| E | not run | ${cell(input.bestJevOff, "e")} | ${cell(input.bestBreakout, "e")} |`);
  lines.push(`| Jev spend | ${num(input.coverage.spentUsd, 4)} | ${cell(input.bestJevOff, "spend")} | ${cell(input.bestBreakout, "spend")} |`);
  lines.push("");
  if (input.selected && input.bestBreakout) {
    const beats = input.selected.score.oosNetUsd > input.bestBreakout.oosNetUsd;
    lines.push(
      beats
        ? `The selected config's OOS net is above the best repo_breakout_4h OOS net (${num(input.bestBreakout.oosNetUsd)}).`
        : `The selected config's OOS net is not above the best repo_breakout_4h OOS net (${num(input.bestBreakout.oosNetUsd)}).`,
    );
  } else if (!input.selected) {
    lines.push("No selected config, so the breakout comparison has nothing to score.");
  }
  lines.push("");
  lines.push("## Holdout");
  lines.push("");
  if (!input.holdoutOpenedAt) {
    lines.push("Holdout was not opened.");
  } else {
    lines.push(`Holdout opened once at ${input.holdoutOpenedAt}.`);
    lines.push("The month is 2026-09-09 through 2026-10-09. Search code did not read those bars.");
    const rows: Array<[string, EvalSnap | null]> = [
      ["selected", input.holdout.selected],
      ["best jev_off", input.holdout.jevOff],
      ["best repo_breakout_4h", input.holdout.breakout],
    ];
    lines.push("");
    lines.push("| run | id | net | max DD | trades | E R | p* |");
    lines.push("|---|---|---:|---:|---:|---:|---:|");
    for (const [label, snap] of rows) {
      if (!snap) {
        lines.push(`| ${label} | | not run | | | | |`);
        continue;
      }
      const ok = snap.netUsd > 0 && snap.maxDrawdownUsd < 8_000 && !snap.pairHalt && !snap.dailyHalt;
      lines.push(
        `| ${label} | ${snap.id} | ${num(snap.netUsd)} | ${num(snap.maxDrawdownUsd)} | ${snap.trades} | ${num(snap.eR, 3)} | ${pct(snap.pStar)} |`,
      );
      lines.push(`| | holdout net > 0, DD < 8000, halts clear: ${ok ? "pass" : "miss"} | | | | | |`);
    }
  }
  lines.push("");
  lines.push("## Selected config, 1m / 3m / 6m");
  lines.push("");
  if (!input.selected || !input.selectedWindows) {
    lines.push("N/A. No config was selected, so the 1m, 3m, and 6m windows were not run.");
    lines.push("The $1,200 per quarter pace is N/A.");
  } else {
    lines.push("These windows end 2026-10-09 and include the holdout month. They were run inside the single holdout open.");
    lines.push("");
    lines.push("| window | net | max DD | trades | required | target pace |");
    lines.push("|---|---:|---:|---:|---|---|");
    for (const window of ["1m", "3m", "6m"] as const) {
      const snap = input.selectedWindows[window];
      lines.push(
        `| ${window} | ${num(snap.netUsd)} | ${num(snap.maxDrawdownUsd)} | ${snap.trades} | ${snap.requiredPass ? "pass" : "fail"} | ${snap.targetPass ? "pass" : "miss"} |`,
      );
      if (snap.requiredReasons.length) lines.push(`| | required: ${snap.requiredReasons.join("; ")} | | | | |`);
      if (snap.targetReasons.length) lines.push(`| | pace: ${snap.targetReasons.join("; ")} | | | | |`);
    }
    const pace = (["1m", "3m", "6m"] as const).every((w) => input.selectedWindows![w].targetPass === true);
    lines.push("");
    lines.push(pace ? "The $1,200 per quarter pace passes on 1m, 3m, and 6m." : "The $1,200 per quarter pace misses.");
  }
  lines.push("");
  lines.push("## Jev spend and coverage");
  lines.push("");
  lines.push(`Model id \`${input.coverage.model}\`. Cap $${input.coverage.capUsd}. Spent $${num(input.coverage.spentUsd, 4)}. Calls ${input.coverage.calls}. Cache hits ${input.coverage.hits}. Tokens ${input.coverage.tokens}.`);
  lines.push(`Jev configs in the grid: ${input.coverage.jevConfigs}. Executed: ${input.coverage.executed}. Cap stopped the run: ${input.coverage.stopped ? "yes" : "no"}.`);
  if (input.coverage.reason) lines.push(input.coverage.reason);
  lines.push("No mock review was written into a reported row.");
  lines.push("");
  lines.push("## Forward paper");
  lines.push("");
  lines.push("Jev stage stays 0 and SWING_APPROVED stays false. A blocked Jev run does not change those defaults.");
  lines.push("");
  return lines.join("\n");
}

export function selectedBeatsBreakout(selected: Ranked | null, breakout: ConfigScore | null): boolean | null {
  if (!selected || !breakout) return null;
  return selected.score.oosNetUsd > breakout.oosNetUsd;
}

export function configLabel(cfg: SearchConfig): string {
  return cfg.id;
}
