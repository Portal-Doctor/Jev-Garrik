import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ArtifactStamp } from "../manifest";
import { deriveBars, type DerivedBar, type Timeframe } from "./derive";
import { readPairMonth } from "./store";

export function derivePairMonthFile(opts: {
  sqlitePath: string;
  outDir: string;
  stamp: ArtifactStamp;
  timeframes?: readonly Timeframe[];
}): string[] {
  const stored = readPairMonth(opts.sqlitePath);
  const start = Date.parse(stored.meta.windowStart) / 1000;
  const end = Date.parse(stored.meta.windowEnd) / 1000;
  const written: string[] = [];
  for (const timeframe of opts.timeframes ?? (["1h", "4h", "1d"] as const)) {
    const bars = deriveBars(stored.rows, timeframe, start, end);
    const path = join(opts.outDir, stored.meta.pair, `${stored.meta.month}-${timeframe}.json`);
    writeDerived(path, {
      commitSha: opts.stamp.commitSha,
      dataRootHash: opts.stamp.dataRootHash,
      createdAt: opts.stamp.createdAt,
      phaseId: opts.stamp.phaseId,
      pair: stored.meta.pair,
      month: stored.meta.month,
      timeframe,
      bars,
    });
    written.push(path);
  }
  return written;
}

function writeDerived(path: string, body: {
  commitSha: string;
  dataRootHash: string | null;
  createdAt: string;
  phaseId: string;
  pair: string;
  month: string;
  timeframe: Timeframe;
  bars: DerivedBar[];
}): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body)}\n`);
}
