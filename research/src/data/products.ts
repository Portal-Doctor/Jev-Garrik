export type ProductStatus = "online" | "delisted" | "other";

export interface UsdSpotProduct {
  productId: string;
  base: string;
  quote: "USD";
  status: ProductStatus;
  statusRaw: string;
  tickSize: string | null;
  tradingDisabled: boolean;
  /** Exchange `/products` does not publish a listing timestamp. */
  listingDate: null;
}

export function classifyStatus(statusRaw: string): ProductStatus {
  if (statusRaw === "online") return "online";
  if (statusRaw === "delisted") return "delisted";
  return "other";
}

export function isProbeTarget(product: Pick<UsdSpotProduct, "statusRaw">): boolean {
  return product.statusRaw === "delisted" || product.statusRaw === "offline";
}

/** USD quote rows from the exchange products payload. The list itself is the spot book. */
export function usdSpotFromExchange(rawText: string): UsdSpotProduct[] {
  const parsed: unknown = JSON.parse(rawText);
  if (!Array.isArray(parsed)) throw new Error("products payload is not an array");
  const out: UsdSpotProduct[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.quote_currency !== "USD") continue;
    if (typeof rec.id !== "string" || typeof rec.base_currency !== "string") continue;
    const statusRaw = typeof rec.status === "string" ? rec.status : "";
    out.push({
      productId: rec.id,
      base: rec.base_currency,
      quote: "USD",
      status: classifyStatus(statusRaw),
      statusRaw,
      tickSize: typeof rec.quote_increment === "string" ? rec.quote_increment : null,
      tradingDisabled: rec.trading_disabled === true,
      listingDate: null,
    });
  }
  out.sort((a, b) => (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0));
  return out;
}
