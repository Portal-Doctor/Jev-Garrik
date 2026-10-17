import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { HANDOVER_MICRO_MS } from "./amendment-v6";
import type { Position } from "./engine";
import {
  bar15Key,
  bar1hKey,
  ACCT_KEY,
  bar4hKey,
  d1Key,
  FILLS_KEY,
  HOT_MAX_BYTES,
  LAST_RUN_KEY,
  LEDGER_KEY,
  loadSplit,
  persistSplit,
  ringKey,
  tapeKey,
  writeThroughBook,
} from "./hot-store";
import {
  attachMemberCloses,
  FOUR_KEEP,
  HOUR_KEEP,
  installPaperState,
  SEED_CURSOR_KEY,
  seedMarkKey,
  startPaperHost,
  type PaperHost,
} from "./paper-host";
import {
  decodeLease,
  LEASE_KEY,
  memoryKv,
  releaseLease,
  runInvocation,
  tryAcquire,
  HOT_KEY,
  type Kv,
} from "./relay";
import { hostHolder, redisLogLine } from "./vercel-live";

const NOW = Date.parse("2026-10-12T17:01:00Z");
const TODAY = Math.floor(NOW / 1000 / 86_400) * 86_400;
const PRODUCTS = ["BTC-USD", "ETH-USD", "SOL-USD", "XRP-USD"];

function clock(): number {
  return NOW;
}

function position(id: string, productId = "BTC-USD"): Position {
  return {
    id,
    classId: "C",
    productId,
    entryTs: NOW,
    fillPrice: 100,
    units: 1,
    riskUsd: 20,
    stop: 90,
    notionalUsd: 100,
    sLiveBps: 5,
    atr1h: 1,
    entryFeeUsd: 0,
    entrySpreadUsd: 0,
    arrivalMid: 100,
    target: 110,
    dailyAtr: 2,
    priorDailyCloses: [],
    pendingExit: null,
    pendingExitTs: null,
    rawEntry: 100,
    initialStop: 90,
    highestClose: null,
    clusterId: "c",
    tick: 0.01,
    aConfig: null,
    beta: null,
  };
}

function fifteen(productId: string, startSec: number) {
  return { productId, startSec, open: 1, high: 2, low: 1, close: 1.5, volume: 3 };
}

function ohlc(ts: number) {
  return { ts, open: 1, high: 2, low: 1, close: 1.5, volume: 3 };
}

const LATE = fifteen("BTC-USD", TODAY + 20 * 900);
const LATE_ID = `${LATE.productId}:${LATE.startSec}`;
const LATE_DAY = bar15Key("BTC-USD", new Date(LATE.startSec * 1000).toISOString().slice(0, 10));

async function seedBook(kv: Kv): Promise<void> {
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  host.warmupStored = true;
  host.book.positions = [position("open-1")];
  host.book.realizedUsd = 3;
  host.appliedThrough.set("BTC-USD", TODAY);
  for (const productId of PRODUCTS) {
    for (let day = 0; day < 8; day += 1) {
      for (let slot = 0; slot < 20; slot += 1) host.fifteen.push(fifteen(productId, TODAY - day * 86_400 + slot * 900));
    }
    host.fourBars.set(
      productId,
      Array.from({ length: 80 }, (_, index) => ohlc(TODAY - (index + 1) * 14_400)),
    );
    host.hourWarm.set(
      productId,
      Array.from({ length: 30 }, (_, index) => ohlc(TODAY - (index + 1) * 3_600)),
    );
    host.dailyBars.set(
      productId,
      Array.from({ length: 10 }, (_, index) => ohlc(TODAY - (index + 1) * 86_400)),
    );
  }
  await persistSplit(kv, host);
}

/** The old second load: loadSplit again and install, including the lease token reload() would take. */
async function oldReload(host: PaperHost, kv: Kv, self: string): Promise<void> {
  host.seedChecked = false;
  const lease = decodeLease(await kv.get(LEASE_KEY));
  if (lease?.token && lease.holder === self && lease.release === "none" && lease.untilMs > host.clock()) {
    host.leaseToken = lease.token;
    if (host.holderId == null) host.holderId = self;
    if (host.leaseFromMs == null) host.leaseFromMs = lease.acquiredAtMs ?? host.clock();
    host.leaseUntilMs = lease.untilMs;
  }
  const saved = await loadSplit(kv, host);
  if (!saved) return;
  installPaperState(host, saved);
  for (const bar of host.fifteen) host.persistedBars.add(`${bar.productId}:${bar.startSec}`);
  attachMemberCloses(host);
}

async function saveSinceWarm(kv: Kv, at: () => number, mutate: (host: PaperHost) => void): Promise<void> {
  const host = startPaperHost(PRODUCTS, {});
  host.clock = at;
  host.warmupStored = true;
  const saved = await loadSplit(kv, host);
  if (saved) installPaperState(host, saved);
  mutate(host);
  await persistSplit(kv, host);
}

function snap(host: PaperHost) {
  return {
    positions: host.book.positions.map((row) => ({ id: row.id, productId: row.productId, units: row.units })),
    realizedUsd: host.book.realizedUsd,
    incidents: [...host.book.incidents],
    gaps: host.gaps.map((gap) => ({ ...gap })),
    fifteen: host.fifteen.map((bar) => `${bar.productId}:${bar.startSec}:${bar.close}`).sort(),
    fours: [...host.fourBars.entries()].map(([id, rows]) => [id, rows.map((row) => row.ts).join(",")]).sort(),
    hours: [...host.hourWarm.entries()].map(([id, rows]) => [id, rows.length]).sort(),
    daily: [...host.dailyBars.entries()].map(([id, rows]) => [id, rows.length]).sort(),
    appliedThrough: [...host.appliedThrough.entries()].sort(),
    applied: [...host.applied].sort(),
    marks: [...host.seedMarks.entries()].map(([id, mark]) => `${id}:${mark.status}:${mark.reason}`).sort(),
  };
}

