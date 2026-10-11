import { expect, test } from "bun:test";
import { BELOW_RANK_CUTOFF_LIFT_REASON, liftCompletedFreeze, liftInProgressFreeze, sealFrozenSnapshot, type DataManifest } from "./manifest-file";

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

test("an in-progress freeze can be lifted and a completed universe cannot", () => {
  const manifest: DataManifest = {
    commitSha: "a".repeat(40),
    dataRootHash: "67b8963191a52383657fff6bd6bc505327aa540fe4009de6d264e2c4cd2799d8",
    createdAt: "2026-10-10T22:46:57.932Z",
    updatedAt: "2026-10-10T23:14:12.287Z",
    phaseId: "P1",
    hashAlgorithm: "sha256",
    rootHashInput: "sorted lines of relativePath TAB sha256 LF, UTF-8",
    bunVersion: "1.4.3",
    writerVersion: "1",
    files: [{ path: "candles/00-USD/2023-10.sqlite", sha256: "abc", bytes: 10 }],
    snapshot: {
      status: "frozen",
      reason: "partial",
      downloadStartedAt: "2026-10-10T22:46:57.932Z",
      downloadUpdatedAt: "2026-10-10T23:14:12.287Z",
      frozenAt: "2026-10-10T23:23:41.185Z",
    },
  };
  const superseded = manifest.dataRootHash;
  if (superseded == null) throw new Error("fixture hash");
  const lifted = liftInProgressFreeze(manifest, new Date("2026-10-10T23:40:00.000Z"));
  expect(lifted.snapshot).toBeUndefined();
  expect(lifted.createdAt).toBe(manifest.createdAt);
  expect(lifted.dataRootHash).toBe(manifest.dataRootHash);
  expect(lifted.snapshotLift).toEqual({
    liftedAt: "2026-10-10T23:40:00.000Z",
    reason: expect.stringContaining("did not make the partial download final"),
    supersededDataRootHash: superseded,
    supersededFrozenAt: "2026-10-10T23:23:41.185Z",
    supersededFileCount: 1,
  });
  const sealed = sealFrozenSnapshot(lifted, new Date("2026-10-11T00:00:00.000Z"), {
    universeComplete: true,
    supersededDataRootHash: lifted.snapshotLift?.supersededDataRootHash ?? null,
  });
  expect(sealed.snapshot?.universeComplete).toBe(true);
  expect(sealed.snapshot?.reason.startsWith("Frozen by owner decision")).toBe(true);
  expect(sealed.snapshot?.reason.includes(superseded)).toBe(true);
  expect(() => liftInProgressFreeze(sealed, new Date("2026-10-11T01:00:00.000Z"))).toThrow("completed snapshot stays frozen");
  const again = liftCompletedFreeze(sealed, new Date("2026-10-11T02:00:00.000Z"), "add names back");
  expect(again.snapshot).toBeUndefined();
  expect(again.snapshotLift?.supersededDataRootHash).toBe(superseded);
  expect(again.snapshotLift?.priorSnapshotLift?.supersededDataRootHash).toBe(superseded);
});

test("the rank-cutoff lift reason uses 2026-10-10 20:19 CT (01:19Z)", () => {
  expect(BELOW_RANK_CUTOFF_LIFT_REASON).toContain("2026-10-10 20:19 CT (01:19Z)");
  expect(BELOW_RANK_CUTOFF_LIFT_REASON.includes("2026-10-11 20:19")).toBe(false);
});
