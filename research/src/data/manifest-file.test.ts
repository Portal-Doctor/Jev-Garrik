import { expect, test } from "bun:test";
import { sealFrozenSnapshot, type DataManifest } from "./manifest-file";

test("sealing a snapshot keeps the root hash and records the owner freeze", () => {
  const manifest: DataManifest = {
    commitSha: "a".repeat(40),
    dataRootHash: "root-hash",
    createdAt: "2026-10-10T22:46:57.932Z",
    updatedAt: "2026-10-10T23:14:12.287Z",
    phaseId: "P1",
    hashAlgorithm: "sha256",
    rootHashInput: "sorted lines of relativePath TAB sha256 LF, UTF-8",
    bunVersion: "1.4.3",
    writerVersion: "1",
    files: [{ path: "candles/00-USD/2023-10.sqlite", sha256: "abc", bytes: 10 }],
  };
  const sealed = sealFrozenSnapshot(manifest, new Date("2026-10-10T23:20:00.000Z"));
  expect(sealed.dataRootHash).toBe("root-hash");
  expect(sealed.files).toEqual(manifest.files);
  expect(sealed.snapshot).toEqual({
    status: "frozen",
    reason: expect.stringContaining("24h revision check"),
    downloadStartedAt: "2026-10-10T22:46:57.932Z",
    downloadUpdatedAt: "2026-10-10T23:14:12.287Z",
    frozenAt: "2026-10-10T23:20:00.000Z",
  });
  expect(sealed.snapshot?.reason.includes("not an open item")).toBe(true);
});
