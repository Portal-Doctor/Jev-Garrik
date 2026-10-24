/**
 * Diff the class A buy-and-hold series against Quant's reference.
 * errata 002 item 6. Drift and zero rebalance fees are fixed. They are not flags.
 *
 *   bun research/src/p6/class-a-bh.ts candles.json
 *
 * candles.json:
 *   { "t0": 100, "t1": 104, "excluded": ["STB"], "candles": [{ "pair", "listedIndex", "closes", "volumes" }] }
 * Writes one JSON array of { t, V, members } to stdout.
 */

import { readFileSync } from "node:fs";
import { classABuyHoldSeries, type ClassABhPair } from "./class-a-paper";

interface FileBody {
  t0: number;
  t1: number;
  excluded?: string[];
  candles: ClassABhPair[];
}

export function classABuyHoldFromJson(body: FileBody): { t: number; V: number; members: string[] }[] {
  return classABuyHoldSeries({
    t0: body.t0,
    t1: body.t1,
    excluded: body.excluded ?? [],
    candles: body.candles,
  });
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: bun research/src/p6/class-a-bh.ts <candles.json>\n");
    process.exit(1);
  }
  const body = JSON.parse(readFileSync(path, "utf8")) as FileBody;
  process.stdout.write(`${JSON.stringify(classABuyHoldFromJson(body))}\n`);
}
