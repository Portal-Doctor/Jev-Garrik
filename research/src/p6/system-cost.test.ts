import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { PAPER_MINIMUM_USD } from "../p3/design-rules";
import { p6HealthJson, readP6Page, redactP6View } from "./dashboard-read";
import { PNL_START_USD } from "./pnl-block";
import { memoryKv } from "./relay";
import { FORWARD_BAR_1 } from "./select";
import {
  accruedSystemCostUsd,
  displayedPnlUsd,
  formatCostR,
  formatSignedR,
  isIsoDate,
  loadSystemCostConfig,
  netAfterSystemCost,
  parseSystemCostConfig,
  readSystemCostHurdle,
  SYSTEM_COST_CUTOVER_MS,
  SYSTEM_COST_R_USD,
  SYSTEM_COST_START_ISO,
  SYSTEM_COST_START_MS,
  systemCostHurdle,
  systemCostLight,
  usdToR,
  type SystemCostConfig,
  type SystemCostHurdle,
} from "./system-cost";

const DAY_MS = 86_400_000;
const VERCEL_NOTE = "$110 is an estimate: projected $110-125 for the Oct 18-Nov 18 cycle, with $25.04 billed so far.";
const REDIS_NOTE = "confirmed from invoices";
const MONTHLY_USD = 115.25;

const committed: SystemCostConfig = {
  lastUpdated: "2026-10-24",
  items: [
    { name: "Vercel Pro", monthlyUsd: 110, estimate: true, note: VERCEL_NOTE },
    { name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE },
  ],
};

function atStart(pnlUsd: number | null, nowMs = SYSTEM_COST_START_MS) {
  return systemCostHurdle({ config: committed, pnlUsd, nowMs });
}

function view(over: { systemCost?: SystemCostHurdle & Record<string, unknown> } = {}) {
  return {
    lease: null,
    lastRun: null,
    killSwitch: false,
    incidents: [] as string[],
    gaps: [] as { startMs: number; endMs: number; cause?: string }[],
    positions: [],
    closed: [],
    emitted: [] as string[],
    unreadable: false,
    lastUnreadable: false,
    ...over,
  };
}

test("the forward-test start and the R unit stay the ones the engine already uses", () => {
  expect(SYSTEM_COST_START_ISO).toBe(FORWARD_BAR_1);
  expect(SYSTEM_COST_START_MS).toBe(Date.parse(FORWARD_BAR_1));
  expect(SYSTEM_COST_R_USD).toBe(PAPER_MINIMUM_USD);
  expect(SYSTEM_COST_R_USD).toBe(20);
  expect(PNL_START_USD).toBe(8000);
});

test("a day is monthly times 12/365.25 and a 365.25-day year is twelve months", () => {
  expect(accruedSystemCostUsd(110, 0, DAY_MS)).toBeCloseTo((110 * 12) / 365.25, 10);
  expect(accruedSystemCostUsd(110, 0, 365.25 * DAY_MS)).toBeCloseTo(110 * 12, 8);
  expect(accruedSystemCostUsd(110, 5_000, 5_000)).toBe(0);
  expect(accruedSystemCostUsd(110, 5_000, 1_000)).toBe(0);
  const half = accruedSystemCostUsd(110, 0, DAY_MS / 2);
  expect(half).toBeCloseTo(accruedSystemCostUsd(110, 0, DAY_MS) / 2, 10);
});

test("$20 is 1R and net P/L is the existing P/L minus accrued cost", () => {
  expect(usdToR(20)).toBe(1);
  expect(usdToR(110)).toBe(5.5);
  expect(usdToR(MONTHLY_USD)).toBe(5.7625);
  expect(usdToR(0)).toBe(0);
  expect(netAfterSystemCost(100, 12.5)).toBe(87.5);
  expect(usdToR(netAfterSystemCost(100, 12.5))).toBe(4.375);
  expect(netAfterSystemCost(0, 0)).toBe(0);
  expect(netAfterSystemCost(-5, 2)).toBe(-7);
  expect(displayedPnlUsd(8120)).toBe(120);
  expect(displayedPnlUsd(PNL_START_USD)).toBe(0);
  expect(displayedPnlUsd(null)).toBeNull();
  expect(displayedPnlUsd(Number.NaN)).toBeNull();
  expect(formatCostR(5.5)).toBe("5.50R");
  expect(formatCostR(usdToR(MONTHLY_USD))).toBe("5.76R");
  expect(formatSignedR(4.375)).toBe("+4.38R");
  expect(formatSignedR(-0.5)).toBe("-0.50R");
  expect(formatSignedR(0)).toBe("0.00R");
});

