import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findBannedKeys, keyIsBanned } from "./banned";

const LEGIT = [
  "window",
  "windowStart",
  "windowDays",
  "returned",
  "exchange",
  "unchanged",
  "target",
  "coverage",
  "current",
  "quoteVolume30d",
  "range24h",
  "volume_30day",
  "createdAt",
  "fetchedAt",
];

const BANNED = [
  "pnl",
  "p&l",
  "return",
  "profit",
  "drawdown",
  "forward",
  "hitrate",
  "hit_rate",
  "hitRate",
  "gross",
  "net_bps",
  "netBps",
  "netbps",
  "fwd",
  "ret",
  "change",
  "priceChange",
  "outcome",
  "r_multiple",
  "rMultiple",
  "win",
  "winRate",
];

test("banned terms match whole tokens and field-name parts", () => {
  for (const key of LEGIT) expect(keyIsBanned(key)).toBe(false);
  for (const key of BANNED) expect(keyIsBanned(key)).toBe(true);
  expect(findBannedKeys({ window: 1, forward: 1 }).map((hit) => hit.split(".").pop())).toEqual(["forward"]);
});

test("product-stats carries a commit, a root, and a created time", () => {
  const stats = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "data", "reports", "product-stats.json"), "utf8")) as {
    commitSha: string;
    dataRootHash: string;
    createdAt: string;
    fetchedAt: string;
  };
  expect(stats.commitSha).toBe("7fd9c2b10b5381ddbc83ecedf1bc3359aa0e5299");
  expect(stats.dataRootHash).toBe("e79fb4b27584a745396edd21f769bb12457135a2cc91bb1f3ff75c955007b968");
  expect(stats.createdAt).toBe("2026-10-11T01:30:01.000Z");
  expect(stats.fetchedAt).toBe("2026-10-11T00:08:06.000Z");
});

test("committed stats and decision documents still have no banned fields", () => {
  const reports = join(import.meta.dir, "..", "..", "data", "reports");
  for (const name of ["product-stats.json", "owner-decision.json", "p1-report.json", "coverage.json", "delisted-probe.json"]) {
    const body = JSON.parse(readFileSync(join(reports, name), "utf8")) as unknown;
    expect(findBannedKeys(body)).toEqual([]);
  }
});
