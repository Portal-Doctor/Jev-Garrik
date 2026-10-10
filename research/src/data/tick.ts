import type { ArtifactStamp } from "../manifest";
import type { UsdSpotProduct } from "./products";

export interface TickFlag {
  productId: string;
  tickSize: string | null;
  tickField: "quote_increment";
  historyAvailable: false;
  tickMayHaveChanged: true;
  reason: "product payload publishes only the current quote_increment; no tick-size history is in the snapshot";
}

export interface TickReport extends ArtifactStamp {
  note: string;
  flags: TickFlag[];
}

const REASON = "product payload publishes only the current quote_increment; no tick-size history is in the snapshot";

/** Record the current tick and flag every product, because no history is published. */
export function tickReport(products: readonly UsdSpotProduct[], stamp: ArtifactStamp): TickReport {
  return {
    ...stamp,
    note: "Report only. No pair is treated as having a constant tick.",
    flags: products.map((product) => ({
      productId: product.productId,
      tickSize: product.tickSize,
      tickField: "quote_increment" as const,
      historyAvailable: false as const,
      tickMayHaveChanged: true as const,
      reason: REASON,
    })),
  };
}