test("the light is amber with no closed trade or with net exactly zero, red below zero, and green above zero", () => {
  expect(systemCostLight(10, 0)).toBe("amber");
  expect(systemCostLight(-10, 0)).toBe("amber");
  expect(systemCostLight(0, 0)).toBe("amber");
  expect(systemCostLight(0, 1)).toBe("amber");
  expect(systemCostLight(-1e-9, 1)).toBe("red");
  expect(systemCostLight(1e-9, 1)).toBe("green");
  const none = systemCostHurdle({ config: committed, pnlUsd: 10, nowMs: SYSTEM_COST_START_MS, closedTrades: 0 });
  expect(none.netUsd).toBe(10);
  expect(none.light).toBe("amber");
  const openLoss = systemCostHurdle({ config: committed, pnlUsd: -10, nowMs: SYSTEM_COST_START_MS, closedTrades: 0 });
  expect(openLoss.netUsd).toBe(-10);
  expect(openLoss.light).toBe("amber");
  const closed = (pnlUsd: number) => systemCostHurdle({ config: committed, pnlUsd, nowMs: SYSTEM_COST_START_MS, closedTrades: 1 });
  expect(atStart(0).accruedUsd).toBe(0);
  expect(atStart(0).sunkUsd).toBe(0);
  expect(atStart(0).netUsd).toBe(0);
  expect(atStart(0).netR).toBe(0);
  expect(atStart(0).light).toBe("amber");
  expect(closed(0).netUsd).toBe(0);
  expect(closed(0).light).toBe("amber");
  expect(closed(0.01).netUsd).toBe(0.01);
  expect(closed(0.01).light).toBe("green");
  expect(closed(-0.01).netUsd).toBe(-0.01);
  expect(closed(-0.01).light).toBe("red");
});

test("a full year still accrues twelve months, and only the part after the forward start is in the light", () => {
  const later = atStart(0, SYSTEM_COST_START_MS + DAY_MS);
  expect(later.accruedUsd).toBeGreaterThan(0);
  expect(later.sunkUsd).toBeCloseTo(later.accruedUsd!, 10);
  expect(later.netUsd).toBe(0);
  expect(later.light).toBe("amber");
  expect(later.monthlyR).toBe(5.7625);
  expect(later.accruedR).toBeCloseTo(usdToR(later.accruedUsd!), 10);
  const year = systemCostHurdle({
    config: committed,
    pnlUsd: 0,
    nowMs: SYSTEM_COST_START_MS + 365.25 * DAY_MS,
    closedTrades: 1,
  });
  expect(year.accruedUsd).toBeCloseTo(MONTHLY_USD * 12, 6);
  const sunk = accruedSystemCostUsd(MONTHLY_USD, SYSTEM_COST_START_MS, SYSTEM_COST_CUTOVER_MS);
  expect(year.sunkUsd).toBeCloseTo(sunk, 6);
  expect(year.netUsd).toBeCloseTo(-(year.accruedUsd! - year.sunkUsd!), 6);
  expect(year.netUsd!).toBeLessThan(0);
  expect(year.light).toBe("red");
  const waiting = systemCostHurdle({ config: committed, pnlUsd: 0, nowMs: SYSTEM_COST_START_MS + 365.25 * DAY_MS, closedTrades: 0 });
  expect(waiting.netUsd).toBeCloseTo(year.netUsd!, 6);
  expect(waiting.light).toBe("amber");
});

test("a missing P/L leaves the cost numbers and an unavailable light", () => {
  const hurdle = atStart(null, SYSTEM_COST_START_MS + DAY_MS);
  expect(hurdle.status).toBe("ok");
  expect(hurdle.monthlyUsd).toBe(MONTHLY_USD);
  expect(hurdle.accruedUsd).toBeGreaterThan(0);
  expect(hurdle.pnlUsd).toBeNull();
  expect(hurdle.netUsd).toBeNull();
  expect(hurdle.light).toBe("unavailable");
});

