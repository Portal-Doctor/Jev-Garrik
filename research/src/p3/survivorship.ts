export interface SurvivorshipRow {
  productId: string;
  reason: string;
}

/**
 * Names in the product list with no candle file.
 * After D2, the download scope includes the owner-cut drops and served delisted names.
 * A 404 still leaves the name out. That remainder is listed here.
 */
export function survivorshipReport(opts: {
  catalog: readonly string[];
  downloaded: readonly string[];
  reasonFor: (productId: string) => string;
  d2Executed: boolean;
}): { label: string; missing: SurvivorshipRow[] } {
  const have = new Set(opts.downloaded);
  const missing = opts.catalog
    .filter((id) => !have.has(id))
    .map((productId) => ({ productId, reason: opts.reasonFor(productId) }))
    .sort((a, b) => (a.productId < b.productId ? -1 : 1));
  return {
    label: opts.d2Executed
      ? "D2 executed. Names whose candles were not served stay outside the download."
      : "survivorship from download scope",
    missing,
  };
}
