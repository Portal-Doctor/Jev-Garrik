import { copyFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Copy JSONL mirrors into backup/YYYY-MM-DD. Returns the destination directory. */
export function backupJsonl(srcDir: string, backupRoot: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  const dest = join(backupRoot, day);
  mkdirSync(dest, { recursive: true });
  const names = readdirSync(srcDir).filter((n) => n.endsWith(".jsonl"));
  for (const name of names) {
    const from = join(srcDir, name);
    if (!statSync(from).isFile()) continue;
    copyFileSync(from, join(dest, name));
  }
  return dest;
}