test("a bad config is unavailable and does not throw", () => {
  const item = { name: "Vercel Pro", monthlyUsd: 110 };
  const bad = [
    null,
    110,
    {},
    { lastUpdated: "2026-10-24" },
    { lastUpdated: "2026-13-40", items: [item] },
    { lastUpdated: "2026-02-31", items: [item] },
    { lastUpdated: "10/24/2026", items: [item] },
    { lastUpdated: "2026-10-24T00:00:00.000Z", items: [item] },
    { lastUpdated: "2026-10-24", items: [{ name: "Vercel Pro", monthlyUsd: -1 }] },
    { lastUpdated: "2026-10-24", items: [{ name: "Vercel Pro", monthlyUsd: Number.POSITIVE_INFINITY }] },
    { lastUpdated: "2026-10-24", items: [{ name: "Vercel Pro", monthlyUsd: Number.NaN }] },
    { lastUpdated: "2026-10-24", items: [{ name: "", monthlyUsd: 1 }] },
    { lastUpdated: "2026-10-24", items: [{ name: "Vercel Pro", monthlyUsd: 110, note: 12 }] },
    { lastUpdated: "2026-10-24", items: [{ name: "Vercel Pro", monthlyUsd: 110, estimate: "yes" }] },
    { lastUpdated: "2026-10-24", items: "Vercel Pro" },
    { lastUpdated: "2026-10-24", items: [null] },
  ];
  for (const raw of bad) {
    expect(parseSystemCostConfig(raw), JSON.stringify(raw)).toBeNull();
    const hurdle = systemCostHurdle({ config: parseSystemCostConfig(raw), pnlUsd: 1, nowMs: SYSTEM_COST_START_MS });
    expect(hurdle.status).toBe("unavailable");
    expect(hurdle.light).toBe("unavailable");
    expect(hurdle.monthlyUsd).toBeUndefined();
  }
  expect(isIsoDate("2026-10-24")).toBe(true);
  expect(isIsoDate("2024-02-29")).toBe(true);
  expect(isIsoDate("2025-02-29")).toBe(false);
  expect(loadSystemCostConfig("not json")).toBeNull();
  expect(loadSystemCostConfig("")).toBeNull();
  expect(loadSystemCostConfig("{")).toBeNull();
  expect(systemCostHurdle({ config: null, pnlUsd: 10, nowMs: Number.NaN }).status).toBe("unavailable");
});

