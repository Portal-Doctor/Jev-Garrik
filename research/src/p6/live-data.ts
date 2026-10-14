/**
 * Context files for the live host. Paths are relative to this module, the
 * process working directory, or the repo beside it. Nothing here walks up
 * looking for .git. A missing file is unavailable, not a thrown error.
 *
 * The lookup is hidden from the Next file tracer. A static path under
 * research/data would pull the candle store into the function bundle.
 */

import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function exists(path: string): boolean {
  const check = new Function("nodeRequire", "target", "return nodeRequire('node:fs').existsSync(target)") as (
    nodeRequire: NodeRequire,
    target: string,
  ) => boolean;
  return check(require, path);
}

export function dataFile(...parts: string[]): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const cwd = process.cwd();
  const bases = [
    join(/*turbopackIgnore: true*/ here, "..", "..", "data"),
    join(/*turbopackIgnore: true*/ cwd, "research", "data"),
    join(/*turbopackIgnore: true*/ cwd, "..", "research", "data"),
  ];
  for (const base of bases) {
    const path = join(/*turbopackIgnore: true*/ base, ...parts);
    if (exists(path)) return path;
  }
  return null;
}
