/**
 * Gap 17, one record per order leg. Arrival mid is the M2 reference for a
 * taker entry or a rule, trail, or time exit. The stop price is the reference
 * for a stop exit. Decision mid is logged so delay can be reported. It is not
 * inside cost.
 */

/**
 * Staleness is `sendTs - bookLastUpdateTs`: the age of that product's L2 book at send.
 * It is never the age of the bar close or the decision. 15s is the ratified default.
 * Ruling: "quote staleness at send vs. the REST settle wait", 2026-10-12 11:25 AM CT
 * (p6-staleness-ruling.md). The registered text already covers it, so there is no amendment.
 */
export const STALE_QUOTE_MS = 15_000;

/** A book older than STALE_QUOTE_MS, and a REST product-book snapshot that is too, is not a trade. */
export const MISSED_SEND_STALE_QUOTE = "missed_send_stale_quote";

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
  /** Ruling flag. `rest_fallback` is the one REST product-book snapshot taken at send. */
  quoteSrc?: "l2" | "rest_fallback";
  /** When the signal was known. Logged. It does not reject the leg. */
  decisionTs?: number;
  /** When the signal bar closed. Logged. The close-to-send delay does not reject the leg. */
  barCloseTs?: number;
}

/** Decision-to-arrival drift in bps. GREY, and not part of cost. */
export function delayBps(decisionMid: number, arrivalMid: number): number | null {
  if (!(decisionMid > 0) || !Number.isFinite(arrivalMid)) return null;
  return ((arrivalMid - decisionMid) / decisionMid) * 10_000;
}