test("readBytes counts redis payload bytes on the history load", async () => {
  const kv = memoryKv(clock);
  const four = JSON.stringify([ohlc(TODAY - 14_400)]);
  const hot = JSON.stringify({
    products: ["BTC-USD"],
    positions: [],
    closed: [],
    realizedUsd: 1,
    seq: 1,
    keySeq: { [bar4hKey("BTC-USD")]: 1 },
  });
  await kv.set(HOT_KEY, hot);
  await kv.set(bar4hKey("BTC-USD"), four);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = clock;
  await loadSplit(kv, host);
  expect(host.readBytes).toBe(Buffer.byteLength(hot) + Buffer.byteLength(four));
  host.saveCommands = 4;
  host.saveBytes = 9;
  host.duplicateAppends = 1;
  expect(redisLogLine(host)).toBe(
    `redis cmds=4, bytes=9, readBytes=${Buffer.byteLength(hot) + Buffer.byteLength(four)}, duplicates=1, seqInvalid=0`,
  );
});

test("a snapshot with no sequence reloads every bar key", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; keySeq?: unknown };
  delete hot.seq;
  delete hot.keySeq;
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  const holder = hostHolder(host, kv, [], "standby");
  await holder.warm();
  const seen: string[] = [];
  const base = kv.mget.bind(kv);
  kv.mget = async (keys) => {
    seen.push(...keys);
    return base(keys);
  };
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await holder.reload();
  } finally {
    console.log = log;
  }
  kv.mget = base;
  for (const productId of PRODUCTS) expect(seen).toContain(bar4hKey(productId));
  expect(lines).toContain("redis keySeq missing");
});

test("after takeover the book matches the old double-load path", async () => {
  const neu = await takeover("new");
  const old = await takeover("old");
  expect(neu.snap).toEqual(old.snap);
  expect(neu.applied).toEqual(old.applied);
  expect(neu.applied).not.toContain(LATE_ID);
  expect(neu.snap.positions).toEqual([{ id: "open-1", productId: "BTC-USD", units: 1 }]);
  expect(neu.snap.realizedUsd).toBe(42);
  expect(neu.snap.fifteen.some((row) => row.startsWith(LATE_ID))).toBe(true);
  expect(neu.feedGapMs).toBe(old.feedGapMs);
  expect(neu.feedGapMs).toBeLessThan(HANDOVER_MICRO_MS);
  console.log(
    `t1 readBytes before=${old.readBytes} after=${neu.readBytes} secondBefore=${old.readBytes - old.warmBytes} secondAfter=${neu.readBytes - neu.warmBytes}`,
  );
  expect(neu.warmBytes).toBe(old.warmBytes);
  expect(neu.readBytes).toBeLessThan(old.readBytes);
});

test("overlap reload keeps the bar the holder saved after warm and does not apply it again", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  const holder = hostHolder(host, kv, [LATE], "standby");
  await holder.warm();
  await saveSinceWarm(kv, clock, (editor) => {
    editor.book.realizedUsd = 42;
    editor.fifteen.push({ ...LATE });
  });
  const seen: string[] = [];
  const base = kv.mget.bind(kv);
  kv.mget = async (keys) => {
    seen.push(...keys);
    return base(keys);
  };
  await holder.reload();
  kv.mget = base;
  const applied = await holder.applyDueBars();
  const twin = startPaperHost(PRODUCTS, {});
  twin.clock = clock;
  await oldReload(twin, kv, "standby");
  const twinHolder = hostHolder(twin, kv, [LATE], "standby");
  const twinApplied = await twinHolder.applyDueBars();
  expect(snap(host)).toEqual(snap(twin));
  expect(applied).toEqual(twinApplied);
  expect(applied).not.toContain(LATE_ID);
  expect(seen).toContain(LATE_DAY);
  for (const productId of PRODUCTS) expect(seen).not.toContain(bar4hKey(productId));
});

test("a standby reloads when the holder saved after warm", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  const holder = hostHolder(host, kv, [], "standby");
  await holder.warm();
  expect(host.book.positions.map((row) => row.id)).toEqual(["open-1"]);
  await saveSinceWarm(kv, clock, (editor) => {
    editor.book.positions = [position("open-2")];
    editor.book.realizedUsd = 19;
  });
  const seen: string[] = [];
  const base = kv.mget.bind(kv);
  kv.mget = async (keys) => {
    seen.push(...keys);
    return base(keys);
  };
  await holder.reload();
  kv.mget = base;
  const twin = startPaperHost(PRODUCTS, {});
  twin.clock = clock;
  await oldReload(twin, kv, "standby");
  expect(snap(host)).toEqual(snap(twin));
  expect(host.book.positions.map((row) => row.id)).toEqual(["open-2"]);
  expect(host.book.realizedUsd).toBe(19);
  for (const productId of PRODUCTS) expect(seen).not.toContain(bar4hKey(productId));
});

test("a crash with nothing saved since warm keeps the warmed book and the crash gap", async () => {
  const neu = await crashTakeover("new");
  const old = await crashTakeover("old");
  expect(neu.snap).toEqual(old.snap);
  expect(neu.gaps).toEqual(old.gaps);
  expect(neu.gaps.some((gap) => gap.cause === "crash")).toBe(true);
  expect(neu.snap.positions).toEqual([{ id: "open-1", productId: "BTC-USD", units: 1 }]);
  expect(neu.snap.realizedUsd).toBe(3);
});

