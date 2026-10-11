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
 *   bun run research/src/cli.ts stats-fetch
 *   bun run research/src/cli.ts stats-convert
 *   bun run research/src/cli.ts universe-cut
 *   bun run research/src/cli.ts refresh-reports
 */

import { existsSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { boot } from "./index";
import { stampFromGit, type ArtifactStamp } from "./manifest";
import { createPacer, downloadUsdSpot } from "./data/download";
import { derivePairMonthFile } from "./data/derive-store";
import { buildDerivedManifest } from "./data/derived-manifest";
import { sha256Bytes } from "./data/hash";
import { writeBytes, writeJson } from "./data/io";
import { buildCoverage, type CoverageReport } from "./data/coverage";
import { liftCompletedFreeze, scanCandleFiles, sealFrozenSnapshot, type DataManifest, type SnapshotLift } from "./data/manifest-file";
import { convertBareProductStats, fetchProductStats, parseProductStats } from "./data/product-stats";
import { sha256File } from "./data/store";
import { applyUniverseCut, droppedProductIds, type OwnerDecisionFile } from "./data/universe-cut";
import { BAR_SEC } from "./data/time";
import { dataPaths } from "./data/paths";
import { probeDelisted, type DelistedProbeReport } from "./data/probe";
import { usdSpotFromExchange, type UsdSpotProduct } from "./data/products";
import { productsUrl, publicHeaders } from "./data/public";
import { buildP1Report } from "./data/p1-report";
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
    case "stats-fetch":
      await statsFetch();
      return;
    case "stats-convert":
      statsConvert();
      return;
    case "universe-cut":
      universeCut();
      return;
    case "refresh-reports":
      refreshReports();
      return;
    case "revision-sample":
    case "revision-check":
      console.log("Brian dropped P1 task 9 on 2026-10-10. The revision check is not run.");
      return;
    default:
      throw new Error(
        "usage: snapshot | download | probe | derive | ticks | coverage | seal-snapshot | p1-report | stats-fetch | stats-convert | universe-cut | refresh-reports",
      );
  }
}

function realDataDir(): string {
  return process.env.RESEARCH_DATA_DIR ?? join(repoDataDir(), "research", "data");
}

function repoDataDir(): string {
  return join(import.meta.dir, "..", "..");
}

function decisionPath(): string {
  return join(paths.reports, "owner-decision.json");
}

function statsPath(): string {
  return join(paths.reports, "product-stats.json");
}

