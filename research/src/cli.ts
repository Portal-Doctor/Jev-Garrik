/**
 * Public market-data commands. Refuses to start when an order-capable credential is set.
 *
 *   bun run research/src/cli.ts snapshot
 *   bun run research/src/cli.ts download
 *   bun run research/src/cli.ts probe
 *   bun run research/src/cli.ts derive
 *   bun run research/src/cli.ts ticks
 *   bun run research/src/cli.ts coverage
 *   bun run research/src/cli.ts revision-sample
 *   bun run research/src/cli.ts revision-check
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "./index";
import { gitCommitSha, stampArtifact, type ArtifactStamp } from "./manifest";
import { createPacer, downloadUsdSpot } from "./data/download";
import { derivePairMonthFile } from "./data/derive-store";
import { sha256Bytes } from "./data/hash";
import { writeBytes, writeJson } from "./data/io";
import { buildCoverage } from "./data/coverage";
import { scanCandleFiles } from "./data/manifest-file";
import { dataPaths } from "./data/paths";
import { probeDelisted } from "./data/probe";
import { usdSpotFromExchange, type UsdSpotProduct } from "./data/products";
import { productsUrl, publicHeaders } from "./data/public";
import { buildRevisionSample, runRevisionCheck, type RevisionFile, type RevisionSample } from "./data/revision";
import { readPairMonth } from "./data/store";
import { tickReport } from "./data/tick";

const started = boot();
if (!started.ok) {
  console.error(started.reason);
  process.exit(1);
}

const paths = dataPaths(realDataDir());
const command = process.argv[2] ?? "";

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
    case "revision-sample":
      revisionSample();
      return;
    case "revision-check":
      await revisionCheck();
      return;
    default:
      throw new Error(
        "usage: snapshot | download | probe | derive | ticks | coverage | revision-sample | revision-check",
      );
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
  for (const path of [paths.usdSpot, paths.probe, paths.ticks, paths.coverage, paths.revisionSample]) {
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

async function download(): Promise<void> {
  const intervalMs = Number(process.env.RESEARCH_REQUEST_INTERVAL_MS ?? "150");
  const summary = await downloadUsdSpot({
    products: loadProducts(),
    dataDir: paths.root,
    now: new Date(),
    stamp: stamp("P1"),
    intervalMs,
    stopFile: paths.stopFile,
  });
  applyRootHash();
  console.log(JSON.stringify(summary));
}

async function probe(): Promise<void> {
  const intervalMs = Number(process.env.RESEARCH_REQUEST_INTERVAL_MS ?? "150");
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

function revisionSample(): void {
  const files = scanCandleFiles(paths.root);
  const sample = buildRevisionSample({
    files,
    stamp: stamp("P1"),
    seed: randomBytes(16).toString("hex"),
    now: new Date(),
  });
  writeJson(paths.revisionSample, sample);
  applyRootHash();
  console.log(JSON.stringify({ status: sample.status, population: sample.population, sampleCount: sample.sampleCount, earliestCompareAt: sample.earliestCompareAt }));
}

async function revisionCheck(): Promise<void> {
  if (!existsSync(paths.revisionSample)) throw new Error("revision sample is missing");
  const sample = JSON.parse(readFileSync(paths.revisionSample, "utf8")) as RevisionSample;
  const result = await runRevisionCheck(sample, new Date(), () => redownload(sample));
  if (!result.compared) {
    console.log(JSON.stringify({ status: "pending", earliestCompareAt: result.earliestCompareAt, compared: false }));
    return;
  }
  writeJson(join(paths.reports, "revision-check.json"), { ...stamp("P1"), ...result });
  console.log(JSON.stringify({ status: result.status, mismatches: result.mismatches?.length ?? 0 }));
}

async function redownload(sample: RevisionSample): Promise<RevisionFile[]> {
  const only = new Set<string>();
  const ranges = new Map<string, { startSec: number; endSec: number }>();
  for (const file of sample.files) {
    const match = /^candles\/([^/]+)\/(\d{4}-\d{2})\.sqlite$/.exec(file.path);
    if (!match || !match[1] || !match[2]) throw new Error(`unexpected candle path ${file.path}`);
    const key = `${match[1]}/${match[2]}`;
    only.add(key);
    const stored = readPairMonth(join(paths.root, file.path));
    ranges.set(key, {
      startSec: Date.parse(stored.meta.windowStart) / 1000,
      endSec: Date.parse(stored.meta.windowEnd) / 1000,
    });
  }
  const temp = mkdtempSync(join(tmpdir(), "research-revision-"));
  try {
    await downloadUsdSpot({
      products: loadProducts().filter((product) => [...only].some((key) => key.startsWith(`${product.productId}/`))),
      dataDir: temp,
      now: new Date(),
      stamp: stamp("P1"),
      only,
      ranges,
      log: () => {},
    });
    return scanCandleFiles(temp).map((file) => ({ path: file.path, sha256: file.sha256 }));
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}