test("a sequence change between the token and the data reloads instead of mixing", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  const holder = hostHolder(host, kv, [], "standby");
  await holder.warm();
  const added = TODAY - 500 * 14_400;
  let torn = false;
  const base = kv.mget.bind(kv);
  kv.mget = async (keys) => {
    if (!torn) {
      torn = true;
      const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as {
        seq: number;
        keySeq: Record<string, number>;
        realizedUsd: number;
      };
      hot.seq += 1;
      hot.realizedUsd = 777;
      hot.keySeq[bar4hKey("BTC-USD")] = hot.seq;
      await kv.set(HOT_KEY, JSON.stringify(hot));
      const fours = JSON.parse((await kv.get(bar4hKey("BTC-USD"))) ?? "[]") as { ts: number }[];
      fours.push(ohlc(added));
      await kv.set(bar4hKey("BTC-USD"), JSON.stringify(fours));
    }
    return base(keys);
  };
  await holder.reload();
  kv.mget = base;
  const twin = startPaperHost(PRODUCTS, {});
  twin.clock = clock;
  await oldReload(twin, kv, "standby");
  expect(host.book.realizedUsd).toBe(777);
  expect(host.fourBars.get("BTC-USD")?.some((bar) => bar.ts === added)).toBe(true);
  expect(snap(host)).toEqual(snap(twin));
});

test("takeover reload drops the cached raw strings", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  const holder = hostHolder(host, kv, [], "standby");
  await holder.warm();
  expect(host.redisRaw).not.toBeNull();
  expect(host.redisRings).not.toBeNull();
  const seq = host.redisSeq;
  await holder.reload();
  expect(host.redisRaw).toBeNull();
  expect(host.redisRings).toBeNull();
  expect(host.redisSeq).toBe(seq);
  const twin = startPaperHost(PRODUCTS, {});
  twin.clock = clock;
  await oldReload(twin, kv, "standby");
  expect(snap(host)).toEqual(snap(twin));
});

test("a restarted sequence does not reuse bars warmed at seq N", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const n = 4;
  const warmed = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; keySeq?: Record<string, number> };
  warmed.seq = n;
  for (const key of Object.keys(warmed.keySeq ?? {})) warmed.keySeq![key] = n;
  await kv.set(HOT_KEY, JSON.stringify(warmed));
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  const holder = hostHolder(host, kv, [], "standby");
  await holder.warm();
  expect(host.redisSeq).toBe(n);
  const stripped = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; keySeq?: unknown };
  delete stripped.seq;
  delete stripped.keySeq;
  await kv.set(HOT_KEY, JSON.stringify(stripped));
  const fresh = startPaperHost(PRODUCTS, {});
  fresh.clock = clock;
  fresh.warmupStored = true;
  const loaded = await loadSplit(kv, fresh);
  if (!loaded) throw new Error("fresh load");
  installPaperState(fresh, loaded);
  expect(fresh.redisSeq).toBeNull();
  const added: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const ts = TODAY - (500 + i) * 14_400;
    added.push(ts);
    const rows = fresh.fourBars.get("BTC-USD") ?? [];
    rows.push(ohlc(ts));
    fresh.fourBars.set("BTC-USD", rows);
    fresh.book.realizedUsd = 100 + i;
    await persistSplit(kv, fresh);
  }
  const published = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; keySeq?: Record<string, number> };
  await holder.reload();
  const twin = startPaperHost(PRODUCTS, {});
  twin.clock = clock;
  await oldReload(twin, kv, "standby");
  expect(snap(host)).toEqual(snap(twin));
  for (const ts of added) expect(host.fourBars.get("BTC-USD")?.some((bar) => bar.ts === ts)).toBe(true);
  expect(published.seq).toBeGreaterThan(n);
  expect(published.keySeq?.[bar4hKey("BTC-USD")]).toBe(published.seq);
});