function loadDroppedProductIds(): string[] {
  const path = decisionPath();
  if (!existsSync(path)) return [];
  const body = JSON.parse(readFileSync(path, "utf8")) as OwnerDecisionFile;
  return droppedProductIds(body);
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
  return stampFromGit({
    phaseId,
    dataRootHash: currentRootHash(),
    cwd: repoDataDir(),
  });
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
  let now = new Date();
  if (existsSync(paths.manifest)) {
    const existing = JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest;
    if (existing.snapshot?.blocksResume) {
      throw new Error("snapshot is frozen by owner decision; download will not resume");
    }
    if (existing.snapshot?.universeComplete) {
      if (process.env.RESEARCH_LIFT_COMPLETED_FREEZE !== "1") {
        throw new Error("snapshot is frozen by owner decision; download will not resume");
      }
      if (existing.barSec !== BAR_SEC) throw new Error(`refusing to lift a freeze whose bar size is not ${BAR_SEC}`);
      now = new Date("2026-10-11T12:00:00.000Z");
      const lifted = liftCompletedFreeze(
        existing,
        new Date(),
        "Owner decision (Brian, 2026-10-11 20:19 CT): add back the 56 below-rank-cutoff names on the same 900-second window (2025-10-11T00:00:00.000Z inclusive through 2026-10-11T00:00:00.000Z exclusive). RESEARCH_LIFT_COMPLETED_FREEZE=1 is the guard change that allows this resume. Other cuts stay. Stats were not re-fetched.",
      );
      snapshotLift = lifted.snapshotLift ?? snapshotLift;
      manifestCreatedAt = existing.createdAt;
      writeSync(1, `lifted completed freeze ${existing.dataRootHash} files ${existing.files.length}\n`);
    } else if (existing.barSec === BAR_SEC) {
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
  const dropped = new Set(loadDroppedProductIds());
  const products = loadProducts().filter((product) => !dropped.has(product.productId));
  for (const productId of dropped) rmSync(join(paths.candles, productId), { recursive: true, force: true });
  const summary = await downloadUsdSpot({
    products,
    dataDir: paths.root,
    now,
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
  writeSync(1, `${JSON.stringify(summary)}\n`);
  if (summary.stopped === "finished" || summary.stopped === "deadline") {
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest;
    const sealed = sealFrozenSnapshot(manifest, new Date(), {
      universeComplete: summary.stopped === "finished",
      hardStop: summary.stopped === "deadline",
      supersededDataRootHash: manifest.snapshotLift?.supersededDataRootHash ?? SUPERSEDED_1M_ROOT,
    });
    sealed.downloadRun = summary;
    writeJson(paths.manifest, sealed);
    writeSync(1, `frozen ${sealed.snapshot?.frozenAt} root ${sealed.dataRootHash}\n`);
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
  const ownerDecision = existsSync(decisionPath) ? (JSON.parse(readFileSync(decisionPath, "utf8")) as OwnerDecisionFile) : null;
  const report = buildP1Report({
    stamp: stamp("P1"),
    manifest,
    coverage: coverageReport,
    probe,
    ticks: ticksReport,
    ownerDecision,
  });
  writeJson(paths.p1Report, report);
  console.log(`p1 report ${report.coverage.productCount} products root ${report.dataRootHash}`);
}

async function statsFetch(): Promise<void> {
  if (existsSync(statsPath()) && process.env.RESEARCH_STATS_REFETCH !== "1") {
    throw new Error("product-stats.json already exists. This freeze does not re-fetch. Set RESEARCH_STATS_REFETCH=1 to replace it.");
  }
  const file = await fetchProductStats({ products: loadProducts(), now: new Date() });
  writeJson(statsPath(), file);
  console.log(`stats ${file.products.length} fetchedAt ${file.fetchedAt}`);
}

function statsConvert(): void {
  const text = readFileSync(statsPath(), "utf8");
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    console.log("product-stats.json is already the fetch envelope");
    return;
  }
  writeJson(statsPath(), convertBareProductStats(text));
  console.log("converted bare product-stats array to the fetch envelope");
}

function universeCut(): void {
  const stats = parseProductStats(readFileSync(statsPath(), "utf8"));
  const decision = applyUniverseCut(stats);
  writeJson(decisionPath(), decision);
  const cut = decision.entries[2];
  console.log(`universe cut kept ${cut.kept.length} dropped ${cut.dropped.length} readded ${cut.readded.length}`);
}

function refreshReports(): void {
  const artifact = stamp("P1");
  const raw = readFileSync(paths.productsRaw);
  const products = usdSpotFromExchange(new TextDecoder().decode(raw));
  writeJson(paths.usdSpot, {
    ...artifact,
    source: productsUrl(),
    rawSha256: sha256Bytes(new Uint8Array(raw)),
    rawBytes: raw.byteLength,
    listingDateNote: "listing date is not in the exchange products payload",
    products,
  });
  writeJson(paths.ticks, tickReport(products, artifact));
  const probes = existsSync(paths.probe)
    ? (JSON.parse(readFileSync(paths.probe, "utf8")) as { products: { productId: string; status: UsdSpotProduct["status"]; statusRaw: string; candlesServed: boolean | null; windows: [] }[] }).products
    : [];
  writeJson(
    paths.coverage,
    buildCoverage({
      products,
      probes,
      dataDir: paths.root,
      stamp: artifact,
    }),
  );
  const files = scanCandleFiles(paths.root);
  let derivedCount = 0;
  for (const file of files) {
    derivedCount += derivePairMonthFile({
      sqlitePath: join(paths.root, file.path),
      outDir: paths.derived,
      stamp: artifact,
    }).length;
  }
  const derived = buildDerivedManifest({ stamp: artifact, dataDir: paths.root });
  const derivedPath = join(paths.root, "derived-manifest.json");
  writeJson(derivedPath, derived);
  const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest;
  if (manifest.dataRootHash !== artifact.dataRootHash) throw new Error("candle root hash changed during refresh");
  manifest.commitSha = artifact.commitSha;
  manifest.derivedManifest = {
    path: "derived-manifest.json",
    sha256: sha256File(derivedPath),
    derivedRootHash: derived.derivedRootHash,
    fileCount: derived.files.length,
    bytes: derived.files.reduce((sum, file) => sum + file.bytes, 0),
  };
  writeJson(paths.manifest, manifest);
  const ownerDecision = existsSync(decisionPath()) ? (JSON.parse(readFileSync(decisionPath(), "utf8")) as OwnerDecisionFile) : null;
  const coverageReport = JSON.parse(readFileSync(paths.coverage, "utf8")) as CoverageReport;
  const probe = JSON.parse(readFileSync(paths.probe, "utf8")) as DelistedProbeReport;
  const ticksReport = JSON.parse(readFileSync(paths.ticks, "utf8")) as TickReport;
  writeJson(
    paths.p1Report,
    buildP1Report({
      stamp: artifact,
      manifest,
      coverage: coverageReport,
      probe,
      ticks: ticksReport,
      ownerDecision,
    }),
  );
  console.log(
    `refresh derived ${derivedCount} files derivedRoot ${derived.derivedRootHash} candleRoot ${manifest.dataRootHash}`,
  );
}
