/**
 * jev_off matrix. No gateway calls. Swing runs with the backtest approval flag;
 * forward paper does not.
 * Usage: bun run paperday/src/backtest-cli.ts
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ENABLED_PAIRS, type AllocatorMode, type RunStrategy, type SentimentMode, type ShareFormula } from "./config";
import { assertSafeToStart } from "./safety";
import {
  blockedJevNote,
  buildRunContext,
  hashCandles,
  loadCandleCsv,
  runJevOffCell,
  WINDOWS,
  type MatrixRow,
  type WidthStats,
  type WindowId,
} from "./backtest";

const STRATEGIES: RunStrategy[] = [
  "swing_A",
  "swing_B",
  "swing_C",
  "swing_combined",
  "repo_breakout_4h",
  "intraday_research",
];
const MODES: Array<{ mode: AllocatorMode; formula: ShareFormula }> = [
  { mode: "POOL", formula: "equal" },
  { mode: "POOL", formula: "atr_scaled" },
  { mode: "SILO", formula: "equal" },
  { mode: "SILO", formula: "atr_scaled" },
];
const WINDOW_IDS: WindowId[] = ["1m", "3m", "6m"];
const SENTIMENTS: SentimentMode[] = ["sentiment_blind", "market_proxy"];

function cachePath(pair: string): string {
  return join(import.meta.dir, "..", "cache", "candles", `${pair}-1m.csv`);
}

function fmt(n: number | null, digits = 2): string {
  return n == null ? "" : n.toFixed(digits);
}

function rejectsOf(row: MatrixRow): string {
  const parts = Object.entries(row.rejects).sort((a, b) => b[1] - a[1]);
  return parts.map(([k, v]) => `${k}:${v}`).join(" ");
}

function renderMarkdown(rows: MatrixRow[], dataHash: string): string {
  const lines = [
    "# Paper-day backtest summary",
    "",
    `Data: Coinbase public 1-minute candles, including BTC-USD for the market proxy. Hash \`${dataHash}\`.`,
    "Fee tier 50/90. Winner round trip 100 bps (maker target). Loser round trip 140 bps (taker stop or market exit). Haircut 0.5.",
    "Per-trade floor: (T − 100) ≥ 1.5 × (S + 140). Class p* = (S + 140) / (T + S − 40) ≤ 45%. Walk-forward E ≥ +0.15R or ≥ +25 bps in at least 2 of 3 splits.",
    "Required gate: eligible sample (12 / 40 / 100 closed trades), net > $0 in that window, expectancy met, max drawdown < $8,000, pair-loss and daily-loss halts never breached. A configuration passes only when 1m, 3m, and 6m all pass. The intraday arm is excluded.",
    "Target gate (not blocking): 1m ≥ $400, 3m ≥ $1,200, 6m ≥ $2,400, each full quarter ≥ $1,200, partial quarters prorated by days.",
    "sentiment-blind rows are an upper bound. market-proxy rows are a proxy, not an X read.",
    `Jev: ${blockedJevNote()}. Calls 0, tokens 0, spend $0. No mock was substituted.`,
    "",
    "| strategy | sentiment | mode | formula | window | trades | win rate | avg R | E R | E bps | p* | net USD | max DD | sample | required | target |",
    "|---|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.strategy} | ${r.sentimentMode} | ${r.mode} | ${r.formula} | ${r.window} | ${r.trades ?? ""} | ${fmt(r.winRate == null ? null : r.winRate * 100, 1)} | ${fmt(r.avgR, 3)} | ${fmt(r.eR, 3)} | ${fmt(r.eBps, 1)} | ${fmt(r.pStar == null ? null : r.pStar * 100, 1)} | ${fmt(r.netUsd)} | ${fmt(r.maxDrawdownUsd)} | ${r.sample} | ${r.requiredPass ? "pass" : "fail"} | ${r.targetPass ? "pass" : "fail"} |`,
    );
  }
  lines.push("");
  lines.push("## Rejects");
  lines.push("");
  lines.push("| strategy | sentiment | mode | formula | window | rejects |");
  lines.push("|---|---|---|---|---|---|");
  for (const r of rows) lines.push(`| ${r.strategy} | ${r.sentimentMode} | ${r.mode} | ${r.formula} | ${r.window} | ${rejectsOf(r)} |`);

  lines.push("");
  lines.push("## Required gate across 1m, 3m, and 6m");
  lines.push("");
  const groups = new Map<string, MatrixRow[]>();
  for (const r of rows) {
    if (r.strategy === "intraday_research") continue;
    const key = `${r.strategy}|${r.sentimentMode}|${r.mode}|${r.formula}`;
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  const passers: string[] = [];
  const failures: string[] = [];
  for (const [key, list] of groups) {
    const byWindow = new Map(list.map((r) => [r.window, r]));
    const ok = WINDOW_IDS.every((w) => byWindow.get(w)?.requiredPass === true);
    if (ok) passers.push(key);
    else {
      const why = WINDOW_IDS.map((w) => {
        const row = byWindow.get(w);
        if (!row) return `${w} missing`;
        if (row.requiredPass) return `${w} pass`;
        return `${w} ${row.requiredReasons.join("; ")}`;
      }).join(" | ");
      failures.push(`${key}: ${why}`);
    }
  }
  if (passers.length === 0) {
    lines.push("No swing or baseline configuration meets the required gate on all three windows.");
  } else {
    lines.push("Configurations that meet the required gate on all three windows:");
    for (const key of passers) lines.push(`- ${key}`);
  }
  lines.push("");
  lines.push("Target-gate result for those configurations is in the table above. None are listed when the required gate is empty.");
  lines.push("");
  lines.push("## Stop-width distribution (bps)");
  lines.push("");
  lines.push("Swing stops from the 6-month swing_combined, sentiment-blind, POOL equal run. This is max(1h swing-low distance, 2 × 1h ATR14), recorded before the fee floor, and it is not retuned.");
  lines.push("");
  lines.push("| pair | n | min | p25 | p50 | p75 | max | mean |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  const distRow = rows.find(
    (r) =>
      r.strategy === "swing_combined" &&
      r.sentimentMode === "sentiment_blind" &&
      r.mode === "POOL" &&
      r.formula === "equal" &&
      r.window === "6m",
  );
  const writeWidths = (widths: Record<string, WidthStats> | undefined) => {
    if (!widths) return;
    for (const pair of Object.keys(widths).sort()) {
      const s = widths[pair]!;
      lines.push(`| ${pair} | ${s.n} | ${fmt(s.min, 1)} | ${fmt(s.p25, 1)} | ${fmt(s.p50, 1)} | ${fmt(s.p75, 1)} | ${fmt(s.max, 1)} | ${fmt(s.mean, 1)} |`);
    }
  };
  writeWidths(distRow?.stopWidth);
  lines.push("");
  lines.push("Baseline repo_breakout_4h live stop (tighter of the repo book stop and 3 × 4h ATR), 6-month POOL equal, sentiment-blind. Every one of these signals is below_fee_floor because the strategy has no resting maker target.");
  lines.push("");
  lines.push("| pair | n | min | p25 | p50 | p75 | max | mean |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  const baseRow = rows.find(
    (r) => r.strategy === "repo_breakout_4h" && r.sentimentMode === "sentiment_blind" && r.mode === "POOL" && r.formula === "equal" && r.window === "6m",
  );
  writeWidths(baseRow?.stopWidth);
  lines.push("");
  lines.push("## Notes");
  lines.push("");
  lines.push("Parameters, the pair list, and the fee floor were frozen before this run. Nothing was changed after seeing the results.");
  lines.push("The repo 4h breakout exits on a 3×ATR trail or a 14-day market flat. Both are taker. There is no T in (T − 100), so those signals are rejected as below_fee_floor and are not given an invented target.");
  lines.push("Swing replaces the 60-minute time stop and the flat-by-midnight rule with a 48-hour max hold and a $500 overnight loss-to-stop cap. SWING_APPROVED stays false for forward paper.");
  lines.push(blockedJevNote());
  lines.push("");
  if (failures.length) {
    lines.push("<details><summary>Why each configuration missed the required gate</summary>");
    lines.push("");
    for (const line of failures) lines.push(`- ${line}`);
    lines.push("");
    lines.push("</details>");
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const safety = assertSafeToStart(process.env);
  if (!safety.ok) {
    console.error(safety.reason);
    process.exit(1);
  }
  if (process.env.AI_GATEWAY_API_KEY) {
    console.error("AI_GATEWAY_API_KEY is set. This CLI does not spend it. Task 9 is a separate path and was not started here.");
  }
  const needed = [...ENABLED_PAIRS, "BTC-USD"];
  const missing = needed.filter((p) => !existsSync(cachePath(p)));
  const outDir = join(import.meta.dir, "..", "results");
  mkdirSync(outDir, { recursive: true });
  if (missing.length) {
    const blocked = { dataSource: "blocked", note: `public candle cache missing for ${missing.join(", ")}`, rows: [] as MatrixRow[] };
    writeFileSync(join(outDir, "backtest-summary.json"), JSON.stringify(blocked, null, 2));
    console.error(blocked.note);
    process.exit(2);
  }
  const candles: Record<string, import("./bars").Candle[]> = {};
  for (const pair of ENABLED_PAIRS) candles[pair] = loadCandleCsv(cachePath(pair));
  const btc = loadCandleCsv(cachePath("BTC-USD"));
  const hashed = { ...candles, "BTC-USD": btc };
  const dataHash = hashCandles(hashed);
  writeFileSync(join(outDir, "candle-hash.txt"), `${dataHash}\n`);
  console.log(`candle hash ${dataHash}`, new Date().toISOString());
  console.log("preparing swing bars and market proxy");
  const ctx = buildRunContext(candles, btc);
  const rows: MatrixRow[] = [];
  for (const strategy of STRATEGIES) {
    for (const alloc of MODES) {
      for (const sentimentMode of SENTIMENTS) {
        for (const window of WINDOW_IDS) {
          console.log(`run ${strategy} ${alloc.mode} ${alloc.formula} ${sentimentMode} ${window}`, new Date().toISOString());
          const row = await runJevOffCell({ ctx, strategy, mode: alloc.mode, formula: alloc.formula, window, sentimentMode });
          rows.push(row);
          console.log(
            `  net=${row.netUsd?.toFixed(2)} dd=${row.maxDrawdownUsd?.toFixed(2)} trades=${row.trades} ideas=${row.ideas} sample=${row.sample} required=${row.requiredPass} target=${row.targetPass}`,
          );
          writeFileSync(
            join(outDir, "backtest-summary.json"),
            JSON.stringify({ generatedAt: new Date().toISOString(), dataHash, partial: true, jev: blockedJevNote(), rows }, null, 2),
          );
        }
      }
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    dataSource: "coinbase public exchange candles (api.exchange.coinbase.com, no key)",
    dataHash,
    feeTier: "50/90",
    fWinBps: 100,
    fLossBps: 140,
    haircut: 0.5,
    jev: blockedJevNote(),
    jevCalls: 0,
    jevTokens: 0,
    jevSpendUsd: 0,
    windows: WINDOWS,
    rows,
  };
  writeFileSync(join(outDir, "backtest-summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "backtest-summary.md"), renderMarkdown(rows, dataHash));
  console.log(`wrote ${rows.length} rows hash ${dataHash}`);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