test("the committed file freezes the $115.25 history at the 2026-10-26 cutover and bills $0 after it", () => {
  const config = loadSystemCostConfig();
  const dockerNote = "Brian's local Docker server, no charge after the cutover";
  expect(config?.lastUpdated).toBe("2026-10-24");
  expect(config?.cutover).toBe("2026-10-26");
  expect(config?.spans).toEqual([
    {
      from: "2026-10-10",
      until: "2026-10-26",
      items: [
        { name: "Vercel Pro", monthlyUsd: 110, estimate: true, note: VERCEL_NOTE },
        { name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE },
      ],
    },
    { from: "2026-10-26", items: [{ name: "Local Docker", monthlyUsd: 0, note: dockerNote }] },
  ]);
  expect(config?.items).toEqual([{ name: "Local Docker", monthlyUsd: 0, note: dockerNote }]);
  const now = Date.parse("2026-10-26T00:00:00.000Z");
  const days = (now - SYSTEM_COST_START_MS) / DAY_MS;
  const frozen = (MONTHLY_USD * 12) / 365.25 * days;
  const hurdle = systemCostHurdle({ config, pnlUsd: 0, nowMs: now });
  expect(hurdle.status).toBe("ok");
  expect(hurdle.monthlyUsd).toBe(0);
  expect(hurdle.monthlyR).toBe(0);
  expect(hurdle.since).toBe(SYSTEM_COST_START_ISO);
  expect(hurdle.elapsedDays).toBe(days);
  expect(hurdle.accruedUsd).toBeCloseTo(frozen, 8);
  expect(hurdle.sunkUsd).toBeCloseTo(frozen, 8);
  expect(hurdle.sunkR).toBeCloseTo(usdToR(frozen), 8);
  expect(hurdle.netUsd).toBe(0);
  expect(hurdle.light).toBe("amber");
  const closedAtZero = systemCostHurdle({ config, pnlUsd: 0, nowMs: now, closedTrades: 1 });
  expect(closedAtZero.netUsd).toBe(0);
  expect(closedAtZero.light).toBe("amber");
  expect(hurdle.items?.[0]).toEqual({ name: "Vercel Pro", monthlyUsd: 110, estimate: true, note: VERCEL_NOTE, from: "2026-10-10", until: "2026-10-26" });
  expect(hurdle.items?.[1]).toEqual({ name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE, from: "2026-10-10", until: "2026-10-26" });
  expect(hurdle.items?.[2]).toEqual({ name: "Local Docker", monthlyUsd: 0, note: dockerNote, from: "2026-10-26" });
  const before = systemCostHurdle({ config, pnlUsd: 0, nowMs: now - 1 });
  expect(before.monthlyUsd).toBe(MONTHLY_USD);
  expect(before.accruedUsd).toBeLessThan(frozen);
  expect(before.sunkUsd).toBeCloseTo(before.accruedUsd!, 8);
  expect(before.netUsd).toBe(0);
  const later = systemCostHurdle({ config, pnlUsd: 0, nowMs: now + 30 * DAY_MS });
  expect(later.monthlyUsd).toBe(0);
  expect(later.accruedUsd).toBeCloseTo(frozen, 8);
  expect(later.sunkUsd).toBeCloseTo(frozen, 8);
  expect(later.netUsd).toBe(0);
  expect(later.elapsedDays).toBe(days + 30);
  const confirmed = parseSystemCostConfig({
    lastUpdated: "2026-10-24",
    items: [{ name: "Redis Cloud", monthlyUsd: 5.25, estimate: false, note: REDIS_NOTE }],
  });
  expect(confirmed?.items[0]?.estimate).toBeUndefined();
  expect(confirmed?.spans).toBeUndefined();
  expect(parseSystemCostConfig({ lastUpdated: "2026-10-24", spans: [] })).toBeNull();
  expect(parseSystemCostConfig({ lastUpdated: "2026-10-24", spans: [{ from: "2026-10-24", until: "2026-10-10", items: [] }] })).toBeNull();
});

test("overlapping cost spans are rejected and contiguous spans are billed once", () => {
  const item = (name: string, monthlyUsd: number) => [{ name, monthlyUsd }];
  const overlap = {
    lastUpdated: "2026-10-24",
    spans: [
      { from: "2026-10-10", until: "2026-10-26", items: item("Vercel Pro", 110) },
      { from: "2026-10-20", until: "2026-11-01", items: item("Redis Cloud", 5.25) },
    ],
  };
  expect(() => parseSystemCostConfig(overlap)).toThrow("overlapping system cost spans: 2026-10-10..2026-10-26 and 2026-10-20..2026-11-01");
  expect(() => loadSystemCostConfig(JSON.stringify(overlap))).toThrow("overlapping system cost spans");
  const doubled = systemCostHurdle({
    config: {
      lastUpdated: "2026-10-24",
      items: [],
      spans: [
        { from: "2026-10-10", until: "2026-10-26", items: item("Vercel Pro", 100) },
        { from: "2026-10-10", until: "2026-10-26", items: item("Redis Cloud", 100) },
      ],
    },
    pnlUsd: 0,
    nowMs: Date.parse("2026-10-26T00:00:00.000Z"),
  });
  expect(doubled.status).toBe("unavailable");
  expect(doubled.accruedUsd).toBeUndefined();
  const contiguous = parseSystemCostConfig({
    lastUpdated: "2026-10-24",
    spans: [
      { from: "2026-10-10", until: "2026-10-26", items: item("Vercel Pro", 110) },
      { from: "2026-10-26", items: item("Local Docker", 0) },
    ],
  });
  expect(contiguous?.spans).toHaveLength(2);
  const now = Date.parse("2026-10-26T00:00:00.000Z");
  const once = accruedSystemCostUsd(110, SYSTEM_COST_START_MS, now);
  const hurdle = systemCostHurdle({ config: contiguous, pnlUsd: 0, nowMs: now + 10 * DAY_MS });
  expect(hurdle.status).toBe("ok");
  expect(hurdle.monthlyUsd).toBe(0);
  expect(hurdle.accruedUsd).toBeCloseTo(once, 8);
  expect(hurdle.sunkUsd).toBeCloseTo(once, 8);
  expect(hurdle.netUsd).toBe(0);
  expect(hurdle.accruedUsd).not.toBeCloseTo(once * 2, 8);
});

