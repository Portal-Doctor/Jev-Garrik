import { expect, test } from "bun:test";
import { gitCommitSha, stampArtifact } from "./manifest";

test("stamp records commit SHA, data root hash, creation timestamp, and phase id", () => {
  const createdAt = new Date("2026-10-10T22:00:00.000Z");
  const stamp = stampArtifact({
    commitSha: "abc123abc123abc123abc123abc123abc123abcd",
    dataRootHash: "deadbeef",
    createdAt,
    phaseId: "P0",
  });
  expect(stamp).toEqual({
    commitSha: "abc123abc123abc123abc123abc123abc123abcd",
    dataRootHash: "deadbeef",
    createdAt: "2026-10-10T22:00:00.000Z",
    phaseId: "P0",
  });
});

test("data root hash stays null until a candle manifest exists", () => {
  const stamp = stampArtifact({
    commitSha: "abc123abc123abc123abc123abc123abc123abcd",
    phaseId: "P1",
    createdAt: new Date("2026-10-10T00:00:00.000Z"),
  });
  expect(stamp.dataRootHash).toBeNull();
});

test("gitCommitSha matches git rev-parse HEAD", () => {
  const sha = gitCommitSha();
  expect(sha).toMatch(/^[0-9a-f]{40}$/);
});
