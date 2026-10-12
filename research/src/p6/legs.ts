/**
 * Gap 17, one record per order leg. Arrival mid is the M2 reference for a
 * taker entry or a rule, trail, or time exit. The stop price is the reference
 * for a stop exit. Decision mid is logged so delay can be reported. It is not
 * inside cost.
 */

/** A level2 snapshot older than this is not a live book. Same window as a missed heartbeat. */
export const STALE_QUOTE_MS = 15_000;

export interface LegLog {
  id: string;
  productId: string;
  classId: string;
  side: "entry" | "exit";
  arrivalMid: number;
  arrivalBid: number;
  arrivalAsk: number;
  arrivalSnapshotTs: number;
  orderSendTs: number;
  decisionMid: number;
  activeStop: number | null;
  triggerBarTs: number | null;
  fillPrice: number;
  units: number;
  feesUsd: number;
  /** The snapshot was missing, older than STALE_QUOTE_MS, or a flagged REST product-book fallback. The fill is still the fill. */
  stale?: boolean;
  /** l2 is the live book. rest is the V6 product-book fallback. */
  source?: "l2" | "rest";
}

/** Decision-to-arrival drift in bps. GREY, and not part of cost. */
export function delayBps(decisionMid: number, arrivalMid: number): number | null {
  if (!(decisionMid > 0) || !Number.isFinite(arrivalMid)) return null;
  return ((arrivalMid - decisionMid) / decisionMid) * 10_000;
}