test("pre-cutover cost is excluded from the light and shown as sunk history, including the exact forward-start boundary", () => {
  const config = loadSystemCostConfig();
  const now = Date.parse("2026-10-24T00:00:00.000Z");
  const cutover = SYSTEM_COST_CUTOVER_MS;
  expect(cutover).toBe(Date.parse("2026-10-26T00:00:00.000Z"));
  const sunk = (MONTHLY_USD * 12) / 365.25 * ((now - SYSTEM_COST_START_MS) / DAY_MS);
  const green = systemCostHurdle({ config, pnlUsd: 1, nowMs: now, closedTrades: 1 });
  expect(green.sunkUsd).toBeCloseTo(sunk, 8);
  expect(green.accruedUsd).toBeCloseTo(sunk, 8);
  expect(green.netUsd).toBeCloseTo(1, 8);
  expect(green.netUsd).not.toBeCloseTo(1 - sunk, 2);
  expect(green.light).toBe("green");
  const red = systemCostHurdle({ config, pnlUsd: -1, nowMs: now, closedTrades: 1 });
  expect(red.netUsd).toBeCloseTo(-1, 8);
  expect(red.light).toBe("red");
  const waiting = systemCostHurdle({ config, pnlUsd: 50, nowMs: now, closedTrades: 0 });
  expect(waiting.netUsd).toBeCloseTo(50, 8);
  expect(waiting.sunkUsd).toBeCloseTo(sunk, 8);
  expect(waiting.light).toBe("amber");
  const frozen = (MONTHLY_USD * 12) / 365.25 * ((cutover - SYSTEM_COST_START_MS) / DAY_MS);
  const at = systemCostHurdle({ config, pnlUsd: 0, nowMs: cutover, closedTrades: 1 });
  expect(at.monthlyUsd).toBe(0);
  expect(at.sunkUsd).toBeCloseTo(frozen, 8);
  expect(at.accruedUsd).toBeCloseTo(frozen, 8);
  expect(at.netUsd).toBe(0);
  expect(at.light).toBe("amber");
  const justBefore = systemCostHurdle({ config, pnlUsd: 0, nowMs: cutover - 1, closedTrades: 1 });
  expect(justBefore.monthlyUsd).toBe(MONTHLY_USD);
  expect(justBefore.sunkUsd).toBeLessThan(frozen);
  expect(justBefore.sunkUsd).toBeCloseTo(justBefore.accruedUsd!, 8);
  expect(justBefore.netUsd).toBe(0);
  expect(justBefore.light).toBe("amber");
  const justAfter = systemCostHurdle({ config, pnlUsd: 5, nowMs: cutover + 1, closedTrades: 1 });
  expect(justAfter.sunkUsd).toBeCloseTo(frozen, 8);
  expect(justAfter.accruedUsd).toBeCloseTo(frozen, 8);
  expect(justAfter.netUsd).toBeCloseTo(5, 8);
  expect(justAfter.light).toBe("green");
  const paidAfter = parseSystemCostConfig({
    lastUpdated: "2026-10-24",
    spans: [
      { from: "2026-10-10", until: "2026-10-26", items: [{ name: "Vercel Pro", monthlyUsd: 110 }] },
      { from: "2026-10-26", items: [{ name: "Local Docker", monthlyUsd: 30 }] },
    ],
  });
  const postNow = cutover + 30 * DAY_MS;
  const pre = accruedSystemCostUsd(110, SYSTEM_COST_START_MS, cutover);
  const post = accruedSystemCostUsd(30, cutover, postNow);
  const billed = systemCostHurdle({ config: paidAfter, pnlUsd: 0, nowMs: postNow, closedTrades: 1 });
  expect(billed.sunkUsd).toBeCloseTo(pre, 8);
  expect(billed.accruedUsd).toBeCloseTo(pre + post, 8);
  expect(billed.netUsd).toBeCloseTo(-post, 8);
  expect(billed.light).toBe("red");
  const stillOpen = systemCostHurdle({ config: paidAfter, pnlUsd: 0, nowMs: postNow, closedTrades: 0 });
  expect(stillOpen.netUsd).toBeCloseTo(-post, 8);
  expect(stillOpen.light).toBe("amber");
});

