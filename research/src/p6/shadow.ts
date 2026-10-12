/**
 * X2 and X3 stay off the wire. A public trade at least one tick through the limit fills half the displayed volume.
 * A gap while the order is working is indeterminate. Class D takes no fill.
 */

import { tradeThroughFill } from "../p3/design-rules";
import type { ClassId } from "../p3/portfolio";

export type ShadowStatus = "working" | "filled" | "indeterminate" | "no-fill";

export interface ShadowOrder {
  id: string;
  mode: "X2" | "X3";
  classId: ClassId;
  productId: string;
  limit: number;
  tick: number;
  status: ShadowStatus;
  filledVolume: number;
}

export function openShadow(order: Omit<ShadowOrder, "status" | "filledVolume">): ShadowOrder {
  if (order.classId === "D") return { ...order, status: "no-fill", filledVolume: 0 };
  return { ...order, status: "working", filledVolume: 0 };
}

export function onPublicTrade(order: ShadowOrder, price: number, volume: number): ShadowOrder {
  if (order.status !== "working") return order;
  const fill = tradeThroughFill(order.limit, price, order.tick, volume);
  if (!fill?.filled) return order;
  return { ...order, status: "filled", filledVolume: fill.volume };
}

/** A gap makes a working shadow order indeterminate. It does not invent a fill. */
export function onFeedGap(order: ShadowOrder): ShadowOrder {
  if (order.status !== "working") return order;
  return { ...order, status: "indeterminate", filledVolume: 0 };
}

/**
 * Share of resolved X2/X3 orders that are indeterminate.
 * The denominator is an open question (gap-share). Class D no-fills are not in it.
 */
export function indeterminateShare(orders: readonly ShadowOrder[]): { indeterminate: number; resolved: number; share: number | null; flagged: boolean } {
  const resolved = orders.filter((order) => order.status === "filled" || order.status === "indeterminate");
  const indeterminate = resolved.filter((order) => order.status === "indeterminate").length;
  if (resolved.length === 0) return { indeterminate: 0, resolved: 0, share: null, flagged: false };
  const share = indeterminate / resolved.length;
  return { indeterminate, resolved: resolved.length, share, flagged: share > 0.1 };
}
