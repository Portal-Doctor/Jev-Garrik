import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertCleanWorkTree, gitCommitSha, stampArtifact, stampFromGit } from "./manifest";

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

test("stamping refuses a dirty work tree", () => {
  const dir = mkdtempSync(join(tmpdir(), "research-stamp-"));
  const git = (args: string[]) => {
    const proc = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
    if (proc.status !== 0) throw new Error(proc.stderr || proc.stdout);
  };
  git(["init"]);
  git(["config", "user.email", "stamp@example.com"]);
  git(["config", "user.name", "Stamp Test"]);
  writeFileSync(join(dir, "a.txt"), "a\n");
  git(["add", "a.txt"]);
  git(["commit", "-m", "init"]);
  const clean = stampFromGit({ phaseId: "P1", cwd: dir, createdAt: new Date("2026-10-11T00:00:00.000Z") });
  expect(clean.commitSha).toBe(gitCommitSha(dir));
  expect(assertCleanWorkTree(dir)).toBeUndefined();
  writeFileSync(join(dir, "b.txt"), "b\n");
  expect(() => stampFromGit({ phaseId: "P1", cwd: dir })).toThrow(/dirty git tree/);
  rmSync(dir, { recursive: true, force: true });
});