test("the scrubber keeps the system-cost fields and drops a planted host", () => {
  const host = "x.upstash.io";
  const planted = {
    status: "ok" as const,
    light: "amber" as const,
    lastUpdated: "2026-10-24",
    monthlyUsd: MONTHLY_USD,
    monthlyR: 5.7625,
    accruedUsd: 42,
    accruedR: 2.1,
    sunkUsd: 53.1,
    sunkR: 2.655,
    pnlUsd: 32,
    pnlR: 1.6,
    netUsd: -10,
    netR: -0.5,
    since: SYSTEM_COST_START_ISO,
    elapsedDays: 14,
    items: [
      { name: "Vercel Pro", monthlyUsd: 110, estimate: true, note: VERCEL_NOTE },
      { name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE },
      { name: host, monthlyUsd: 1, note: host },
    ],
    token: host,
    holder: host,
  };
  const shown = redactP6View(view({ systemCost: planted }));
  expect(shown.systemCost?.status).toBe("ok");
  expect(shown.systemCost?.light).toBe("amber");
  expect(shown.systemCost?.lastUpdated).toBe("2026-10-24");
  expect(shown.systemCost?.monthlyUsd).toBe(MONTHLY_USD);
  expect(shown.systemCost?.monthlyR).toBe(5.7625);
  expect(shown.systemCost?.accruedUsd).toBe(42);
  expect(shown.systemCost?.accruedR).toBe(2.1);
  expect(shown.systemCost?.sunkUsd).toBe(53.1);
  expect(shown.systemCost?.sunkR).toBe(2.655);
  expect(shown.systemCost?.pnlUsd).toBe(32);
  expect(shown.systemCost?.pnlR).toBe(1.6);
  expect(shown.systemCost?.netUsd).toBe(-10);
  expect(shown.systemCost?.netR).toBe(-0.5);
  expect(shown.systemCost?.since).toBe(SYSTEM_COST_START_ISO);
  expect(shown.systemCost?.elapsedDays).toBe(14);
  expect(shown.systemCost?.items).toEqual([
    { name: "Vercel Pro", monthlyUsd: 110, estimate: true, note: VERCEL_NOTE },
    { name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE },
  ]);
  const output = JSON.stringify(shown);
  expect(output.includes("Redis Cloud")).toBe(true);
  expect(output.includes(REDIS_NOTE)).toBe(true);
  expect(output.includes(host)).toBe(false);
  expect(output.includes("upstash")).toBe(false);
  expect(output.includes("token")).toBe(false);
  expect(output.includes("holder")).toBe(false);
  const again = redactP6View(shown);
  expect(again.systemCost).toEqual(shown.systemCost);
  const hostile = redactP6View(
    view({
      systemCost: {
        status: "ok",
        light: "amber",
        sunkUsd: Number.NaN,
        sunkR: "53" as unknown as number,
        sunkNote: host,
      },
    }),
  );
  expect(hostile.systemCost?.sunkUsd).toBeUndefined();
  expect(hostile.systemCost?.sunkR).toBeUndefined();
  expect(JSON.stringify(hostile).includes(host)).toBe(false);
  expect(JSON.stringify(hostile).includes("sunkNote")).toBe(false);
});