test("prod-sized hot with keySeq stays under 256 KB and a steady flush is not grouped", async () => {
  const path = fileURLToPath(new URL("../../data/reports/universe-membership.json", import.meta.url));
  const membership = JSON.parse(readFileSync(path, "utf8")) as { members: { date: string; names: string[] }[] };
  const latest = membership.members[membership.members.length - 1];
  const names = latest?.names ?? [];
  expect(names.length).toBeGreaterThan(20);
  const kv = memoryKv(clock);
  expect(await tryAcquire(kv, "holder", NOW + 60 * 60_000, NOW)).toBe(true);
  const lease = decodeLease(await kv.get(LEASE_KEY));
  if (!lease?.token) throw new Error("lease");
  const host = startPaperHost(names, {});
  host.clock = clock;
  host.warmupStored = true;
  host.leaseToken = lease.token;
  host.holderId = "holder";
  const day0 = Math.floor(Date.parse("2025-11-10T00:00:00Z") / 1000);
  const dailyCount = Math.floor((TODAY - day0) / 86_400);
  expect(dailyCount).toBeGreaterThan(300);
  for (const productId of names) {
    for (let day = 0; day < 8; day += 1) {
      for (let slot = 0; slot < 96; slot += 1) host.fifteen.push(fifteen(productId, TODAY - day * 86_400 + slot * 900));
    }
    host.fourBars.set(
      productId,
      Array.from({ length: FOUR_KEEP }, (_, index) => ohlc(TODAY - (index + 1) * 14_400)),
    );
    host.hourWarm.set(
      productId,
      Array.from({ length: HOUR_KEEP }, (_, index) => ohlc(TODAY - (index + 1) * 3_600)),
    );
    host.dailyBars.set(
      productId,
      Array.from({ length: dailyCount }, (_, index) => ohlc(day0 + index * 86_400)),
    );
  }
  let barSets = 0;
  let stripSets = 0;
  let stripBytes = 0;
  const ownedSet = kv.ownedSet.bind(kv);
  kv.ownedSet = async (leaseKey, token, key, value, opts) => {
    if (key.startsWith("p6:bar")) barSets += 1;
    if (key === HOT_KEY) {
      const body = JSON.parse(value) as { seq?: unknown; keySeq?: unknown };
      if (body.seq == null && body.keySeq == null) {
        stripSets += 1;
        stripBytes += Buffer.byteLength(value);
      }
    }
    return ownedSet(leaseKey, token, key, value, opts);
  };
  const payloads: number[] = [];
  const ownedFlush = kv.ownedFlush.bind(kv);
  kv.ownedFlush = async (leaseKey, token, nowMs, payload) => {
    payloads.push(Buffer.byteLength(payload));
    return ownedFlush(leaseKey, token, nowMs, payload);
  };
  await persistSplit(kv, host);
  const firstBarSets = barSets;
  const firstPayload = payloads[payloads.length - 1] ?? 0;
  const stored = await kv.get(HOT_KEY);
  if (!stored) throw new Error("hot");
  const parsed = JSON.parse(stored) as { era?: string; seq?: number; keySeq?: Record<string, number> };
  const keySeq = parsed.keySeq ?? {};
  const rest = { ...parsed } as { seq?: number; keySeq?: unknown; era?: unknown; keyEra?: unknown };
  delete rest.seq;
  delete rest.keySeq;
  delete rest.era;
  delete rest.keyEra;
  const hotBefore = Buffer.byteLength(JSON.stringify(rest));
  const hotAfter = Buffer.byteLength(stored);
  expect(parsed.era).toMatch(/^[0-9a-f]{16}$/);
  expect(hotAfter).toBeLessThan(64 * 1024);
  expect(hotAfter).toBeLessThan(HOT_MAX_BYTES);
  expect(Object.keys(keySeq).length).toBeGreaterThan(names.length);
  barSets = 0;
  const steady: number[] = [];
  for (let i = 0; i < 3; i += 1) {
    host.book.realizedUsd = i + 1;
    const before = payloads.length;
    await persistSplit(kv, host);
    steady.push(payloads[before] ?? 0);
  }
  host.fifteen.push(fifteen(names[0]!, TODAY + 96 * 900));
  const beforeBar = payloads.length;
  await persistSplit(kv, host);
  const barPayload = payloads[beforeBar] ?? 0;
  const steadyGrouped = barSets;
  const steadyStrip = stripSets;
  let hotGets = 0;
  let hotGetBytes = 0;
  let countGets = false;
  const get = kv.get.bind(kv);
  kv.get = async (key) => {
    const value = await get(key);
    if (countGets && key === HOT_KEY) {
      hotGets += 1;
      if (value) hotGetBytes += Buffer.byteLength(value);
    }
    return value;
  };
  host.persistedBars.clear();
  const stripBefore = stripSets;
  const stripBytesBefore = stripBytes;
  const barsBefore = barSets;
  const saveBefore = host.saveBytes;
  let accounted = 0;
  let inFlush = false;
  const ownedSetAccount = kv.ownedSet.bind(kv);
  kv.ownedSet = async (leaseKey, token, key, value, opts) => {
    if (!inFlush) accounted += Buffer.byteLength(value);
    return ownedSetAccount(leaseKey, token, key, value, opts);
  };
  const ownedFlushAccount = kv.ownedFlush.bind(kv);
  kv.ownedFlush = async (leaseKey, token, nowMs, payload) => {
    inFlush = true;
    try {
      accounted += Buffer.byteLength(payload);
      return await ownedFlushAccount(leaseKey, token, nowMs, payload);
    } finally {
      inFlush = false;
    }
  };
  countGets = true;
  await persistSplit(kv, host);
  countGets = false;
  expect(host.saveBytes - saveBefore).toBe(accounted);
  console.log(
    `t1 prod asOf=${latest?.date} products=${names.length} hotBefore=${hotBefore} hotAfter=${hotAfter} keySeqKeys=${Object.keys(keySeq).length} firstBarSets=${firstBarSets} firstPayload=${firstPayload} steadyStripSets=${steadyStrip} steadyPayloads=${steady.join(",")} barPayload=${barPayload} steadyBarSets=${steadyGrouped} againBarSets=${barSets - barsBefore} againStripSets=${stripSets - stripBefore} againStripBytes=${stripBytes - stripBytesBefore} againHotGets=${hotGets} againHotGetBytes=${hotGetBytes}`,
  );
  expect(hotAfter).toBeLessThan(HOT_MAX_BYTES);
  expect(firstBarSets).toBeGreaterThan(0);
  expect(firstPayload).toBeLessThan(1_048_576);
  expect(steadyGrouped).toBe(0);
  expect(steadyStrip).toBe(0);
  for (const bytes of steady) expect(bytes).toBeLessThan(1_048_576);
  expect(barPayload).toBeLessThan(1_048_576);
  expect(stripSets - stripBefore).toBe(1);
}, 30_000);

test("takeover switch time stays under a second and is no worse than a full reload", async () => {
  const neu = await takeover("new");
  const old = await takeover("old");
  console.log(`t1 switch ms partial=${neu.reloadMs.toFixed(3)} full=${old.reloadMs.toFixed(3)} feedGapMs=${neu.feedGapMs}`);
  expect(neu.feedGapMs).toBe(old.feedGapMs);
  expect(neu.feedGapMs).toBeLessThan(HANDOVER_MICRO_MS);
  expect(neu.reloadMs).toBeLessThan(HANDOVER_MICRO_MS);
  expect(old.reloadMs).toBeLessThan(HANDOVER_MICRO_MS);
  expect(neu.snap).toEqual(old.snap);
});

