/**
 * X2 and X3 stay off the wire. A public trade at least one tick through the limit fills half the displayed volume.
 * A gap while the order is working is indeterminate. Class D is a maker order:
 * indeterminate is no fill, and the count is still reported.
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
 * M7. The denominator is every submitted order in the set, including
 * indeterminate ones. Class D's indeterminate count is always reported.
 * A class with no trade-through orders is n/a.
 */
export function indeterminateShare(orders: readonly ShadowOrder[]): {
  indeterminate: number;
  submitted: number;
  share: number | null;
  flagged: boolean;
  classDIndeterminate: number;
} {
  const classDIndeterminate = orders.filter((order) => order.classId === "D" && order.status === "indeterminate").length;
  if (orders.length === 0) return { indeterminate: 0, submitted: 0, share: null, flagged: false, classDIndeterminate };
  const indeterminate = orders.filter((order) => order.status === "indeterminate").length;
  const share = indeterminate / orders.length;
  return { indeterminate, submitted: orders.length, share, flagged: share > 0.1, classDIndeterminate };
}
