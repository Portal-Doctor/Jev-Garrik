/**
 * Products snapshot visibility. One log line and one public health field.
 * The name is repo-relative. No absolute path, no environment value, no secret.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dataFile } from "./live-data";

export const CLASS_A_PRODUCTS_FILE = "products/exchange-products.raw.json";

export interface ClassAProductsSnapshot {
  file: typeof CLASS_A_PRODUCTS_FILE;
  found: boolean;
  pairs: number;
  sha256: string | null;
}

let cached: ClassAProductsSnapshot | null = null;

/** Read one snapshot. `filePath` null is the missing file. The log names the repo-relative file, not `filePath`. */
export function readClassAProductsSnapshot(filePath: string | null): ClassAProductsSnapshot {
  const file = CLASS_A_PRODUCTS_FILE;
  const missing: ClassAProductsSnapshot = { file, found: false, pairs: 0, sha256: null };
  if (!filePath) {
    logProductsSnapshot(missing);
    return missing;
  }
  try {
    const bytes = readFileSync(filePath);
    const body = JSON.parse(bytes.toString("utf8")) as { id?: unknown }[];
    const pairs = Array.isArray(body) ? body.filter((row) => row && typeof row.id === "string" && row.id.length > 0).length : 0;
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const snap: ClassAProductsSnapshot = { file, found: true, pairs, sha256 };
    logProductsSnapshot(snap);
    return snap;
  } catch {
    logProductsSnapshot(missing);
    return missing;
  }
}

function logProductsSnapshot(snap: ClassAProductsSnapshot): void {
  console.log(`class-a products file=${snap.file} found=${snap.found ? "yes" : "no"} pairs=${snap.pairs} sha256=${snap.sha256 ?? "none"}`);
}

/** Loads the committed snapshot once and logs one line. A missing file stays missing. It does not call the network. */
export function classAProductsSnapshot(): ClassAProductsSnapshot {
  if (cached) return cached;
  cached = readClassAProductsSnapshot(dataFile("products", "exchange-products.raw.json"));
  return cached;
}
