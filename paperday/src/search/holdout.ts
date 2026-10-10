/**
 * The holdout month is opened once. A second open throws.
 * Search never calls this. The file is the lock, so a new process cannot sneak a second look.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

export interface HoldoutLock {
  openedAt: string;
  purpose: string;
}

export function openHoldout(lockPath: string, now = new Date(), purpose = "search-v1"): HoldoutLock {
  if (existsSync(lockPath)) {
    const prev = readFileSync(lockPath, "utf8");
    throw new Error(`holdout already opened: ${prev.slice(0, 240)}`);
  }
  const lock: HoldoutLock = { openedAt: now.toISOString(), purpose };
  writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  return lock;
}
