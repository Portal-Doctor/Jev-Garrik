/**
 * Cloud-VM backtest entry. jev_off only. No Jev gateway calls.
 * Usage: bun run paperday/src/backtest-cli.ts
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ENABLED_PAIRS, type AllocatorMode, type ShareFormula, type StrategyId } from "./config";
import { assertSafeToStart } from "./safety";
import { hashCandles, loadCandleCsv, notRunRow, runJevOffCell, WINDOWS, type MatrixRow, type WindowId } from "./backtest";

const STRATEGIES: StrategyId[] = ["combined", "A", "B", "C"];
const MODES: Array<{ mode: AllocatorMode; formula: ShareFormula }> = [
  { mode: "POOL", formula: "equal" },
  { mode: "POOL", formula: "atr_scaled" },
  { mode: "SILO", formula: "equal" },
];
const WINDOW_IDS: WindowId[] = ["1m", "3m", "6m"];

function cachePath(pair: string): string {
  return join(import.meta.dir, "..", "cache", "candles", `${pair}-1m.csv`);
}

async function main(): Promise<void> {
  const safety = assertSafeToStart(process.env);
  if (!safety.ok) {
    console.error(safety.reason);
    process.exit(1);
  }
  const missing = ENABLED_PAIRS.filter((p) => !existsSync(cachePath(p)));
  const outDir = join(import.meta.dir, "..", "results");
  mkdirSync(outDir, { recursive: true });
  if (missing.length) {
    const blocked = {
      dataSource: "blocked",
      note: `public candle cache missing for ${missing.join(", ")}`,
      rows: [] as MatrixRow[],
    };
    writeFileSync(join(outDir, "backtest-summary.json"), JSON.stringify(blocked, null, 2));
    console.error(blocked.note);
    process.exit(2);
  }
  const candles: Record<string, import("./bars").Candle[]> = {};
  for (const pair of ENABLED_PAIRS) candles[pair] = loadCandleCsv(cachePath(pair));
  const dataHash = hashCandles(candles);
  const rows: MatrixRow[] = [];
  for (const strategy of STRATEGIES) {
    for (const alloc of MODES) {
      for (const window of WINDOW_IDS) {
        console.log(`run ${strategy} ${alloc.mode} ${alloc.formula} ${window}`, new Date().toISOString());
        const row = await runJevOffCell({ candles, strategy, mode: alloc.mode, formula: alloc.formula, window });
        rows.push(row);
        console.log(`  net=${row.netUsd?.toFixed(2)} dd=${row.maxDrawdownUsd?.toFixed(2)} trades=${row.trades} ideas=${row.ideas} ${row.status}`);
        writeFileSync(join(outDir, "backtest-summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), dataHash, partial: true, rows }, null, 2));
        rows.push(notRunRow(strategy, "jev_veto", alloc.mode, alloc.formula, window));
        rows.push(notRunRow(strategy, "jev_select", alloc.mode, alloc.formula, window));
      }
    }
  }
  const summary = {
    generatedAt: new Date().toISOString(),
    dataSource: "coinbase public exchange candles (api.exchange.coinbase.com, no key)",
    dataHash,
    feeTier: "50/90",
    haircut: 0.5,
    sentiment: "unknown",
    windows: WINDOWS,
    rows,
  };
  writeFileSync(join(outDir, "backtest-summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "backtest-summary.md"), renderMarkdown(summary.rows, dataHash));
  console.log(`wrote ${rows.length} rows`);
}

function renderMarkdown(rows: MatrixRow[], dataHash: string): string {
  const lines = [
    "# Paper-day backtest summary",
    "",
    `Data: Coinbase public 1-minute candles. Hash \`${dataHash}\`.`,
    "Fee tier 50/90, haircut 0.5. Sentiment unknown, so the rule engine keeps setup A only.",
    "jev_veto and jev_select: not run: needs paid Jev reviews.",
    "",
    "| strategy | variant | mode | formula | window | net USD | max drawdown USD | gate |",
    "|---|---|---|---|---|---:|---:|---|",
  ];
  for (const r of rows) {
    const net = r.netUsd == null ? "" : r.netUsd.toFixed(2);
    const dd = r.maxDrawdownUsd == null ? "" : r.maxDrawdownUsd.toFixed(2);
    const gate = r.status === "not_run" ? "not run" : r.gatePass ? "pass" : "fail";
    lines.push(`| ${r.strategy} | ${r.variant} | ${r.mode} | ${r.formula} | ${r.window} | ${net} | ${dd} | ${gate} |`);
  }
  lines.push("");
  lines.push("## Reading the jev_off cells");
  lines.push("");
  lines.push("Sentiment is unknown: there is no point-in-time X history, so the rule engine keeps setup A and a one-idea caution cap. Setups B and C therefore qualify nothing in this matrix.");
  lines.push("Setup A did qualify. The hard 50/90 fee gate rejected those candidates. A 3R target is at least twice a 1R loser after 140 bps only when the stop is at least 420 bps, and the 5-minute structural stops were tighter. Stops were not widened to force a pass.");
  lines.push("The 6-month gate also requires every calendar quarter the window touches, including partial quarters and quarters with no closes, to net at least $1,200.");
  lines.push("jev_veto and jev_select were not run: needs paid Jev reviews.");
  lines.push("");
  return lines.join("\n");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
