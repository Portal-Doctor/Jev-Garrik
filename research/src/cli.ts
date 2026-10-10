/**
 * Public market-data commands. Refuses to start when an order-capable credential is set.
 *
 *   bun run research/src/cli.ts snapshot
 *   bun run research/src/cli.ts download
 *   bun run research/src/cli.ts probe
 *   bun run research/src/cli.ts derive
 *   bun run research/src/cli.ts ticks
 *   bun run research/src/cli.ts coverage
 *   bun run research/src/cli.ts seal-snapshot
 *   bun run research/src/cli.ts p1-report
 */

import { existsSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { boot } from "./index";
import { gitCommitSha, stampArtifact, type ArtifactStamp } from "./manifest";
import { createPacer, downloadUsdSpot } from "./data/download";
import { derivePairMonthFile } from "./data/derive-store";
import { sha256Bytes } from "./data/hash";
import { writeBytes, writeJson } from "./data/io";
import { buildCoverage, type CoverageReport } from "./data/coverage";
import { scanCandleFiles, sealFrozenSnapshot, type DataManifest, type SnapshotLift } from "./data/manifest-file";
import { BAR_SEC } from "./data/time";
import { dataPaths } from "./data/paths";
import { probeDelisted, type DelistedProbeReport } from "./data/probe";
import { usdSpotFromExchange, type UsdSpotProduct } from "./data/products";
import { productsUrl, publicHeaders } from "./data/public";
import { buildP1Report, type OwnerDecision } from "./data/p1-report";
import { tickReport, type TickReport } from "./data/tick";

const started = boot();
if (!started.ok) {
  console.error(started.reason);
  process.exit(1);
}

const paths = dataPaths(realDataDir());
const command = process.argv[2] ?? "";
const SUPERSEDED_1M_ROOT = "67b8963191a52383657fff6bd6bc505327aa540fe4009de6d264e2c4cd2799d8";

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}

async function main(): Promise<void> {
  switch (command) {
    case "snapshot":
      await snapshot();
      return;
    case "download":
      await download();
      return;
    case "probe":
      await probe();
      return;
    case "derive":
      derive();
      return;
    case "ticks":
      ticks();
      return;
    case "coverage":
      coverage();
      return;
    case "seal-snapshot":
      sealSnapshot();
      return;
    case "p1-report":
      p1Report();
      return;
    case "revision-sample":
    case "revision-check":
      console.log("P1 task 9 was dropped by owner decision on 2026-10-10. The revision check is not run.");
      return;
    default:
      throw new Error("usage: snapshot | download | probe | derive | ticks | coverage | seal-snapshot | p1-report");
  }
}

function realDataDir(): string {
  return process.env.RESEARCH_DATA_DIR ?? join(repoDataDir(), "research", "data");
}

function repoDataDir(): string {
  return join(import.meta.dir, "..", "..");
}

function loadProducts(): UsdSpotProduct[] {
  const body = JSON.parse(readFileSync(paths.usdSpot, "utf8")) as { products: UsdSpotProduct[] };
  return body.products;
}

function currentRootHash(): string | null {
  if (!existsSync(paths.manifest)) return null;
  const body = JSON.parse(readFileSync(paths.manifest, "utf8")) as { dataRootHash?: string | null };
  return body.dataRootHash ?? null;
}

function stamp(phaseId: string): ArtifactStamp {
  return stampArtifact({
    commitSha: gitCommitSha(repoDataDir()),
    dataRootHash: currentRootHash(),
    phaseId,
  });
}

function applyRootHash(): void {
  const hash = currentRootHash();
  if (hash == null) return;
  for (const path of [paths.usdSpot, paths.probe, paths.ticks, paths.coverage, paths.p1Report]) {
    if (!existsSync(path)) continue;
    const body = JSON.parse(readFileSync(path, "utf8")) as { dataRootHash?: string | null };
    if (body.dataRootHash === hash) continue;
    body.dataRootHash = hash;
    writeJson(path, body);
  }
}