async function takeover(mode: "new" | "old"): Promise<{
  snap: ReturnType<typeof snap>;
  applied: string[];
  feedGapMs: number;
  readBytes: number;
  warmBytes: number;
  reloadMs: number;
}> {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const releaseAt = NOW + 29 * 60_000;
  expect(await tryAcquire(kv, "old", NOW + 30 * 60_000, NOW)).toBe(true);
  await releaseLease(kv, "old", "deadline", releaseAt);
  const at = () => releaseAt;
  const host = startPaperHost(PRODUCTS, {});
  host.clock = at;
  const holder = hostHolder(host, kv, [LATE], "new");
  let warmBytes = 0;
  let reloadMs = 0;
  const result = await runInvocation({
    kv,
    self: "new",
    nowMs: releaseAt,
    deadlineMs: releaseAt + 30 * 60_000,
    lastCronMs: NOW,
    holder: {
      async warm() {
        await holder.warm();
        warmBytes = host.readBytes;
        await saveSinceWarm(kv, at, (editor) => {
          editor.book.realizedUsd = 42;
          editor.fifteen.push({ ...LATE });
        });
      },
      async reload() {
        const started = performance.now();
        if (mode === "new") await holder.reload();
        else await oldReload(host, kv, "new");
        reloadMs = performance.now() - started;
      },
      applyDueBars: () => holder.applyDueBars(),
      releaseDeadline() {},
      recordGap(gap) {
        holder.recordGap(gap);
      },
      persist: () => holder.persist(),
      async sampleUntil() {},
    },
  });
  return {
    snap: snap(host),
    applied: result.applied,
    feedGapMs: result.feedGapMs,
    readBytes: host.readBytes,
    warmBytes,
    reloadMs,
  };
}

async function crashTakeover(mode: "new" | "old"): Promise<{ snap: ReturnType<typeof snap>; gaps: { cause: string; startMs: number; endMs: number }[] }> {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const start = NOW;
  expect(await tryAcquire(kv, "old", start + 30 * 60_000, start)).toBe(true);
  await kv.del(LEASE_KEY);
  const at = start + 60_000;
  const host = startPaperHost(PRODUCTS, {});
  host.clock = () => at;
  const holder = hostHolder(host, kv, [], "new");
  const gaps: { cause: string; startMs: number; endMs: number }[] = [];
  await runInvocation({
    kv,
    self: "new",
    nowMs: at,
    deadlineMs: at + 30 * 60_000,
    holder: {
      warm: () => holder.warm(),
      reload: () => (mode === "new" ? holder.reload() : oldReload(host, kv, "new")),
      async applyDueBars() {
        return [];
      },
      releaseDeadline() {},
      async sampleUntil() {},
      recordGap(gap) {
        gaps.push({ cause: gap.cause, startMs: gap.startMs, endMs: gap.endMs });
        holder.recordGap(gap);
      },
      persist: () => holder.persist(),
    },
  });
  return { snap: snap(host), gaps };
}

function watchMget(kv: Kv): { calls: string[][]; full: () => number; restore: () => void } {
  const calls: string[][] = [];
  const base = kv.mget.bind(kv);
  kv.mget = async (keys) => {
    calls.push([...keys]);
    return base(keys);
  };
  return {
    calls,
    full: () => calls.filter((keys) => keys.includes(HOT_KEY)).length,
    restore() {
      kv.mget = base;
    },
  };
}

async function warmStandby(kv: Kv): Promise<{ standby: PaperHost; holder: ReturnType<typeof hostHolder> }> {
  const standby = startPaperHost(PRODUCTS, {});
  standby.clock = clock;
  const holder = hostHolder(standby, kv, [], "standby");
  await holder.warm();
  return { standby, holder };
}

async function twinOf(kv: Kv, at: () => number = clock): Promise<PaperHost> {
  const twin = startPaperHost(PRODUCTS, {});
  twin.clock = at;
  await oldReload(twin, kv, "standby");
  return twin;
}

async function wipeBook(kv: Kv): Promise<void> {
  const keys = [HOT_KEY, FILLS_KEY, LEDGER_KEY, LAST_RUN_KEY, ACCT_KEY, SEED_CURSOR_KEY, LEASE_KEY, "p6:lease-meta", "p6:cron", "p6:eq:first"];
  const nowSec = Math.floor(NOW / 1000);
  const today = Math.floor(nowSec / 86_400) * 86_400;
  for (let i = 0; i < 8; i += 1) {
    const day = new Date((today - i * 86_400) * 1000).toISOString().slice(0, 10);
    for (const productId of PRODUCTS) keys.push(bar15Key(productId, day));
  }
  for (const productId of PRODUCTS) keys.push(bar4hKey(productId), bar1hKey(productId), d1Key(productId), seedMarkKey(productId), ringKey(productId));
  const minute = Math.floor(nowSec / 60) * 60;
  for (let i = 0; i < 10; i += 1) keys.push(tapeKey(minute - i * 60));
  const hour = Math.floor(nowSec / 3600) * 3600;
  keys.push(`p6:eq:${hour}`, `p6:eq:tr:${hour}`);
  for (const key of keys) await kv.del(key);
}

test("a standby takeover reuses keys the previous holder stamped and does no full reload", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const warmedEra = standby.redisSeenEra;
  const ethSeq = standby.redisKeySeq?.get(bar4hKey("ETH-USD"));
  if (!warmedEra || ethSeq == null) throw new Error("warm stamp");
  const added = TODAY - 700 * 14_400;
  await saveSinceWarm(kv, clock, (editor) => {
    const rows = editor.fourBars.get("BTC-USD") ?? [];
    rows.push({ ...ohlc(added), close: 85 });
    editor.fourBars.set("BTC-USD", rows);
    editor.book.realizedUsd = 64;
  });
  const published = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as {
    era?: string;
    seq?: number;
    keySeq?: Record<string, number>;
    keyEra?: Record<string, string>;
  };
  expect(published.era).toMatch(/^[0-9a-f]{16}$/);
  expect(published.era).not.toBe(warmedEra);
  expect(published.keyEra?.[bar4hKey("ETH-USD")]).toBe(warmedEra);
  expect(published.keySeq?.[bar4hKey("ETH-USD")]).toBe(ethSeq);
  expect(published.keySeq?.[bar4hKey("BTC-USD")]).toBe(published.seq);
  const watch = watchMget(kv);
  await holder.reload();
  watch.restore();
  expect(watch.full()).toBe(0);
  const read = watch.calls.flat();
  expect(read).toContain(bar4hKey("BTC-USD"));
  expect(read).not.toContain(bar4hKey("ETH-USD"));
  const twin = await twinOf(kv);
  expect(snap(standby)).toEqual(snap(twin));
  expect(standby.fourBars.get("BTC-USD")?.some((bar) => bar.ts === added && bar.close === 85)).toBe(true);
});

