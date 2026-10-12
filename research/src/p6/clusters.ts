/**
 * Forward clusters and betas. Same 60-day member returns as P5: average
 * linkage, recomputed on month starts and on fold starts. The position keeps
 * the cluster id from entry.
 */

import { foldStartDates } from "../p3/schedule";
import { monthlyClusters, trailingReturns, type ClosePoint } from "../p5/book";
import { alignedBeta, assignBetas } from "../p5/risk";

const FLAGS = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };

export interface MemberCloses {
  productId: string;
  days: readonly ClosePoint[];
}

export function clusterSchedule(through = "2030-12-01"): string[] {
  const months: string[] = [];
  for (let year = 2025; year <= 2030; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const date = `${year}-${String(month).padStart(2, "0")}-01`;
      if (date >= "2025-11-01" && date <= through) months.push(date);
    }
  }
  return [...new Set([...months, ...foldStartDates().filter((date) => date <= through)])].sort();
}

/** Latest month start or fold start on or before `day`. */
export function latestClusterDate(day: string, through = "2030-12-01"): string | null {
  let chosen: string | null = null;
  for (const date of clusterSchedule(through)) {
    if (date <= day) chosen = date;
    else break;
  }
  return chosen;
}

export function forwardClusterBeta(
  members: readonly MemberCloses[],
  btc: readonly ClosePoint[],
  asOf: string,
  memberOn?: (productId: string, date: string) => boolean,
): { clusters: Map<string, string>; betas: Map<string, number> } {
  const names = members.map((member) => ({ productId: member.productId, flags: FLAGS, days: member.days }));
  const clusters = monthlyClusters(names, [asOf], memberOn).get(asOf) ?? new Map<string, string>();
  const active = members.filter((member) => memberOn == null || memberOn(member.productId, asOf));
  const rows = active.map((member) => ({
    id: member.productId,
    beta: alignedBeta(member.days, btc, asOf, trailingReturns),
  }));
  return { clusters, betas: assignBetas(rows) };
}
