/**
 * Pre-registered search space. The full cross of the declared dimensions is
 * 1,460 configs. The cap is 500, so this file is the bound, written before any run:
 * jev_off gets the full structural cross; jev_veto V1/V2/V3 and jev_select are
 * registered only at the default knobs (2× ATR, 3R, 48h) across every strategy
 * and allocator. sentiment_blind is not selectable.
 * Hard limits are not fields on a config.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { AllocatorMode, RunStrategy, ShareFormula } from "../config";

export const GRID_CAP = 500;
export const DEFAULT_STOP = 2;
export const DEFAULT_TARGET_R = 3;
export const DEFAULT_HOLD_HOURS = 48;

export const STOP_STEPS = [1.5, 2, 2.5] as const;
export const TARGET_STEPS = [2.5, 3, 4] as const;
export const HOLD_STEPS = [24, 48] as const;

export type VetoRule = "V1" | "V2" | "V3";
export type SearchVariant = "jev_off" | "jev_veto" | "jev_select";

export interface SearchConfig {
  id: string;
  strategy: RunStrategy;
  stopAtrMult: number | null;
  targetR: number | null;
  maxHoldHours: number | null;
  mode: AllocatorMode;
  formula: ShareFormula;
  sentimentMode: "market_proxy";
  variant: SearchVariant;
  vetoRule: VetoRule | null;
}

export interface GridFile {
  version: 1;
  cap: number;
  bounding: string;
  hardLimitsNotSearched: string[];
  defaults: { stopAtrMult: number; targetR: number; maxHoldHours: number };
  configs: SearchConfig[];
}

const ALLOCATORS: Array<{ mode: AllocatorMode; formula: ShareFormula }> = [
  { mode: "POOL", formula: "equal" },
  { mode: "POOL", formula: "atr_scaled" },
  { mode: "SILO", formula: "equal" },
  { mode: "SILO", formula: "atr_scaled" },
];

const SWING: RunStrategy[] = ["swing_A", "swing_B", "swing_C", "swing_combined"];

const JEV: Array<{ variant: SearchVariant; vetoRule: VetoRule | null }> = [
  { variant: "jev_veto", vetoRule: "V1" },
  { variant: "jev_veto", vetoRule: "V2" },
  { variant: "jev_veto", vetoRule: "V3" },
  { variant: "jev_select", vetoRule: null },
];

export const GRID_BOUNDING =
  "Full cross is 4 strategies x 3 stops x 3 targets x 2 holds x 4 allocators x 5 Jev variants, plus 4 breakout allocators x 5 Jev variants = 1460. Cap 500. jev_off uses the full structural cross (288 swing + 4 breakout). jev_veto V1/V2/V3 and jev_select are registered only at stop 2, target 3R, hold 48h, for every strategy and allocator (64 swing + 16 breakout). Total 372. sentiment_blind is not in the grid.";

function swingId(strategy: string, stop: number, target: number, hold: number, mode: string, formula: string, variant: string, veto: string | null): string {
  const tail = veto ? `${variant}|${veto}` : variant;
  return `${strategy}|stop=${stop}|target=${target}|hold=${hold}|${mode}|${formula}|market_proxy|${tail}`;
}

function breakoutId(mode: string, formula: string, variant: string, veto: string | null): string {
  const tail = veto ? `${variant}|${veto}` : variant;
  return `repo_breakout_4h|locked|${mode}|${formula}|market_proxy|${tail}`;
}

export function buildGridV1(): GridFile {
  const configs: SearchConfig[] = [];
  for (const strategy of SWING) {
    for (const stop of STOP_STEPS) {
      for (const target of TARGET_STEPS) {
        for (const hold of HOLD_STEPS) {
          for (const alloc of ALLOCATORS) {
            configs.push({
              id: swingId(strategy, stop, target, hold, alloc.mode, alloc.formula, "jev_off", null),
              strategy,
              stopAtrMult: stop,
              targetR: target,
              maxHoldHours: hold,
              mode: alloc.mode,
              formula: alloc.formula,
              sentimentMode: "market_proxy",
              variant: "jev_off",
              vetoRule: null,
            });
          }
        }
      }
    }
  }
  for (const alloc of ALLOCATORS) {
    configs.push({
      id: breakoutId(alloc.mode, alloc.formula, "jev_off", null),
      strategy: "repo_breakout_4h",
      stopAtrMult: null,
      targetR: null,
      maxHoldHours: null,
      mode: alloc.mode,
      formula: alloc.formula,
      sentimentMode: "market_proxy",
      variant: "jev_off",
      vetoRule: null,
    });
  }
  for (const strategy of SWING) {
    for (const alloc of ALLOCATORS) {
      for (const jev of JEV) {
        configs.push({
          id: swingId(strategy, DEFAULT_STOP, DEFAULT_TARGET_R, DEFAULT_HOLD_HOURS, alloc.mode, alloc.formula, jev.variant, jev.vetoRule),
          strategy,
          stopAtrMult: DEFAULT_STOP,
          targetR: DEFAULT_TARGET_R,
          maxHoldHours: DEFAULT_HOLD_HOURS,
          mode: alloc.mode,
          formula: alloc.formula,
          sentimentMode: "market_proxy",
          variant: jev.variant,
          vetoRule: jev.vetoRule,
        });
      }
    }
  }
  for (const alloc of ALLOCATORS) {
    for (const jev of JEV) {
      configs.push({
        id: breakoutId(alloc.mode, alloc.formula, jev.variant, jev.vetoRule),
        strategy: "repo_breakout_4h",
        stopAtrMult: null,
        targetR: null,
        maxHoldHours: null,
        mode: alloc.mode,
        formula: alloc.formula,
        sentimentMode: "market_proxy",
        variant: jev.variant,
        vetoRule: jev.vetoRule,
      });
    }
  }
  return {
    version: 1,
    cap: GRID_CAP,
    bounding: GRID_BOUNDING,
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
      "ideas per day 3 weekday",
      "long only",
      "overnight risk cap 500",
      "paper only",
      "enabled pairs only",
    ],
    defaults: { stopAtrMult: DEFAULT_STOP, targetR: DEFAULT_TARGET_R, maxHoldHours: DEFAULT_HOLD_HOURS },
    configs,
  };
}

export function hashBytes(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function validateGrid(grid: GridFile): string[] {
  const problems: string[] = [];
  if (grid.version !== 1) problems.push("version");
  if (grid.configs.length > GRID_CAP) problems.push(`count ${grid.configs.length} > ${GRID_CAP}`);
  if (grid.configs.length === 0) problems.push("empty");
  const ids = new Set<string>();
  for (const cfg of grid.configs) {
    if (ids.has(cfg.id)) problems.push(`duplicate ${cfg.id}`);
    ids.add(cfg.id);
    if (cfg.sentimentMode !== "market_proxy") problems.push(`${cfg.id} sentiment`);
    if (cfg.strategy === "repo_breakout_4h") {
      if (cfg.stopAtrMult != null || cfg.targetR != null || cfg.maxHoldHours != null) problems.push(`${cfg.id} breakout knobs are locked`);
    } else {
      if (!STOP_STEPS.includes(cfg.stopAtrMult as (typeof STOP_STEPS)[number])) problems.push(`${cfg.id} stop`);
      if (!TARGET_STEPS.includes(cfg.targetR as (typeof TARGET_STEPS)[number])) problems.push(`${cfg.id} target`);
      if (!HOLD_STEPS.includes(cfg.maxHoldHours as (typeof HOLD_STEPS)[number])) problems.push(`${cfg.id} hold`);
    }
    if (cfg.variant !== "jev_off") {
      const atDefault =
        cfg.strategy === "repo_breakout_4h" ||
        (cfg.stopAtrMult === DEFAULT_STOP && cfg.targetR === DEFAULT_TARGET_R && cfg.maxHoldHours === DEFAULT_HOLD_HOURS);
      if (!atDefault) problems.push(`${cfg.id} jev off the default knobs`);
      if (cfg.variant === "jev_veto" && cfg.vetoRule !== "V1" && cfg.vetoRule !== "V2" && cfg.vetoRule !== "V3") {
        problems.push(`${cfg.id} veto rule`);
      }
      if (cfg.variant === "jev_select" && cfg.vetoRule != null) problems.push(`${cfg.id} select has a veto rule`);
    } else if (cfg.vetoRule != null) problems.push(`${cfg.id} jev_off veto`);
    const banned = ["fee", "haircut", "halt", "pairList", "overnight"];
    for (const key of Object.keys(cfg)) {
      if (banned.some((word) => key.toLowerCase().includes(word))) problems.push(`${cfg.id} searched ${key}`);
    }
  }
  return problems;
}

export function loadGrid(path: string): { grid: GridFile; hash: string; bytes: Buffer } {
  const bytes = readFileSync(path);
  const hash = hashBytes(bytes);
  const grid = JSON.parse(bytes.toString("utf8")) as GridFile;
  const problems = validateGrid(grid);
  if (problems.length) throw new Error(`grid refused: ${problems.slice(0, 8).join("; ")}`);
  return { grid, hash, bytes };
}

export function assertConfigInGrid(grid: GridFile, id: string): SearchConfig {
  const found = grid.configs.find((cfg) => cfg.id === id);
  if (!found) throw new Error(`config not in grid: ${id}`);
  return found;
}

export interface SearchManifest {
  gridHash: string;
  gridPath: string;
  configCount: number;
  writtenAt: string;
}

/** Writes the manifest if this is the first start. Refuses a different hash. */
export function lockGrid(gridPath: string, manifestPath: string, now = new Date()): { grid: GridFile; hash: string; manifest: SearchManifest } {
  const { grid, hash } = loadGrid(gridPath);
  if (existsSync(manifestPath)) {
    const prev = JSON.parse(readFileSync(manifestPath, "utf8")) as SearchManifest;
    if (prev.gridHash !== hash) {
      throw new Error(`grid hash changed: manifest ${prev.gridHash} file ${hash}`);
    }
    return { grid, hash, manifest: prev };
  }
  const manifest: SearchManifest = {
    gridHash: hash,
    gridPath,
    configCount: grid.configs.length,
    writtenAt: now.toISOString(),
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return { grid, hash, manifest };
}

export function paramChanges(cfg: Pick<SearchConfig, "strategy" | "stopAtrMult" | "targetR" | "maxHoldHours">): number {
  if (cfg.strategy === "repo_breakout_4h") return 0;
  let n = 0;
  if (cfg.stopAtrMult !== DEFAULT_STOP) n += 1;
  if (cfg.targetR !== DEFAULT_TARGET_R) n += 1;
  if (cfg.maxHoldHours !== DEFAULT_HOLD_HOURS) n += 1;
  return n;
}

export function neighborsOf(cfg: SearchConfig, grid: GridFile): SearchConfig[] {
  if (cfg.strategy === "repo_breakout_4h" || cfg.stopAtrMult == null || cfg.targetR == null || cfg.maxHoldHours == null) return [];
  const out: SearchConfig[] = [];
  const stopI = STOP_STEPS.indexOf(cfg.stopAtrMult as (typeof STOP_STEPS)[number]);
  const targetI = TARGET_STEPS.indexOf(cfg.targetR as (typeof TARGET_STEPS)[number]);
  const holdI = HOLD_STEPS.indexOf(cfg.maxHoldHours as (typeof HOLD_STEPS)[number]);
  const steps: Array<Partial<SearchConfig>> = [];
  if (stopI > 0) steps.push({ stopAtrMult: STOP_STEPS[stopI - 1] });
  if (stopI >= 0 && stopI < STOP_STEPS.length - 1) steps.push({ stopAtrMult: STOP_STEPS[stopI + 1] });
  if (targetI > 0) steps.push({ targetR: TARGET_STEPS[targetI - 1] });
  if (targetI >= 0 && targetI < TARGET_STEPS.length - 1) steps.push({ targetR: TARGET_STEPS[targetI + 1] });
  if (holdI > 0) steps.push({ maxHoldHours: HOLD_STEPS[holdI - 1] });
  if (holdI >= 0 && holdI < HOLD_STEPS.length - 1) steps.push({ maxHoldHours: HOLD_STEPS[holdI + 1] });
  for (const step of steps) {
    const found = grid.configs.find(
      (other) =>
        other.strategy === cfg.strategy &&
        other.mode === cfg.mode &&
        other.formula === cfg.formula &&
        other.variant === cfg.variant &&
        other.vetoRule === cfg.vetoRule &&
        other.sentimentMode === cfg.sentimentMode &&
        other.stopAtrMult === (step.stopAtrMult ?? cfg.stopAtrMult) &&
        other.targetR === (step.targetR ?? cfg.targetR) &&
        other.maxHoldHours === (step.maxHoldHours ?? cfg.maxHoldHours),
    );
    if (found && found.id !== cfg.id) out.push(found);
  }
  return out;
}
