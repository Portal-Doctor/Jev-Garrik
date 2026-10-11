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

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { boot } from "./index";
import { stampFromGit, type ArtifactStamp } from "./manifest";
import { createPacer, downloadUsdSpot } from "./data/download";
import { derivePairMonthFile } from "./data/derive-store";
import { sha256Bytes } from "./data/hash";
import { writeBytes, writeJson } from "./data/io";
import { buildCoverage, type CoverageReport } from "./data/coverage";
import { BELOW_RANK_CUTOFF_LIFT_REASON, D1_FREEZE_REASON, D2_LIFT_REASON, liftCompletedFreeze, scanCandleFiles, sealFrozenSnapshot, type DataManifest, type SnapshotLift } from "./data/manifest-file";
import { assertFrozenRoots, withLastRefreshed } from "./data/refresh";
import { convertBareProductStats, fetchProductStats, parseProductStats } from "./data/product-stats";
import { sha256File } from "./data/store";
import { applyUniverseCut, droppedProductIds, type OwnerDecisionFile } from "./data/universe-cut";
import { BAR_SEC, DAILY_WINDOW_END_ISO, DAILY_WINDOW_START_ISO, DAY_SEC, FIFTEEN_WINDOW_END_ISO, FIFTEEN_WINDOW_START_ISO } from "./data/time";
import { dataPaths } from "./data/paths";
import { probeDelisted, type DelistedProbeReport } from "./data/probe";
import { usdSpotFromExchange, type UsdSpotProduct } from "./data/products";
import { productsUrl, publicHeaders } from "./data/public";
import { buildP1Report } from "./data/p1-report";
import { tickReport, type TickReport } from "./data/tick";
import { assertNoBannedKeys } from "./data/banned";
import { proposeExclusions } from "./p2/exclusion";
import { buildDerivedManifest } from "./data/derived-manifest";
import { loadPair, scanTwoPass } from "./p3/geometry-run";
import { jevSmoke } from "./p3/jev";
import { assertScanSchema } from "./p3/scan-schema";
import { survivorshipReport } from "./p3/survivorship";

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
    case "download-daily":
      await downloadDaily(stamp("P1"));
      return;
    case "lift-d2":
      await liftD2(stamp("P1"));
      return;
    case "part-a":
      await partA();
      return;
    case "probe":
      await probe();
      return;
    case "derive":
      derive();
      return;
    case "derive-new":
      deriveNew();
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
    case "geometry":
      writeGeometry();
      return;
    case "jev-smoke":
      await writeJevSmoke();
      return;
    case "revision-sample":
    case "revision-check":
      console.log("Brian dropped P1 task 9 on 2026-10-10. The revision check is not run.");
      return;
    default:
      throw new Error(
        "usage: snapshot | download | download-daily | lift-d2 | part-a | probe | derive | derive-new | ticks | coverage | seal-snapshot | p1-report | stats-fetch | stats-convert | universe-cut | refresh-reports | geometry | jev-smoke",
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
        BELOW_RANK_CUTOFF_LIFT_REASON,
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

function dailyDir(): string {
  return join(realDataDir(), "daily");
}

async function partA(): Promise<void> {
  const artifact = stamp("P1");
  await downloadDaily(artifact);
  await liftD2(artifact);
}

async function downloadDaily(artifact: ArtifactStamp): Promise<void> {
  const dataDir = dailyDir();
  mkdirSync(dataDir, { recursive: true });
  const dailyPaths = dataPaths(dataDir);
  let manifestCreatedAt: string | undefined;
  if (existsSync(dailyPaths.manifest)) {
    const existing = JSON.parse(readFileSync(dailyPaths.manifest, "utf8")) as DataManifest;
    if (existing.snapshot?.universeComplete && existing.barSec === DAY_SEC) {
      if (existing.snapshot.reason !== D1_FREEZE_REASON) {
        const artifact = stamp("P1");
        existing.snapshot.reason = D1_FREEZE_REASON;
        existing.commitSha = artifact.commitSha;
        existing.createdAt = artifact.createdAt;
        existing.phaseId = artifact.phaseId;
        writeJson(dailyPaths.manifest, existing);
        console.log(`daily freeze restamped ${artifact.commitSha} root ${existing.dataRootHash}`);
        return;
      }
      console.log(`daily snapshot already frozen ${existing.snapshot.frozenAt} root ${existing.dataRootHash}`);
      return;
    }
    if (existing.barSec === DAY_SEC) manifestCreatedAt = existing.createdAt;
  }
  const startSec = Date.parse(DAILY_WINDOW_START_ISO) / 1000;
  const endSec = Date.parse(DAILY_WINDOW_END_ISO) / 1000;
  const intervalMs = Number(process.env.RESEARCH_REQUEST_INTERVAL_MS ?? "100");
  const concurrency = Number(process.env.RESEARCH_DOWNLOAD_CONCURRENCY ?? "10");
  const summary = await downloadUsdSpot({
    products: loadProducts(),
    dataDir,
    now: new Date("2026-10-11T12:00:00.000Z"),
    stamp: artifact,
    intervalMs,
    concurrency,
    stopFile: dailyPaths.stopFile,
    manifestCreatedAt,
    fixedWindow: { startSec, endSec },
    barSec: DAY_SEC,
    log: (message) => writeSync(1, `${message}\n`),
  });
  writeSync(1, `${JSON.stringify(summary)}\n`);
  if (summary.stopped === "finished") {
    const manifest = JSON.parse(readFileSync(dailyPaths.manifest, "utf8")) as DataManifest;
    manifest.snapshot = {
      status: "frozen",
      reason: D1_FREEZE_REASON,
      downloadStartedAt: manifest.createdAt,
      downloadUpdatedAt: manifest.updatedAt,
      frozenAt: new Date().toISOString(),
      universeComplete: true,
    };
    manifest.downloadRun = summary;
    writeJson(dailyPaths.manifest, manifest);
    writeSync(1, `daily frozen ${manifest.snapshot.frozenAt} root ${manifest.dataRootHash} files ${manifest.files.length}\n`);
  }
}

function d2Ids(): { servedDelisted: string[]; cutDropped: string[]; union: string[] } {
  const decision = JSON.parse(readFileSync(decisionPath(), "utf8")) as OwnerDecisionFile;
  const cutDropped = droppedProductIds(decision);
  const probe = JSON.parse(readFileSync(paths.probe, "utf8")) as DelistedProbeReport;
  const servedDelisted = probe.products.filter((product) => product.candlesServed === true).map((product) => product.productId);
  const union = [...new Set([...servedDelisted, ...cutDropped])].sort();
  return { servedDelisted: servedDelisted.slice().sort(), cutDropped: cutDropped.slice().sort(), union };
}

async function liftD2(artifact: ArtifactStamp): Promise<void> {
  if (!existsSync(paths.manifest)) throw new Error("15m manifest is missing");
  const names = d2Ids();
  const catalog = new Set(loadProducts().map((product) => product.productId));
  const decision = JSON.parse(readFileSync(decisionPath(), "utf8")) as OwnerDecisionFile;
  const cut = decision.entries.find((entry) => entry.id === "universe-cut");
  const keptIds = cut?.id === "universe-cut" ? new Set(cut.kept) : new Set<string>();
  const overlapKept = names.union.filter((id) => keptIds.has(id));
  writeJson(join(paths.reports, "d2-names.json"), {
    ...artifact,
    windowStart: FIFTEEN_WINDOW_START_ISO,
    windowEnd: FIFTEEN_WINDOW_END_ISO,
    servedDelisted: names.servedDelisted,
    cutDropped: names.cutDropped,
    union: names.union,
    servedDelistedCount: names.servedDelisted.length,
    cutDroppedCount: names.cutDropped.length,
    unionCount: names.union.length,
    alreadyKeptCount: overlapKept.length,
    note: "D2 downloads this union on the same 15m window. The owner cut is not universe membership. Names that 404 stay out of the candle root.",
  });
  let existing = JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest;
  if (existing.snapshot?.universeComplete && existing.snapshotLift?.reason === D2_LIFT_REASON) {
    console.log(`D2 lift already frozen ${existing.snapshot.frozenAt} root ${existing.dataRootHash}`);
    return;
  }
  if (existing.dataRootHash !== "e79fb4b27584a745396edd21f769bb12457135a2cc91bb1f3ff75c955007b968" && existing.snapshotLift?.supersededDataRootHash !== "e79fb4b27584a745396edd21f769bb12457135a2cc91bb1f3ff75c955007b968" && existing.snapshotLift?.priorSnapshotLift?.supersededDataRootHash !== "e79fb4b27584a745396edd21f769bb12457135a2cc91bb1f3ff75c955007b968") {
    throw new Error(`refusing to lift a manifest that is not chained to e79fb4b2, root ${existing.dataRootHash}`);
  }
  let snapshotLift = existing.snapshotLift;
  let manifestCreatedAt = existing.createdAt;
  if (existing.snapshot?.universeComplete) {
    if (existing.barSec !== BAR_SEC) throw new Error(`refusing to lift a freeze whose bar size is not ${BAR_SEC}`);
    const lifted = liftCompletedFreeze(existing, new Date(), D2_LIFT_REASON);
    delete lifted.lastRefreshed;
    snapshotLift = lifted.snapshotLift;
    writeJson(paths.manifest, lifted);
    existing = lifted;
    writeSync(1, `lifted completed freeze ${snapshotLift?.supersededDataRootHash} files ${snapshotLift?.supersededFileCount}\n`);
  } else if (existing.snapshotLift?.reason !== D2_LIFT_REASON) {
    throw new Error("15m manifest is not a completed freeze and is not a D2 resume");
  }
  const want = new Set(names.union);
  const products = loadProducts().filter((product) => want.has(product.productId));
  if (products.length !== names.union.length) {
    const missing = names.union.filter((id) => !catalog.has(id));
    throw new Error(`D2 names missing from the product snapshot: ${missing.join(",")}`);
  }
  const intervalMs = Number(process.env.RESEARCH_REQUEST_INTERVAL_MS ?? "100");
  const concurrency = Number(process.env.RESEARCH_DOWNLOAD_CONCURRENCY ?? "10");
  const summary = await downloadUsdSpot({
    products,
    dataDir: paths.root,
    now: new Date("2026-10-11T12:00:00.000Z"),
    stamp: artifact,
    intervalMs,
    concurrency,
    stopFile: paths.stopFile,
    manifestCreatedAt,
    snapshotLift,
    log: (message) => writeSync(1, `${message}\n`),
  });
  writeSync(1, `${JSON.stringify(summary)}\n`);
  if (summary.stopped === "finished") {
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest;
    const sealed = sealFrozenSnapshot(manifest, new Date(), {
      universeComplete: true,
      supersededDataRootHash: manifest.snapshotLift?.supersededDataRootHash ?? null,
    });
    sealed.downloadRun = summary;
    writeJson(paths.manifest, sealed);
    writeSync(1, `D2 frozen ${sealed.snapshot?.frozenAt} root ${sealed.dataRootHash} files ${sealed.files.length}\n`);
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

/** Derives pair-months that do not already have a daily JSON file. Existing derived bytes stay put. */
function deriveNew(): void {
  const priorPath = join(paths.root, "derived-manifest.json");
  const prior = existsSync(priorPath) ? ((JSON.parse(readFileSync(priorPath, "utf8")) as { derivedRootHash?: string }).derivedRootHash ?? null) : null;
  const artifact = stamp("P1");
  const files = scanCandleFiles(paths.root);
  let months = 0;
  for (const file of files) {
    const parts = file.path.split("/");
    const pair = parts[1];
    const month = parts[2]?.replace(/\.sqlite$/, "");
    if (!pair || !month) continue;
    if (existsSync(join(paths.derived, pair, `${month}-1d.json`))) continue;
    derivePairMonthFile({
      sqlitePath: join(paths.root, file.path),
      outDir: paths.derived,
      stamp: artifact,
    });
    months += 1;
    if (months % 25 === 0) writeSync(1, `derive-new ${months} ${pair} ${month}\n`);
  }
  const manifest = buildDerivedManifest({ stamp: artifact, dataDir: paths.root });
  writeJson(priorPath, manifest);
  writeJson(join(paths.reports, "derived-roots.json"), {
    ...artifact,
    priorDerivedRootHash: prior,
    derivedRootHash: manifest.derivedRootHash,
    newMonths: months,
    note: "New pair-months were derived. Existing derived files were not rewritten, so their embedded stamps stay in the new root.",
  });
  console.log(`derive-new months ${months} prior ${prior} root ${manifest.derivedRootHash}`);
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
  const checked = assertFrozenRoots(paths.root);
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
  const derivedPath = join(paths.root, "derived-manifest.json");
  const derived = JSON.parse(readFileSync(derivedPath, "utf8")) as { derivedRootHash: string; files: { bytes: number }[] };
  const manifest = withLastRefreshed(checked.manifest, { commit: artifact.commitSha, at: artifact.createdAt });
  if (manifest.dataRootHash !== artifact.dataRootHash) throw new Error("candle root hash changed during refresh");
  if (manifest.dataRootHash !== checked.manifest.dataRootHash) throw new Error("refresh changed the frozen candle root");
  if (manifest.snapshot?.frozenAt !== checked.manifest.snapshot?.frozenAt) throw new Error("refresh changed frozenAt");
  if (manifest.commitSha !== checked.manifest.commitSha) throw new Error("refresh changed the frozen commit");
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
    `refresh lastRefreshed ${manifest.lastRefreshed?.commit} derivedRoot ${derived.derivedRootHash} candleRoot ${manifest.dataRootHash}`,
  );
}

function pairDirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => !name.startsWith(".")).sort();
}

