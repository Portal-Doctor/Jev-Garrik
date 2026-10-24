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
    { name: "Vercel Pro", monthlyUsd: 110, note: VERCEL_NOTE },
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

test("the light is amber at exactly zero net, green just above, and amber just below", () => {
  expect(systemCostLight(0, 110)).toBe("amber");
  expect(systemCostLight(1e-9, 110)).toBe("green");
  expect(systemCostLight(-1e-9, 110)).toBe("amber");
  expect(atStart(0).accruedUsd).toBe(0);
  expect(atStart(0).netUsd).toBe(0);
  expect(atStart(0).netR).toBe(0);
  expect(atStart(0).light).toBe("amber");
  expect(atStart(0.01).netUsd).toBe(0.01);
  expect(atStart(0.01).light).toBe("green");
  expect(atStart(-0.01).netUsd).toBe(-0.01);
  expect(atStart(-0.01).light).toBe("amber");
});

test("red begins at minus one month of system cost", () => {
  expect(systemCostLight(-110, 110)).toBe("red");
  expect(systemCostLight(-110 + 1e-9, 110)).toBe("amber");
  expect(systemCostLight(-110 - 1e-9, 110)).toBe("red");
  expect(atStart(-MONTHLY_USD).light).toBe("red");
  expect(atStart(-MONTHLY_USD + 0.01).light).toBe("amber");
  expect(atStart(-MONTHLY_USD - 0.01).light).toBe("red");
  expect(systemCostLight(0, 0)).toBe("red");
  const later = atStart(0, SYSTEM_COST_START_MS + DAY_MS);
  expect(later.accruedUsd).toBeGreaterThan(0);
  expect(later.netUsd).toBeCloseTo(-later.accruedUsd!, 10);
  expect(later.light).toBe("amber");
  expect(later.monthlyR).toBe(5.7625);
  expect(later.accruedR).toBeCloseTo(usdToR(later.accruedUsd!), 10);
  const year = atStart(0, SYSTEM_COST_START_MS + 365.25 * DAY_MS);
  expect(year.accruedUsd).toBeCloseTo(MONTHLY_USD * 12, 6);
  expect(year.light).toBe("red");
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

test("the committed file totals $115.25 a month and was updated 2026-10-24", () => {
  const config = loadSystemCostConfig();
  expect(config).toEqual(committed);
  const now = Date.parse("2026-10-24T00:00:00.000Z");
  const hurdle = systemCostHurdle({ config, pnlUsd: 0, nowMs: now });
  expect(hurdle.status).toBe("ok");
  expect(hurdle.monthlyUsd).toBe(MONTHLY_USD);
  expect(hurdle.monthlyR).toBe(5.7625);
  expect(hurdle.since).toBe(SYSTEM_COST_START_ISO);
  const days = (now - SYSTEM_COST_START_MS) / DAY_MS;
  expect(hurdle.elapsedDays).toBe(days);
  expect(hurdle.accruedUsd).toBeCloseTo((MONTHLY_USD * 12) / 365.25 * days, 8);
  expect(hurdle.items?.[0]?.monthlyUsd).toBe(110);
  expect(hurdle.items?.[0]?.note).toBe(VERCEL_NOTE);
  expect(hurdle.items?.[1]).toEqual({ name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE });
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
    pnlUsd: 32,
    pnlR: 1.6,
    netUsd: -10,
    netR: -0.5,
    since: SYSTEM_COST_START_ISO,
    elapsedDays: 14,
    items: [
      { name: "Vercel Pro", monthlyUsd: 110, note: VERCEL_NOTE },
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
  expect(shown.systemCost?.pnlUsd).toBe(32);
  expect(shown.systemCost?.pnlR).toBe(1.6);
  expect(shown.systemCost?.netUsd).toBe(-10);
  expect(shown.systemCost?.netR).toBe(-0.5);
  expect(shown.systemCost?.since).toBe(SYSTEM_COST_START_ISO);
  expect(shown.systemCost?.elapsedDays).toBe(14);
  expect(shown.systemCost?.items).toEqual([
    { name: "Vercel Pro", monthlyUsd: 110, note: VERCEL_NOTE },
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
          { name: "Vercel Pro", monthlyUsd: 110, note: VERCEL_NOTE },
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
    { name: "Vercel Pro", monthlyUsd: 110, note: VERCEL_NOTE },
    { name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE },
  ]);
  const output = JSON.stringify(body);
  expect(output.includes("PASSWORD")).toBe(false);
  expect(output.includes("6379")).toBe(false);
  expect(p6HealthJson(view(), "Error").systemCost).toEqual({ status: "unavailable", light: "unavailable" });
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
  expect(loaded.systemCost?.items?.[1]).toEqual({ name: "Redis Cloud", monthlyUsd: 5.25, note: REDIS_NOTE });
  expect(loaded.systemCost?.netUsd).toBeCloseTo(120 - (loaded.systemCost?.accruedUsd ?? 0), 8);
  const shown = redactP6View(loaded);
  expect(shown.systemCost?.pnlUsd).toBe(120);
  expect(shown.systemCost?.light).toBe(loaded.systemCost?.light);
  const body = p6HealthJson(loaded, "Healthy");
  const cost = shown.systemCost;
  if (cost == null) throw new Error("system cost missing");
  expect(body.systemCost).toEqual(cost);
  const root = join(import.meta.dir, "..", "..", "..");
  const page = readFileSync(join(root, "web/src/app/p6/page.tsx"), "utf8");
  const route = readFileSync(join(root, "web/src/app/p6/health.json/route.ts"), "utf8");
  expect(page.includes("Net after system cost")).toBe(true);
  expect(page.includes("view.systemCost")).toBe(true);
  expect(route.includes("p6HealthJson(")).toBe(true);
  expect(route.includes("DASHBOARD_TOKEN")).toBe(false);
  expect(readSystemCostHurdle(null, now).pnlUsd).toBeNull();
  expect(readSystemCostHurdle(8120, now).pnlUsd).toBe(120);
});
