/**
 * Pre-registered grid v2. Base rows only, cap 120.
 * Allocators are POOL+atr_scaled and SILO+equal.
 * 1h: 4 strategies × stops 1.5/2/2.5 × targets 3R/4R × holds 24h/48h × 2 allocators = 96.
 * swing_4h: k 1/1.5 × targets 3R/4R × holds 48h/96h × 2 = 16.
 * repo_breakout_4h locked × 2 = 2.
 * Total 114 before the 6b stop-width drop. Jev variants are not rows in this file.
 */

import type { AllocatorMode, RunStrategy, ShareFormula } from "../config";
import { hashBytes, type SearchConfig, type SearchVariant, type VetoRule } from "./grid";

export const GRID_V2_CAP = 120;
export const STOP_FLOOR_BPS = 210;

export const V2_ALLOCATORS: Array<{ mode: AllocatorMode; formula: ShareFormula }> = [
  { mode: "POOL", formula: "atr_scaled" },
  { mode: "SILO", formula: "equal" },
];

export const V2_STRATEGIES_1H: RunStrategy[] = ["swing_A", "swing_B", "swing_C", "swing_combined"];
export const V2_STOPS_1H = [1.5, 2, 2.5] as const;
export const V2_STOPS_4H = [1, 1.5] as const;
export const V2_TARGETS = [3, 4] as const;
export const V2_HOLDS_1H = [24, 48] as const;
export const V2_HOLDS_4H = [48, 96] as const;

export interface GridFileV2 {
  version: 2;
  cap: number;
  baseBeforeDrops: number;
  bounding: string;
  holdoutV1: "consumed, pre-contaminated";
  hardLimitsNotSearched: string[];
  configs: SearchConfig[];
}

export const GRID_V2_BOUNDING =
  "114 base configs before the 6b drop: 96 one-hour swing rows (A/B/C/combined × stops 1.5/2/2.5 × targets 3R/4R × holds 24h/48h × POOL atr_scaled and SILO equal), 16 swing_4h rows (k 1.0/1.5 × 3R/4R × 48h/96h × the same two allocators; 96h approved before the hash), and 2 locked repo_breakout_4h rows. Cap 120. The runner refuses a larger file. Jev veto and jev_select are paired later, and only on eligible bases.";

function swingId(strategy: string, stop: number, target: number, hold: number, mode: string, formula: string): string {
  return `${strategy}|stop=${stop}|target=${target}|hold=${hold}|${mode}|${formula}|market_proxy|jev_off`;
}

function breakoutId(mode: string, formula: string): string {
  return `repo_breakout_4h|locked|${mode}|${formula}|market_proxy|jev_off`;
}

function row(
  id: string,
  strategy: RunStrategy,
  stop: number | null,
  target: number | null,
  hold: number | null,
  mode: AllocatorMode,
  formula: ShareFormula,
): SearchConfig {
  return {
    id,
    strategy,
    stopAtrMult: stop,
    targetR: target,
    maxHoldHours: hold,
    mode,
    formula,
    sentimentMode: "market_proxy",
    variant: "jev_off" satisfies SearchVariant,
    vetoRule: null satisfies VetoRule | null,
  };
}

/** Full 114-row universe. Drops are applied after the geometry scan, before the hash. */
export function buildGridV2Universe(): SearchConfig[] {
  const configs: SearchConfig[] = [];
  for (const strategy of V2_STRATEGIES_1H) {
    for (const stop of V2_STOPS_1H) {
      for (const target of V2_TARGETS) {
        for (const hold of V2_HOLDS_1H) {
          for (const alloc of V2_ALLOCATORS) {
            configs.push(row(swingId(strategy, stop, target, hold, alloc.mode, alloc.formula), strategy, stop, target, hold, alloc.mode, alloc.formula));
          }
        }
      }
    }
  }
  for (const stop of V2_STOPS_4H) {
    for (const target of V2_TARGETS) {
      for (const hold of V2_HOLDS_4H) {
        for (const alloc of V2_ALLOCATORS) {
          configs.push(row(swingId("swing_4h", stop, target, hold, alloc.mode, alloc.formula), "swing_4h", stop, target, hold, alloc.mode, alloc.formula));
        }
      }
    }
  }
  for (const alloc of V2_ALLOCATORS) {
    configs.push(row(breakoutId(alloc.mode, alloc.formula), "repo_breakout_4h", null, null, null, alloc.mode, alloc.formula));
  }
  return configs;
}

export function cellKey(strategy: string, stopAtrMult: number | null): string {
  if (strategy === "repo_breakout_4h" || stopAtrMult == null) return "repo_breakout_4h|locked";
  return `${strategy}|stop=${stopAtrMult}`;
}

