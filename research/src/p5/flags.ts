/**
 * F8. P5 reads per-name flags from the registration.
 * It does not recompute them from a pair's F5 row.
 * A name whose barAccess row disagrees with the overlap lists is not given a flag.
 */

import type { GroupFlags } from "../p3/bar-access";

export interface BarAccessName {
  productId: string;
  priceGroupPasses: boolean;
  volumeGroupPasses: boolean;
  boundarySaved: boolean;
}

export interface RegistrationFlagSource {
  overlap?: {
    priceGroupFailNames?: readonly string[];
    volumeGroupFailNames?: readonly string[];
    boundarySavesCloses?: readonly string[];
  };
  barAccess?: { names?: readonly BarAccessName[] };
}

export interface RegisteredFlagBook {
  byId: Map<string, GroupFlags>;
  missing: string[];
  conflicts: string[];
}

function listed(ids: readonly string[] | undefined): Set<string> {
  return new Set(ids ?? []);
}

export function registeredFlags(source: RegistrationFlagSource, productIds: readonly string[]): RegisteredFlagBook {
  const names = source.barAccess?.names ?? [];
  const byId = new Map<string, GroupFlags>();
  const conflicts: string[] = [];
  const priceFail = listed(source.overlap?.priceGroupFailNames);
  const volumeFail = listed(source.overlap?.volumeGroupFailNames);
  const boundary = listed(source.overlap?.boundarySavesCloses);
  const seen = new Set<string>();
  for (const row of names) {
    if (seen.has(row.productId)) {
      conflicts.push(`${row.productId} is listed twice in barAccess.names`);
      continue;
    }
    seen.add(row.productId);
    if (typeof row.priceGroupPasses !== "boolean" || typeof row.volumeGroupPasses !== "boolean" || typeof row.boundarySaved !== "boolean") {
      conflicts.push(`${row.productId} is missing a boolean flag`);
      continue;
    }
    if (priceFail.has(row.productId) !== !row.priceGroupPasses) {
      conflicts.push(`${row.productId} priceGroupPasses disagrees with priceGroupFailNames`);
    }
    if (volumeFail.has(row.productId) !== !row.volumeGroupPasses) {
      conflicts.push(`${row.productId} volumeGroupPasses disagrees with volumeGroupFailNames`);
    }
    if (boundary.has(row.productId) !== row.boundarySaved) {
      conflicts.push(`${row.productId} boundarySaved disagrees with boundarySavesCloses`);
    }
    if (conflicts.some((line) => line.startsWith(`${row.productId} `))) continue;
    byId.set(row.productId, {
      priceGroupPasses: row.priceGroupPasses,
      volumeGroupPasses: row.volumeGroupPasses,
      boundarySaved: row.boundarySaved,
    });
  }
  for (const id of [...priceFail, ...volumeFail, ...boundary]) {
    if (!seen.has(id)) conflicts.push(`${id} is named in overlap and missing from barAccess.names`);
  }
  const missing = [...new Set(productIds.filter((id) => !byId.has(id)))].sort();
  return { byId, missing, conflicts };
}