test("health.json is the scrubbed hurdle", () => {
  const host = "user:PASSWORD@host:6379";
  const body = p6HealthJson(
    view({
      systemCost: {
        status: "ok",
        light: "green",
        lastUpdated: "2026-10-24",
        monthlyUsd: MONTHLY_USD,
        monthlyR: 5.7625,
        accruedUsd: 1,
        accruedR: 0.05,
        pnlUsd: 20,
        pnlR: 1,
        netUsd: 19,
        netR: 0.95,
        since: SYSTEM_COST_START_ISO,
        elapsedDays: 1,
        items: [
          { name: "Vercel Pro", monthlyUsd: 110, estimate: true, note: VERCEL_NOTE },
          { name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE },
        ],
        secret: host,
      },
    }),
    "Healthy",
  );
  expect(body.health).toBe("Healthy");
  expect(body.systemCost.status).toBe("ok");
  expect(body.systemCost.light).toBe("green");
  expect(body.systemCost.monthlyUsd).toBe(MONTHLY_USD);
  expect(body.systemCost.monthlyR).toBe(5.7625);
  expect(body.systemCost.netUsd).toBe(19);
  expect(body.systemCost.items).toEqual([
    { name: "Vercel Pro", monthlyUsd: 110, estimate: true, note: VERCEL_NOTE },
    { name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE },
  ]);
  const output = JSON.stringify(body);
  expect(output.includes("PASSWORD")).toBe(false);
  expect(output.includes("6379")).toBe(false);
  expect(p6HealthJson(view(), "Error").systemCost).toEqual({ status: "unavailable", light: "unavailable" });
});

function scrubbedCost(item: { name: string; monthlyUsd: number; note?: string; estimate?: unknown }) {
  const raw = { ...view(), systemCost: { status: "ok", light: "amber", items: [item] } };
  return redactP6View(raw as Parameters<typeof redactP6View>[0]).systemCost;
}

test("a secret marker in a cost name or note is dropped", () => {
  for (const marker of ["upstash", "password", "token", "secret", "//"]) {
    const byName = scrubbedCost({ name: `Vendor ${marker} line`, monthlyUsd: 1, note: "plain note" });
    expect(JSON.stringify(byName ?? {}).includes(marker), `name ${marker}`).toBe(false);
    expect(byName?.items, `name ${marker}`).toBeUndefined();
    const byNote = scrubbedCost({ name: "Redis Cloud", monthlyUsd: 5.25, note: `invoice ${marker} ref` });
    expect(JSON.stringify(byNote ?? {}).includes(marker), `note ${marker}`).toBe(false);
    expect(byNote?.items, `note ${marker}`).toEqual([{ name: "Redis Cloud", monthlyUsd: 5.25 }]);
  }
});

test("a host in a cost note is dropped", () => {
  const host = "redis-12345.c1.us-east-1-2.ec2.redns.redis-cloud.com";
  const shown = scrubbedCost({ name: "Redis Cloud", monthlyUsd: 5.25, note: `db at ${host} port 12345` });
  expect(JSON.stringify(shown ?? {}).includes("redis-cloud.com")).toBe(false);
  expect(shown?.items).toEqual([{ name: "Redis Cloud", monthlyUsd: 5.25 }]);
  const named = scrubbedCost({ name: "redis-cloud.com", monthlyUsd: 1 });
  expect(named?.items).toBeUndefined();
  expect(JSON.stringify(named ?? {}).includes("redis-cloud.com")).toBe(false);
});

test("a non-finite P/L leaves the light unavailable", () => {
  for (const pnlUsd of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const hurdle = systemCostHurdle({ config: committed, pnlUsd, nowMs: SYSTEM_COST_START_MS });
    expect(hurdle.status).toBe("ok");
    expect(hurdle.light).toBe("unavailable");
    expect(hurdle.pnlUsd).toBeNull();
    expect(hurdle.netUsd).toBeNull();
    expect(hurdle.monthlyUsd).toBe(MONTHLY_USD);
  }
  expect(readSystemCostHurdle(Number.NaN, SYSTEM_COST_START_MS).light).toBe("unavailable");
});

test("a planted light outside the hurdle enum is unavailable", () => {
  const planted = redactP6View({ ...view(), systemCost: { status: "ok", light: "<script>", monthlyUsd: 1 } } as unknown as Parameters<typeof redactP6View>[0]);
  expect(planted.systemCost?.status).toBe("ok");
  expect(planted.systemCost?.light).toBe("unavailable");
  expect(JSON.stringify(planted).includes("<script>")).toBe(false);
  for (const light of ["green", "amber", "red", "unavailable"] as const) {
    expect(redactP6View(view({ systemCost: { status: "ok", light } })).systemCost?.light).toBe(light);
  }
});

