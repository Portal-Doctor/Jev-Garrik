import { expect, test } from "bun:test";
import { buildRevisionSample, chooseSample, revisionDue, runRevisionCheck, sampleCount } from "./revision";

const stamp = {
  commitSha: "b".repeat(40),
  dataRootHash: "root",
  createdAt: "2026-10-10T00:00:00.000Z",
  phaseId: "P1",
};

test("a 2% sample uses floor and is stable for a seed", () => {
  expect(sampleCount(49)).toBe(0);
  expect(sampleCount(50)).toBe(1);
  expect(sampleCount(100)).toBe(2);
  const paths = Array.from({ length: 100 }, (_, i) => `candles/P${i}-USD/2023-10.sqlite`);
  expect(chooseSample(paths, 0.02, "abc123")).toEqual(chooseSample(paths.slice().reverse(), 0.02, "abc123"));
  expect(chooseSample(paths, 0.02, "abc123")).toHaveLength(2);
});

test("revision check stays pending until 24h and does not redownload", async () => {
  const files = Array.from({ length: 50 }, (_, i) => ({
    path: `candles/P${String(i).padStart(2, "0")}-USD/2023-10.sqlite`,
    sha256: `hash-${i}`,
    bytes: 1,
  }));
  const sample = buildRevisionSample({ files, stamp, seed: "abc123", now: new Date("2026-10-10T00:00:00.000Z") });
  expect(sample.status).toBe("pending");
  expect(sample.sampleCount).toBe(1);
  expect(sample.earliestCompareAt).toBe("2026-10-11T00:00:00.000Z");
  expect(sample.mismatches).toBeNull();
  let calls = 0;
  const early = await runRevisionCheck(sample, new Date("2026-10-10T23:00:00.000Z"), async () => {
    calls += 1;
    return [];
  });
  expect(early).toMatchObject({ status: "pending", compared: false, mismatches: null });
  expect(calls).toBe(0);
  expect(revisionDue(sample, new Date("2026-10-11T00:00:00.000Z"))).toBe(true);
});

test("a due revision check reports hash mismatches", async () => {
  const files = Array.from({ length: 50 }, (_, i) => ({
    path: `candles/P${String(i).padStart(2, "0")}-USD/2023-10.sqlite`,
    sha256: "same",
    bytes: 1,
  }));
  const sample = buildRevisionSample({ files, stamp, seed: "abc123", now: new Date("2026-10-10T00:00:00.000Z") });
  const result = await runRevisionCheck(sample, new Date("2026-10-11T00:00:00.000Z"), async () =>
    sample.files.map((file) => ({ path: file.path, sha256: "changed" })),
  );
  expect(result.compared).toBe(true);
  expect(result.mismatches).toHaveLength(sample.sampleCount);
  expect(result.mismatches?.[0]?.actual).toBe("changed");
});

test("an empty 2% sample does not start the 24h clock", () => {
  const sample = buildRevisionSample({
    files: [{ path: "candles/BTC-USD/2023-10.sqlite", sha256: "aa", bytes: 1 }],
    stamp,
    seed: "abc123",
  });
  expect(sample.status).toBe("empty");
  expect(sample.sampleCount).toBe(0);
  expect(sample.earliestCompareAt).toBeNull();
});
