import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DERIVED_STAMP_NOTE } from "./derived-manifest";
import { withLastRefreshed } from "./refresh";
import type { DataManifest } from "./manifest-file";

test("refresh-reports on an empty data dir exits non-zero and writes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "refresh-empty-"));
  try {
    const proc = spawnSync(process.execPath, [join(import.meta.dir, "..", "cli.ts"), "refresh-reports"], {
      env: { ...process.env, RESEARCH_DATA_DIR: dir },
      encoding: "utf8",
    });
    expect(proc.status).not.toBe(0);
    expect(readdirSync(dir)).toEqual([]);
    expect(`${proc.stderr}\n${proc.stdout}`).toContain("refusing to refresh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("refresh-reports does not rewrite a manifest when candle files are missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "refresh-mismatch-"));
  const manifestPath = join(dir, "data-manifest.json");
  const body = `${JSON.stringify({
    commitSha: "a".repeat(40),
    dataRootHash: "abc",
    snapshot: { frozenAt: "2026-10-11T01:41:21.764Z" },
  })}\n`;
  writeFileSync(manifestPath, body);
  writeFileSync(join(dir, "derived-manifest.json"), `${JSON.stringify({ derivedRootHash: "def" })}\n`);
  try {
    const proc = spawnSync(process.execPath, [join(import.meta.dir, "..", "cli.ts"), "refresh-reports"], {
      env: { ...process.env, RESEARCH_DATA_DIR: dir },
      encoding: "utf8",
    });
    expect(proc.status).not.toBe(0);
    expect(readFileSync(manifestPath, "utf8")).toBe(body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lastRefreshed does not replace the frozen commit or frozenAt", () => {
  const manifest = {
    commitSha: "7fd9c2b10b5381ddbc83ecedf1bc3359aa0e5299",
    dataRootHash: "e79fb4b27584a745396edd21f769bb12457135a2cc91bb1f3ff75c955007b968",
    createdAt: "2026-10-10T23:47:55.410Z",
    updatedAt: "2026-10-11T01:41:21.759Z",
    phaseId: "P1",
    hashAlgorithm: "sha256",
    rootHashInput: "sorted lines of relativePath TAB sha256 LF, UTF-8",
    bunVersion: "1.4.3",
    writerVersion: "1",
    files: [],
    snapshot: { status: "frozen", reason: "frozen", downloadStartedAt: "t", downloadUpdatedAt: "t", frozenAt: "2026-10-11T01:41:21.764Z" },
  } as DataManifest;
  const next = withLastRefreshed(manifest, { commit: "c".repeat(40), at: "2026-10-11T01:42:36.815Z" });
  expect(next.commitSha).toBe(manifest.commitSha);
  expect(next.snapshot?.frozenAt).toBe("2026-10-11T01:41:21.764Z");
  expect(next.lastRefreshed).toEqual({ commit: "c".repeat(40), at: "2026-10-11T01:42:36.815Z" });
});

test("the derived manifest notes that its root includes file stamps", () => {
  const text = readFileSync(join(import.meta.dir, "..", "..", "data", "derived-manifest.json"), "utf8");
  const body = JSON.parse(text) as { stampEmbeddedNote: string; derivedRootHash: string };
  expect(body.stampEmbeddedNote).toBe(DERIVED_STAMP_NOTE);
  expect(body.derivedRootHash).toBe("bd6dc35cc0b7212c0e4a95bfba6a6aafe1bb19dcdf3091196ce47953498a1eb5");
  const roots = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "data", "reports", "derived-roots.json"), "utf8")) as {
    priorDerivedRootHash: string;
    derivedRootHash: string;
  };
  expect(roots.priorDerivedRootHash).toBe("1e509c1bd5b760703b4f52cc53a1e0ccab512f3e75e5f5b9fe1c00e4e0eefe7b");
  expect(roots.derivedRootHash).toBe(body.derivedRootHash);
});