async function snapshot(): Promise<void> {
  const res = await fetch(productsUrl(), { headers: publicHeaders() });
  if (!res.ok) throw new Error(`products ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  writeBytes(paths.productsRaw, bytes);
  const products = usdSpotFromExchange(new TextDecoder().decode(bytes));
  writeJson(paths.usdSpot, {
    ...stamp("P1"),
    source: productsUrl(),
    rawSha256: sha256Bytes(bytes),
    rawBytes: bytes.byteLength,
    listingDateNote: "listing date is not in the exchange products payload",
    products,
  });
  console.log(`snapshot ${products.length} USD products raw ${sha256Bytes(bytes)}`);
}

function oneMinuteSuperseded(now: Date): SnapshotLift {
  return {
    liftedAt: now.toISOString(),
    reason:
      "Owner decision (Brian, 2026-10-10): the partial 58-file 1-minute snapshot is superseded by the one-year candle download. The revision check stays dropped and is not an open item for the hash.",
    supersededDataRootHash: SUPERSEDED_1M_ROOT,
    supersededFrozenAt: "2026-10-10T23:23:41.185Z",
    supersededFileCount: 58,
  };
}

async function download(): Promise<void> {
  let manifestCreatedAt: string | undefined;
  let snapshotLift = oneMinuteSuperseded(new Date());
  if (existsSync(paths.manifest)) {
    const existing = JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest;
    if (existing.snapshot?.universeComplete || existing.snapshot?.blocksResume) {
      throw new Error("snapshot is frozen by owner decision; download will not resume");
    }
    if (existing.barSec === BAR_SEC) {
      manifestCreatedAt = existing.createdAt;
      if (existing.snapshotLift) snapshotLift = existing.snapshotLift;
    } else {
      rmSync(paths.candles, { recursive: true, force: true });
      rmSync(paths.derived, { recursive: true, force: true });
      writeSync(1, `cleared candle files whose bar size is not ${BAR_SEC}\n`);
    }
  }
  const intervalMs = Number(process.env.RESEARCH_REQUEST_INTERVAL_MS ?? "100");
  const concurrency = Number(process.env.RESEARCH_DOWNLOAD_CONCURRENCY ?? "10");
  const deadlineMs = process.env.RESEARCH_DOWNLOAD_DEADLINE_ISO
    ? Date.parse(process.env.RESEARCH_DOWNLOAD_DEADLINE_ISO)
    : undefined;
  const summary = await downloadUsdSpot({
    products: loadProducts(),
    dataDir: paths.root,
    now: new Date(),
    stamp: stamp("P1"),
    intervalMs,
    concurrency,
    stopFile: paths.stopFile,
    manifestCreatedAt,
    snapshotLift,
    deadlineMs,
    log: (message) => {
      writeSync(1, `${message}\n`);
    },
  });
  applyRootHash();
  writeSync(1, `${JSON.stringify(summary)}\n`);
  if (summary.stopped === "finished" || summary.stopped === "deadline") {
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest;
    const sealed = sealFrozenSnapshot(manifest, new Date(), {
      universeComplete: summary.stopped === "finished",
      hardStop: summary.stopped === "deadline",
      supersededDataRootHash: manifest.snapshotLift?.supersededDataRootHash ?? SUPERSEDED_1M_ROOT,
    });
    writeJson(paths.manifest, sealed);
    writeSync(1, `frozen ${sealed.snapshot?.frozenAt} root ${sealed.dataRootHash}\n`);
    derive();
    coverage();
    p1Report();
  }
}

async function probe(): Promise<void> {
  const intervalMs = Number(process.env.RESEARCH_REQUEST_INTERVAL_MS ?? "100");
  const report = await probeDelisted({
    products: loadProducts(),
    now: new Date(),
    stamp: stamp("P1"),
    pace: createPacer(intervalMs, Date.now, (ms) => new Promise((resolve) => setTimeout(resolve, ms))),
  });
  writeJson(paths.probe, report);
  const served = report.products.filter((product) => product.candlesServed === true).length;
  console.log(`probe ${report.products.length} products, candles served for ${served}`);
}

function ticks(): void {
  writeJson(paths.ticks, tickReport(loadProducts(), stamp("P1")));
  console.log(`tick flags ${loadProducts().length}`);
}

function derive(): void {
  const files = scanCandleFiles(paths.root);
  const written: string[] = [];
  for (const file of files) {
    written.push(
      ...derivePairMonthFile({
        sqlitePath: join(paths.root, file.path),
        outDir: paths.derived,
        stamp: stamp("P1"),
      }),
    );
  }
  console.log(`derived ${written.length} files`);
}

function coverage(): void {
  const probes = existsSync(paths.probe)
    ? (JSON.parse(readFileSync(paths.probe, "utf8")) as { products: { productId: string; status: UsdSpotProduct["status"]; statusRaw: string; candlesServed: boolean | null; windows: [] }[] }).products
    : [];
  const report = buildCoverage({
    products: loadProducts(),
    probes,
    dataDir: paths.root,
    stamp: stamp("P1"),
  });
  writeJson(paths.coverage, report);
  applyRootHash();
  console.log(`coverage ${report.productCount} products`);
}

function sealSnapshot(): void {
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest;
  if (manifest.snapshot?.universeComplete) {
    console.log(`already frozen ${manifest.snapshot.frozenAt} root ${manifest.dataRootHash}`);
    return;
  }
  const sealed = sealFrozenSnapshot(manifest, new Date(), {
    universeComplete: true,
    supersededDataRootHash: manifest.snapshotLift?.supersededDataRootHash ?? null,
  });
  writeJson(paths.manifest, sealed);
  console.log(`frozen ${sealed.snapshot?.frozenAt} root ${sealed.dataRootHash}`);
}

function p1Report(): void {
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest;
  const coverageReport = JSON.parse(readFileSync(paths.coverage, "utf8")) as CoverageReport;
  const probe = JSON.parse(readFileSync(paths.probe, "utf8")) as DelistedProbeReport;
  const ticksReport = JSON.parse(readFileSync(paths.ticks, "utf8")) as TickReport;
  const decisionPath = join(paths.reports, "owner-decision.json");
  const ownerDecision = existsSync(decisionPath) ? (JSON.parse(readFileSync(decisionPath, "utf8")) as OwnerDecision) : null;
  const report = buildP1Report({
    stamp: stamp("P1"),
    manifest,
    coverage: coverageReport,
    probe,
    ticks: ticksReport,
    ownerDecision,
  });
  writeJson(paths.p1Report, report);
  applyRootHash();
  console.log(`p1 report ${report.coverage.productCount} products root ${report.dataRootHash}`);
}