test("the estimate flag stays after the note is scrubbed", () => {
  const shown = redactP6View({
    ...view(),
    systemCost: {
      status: "ok",
      light: "amber",
      monthlyUsd: MONTHLY_USD,
      items: [
        { name: "Vercel Pro", monthlyUsd: 110, note: "redis-cloud.com", estimate: true },
        { name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE, estimate: "<script>" },
      ],
    },
  } as Parameters<typeof redactP6View>[0]);
  expect(shown.systemCost?.items).toEqual([
    { name: "Vercel Pro", monthlyUsd: 110, estimate: true },
    { name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE },
  ]);
  const output = JSON.stringify(shown);
  expect(output.includes("redis-cloud.com")).toBe(false);
  expect(output.includes("<script>")).toBe(false);
  expect(output.includes("estimate")).toBe(true);
});

test("a page read puts the hurdle on the view from the displayed equity P/L", async () => {
  const kv = memoryKv();
  const now = Date.parse("2026-10-24T00:00:00.000Z");
  await kv.set(
    "p6:lastRun",
    JSON.stringify({
      outcome: "handover",
      end: now,
      pnl: { equityUsd: 8120, realizedUsd: 100, unrealizedUsd: 20, feesUsd: 0, spreadSlipUsd: 0 },
    }),
  );
  await kv.set("p6:hot", JSON.stringify({ positions: [], closed: [] }));
  const { view: loaded } = await readP6Page(kv, now);
  expect(loaded.systemCost?.status).toBe("ok");
  expect(loaded.systemCost?.pnlUsd).toBe(120);
  expect(loaded.systemCost?.monthlyUsd).toBe(MONTHLY_USD);
  expect(loaded.systemCost?.monthlyR).toBe(5.7625);
  expect(loaded.systemCost?.items?.[0]?.note).toBe(VERCEL_NOTE);
  expect(loaded.systemCost?.items?.[0]?.estimate).toBe(true);
  expect(loaded.systemCost?.items?.[1]?.name).toBe("Redis Cloud");
  expect(loaded.systemCost?.items?.[1]?.monthlyUsd).toBe(5.25);
  expect(loaded.systemCost?.items?.[2]?.name).toBe("Local Docker");
  expect(loaded.systemCost?.items?.[2]?.monthlyUsd).toBe(0);
  const frozen = (MONTHLY_USD * 12) / 365.25 * ((now - SYSTEM_COST_START_MS) / DAY_MS);
  expect(loaded.systemCost?.accruedUsd).toBeCloseTo(frozen, 8);
  expect(loaded.systemCost?.sunkUsd).toBeCloseTo(frozen, 8);
  expect(loaded.systemCost?.netUsd).toBeCloseTo(120, 8);
  expect(loaded.systemCost?.light).toBe("amber");
  const shown = redactP6View(loaded);
  expect(shown.systemCost?.pnlUsd).toBe(120);
  expect(shown.systemCost?.sunkUsd).toBeCloseTo(frozen, 8);
  expect(shown.systemCost?.light).toBe(loaded.systemCost?.light);
  const body = p6HealthJson(loaded, "Healthy");
  const cost = shown.systemCost;
  if (cost == null) throw new Error("system cost missing");
  expect(body.systemCost).toEqual(cost);
  const root = join(import.meta.dir, "..", "..", "..");
  const page = readFileSync(join(root, "web/src/app/p6/page.tsx"), "utf8");
  const route = readFileSync(join(root, "web/src/app/p6/health.json/route.ts"), "utf8");
  expect(page.includes("Net after system cost")).toBe(true);
  expect(page.includes("Sunk history")).toBe(true);
  expect(page.includes("view.systemCost")).toBe(true);
  expect(page.includes("item.estimate === true")).toBe(true);
  expect(page.includes("(est.)")).toBe(true);
  expect(shown.systemCost?.items?.[0]?.estimate).toBe(true);
  expect(route.includes("p6HealthJson(")).toBe(true);
  expect(route.includes("DASHBOARD_TOKEN")).toBe(false);
  expect(readSystemCostHurdle(null, now).pnlUsd).toBeNull();
  expect(readSystemCostHurdle(8120, now).pnlUsd).toBe(120);
});
