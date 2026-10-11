import { join } from "node:path";

export function dataPaths(dataDir: string) {
  return {
    root: dataDir,
    productsRaw: join(dataDir, "products", "exchange-products.raw.json"),
    usdSpot: join(dataDir, "products", "usd-spot.json"),
    manifest: join(dataDir, "data-manifest.json"),
    candles: join(dataDir, "candles"),
    derived: join(dataDir, "derived"),
    reports: join(dataDir, "reports"),
    probe: join(dataDir, "reports", "delisted-probe.json"),
    coverage: join(dataDir, "reports", "coverage.json"),
    ticks: join(dataDir, "reports", "tick-size.json"),
    p1Report: join(dataDir, "reports", "p1-report.json"),
    revisionSample: join(dataDir, "reports", "revision-sample.json"),
    stopFile: join(dataDir, "STOP"),
  };
}

export function candleFile(pair: string, month: string): string {
  return `candles/${pair}/${month}.sqlite`;
}

export function partialFile(pair: string, month: string): string {
  return `candles/${pair}/${month}.partial.sqlite`;
}

export function unavailableFile(pair: string): string {
  return `candles/${pair}/unavailable.json`;
}
