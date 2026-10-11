import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMANDS = ["geometry", "derive-new", "coverage", "p1-report", "ticks", "universe-cut", "download-daily", "p5"] as const;

test("artifact commands refuse an empty data dir and write nothing", () => {
  const cli = join(import.meta.dir, "..", "cli.ts");
  for (const command of COMMANDS) {
    const dir = mkdtempSync(join(tmpdir(), `guard-${command}-`));
    try {
      const before = readdirSync(dir);
      const proc = spawnSync(process.execPath, [cli, command], {
        env: { ...process.env, RESEARCH_DATA_DIR: dir },
        encoding: "utf8",
      });
      expect(proc.status, command).not.toBe(0);
      expect(readdirSync(dir), command).toEqual(before);
      expect(`${proc.stderr}\n${proc.stdout}`, command).toContain("refusing");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("prehash refuses an empty data dir and writes no geometry", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-prehash-"));
  const script = join(import.meta.dir, "..", "p5", "prehash.ts");
  try {
    const proc = spawnSync(process.execPath, [script], {
      env: { ...process.env, RESEARCH_DATA_DIR: dir },
      encoding: "utf8",
    });
    expect(proc.status).not.toBe(0);
    expect(`${proc.stderr}\n${proc.stdout}`).toContain("refusing");
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("download-daily does not restamp a frozen manifest whose files are missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "guard-daily-"));
  const daily = join(dir, "daily");
  mkdirSync(daily);
  const manifestPath = join(daily, "data-manifest.json");
  const body = `${JSON.stringify({
    commitSha: "a30b246a95951faa4f99882bf9ddba0a2fad24d1",
    dataRootHash: "76c41956e5575bb2c3223d168e4c3dd62dbd3725d583aac717ad15a931ef4ad4",
    createdAt: "2026-10-11T02:05:24.601Z",
    snapshot: {
      status: "frozen",
      universeComplete: true,
      frozenAt: "2026-10-11T02:35:46.619Z",
      downloadStartedAt: "2026-10-11T02:05:24.812Z",
      downloadUpdatedAt: "2026-10-11T02:35:46.619Z",
    },
  })}\n`;
  writeFileSync(manifestPath, body);
  try {
    const proc = spawnSync(process.execPath, [join(import.meta.dir, "..", "cli.ts"), "download-daily"], {
      env: { ...process.env, RESEARCH_DATA_DIR: dir },
      encoding: "utf8",
    });
    expect(proc.status).not.toBe(0);
    expect(readFileSync(manifestPath, "utf8")).toBe(body);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the D1 freeze record names the commit that froze it", () => {
  const manifest = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "data", "daily", "data-manifest.json"), "utf8")) as {
    commitSha: string;
    createdAt: string;
    updatedAt: string;
    snapshot: { frozenAt: string; downloadStartedAt: string; downloadUpdatedAt: string };
  };
  expect(manifest.commitSha).toBe("a30b246a95951faa4f99882bf9ddba0a2fad24d1");
  expect(manifest.snapshot.frozenAt).toBe("2026-10-11T02:35:46.619Z");
  expect(manifest.createdAt).toBe("2026-10-11T02:05:24.601Z");
  expect(Date.parse(manifest.snapshot.downloadUpdatedAt)).toBeGreaterThanOrEqual(Date.parse(manifest.snapshot.downloadStartedAt));
  expect(manifest.snapshot.downloadUpdatedAt).toBe(manifest.snapshot.frozenAt);
  expect(manifest.updatedAt).toBe(manifest.snapshot.frozenAt);
});