export function configCell(cfg: Pick<SearchConfig, "strategy" | "stopAtrMult">): string {
  return cellKey(cfg.strategy, cfg.stopAtrMult);
}

/** Even counts use the mean of the two central values. An empty list is null, not a drop. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const xs = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  if (xs.length % 2 === 1) return xs[mid]!;
  return (xs[mid - 1]! + xs[mid]!) / 2;
}

/** True only when a median exists and is under 210 bps. A missing distribution is kept. */
export function dropCell(medianP50: number | null, floorBps = STOP_FLOOR_BPS): boolean {
  return medianP50 != null && medianP50 < floorBps;
}

export function applyCellDrops(configs: readonly SearchConfig[], droppedCells: readonly string[]): SearchConfig[] {
  const drop = new Set(droppedCells);
  return configs.filter((cfg) => !drop.has(configCell(cfg)));
}

export function assertGridCap(count: number, cap = GRID_V2_CAP): void {
  if (count > cap) throw new Error(`grid v2 refuses ${count} base configs; cap is ${cap}`);
}

const ALLOC_OK = new Set(V2_ALLOCATORS.map((a) => `${a.mode}|${a.formula}`));

export function validateGridV2(grid: GridFileV2): string[] {
  const problems: string[] = [];
  if (grid.version !== 2) problems.push("version");
  if (grid.holdoutV1 !== "consumed, pre-contaminated") problems.push("holdout v1 label");
  if (grid.configs.length > GRID_V2_CAP) problems.push(`count ${grid.configs.length} > ${GRID_V2_CAP}`);
  if (grid.configs.length === 0) problems.push("empty");
  const ids = new Set<string>();
  for (const cfg of grid.configs) {
    if (ids.has(cfg.id)) problems.push(`duplicate ${cfg.id}`);
    ids.add(cfg.id);
    if (cfg.variant !== "jev_off" || cfg.vetoRule != null) problems.push(`${cfg.id} jev row in the base file`);
    if (cfg.sentimentMode !== "market_proxy") problems.push(`${cfg.id} sentiment`);
    if (!ALLOC_OK.has(`${cfg.mode}|${cfg.formula}`)) problems.push(`${cfg.id} allocator`);
    if (cfg.strategy === "repo_breakout_4h") {
      if (cfg.stopAtrMult != null || cfg.targetR != null || cfg.maxHoldHours != null) problems.push(`${cfg.id} breakout knobs`);
    } else if (cfg.strategy === "swing_4h") {
      if (!V2_STOPS_4H.includes(cfg.stopAtrMult as (typeof V2_STOPS_4H)[number])) problems.push(`${cfg.id} 4h stop`);
      if (!V2_TARGETS.includes(cfg.targetR as (typeof V2_TARGETS)[number])) problems.push(`${cfg.id} 4h target`);
      if (!V2_HOLDS_4H.includes(cfg.maxHoldHours as (typeof V2_HOLDS_4H)[number])) problems.push(`${cfg.id} 4h hold`);
    } else if (V2_STRATEGIES_1H.includes(cfg.strategy)) {
      if (!V2_STOPS_1H.includes(cfg.stopAtrMult as (typeof V2_STOPS_1H)[number])) problems.push(`${cfg.id} 1h stop`);
      if (!V2_TARGETS.includes(cfg.targetR as (typeof V2_TARGETS)[number])) problems.push(`${cfg.id} 1h target`);
      if (!V2_HOLDS_1H.includes(cfg.maxHoldHours as (typeof V2_HOLDS_1H)[number])) problems.push(`${cfg.id} 1h hold`);
    } else problems.push(`${cfg.id} strategy`);
  }
  return problems;
}

export function gridFileV2(configs: SearchConfig[]): GridFileV2 {
  assertGridCap(configs.length);
  return {
    version: 2,
    cap: GRID_V2_CAP,
    baseBeforeDrops: 114,
    bounding: GRID_V2_BOUNDING,
    holdoutV1: "consumed, pre-contaminated",
    hardLimitsNotSearched: [
      "maker 50",
      "taker 90",
      "maker target and taker stop billing",
      "haircut 0.5",
      "drawdown halt 8000",
      "pair halt 500",
      "daily halt 900",
      "one position per pair",
      "max concurrent 2",
      "ideas per day 3 weekday, weekend half cap",
      "long only",
      "overnight risk cap 500",
      "paper only",
      "enabled pairs only",
    ],
    configs,
  };
}

export function hashGridFile(text: string): string {
  return hashBytes(text);
}