function writeGeometry(): void {
  const fifteen = existsSync(paths.manifest) ? (JSON.parse(readFileSync(paths.manifest, "utf8")) as DataManifest) : null;
  const dailyPath = join(dailyDir(), "data-manifest.json");
  const daily = existsSync(dailyPath) ? (JSON.parse(readFileSync(dailyPath, "utf8")) as DataManifest) : null;
  if (!fifteen?.dataRootHash || !fifteen.snapshot?.universeComplete) throw new Error("15m snapshot is not frozen");
  if (!daily?.dataRootHash || !daily.snapshot?.universeComplete) throw new Error("daily snapshot is not frozen");
  if (fifteen.snapshotLift?.reason !== D2_LIFT_REASON) throw new Error("15m snapshot is not the D2 lift");
  const artifact = stamp("P3");
  const ids = [...new Set([...pairDirs(paths.candles), ...pairDirs(join(dailyDir(), "candles"))])].sort();
  const dailyCandles = join(dailyDir(), "candles");
  let loaded = 0;
  const load = function* () {
    for (const id of ids) {
      const pair = loadPair(id, dailyCandles, paths.candles);
      if (!pair) continue;
      loaded += 1;
      if (loaded % 20 === 0) writeSync(1, `geometry load ${loaded} ${id}\n`);
      yield pair;
    }
  };
  const exclusion = proposeExclusions(loadProducts().map((product) => product.productId));
  const excluded = new Set(exclusion.productIds);
  const scan = scanTwoPass(() => load(), excluded);
  const decision = existsSync(decisionPath()) ? (JSON.parse(readFileSync(decisionPath(), "utf8")) as OwnerDecisionFile) : null;
  const reasons = new Map<string, string>();
  const cut = decision?.entries.find((entry) => entry.id === "universe-cut");
  if (cut?.id === "universe-cut") {
    for (const row of cut.dropped) reasons.set(row.productId, row.reason);
  }
  const downloaded = pairDirs(paths.candles);
  const survival = survivorshipReport({
    catalog: loadProducts().map((product) => product.productId),
    downloaded,
    d2Executed: true,
    reasonFor: (productId) => reasons.get(productId) ?? "candles-not-served",
  });
  const roots = { dataRootHash: fifteen.dataRootHash, dailyRootHash: daily.dataRootHash };
  const scanDoc = {
    ...artifact,
    ...roots,
    label: scan.d3.b.label,
    signalCounts: scan.signalCounts,
    projectedOos: scan.projectedOos,
    d3: scan.d3,
    stopWidths: scan.stopWidths,
    btcFilterShares: scan.btcFilterShares,
    universeSize: scan.universeSize,
    passCounts: scan.passCounts,
    passCountFlag: scan.passCountFlag,
    volumeTier: scan.volumeTier,
    above5m: scan.above5m,
    overlap: scan.overlap,
    warmup: scan.warmup,
    firstUniverseDate: scan.firstUniverseDate,
    coverage: { names: scan.warmup.names, fifteenFiles: fifteen.files.length, dailyFiles: daily.files.length },
  };
  assertScanSchema(scanDoc);
  if (Date.parse(scan.overlap.tolerance.recordedAt) >= Date.parse(artifact.createdAt)) {
    throw new Error("overlap tolerance was not recorded before the scan timestamp");
  }
  const handoff = {
    ...artifact,
    ...roots,
    openItems: [
      "Exclusion proposal is unconfirmed.",
      "Overlap tolerance is unconfirmed.",
      "Fee tier is unconfirmed.",
      "Class E blackout calendar is not applied.",
      "Class D full-engine parity on the earlier candle set is not run. Numeric swing geometry is tested. The v3 target multiple is 4. The 87b35d0 omitted-argument default is 3.",
      "The class C book-wide cap of 3 entries per UTC day is not applied to geometry counts.",
      "Purge, embargo, and Holm are registration work and are not built.",
    ],
  };
  const files: [string, unknown][] = [
    ["exclusion-proposal.json", { ...artifact, ...roots, ...exclusion }],
    ["warmup-ledger.json", { ...artifact, ...roots, firstUniverseDate: scan.firstUniverseDate, rows: scan.warmupRows }],
    ["survivorship.json", { ...artifact, ...roots, ...survival }],
    ["overlap-check.json", { ...artifact, ...roots, ...scan.overlap }],
    ["geometry-scan.json", scanDoc],
    ["p3-handoff.json", handoff],
  ];
  for (const [name, body] of files) {
    assertNoBannedKeys(body, name);
    writeJson(join(paths.reports, name), body);
  }
  console.log(`geometry names ${scan.warmup.names} fifteen ${fifteen.dataRootHash} daily ${daily.dataRootHash}`);
}

async function writeJevSmoke(): Promise<void> {
  const artifact = stamp("P3");
  if (!process.env.TYPESAFE_AI_API_KEY) {
    const body = { ...artifact, ran: false, synthetic: true, reason: "TYPESAFE_AI_API_KEY is not set" };
    assertNoBannedKeys(body, "jev-smoke");
    writeJson(join(paths.reports, "jev-smoke.json"), body);
    console.log("jev smoke skipped: TYPESAFE_AI_API_KEY is not set");
    return;
  }
  const smoke = await jevSmoke(process.env);
  const body = { ...artifact, ran: true, modelId: smoke.modelId, latencyMs: smoke.latencyMs, synthetic: smoke.synthetic };
  assertNoBannedKeys(body, "jev-smoke");
  writeJson(join(paths.reports, "jev-smoke.json"), body);
  console.log(`jev smoke model ${smoke.modelId} latencyMs ${Math.round(smoke.latencyMs)}`);
}
