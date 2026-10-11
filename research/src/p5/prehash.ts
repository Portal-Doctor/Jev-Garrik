/**
 * G1 and G2 geometry. No P&L, no outcome fields, no Jev calls.
 * The numbers are reported and not used to change a rule.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertNoBannedKeys } from "../data/banned";
import { dataPaths } from "../data/paths";
import { assertFrozenRoots } from "../data/refresh";
import { assertCleanWorkTree, stampFromGit } from "../manifest";
import { ema } from "../p2/indicators";
import { FIRST_UNIVERSE_DATE, OOS_END } from "../p2/universe";
import { classBarInputs, correlationCloses } from "../p3/bar-access";
import { WINDOW_START } from "../p3/f5";
import { loadPair } from "../p3/geometry-run";
import { monthlyRebalanceDates } from "../p3/schedule";
import { monthlyClusters, type ClosePoint } from "./book";
import { registeredFlags } from "./flags";
import { breadthByEntryDate, momentumBlocked, momentumCrashOn } from "./guards";
import { addDays } from "./stats";

export interface PrehashGeometry {
  role: "v3.1 pre-hash geometry";
  tuned: false;
  breadth: {
    entryDays: number;
    pausedDays: number;
    pausedShare: number;
    flag: boolean;
    pausedDates: string[];
    undefinedLeftOut: true;
    initialState: "off";
    membership: "entry day";
  };
  momentum: {
    conditionDates: string[];
    blockedDates: string[];
  };
  clusters: {
    months: {
      month: string;
      names: number;
      clusterCount: number;
      largestNames: number;
      largestShare: number | null;
      largestAbove60: boolean;
    }[];
    monthCount: number;
    monthsAbove60: number;
    flag: boolean;
  };
  maxOpen: null;
  maxOpenNote: "G2 concurrency measured in the post-hash rerun";
  skipped: string[];
}

function memberOn(rows: readonly { date: string; names: string[] }[]): (productId: string, date: string) => boolean {
  const dates = rows.map((row) => row.date).slice().sort();
  const sets = new Map(rows.map((row) => [row.date, new Set(row.names)]));
  return (productId, date) => {
    let prior: string | null = null;
    for (const item of dates) {
      if (item <= date) prior = item;
      else break;
    }
    if (!prior) return false;
    return sets.get(prior)?.has(productId) ?? false;
  };
}

function datesFrom(start: string, end: string): string[] {
  const out: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

export function buildPrehashGeometry(dataDir: string): PrehashGeometry {
  const paths = dataPaths(dataDir);
  const registration = JSON.parse(readFileSync(join(paths.reports, "p4-registration.json"), "utf8")) as {
    overlap?: { priceGroupFailNames?: string[]; volumeGroupFailNames?: string[]; boundarySavesCloses?: string[] };
    barAccess?: { names?: { productId: string; priceGroupPasses: boolean; volumeGroupPasses: boolean; boundarySaved: boolean }[] };
  };
  const membership = JSON.parse(readFileSync(join(paths.reports, "universe-membership.json"), "utf8")) as {
    members: { date: string; names: string[] }[];
  };
  const isMember = memberOn(membership.members);
  const names = [...new Set(membership.members.flatMap((row) => row.names))].sort();
  const flagBook = registeredFlags(registration, names.filter((id) => id !== "BTC-USD"));
  const dailyDir = join(dataDir, "daily", "candles");
  const series = new Map<string, Map<string, { close: number; ema50: number | null }>>();
  const closes = new Map<string, ClosePoint[]>();
  const btc = loadPair("BTC-USD", dailyDir, paths.candles);
  const btcDays = new Map<string, number>();
  for (const row of btc?.days ?? []) {
    if (!row.empty && row.close > 0) btcDays.set(row.date, row.close);
  }
  for (const id of names) {
    if (id === "BTC-USD") continue;
    const flags = flagBook.byId.get(id);
    if (!flags) continue;
    const pair = loadPair(id, dailyDir, paths.candles);
    if (!pair) continue;
    const inputs = classBarInputs(flags, pair.days, pair.listedDate ?? WINDOW_START);
    const ema50 = ema(inputs.ema.map((row) => row.close), 50);
    const byDate = new Map<string, { close: number; ema50: number | null }>();
    inputs.ema.forEach((row, index) => {
      if (!(row.close > 0)) return;
      byDate.set(row.date, { close: row.close, ema50: ema50[index] ?? null });
    });
    series.set(id, byDate);
    closes.set(id, correlationCloses(flags, pair.days));
  }
  const entryDates = datesFrom(FIRST_UNIVERSE_DATE, OOS_END);
  const breadth = breadthByEntryDate(entryDates, (entryDate) => {
    const closeDate = addDays(entryDate, -1);
    return names.filter((id) => id !== "BTC-USD" && isMember(id, entryDate)).map((id) => {
      const point = series.get(id)?.get(closeDate);
      return { member: true, close: point?.close ?? null, ema50: point?.ema50 ?? null };
    });
  });
  const pausedDates = entryDates.filter((date) => breadth.get(date) === "off");
  const entryDays = datesFrom(FIRST_UNIVERSE_DATE, OOS_END).length;
  const conditionDates: string[] = [];
  const btcDates = [...btcDays.keys()].sort();
  for (const date of btcDates) {
    const known = addDays(date, 1);
    if (known < FIRST_UNIVERSE_DATE || known > OOS_END) continue;
    const close = btcDays.get(date)!;
    const prev60 = btcDays.get(addDays(date, -60));
    const prev10 = btcDays.get(addDays(date, -10));
    if (prev60 == null || prev10 == null || !(prev60 > 0) || !(prev10 > 0)) continue;
    if (momentumCrashOn(close / prev60 - 1, close / prev10 - 1)) conditionDates.push(known);
  }
  const blockedDates = datesFrom(FIRST_UNIVERSE_DATE, OOS_END).filter((date) => momentumBlocked(conditionDates, date));
  const months = monthlyRebalanceDates();
  const clusterNames = [...closes.entries()].map(([productId, days]) => ({
    productId,
    flags: flagBook.byId.get(productId)!,
    days,
  }));
  const maps = monthlyClusters(clusterNames, months, (id, date) => isMember(id, date));
  const clusterMonths = months.map((month) => {
    const assigned = maps.get(month) ?? new Map<string, string>();
    const groups = new Map<string, number>();
    for (const cluster of assigned.values()) groups.set(cluster, (groups.get(cluster) ?? 0) + 1);
    const sizes = [...groups.values()];
    const largest = sizes.length === 0 ? 0 : Math.max(...sizes);
    const share = assigned.size === 0 ? null : largest / assigned.size;
    return {
      month,
      names: assigned.size,
      clusterCount: sizes.length,
      largestNames: largest,
      largestShare: share,
      largestAbove60: share != null && share > 0.6,
    };
  });
  const monthsAbove60 = clusterMonths.filter((row) => row.largestAbove60).length;
  const doc: PrehashGeometry = {
    role: "v3.1 pre-hash geometry",
    tuned: false,
    breadth: {
      entryDays,
      pausedDays: pausedDates.length,
      pausedShare: entryDays === 0 ? 0 : pausedDates.length / entryDays,
      flag: entryDays > 0 && pausedDates.length / entryDays > 0.3,
      pausedDates,
      undefinedLeftOut: true,
      initialState: "off",
      membership: "entry day",
    },
    momentum: { conditionDates, blockedDates },
    clusters: {
      months: clusterMonths,
      monthCount: clusterMonths.length,
      monthsAbove60,
      flag: clusterMonths.length > 0 && monthsAbove60 > clusterMonths.length / 2,
    },
    maxOpen: null,
    maxOpenNote: "G2 concurrency measured in the post-hash rerun",
    skipped: flagBook.missing,
  };
  assertNoBannedKeys(doc, "v3.1 geometry");
  return doc;
}

if (import.meta.main) {
  const dataDir = process.env.RESEARCH_DATA_DIR ?? join(import.meta.dir, "..", "..", "data");
  assertCleanWorkTree();
  const roots = assertFrozenRoots(dataDir);
  const stamp = stampFromGit({ phaseId: "P5", dataRootHash: roots.manifest.dataRootHash });
  const doc = { ...buildPrehashGeometry(dataDir), commitSha: stamp.commitSha, createdAt: stamp.createdAt };
  const { writeJson } = await import("../data/io.ts");
  writeJson(join(dataDir, "reports", "p5-v31-geometry.json"), doc);
  console.log(`breadth ${doc.breadth.pausedDays}/${doc.breadth.entryDays} flag ${doc.breadth.flag} clusters flag ${doc.clusters.flag} conditions ${doc.momentum.conditionDates.length}`);
}
