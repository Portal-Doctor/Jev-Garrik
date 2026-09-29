import { expect, test } from "bun:test";
import { ADVANCED_VIP_LADDER, US_ANNOUNCED_TIERS, tierReached, tiersInReach } from "./feetiers";

test("the US entry tier is the live 50/90 default and needs no volume", () => {
  const entry = US_ANNOUNCED_TIERS[0]!;
  expect(entry.makerBps).toBe(50);
  expect(entry.takerBps).toBe(90);
  expect(entry.thirtyDayVolumeUsd).toBe(0);
});

test("the first discounted US step starts at $10,000 of trailing 30 day volume", () => {
  const step = US_ANNOUNCED_TIERS.find((t) => t.thirtyDayVolumeUsd === 10_000);
  expect(step).toBeDefined();
  expect(step!.makerBps).toBe(25);
  expect(step!.takerBps).toBe(40);
});

test("every published row records where it was read from", () => {
  for (const t of [...US_ANNOUNCED_TIERS, ...ADVANCED_VIP_LADDER]) {
    expect(t.source.length).toBeGreaterThan(0);
  }
});

test("the advanced-vip ladder is monotonic: more volume never costs more", () => {
  for (let i = 1; i < ADVANCED_VIP_LADDER.length; i++) {
    const prev = ADVANCED_VIP_LADDER[i - 1]!;
    const cur = ADVANCED_VIP_LADDER[i]!;
    expect(cur.thirtyDayVolumeUsd).toBeGreaterThan(prev.thirtyDayVolumeUsd);
    expect(cur.makerBps).toBeLessThanOrEqual(prev.makerBps);
    expect(cur.takerBps).toBeLessThanOrEqual(prev.takerBps);
  }
});

test("tiers in reach keeps the entry row and rows within ten times measured turnover", () => {
  const inReach = tiersInReach(ADVANCED_VIP_LADDER, 30_000, 10);
  const names = inReach.map((t) => t.name);
  expect(names).toContain("Intro 1");
  expect(names).toContain("Intro 2");
  expect(names).toContain("Advanced 1");
  expect(names).toContain("Advanced 2");
  expect(names).toContain("Advanced 3");
  expect(names).not.toContain("VIP 1");
  expect(names).not.toContain("VIP 8");
});

test("a book with no turnover still gets the entry row and nothing above it", () => {
  expect(tiersInReach(ADVANCED_VIP_LADDER, 0, 10).map((t) => t.name)).toEqual(["Intro 1"]);
});

test("a tier is reached only when measured turnover clears its published cutoff", () => {
  const advanced1 = ADVANCED_VIP_LADDER.find((t) => t.name === "Advanced 1")!;
  expect(tierReached(advanced1, 24_999)).toBe(false);
  expect(tierReached(advanced1, 25_000)).toBe(true);
});