const X = Math.floor(NOW / 1000);

async function behindClock(strip: "seq" | "hot" | "all", seconds: number[]): Promise<void> {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const warmedSeq = standby.redisSeq;
  const warmedBarSeq = standby.redisKeySeq?.get(bar4hKey("BTC-USD"));
  const warmedEra = standby.redisSeenEra;
  if (warmedSeq == null || warmedBarSeq == null || !warmedEra) throw new Error("warm stamp");
  if (strip === "seq") {
    const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as Record<string, unknown>;
    delete hot.seq;
    delete hot.keySeq;
    await kv.set(HOT_KEY, JSON.stringify(hot));
  } else if (strip === "hot") await kv.del(HOT_KEY);
  else await wipeBook(kv);
  let t2 = seconds[0]! * 1000;
  const fresh = startPaperHost(PRODUCTS, {});
  fresh.clock = () => t2;
  fresh.warmupStored = true;
  const loaded = await loadSplit(kv, fresh);
  if (loaded) installPaperState(fresh, loaded);
  for (let i = 0; i < seconds.length; i += 1) {
    t2 = seconds[i]! * 1000;
    const rows = fresh.fourBars.get("BTC-USD") ?? [];
    rows.push({ ...ohlc(TODAY - (800 + i) * 14_400), close: 70 + i });
    fresh.fourBars.set("BTC-USD", rows);
    fresh.book.realizedUsd = 500 + i;
    await persistSplit(kv, fresh);
  }
  const published = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as {
    era?: string;
    seq?: number;
    keySeq?: Record<string, number>;
  };
  expect(published.seq).toBe(warmedSeq);
  expect(published.keySeq?.[bar4hKey("BTC-USD")]).toBe(warmedBarSeq);
  expect(published.era).toMatch(/^[0-9a-f]{16}$/);
  expect(published.era).not.toBe(warmedEra);
  const at = () => seconds[seconds.length - 1]! * 1000 + 1000;
  standby.clock = at;
  await holder.reload();
  const twin = await twinOf(kv, at);
  expect(snap(standby)).toEqual(snap(twin));
  expect(standby.book.realizedUsd).toBe(500 + seconds.length - 1);
  expect(standby.fourBars.get("BTC-USD")?.some((bar) => bar.close === 70 + seconds.length - 1)).toBe(true);
}

test("a behind clock that lands on the warmed sequence reloads because the era differs", async () => {
  await behindClock("seq", [X - 180, X - 120, X - 60, X]);
});

test("a behind clock whose last flush is the warmed second reloads because the era differs", async () => {
  await behindClock("seq", [X - 120, X - 60, X]);
});

test("a deleted hot and a behind clock still reload the new bars", async () => {
  await behindClock("hot", [X - 180, X - 120, X - 60, X]);
});

test("a wiped book and a behind clock still reload the new bars", async () => {
  await behindClock("all", [X - 180, X - 120, X - 60, X]);
});

const POISON: { name: string; patch: (hot: { seq?: number; keySeq?: Record<string, number> }) => void }[] = [
  { name: "1e300", patch: (hot) => { hot.seq = 1e300; } },
  { name: "2^53+2", patch: (hot) => { hot.seq = 9_007_199_254_740_994; } },
  { name: "MAX_SAFE", patch: (hot) => { hot.seq = Number.MAX_SAFE_INTEGER; } },
  { name: "keySeq lastRun", patch: (hot) => { hot.keySeq![LAST_RUN_KEY] = (hot.seq ?? 0) + 1_000_000; } },
  { name: "keySeq bar4h", patch: (hot) => { hot.keySeq![bar4hKey("BTC-USD")] = (hot.seq ?? 0) + 1_000_000; } },
  { name: "keySeq 1e12", patch: (hot) => { hot.seq = 3; for (const key of Object.keys(hot.keySeq ?? {})) hot.keySeq![key] = 1e12; } },
];

for (const poison of POISON) {
  test(`poisoned sequence ${poison.name} saves the book and the next flush can cache`, async () => {
    const kv = memoryKv(clock);
    await seedBook(kv);
    const stored = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; keySeq?: Record<string, number> };
    poison.patch(stored);
    await kv.set(HOT_KEY, JSON.stringify(stored));
    const host = startPaperHost(PRODUCTS, {});
    host.clock = clock;
    host.warmupStored = true;
    const loaded = await loadSplit(kv, host);
    if (!loaded) throw new Error("load");
    installPaperState(host, loaded);
    const barA = TODAY - 910 * 14_400;
    const rows = host.fourBars.get("BTC-USD") ?? [];
    rows.push({ ...ohlc(barA), close: 41 });
    host.fourBars.set("BTC-USD", rows);
    host.book.realizedUsd = 77;
    await persistSplit(kv, host);
    const first = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: unknown; keySeq?: unknown; realizedUsd?: number; incidents?: string[] };
    expect(first.realizedUsd).toBe(77);
    expect(first.seq).toBeUndefined();
    expect(first.keySeq).toBeUndefined();
    expect(host.seqInvalid).toBe(1);
    expect(host.book.incidents).toContain("seq invalid");
    expect(redisLogLine(host)).toContain("seqInvalid=1");
    const writtenA = JSON.parse((await kv.get(bar4hKey("BTC-USD"))) ?? "[]") as { ts: number }[];
    expect(writtenA.some((bar) => bar.ts === barA)).toBe(true);
    const barB = TODAY - 911 * 14_400;
    const more = host.fourBars.get("BTC-USD") ?? [];
    more.push({ ...ohlc(barB), close: 42 });
    host.fourBars.set("BTC-USD", more);
    host.book.realizedUsd = 88;
    await persistSplit(kv, host);
    const second = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { era?: string; seq?: number; realizedUsd?: number };
    expect(second.realizedUsd).toBe(88);
    expect(second.era).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof second.seq).toBe("number");
    const writtenB = JSON.parse((await kv.get(bar4hKey("BTC-USD"))) ?? "[]") as { ts: number }[];
    expect(writtenB.some((bar) => bar.ts === barA)).toBe(true);
    expect(writtenB.some((bar) => bar.ts === barB)).toBe(true);
    const { standby, holder } = await warmStandby(kv);
    host.book.realizedUsd = 99;
    await persistSplit(kv, host);
    const watch = watchMget(kv);
    await holder.reload();
    watch.restore();
    expect(watch.full()).toBe(0);
    expect(watch.calls.flat()).not.toContain(bar4hKey("BTC-USD"));
    expect(standby.book.realizedUsd).toBe(99);
    expect(standby.fourBars.get("BTC-USD")?.some((bar) => bar.ts === barB)).toBe(true);
  });
}

