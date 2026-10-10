/**
 * 30-day forward paper for the frozen holdout v2 config.
 * Paper only. Jev stage 0. No order endpoint.
 * The clock starts when this process is launched with the confirm flags.
 * `--dry-run` prints the plan and does not write a start time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ENABLED_PAIRS, SWING_APPROVED } from "./config";
import type { Candle } from "./bars";
import { fetchPublicCandles } from "./ingest";
import { assertLoopbackHost, assertSafeToStart } from "./safety";
import { REPORT_HOST } from "./config";
import { runBreakoutPaper } from "./breakout-paper";
import { runSwing, type HigherOpts } from "./higher";
import { runSwing4h } from "./swing4h";
import { buildMarketProxy } from "./proxy";
import type { SearchConfig } from "./search/grid";

const WINDOW_MS = 30 * 86_400_000;
const HOLD_PATH = join("paperday", "results", "holdout-v2.json");
const CLOCK_PATH = join("paperday", "results", "holdout-v2-clock.json");

export const FORWARD_COMMAND = "PAPERDAY_SWING_APPROVED=true PAPERDAY_FORWARD_CONFIRM=1 bun run paperday/src/forward-paper.ts";

interface HoldoutFile {
  answerId: string | null;
  gridHash: string;
  configHash: string | null;
  frozen: SearchConfig[];
  startedAt: null;
  windowDays: number;
  jevStage: 0;
}

export interface ForwardPlan {
  command: string;
  swingApprovedConstant: false;
  launchSwing: boolean;
  jevStage: 0;
  windowDays: 30;
  answerId: string | null;
  configHash: string | null;
  gridHash: string | null;
  paper: true;
  loopback: string;
  clockStarted: false;
}

export function loadHoldout(path = HOLD_PATH): HoldoutFile | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as HoldoutFile;
}

export function planForward(env: Record<string, string | undefined> = process.env, hold: HoldoutFile | null = loadHoldout()): ForwardPlan {
  return {
    command: FORWARD_COMMAND,
    swingApprovedConstant: SWING_APPROVED,
    launchSwing: env.PAPERDAY_SWING_APPROVED === "true",
    jevStage: 0,
    windowDays: 30,
    answerId: hold?.answerId ?? null,
    configHash: hold?.configHash ?? null,
    gridHash: hold?.gridHash ?? null,
    paper: true,
    loopback: REPORT_HOST,
    clockStarted: false,
  };
}

function answerConfig(hold: HoldoutFile): SearchConfig | null {
  if (!hold.answerId) return null;
  return hold.frozen.find((cfg) => cfg.id === hold.answerId) ?? null;
}

async function replay(cfg: SearchConfig, candles: Record<string, Candle[]>, btc: Candle[], fromMs: number, toMs: number): Promise<{ netUsd: number; trades: number }> {
  const proxy = buildMarketProxy(candles, btc, toMs);
  const opts: HigherOpts = {
    candles,
    fromMs,
    toMs,
    mode: cfg.mode,
    formula: cfg.formula,
    strategy: cfg.strategy,
    sentimentMode: "market_proxy",
    proxy,
    swingApproved: true,
    enabledPairs: ENABLED_PAIRS,
    variant: "jev_off",
    stopAtrMult: cfg.stopAtrMult ?? undefined,
    targetR: cfg.targetR ?? undefined,
    maxHoldMs: cfg.maxHoldHours != null ? cfg.maxHoldHours * 3_600_000 : undefined,
    activityWindow: false,
  };
  const result = cfg.strategy === "repo_breakout_4h" ? await runBreakoutPaper(opts) : cfg.strategy === "swing_4h" ? await runSwing4h(opts) : await runSwing(opts);
  return { netUsd: result.netUsd, trades: result.trades };
}

async function main(): Promise<void> {
  const safety = assertSafeToStart();
  if (!safety.ok) {
    console.error(safety.reason);
    process.exit(1);
  }
  assertLoopbackHost(REPORT_HOST);
  const dry = process.argv.includes("--dry-run");
  const hold = loadHoldout();
  if (dry) {
    console.log(JSON.stringify(planForward(process.env, hold), null, 2));
    return;
  }
  if (process.env.PAPERDAY_SWING_APPROVED !== "true" || process.env.PAPERDAY_FORWARD_CONFIRM !== "1") {
    console.error(`refusing to start. Run: ${FORWARD_COMMAND}`);
    process.exit(1);
  }
  if (!hold || !answerConfig(hold)) {
    console.error("refusing to start: holdout v2 has no selected config");
    process.exit(1);
  }
  if (existsSync(CLOCK_PATH)) {
    console.error(`forward paper already started: ${readFileSync(CLOCK_PATH, "utf8").slice(0, 240)}`);
    process.exit(1);
  }
  const cfg = answerConfig(hold)!;
  const startedAt = new Date().toISOString();
  const startedMs = Date.parse(startedAt);
  const endMs = startedMs + WINDOW_MS;
  mkdirSync(dirname(CLOCK_PATH), { recursive: true });
  writeFileSync(
    CLOCK_PATH,
    `${JSON.stringify({ startedAt, endAt: new Date(endMs).toISOString(), answerId: cfg.id, configHash: hold.configHash, gridHash: hold.gridHash, jevStage: 0, paper: true }, null, 2)}\n`,
  );
  console.log(`forward paper started at ${startedAt}. Jev stage 0. Paper only. Ends ${new Date(endMs).toISOString()}.`);
  const book: Record<string, Candle[]> = {};
  for (const pair of ENABLED_PAIRS) book[pair] = [];
  let btc: Candle[] = [];
  while (Date.now() < endMs) {
    const now = Date.now();
    for (const pair of ENABLED_PAIRS) {
      const fresh = await fetchPublicCandles(pair, startedMs, now);
      book[pair] = fresh;
    }
    btc = await fetchPublicCandles("BTC-USD", startedMs, now);
    const snap = await replay(cfg, book, btc, startedMs, now);
    writeFileSync(join("paperday", "results", "forward-status.json"), `${JSON.stringify({ asOf: new Date(now).toISOString(), netUsd: snap.netUsd, trades: snap.trades, jevStage: 0 }, null, 2)}\n`);
    const sleepMs = Math.min(3_600_000, endMs - Date.now());
    if (sleepMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}

if (import.meta.main) {
  main().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(message);
    process.exit(1);
  });
}