test("three invocations still save the book when the stored sequence is poisoned", async () => {
  let t = NOW;
  const kv = memoryKv(() => t);
  await seedBook(kv);
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq: number; keySeq: Record<string, number> };
  hot.keySeq[LAST_RUN_KEY] = hot.seq + 1_000_000;
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const lines: string[] = [];
  for (let n = 1; n <= 3; n += 1) {
    const host = startPaperHost(PRODUCTS, {});
    host.clock = () => t;
    const holder = hostHolder(host, kv, [], `inv${n}`);
    await holder.warm();
    await runInvocation({
      kv,
      self: `inv${n}`,
      nowMs: t,
      deadlineMs: t + 30 * 60_000,
      lastCronMs: t - 900_000,
      clock: () => t,
      holder: {
        async warm() {},
        reload: () => holder.reload(),
        applyDueBars: () => holder.applyDueBars(),
        releaseDeadline() {},
        recordGap(gap) {
          holder.recordGap(gap);
        },
        persist: () => holder.persist(),
        async sampleUntil() {
          host.book.realizedUsd += 1;
          await holder.persist();
        },
      },
    });
    lines.push(redisLogLine(host));
    const stored = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { realizedUsd?: number };
    expect(stored.realizedUsd).toBe(3 + n);
    t += 16 * 60_000;
  }
  expect(lines[0]).toContain("seqInvalid=1");
  const last = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { realizedUsd?: number; incidents?: string[]; era?: string; seq?: number };
  expect(last.realizedUsd).toBe(6);
  expect(last.incidents).toContain("seq invalid");
  expect(last.era).toMatch(/^[0-9a-f]{16}$/);
  expect(typeof last.seq).toBe("number");
});

test("a normal flush does not GET p6:hot or strip its sequence", async () => {
  const kv = memoryKv(clock);
  expect(await tryAcquire(kv, "holder", NOW + 60 * 60_000, NOW)).toBe(true);
  const lease = decodeLease(await kv.get(LEASE_KEY));
  if (!lease?.token) throw new Error("lease");
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  host.warmupStored = true;
  host.leaseToken = lease.token;
  host.holderId = "holder";
  host.book.realizedUsd = 3;
  host.fifteen.push(fifteen("BTC-USD", TODAY));
  await persistSplit(kv, host);
  let gets = 0;
  let strips = 0;
  const get = kv.get.bind(kv);
  kv.get = async (key) => {
    if (key === HOT_KEY) gets += 1;
    return get(key);
  };
  const ownedSet = kv.ownedSet.bind(kv);
  kv.ownedSet = async (leaseKey, token, key, value, opts) => {
    if (key === HOT_KEY) {
      const body = JSON.parse(value) as { seq?: unknown; keySeq?: unknown };
      if (body.seq == null && body.keySeq == null) strips += 1;
    }
    return ownedSet(leaseKey, token, key, value, opts);
  };
  const before = host.saveBytes;
  host.book.realizedUsd = 4;
  await persistSplit(kv, host);
  expect(gets).toBe(0);
  expect(strips).toBe(0);
  expect(host.saveBytes).toBeGreaterThan(before);
  const stored = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { realizedUsd?: number; seq?: number };
  expect(stored.realizedUsd).toBe(4);
  expect(stored.seq).toBeGreaterThan(0);
});

test("a moved 1h series is reloaded", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const ts = TODAY - 400 * 3_600;
  await saveSinceWarm(kv, clock, (editor) => {
    const rows = editor.hourWarm.get("BTC-USD") ?? [];
    rows.push({ ...ohlc(ts), close: 19 });
    editor.hourWarm.set("BTC-USD", rows);
  });
  await holder.reload();
  expect(standby.hourWarm.get("BTC-USD")?.some((bar) => bar.ts === ts && bar.close === 19)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("a moved daily series is reloaded", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const ts = TODAY - 40 * 86_400;
  await saveSinceWarm(kv, clock, (editor) => {
    const rows = editor.dailyBars.get("BTC-USD") ?? [];
    rows.push({ ...ohlc(ts), close: 21 });
    editor.dailyBars.set("BTC-USD", rows);
  });
  await holder.reload();
  expect(standby.dailyBars.get("BTC-USD")?.some((bar) => bar.ts === ts && bar.close === 21)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("a moved ring is reloaded", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const ts = (Math.floor(NOW / 1000 / 60) * 60 - 120) * 1000;
  await saveSinceWarm(kv, clock, (editor) => {
    editor.book.mids.completed.push({ productId: "BTC-USD", ts, open: 4, high: 4, low: 4, close: 4, volumeBase: 2 });
  });
  await holder.reload();
  expect(standby.book.mids.completed.some((bar) => bar.ts === ts && bar.close === 4)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("a moved tape minute is reloaded", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const tsSec = Math.floor(NOW / 1000 / 60) * 60 - 55;
  await saveSinceWarm(kv, clock, (editor) => {
    editor.trades.push({ productId: "BTC-USD", tsSec, price: 123.5, size: 0.25, side: "buy" });
  });
  await holder.reload();
  expect(standby.trades.some((trade) => trade.tsSec === tsSec && trade.price === 123.5)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("a moved seed mark is reloaded", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  await saveSinceWarm(kv, clock, (editor) => {
    editor.seedMarks.set("BTC-USD", { oldestTs: 1, newestTs: 2, status: "cold", reason: "qa" });
  });
  await holder.reload();
  expect(standby.seedMarks.get("BTC-USD")).toEqual({ oldestTs: 1, newestTs: 2, status: "cold", reason: "qa" });
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("a fill written outside the flush is reloaded", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const editor = startPaperHost(PRODUCTS, {});
  editor.clock = clock;
  editor.warmupStored = true;
  const loaded = await loadSplit(kv, editor);
  if (!loaded) throw new Error("load");
  installPaperState(editor, loaded);
  editor.book.legs.push({
    id: "fill-1",
    productId: "BTC-USD",
    classId: "C",
    side: "entry",
    arrivalMid: 1,
    arrivalBid: 1,
    arrivalAsk: 1,
    arrivalSnapshotTs: NOW,
    orderSendTs: NOW,
    decisionMid: 1,
    activeStop: null,
    triggerBarTs: null,
    fillPrice: 1,
    units: 1,
    feesUsd: 0,
  });
  await writeThroughBook(kv, editor);
  await holder.reload();
  expect(standby.book.legs.some((leg) => leg.id === "fill-1")).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("a backwards token sequence forces a full reload", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  await saveSinceWarm(kv, clock, (editor) => {
    editor.book.realizedUsd = 8;
  });
  const { standby, holder } = await warmStandby(kv);
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { era?: string; seq: number; keySeq: Record<string, number> };
  const barKey = bar4hKey("BTC-USD");
  const barSeq = hot.keySeq[barKey];
  if (barSeq == null || !(barSeq < hot.seq) || standby.redisSeq !== hot.seq) throw new Error("seq setup");
  const added = TODAY - 770 * 14_400;
  const rows = JSON.parse((await kv.get(barKey)) ?? "[]") as ReturnType<typeof ohlc>[];
  rows.push(ohlc(added));
  await kv.set(barKey, JSON.stringify(rows));
  hot.seq = barSeq;
  for (const key of Object.keys(hot.keySeq)) if (hot.keySeq[key]! > barSeq) hot.keySeq[key] = barSeq;
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const watch = watchMget(kv);
  await holder.reload();
  watch.restore();
  expect(watch.full()).toBeGreaterThan(0);
  expect(standby.fourBars.get("BTC-USD")?.some((bar) => bar.ts === added)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("a token with no sequence after warm is loaded in full", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  if (standby.redisSeq == null) throw new Error("warm seq");
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as Record<string, unknown>;
  delete hot.seq;
  delete hot.keySeq;
  delete hot.era;
  delete hot.keyEra;
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const barKey = bar4hKey("BTC-USD");
  const added = TODAY - 760 * 14_400;
  const rows = JSON.parse((await kv.get(barKey)) ?? "[]") as ReturnType<typeof ohlc>[];
  rows.push({ ...ohlc(added), close: 92 });
  await kv.set(barKey, JSON.stringify(rows));
  await holder.reload();
  expect(standby.fourBars.get("BTC-USD")?.some((bar) => bar.ts === added && bar.close === 92)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("a key omitted from a same-era map is reloaded", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as {
    seq: number;
    era: string;
    keySeq: Record<string, number>;
    keyEra?: Record<string, string>;
  };
  const ethKey = bar4hKey("ETH-USD");
  delete hot.keySeq[ethKey];
  if (hot.keyEra) delete hot.keyEra[ethKey];
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const ethTs = TODAY - 730 * 14_400;
  const eth = JSON.parse((await kv.get(ethKey)) ?? "[]") as ReturnType<typeof ohlc>[];
  eth.push({ ...ohlc(ethTs), close: 44 });
  await kv.set(ethKey, JSON.stringify(eth));
  await holder.reload();
  expect(standby.fourBars.get("ETH-USD")?.some((bar) => bar.ts === ethTs && bar.close === 44)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("a partial map published after an unsequenced hot does not skip the keys it left out", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as Record<string, unknown>;
  delete hot.seq;
  delete hot.keySeq;
  delete hot.era;
  delete hot.keyEra;
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const btcTs = TODAY - 750 * 14_400;
  await saveSinceWarm(kv, clock, (editor) => {
    const rows = editor.fourBars.get("BTC-USD") ?? [];
    rows.push({ ...ohlc(btcTs), close: 17 });
    editor.fourBars.set("BTC-USD", rows);
  });
  const published = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { keySeq?: Record<string, number> };
  expect(published.keySeq?.[bar4hKey("ETH-USD")]).toBeUndefined();
  const ethKey = bar4hKey("ETH-USD");
  const ethTs = TODAY - 740 * 14_400;
  const eth = JSON.parse((await kv.get(ethKey)) ?? "[]") as ReturnType<typeof ohlc>[];
  eth.push({ ...ohlc(ethTs), close: 33 });
  await kv.set(ethKey, JSON.stringify(eth));
  await holder.reload();
  expect(standby.fourBars.get("ETH-USD")?.some((bar) => bar.ts === ethTs && bar.close === 33)).toBe(true);
  expect(standby.fourBars.get("BTC-USD")?.some((bar) => bar.ts === btcTs && bar.close === 17)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});
