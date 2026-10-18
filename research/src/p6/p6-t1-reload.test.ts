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
  mutablePlanCount,
  persistSplit,
  reloadSplit,
  SEQ_ENTRY_BYTES,
  SEQ_MAP_FLOOR_BYTES,
  seqMapCapBytes,
  seqMapExceedsCap,
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
    `redis cmds=4, bytes=9, readBytes=${Buffer.byteLength(hot) + Buffer.byteLength(four)}, duplicates=1, seqInvalid=0, seqOverflow=0`,
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
        keySeq?: Record<string, number>;
        realizedUsd: number;
      };
      hot.seq += 1;
      hot.realizedUsd = 777;
      hot.keySeq = hot.keySeq ?? {};
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
  const warmed = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; base?: number; keySeq?: Record<string, number> };
  warmed.seq = n;
  warmed.base = n;
  for (const key of Object.keys(warmed.keySeq ?? {})) warmed.keySeq![key] = n;
  await kv.set(HOT_KEY, JSON.stringify(warmed));
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  const holder = hostHolder(host, kv, [], "standby");
  await holder.warm();
  expect(host.redisSeq).toBe(n);
  const stripped = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; keySeq?: unknown; base?: unknown };
  delete stripped.seq;
  delete stripped.keySeq;
  delete stripped.base;
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
  const parsed = JSON.parse(stored) as { era?: string; seq?: number; base?: number; keySeq?: Record<string, number> };
  const keySeq = parsed.keySeq ?? {};
  const rest = { ...parsed } as { seq?: number; base?: unknown; keySeq?: unknown; era?: unknown; keyEra?: unknown };
  delete rest.seq;
  delete rest.base;
  delete rest.keySeq;
  delete rest.era;
  delete rest.keyEra;
  const hotBefore = Buffer.byteLength(JSON.stringify(rest));
  const hotAfter = Buffer.byteLength(stored);
  expect(parsed.era).toMatch(/^[0-9a-f]{16}$/);
  expect(parsed.base).toBe(parsed.seq);
  expect(hotAfter).toBeLessThan(64 * 1024);
  expect(hotAfter).toBeLessThan(HOT_MAX_BYTES);
  expect(Object.keys(keySeq).length).toBe(0);
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
  const groupedStrips = stripSets - stripBefore;
  const groupedStripBytes = stripBytes - stripBytesBefore;
  let heartbeatSum = 0;
  const heartbeatPayloads: number[] = [];
  for (let i = 0; i < 27; i += 1) {
    host.book.realizedUsd = 200 + i;
    const before = payloads.length;
    await persistSplit(kv, host);
    const bytes = payloads[before] ?? 0;
    heartbeatPayloads.push(bytes);
    heartbeatSum += bytes;
  }
  const successor = startPaperHost(names, {});
  successor.clock = clock;
  successor.warmupStored = true;
  successor.leaseToken = lease.token;
  successor.holderId = "holder";
  const taken = await loadSplit(kv, successor);
  if (!taken) throw new Error("takeover load");
  installPaperState(successor, taken);
  successor.book.realizedUsd = 900;
  const beforeTake = payloads.length;
  await persistSplit(kv, successor);
  const takeoverFlush = payloads[beforeTake] ?? 0;
  const status = readFileSync("/proc/self/status", "utf8");
  const hwm = Number(status.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0);
  console.log(
    `t1 prod asOf=${latest?.date} products=${names.length} hotBefore=${hotBefore} hotAfter=${hotAfter} keySeqKeys=${Object.keys(keySeq).length} firstBarSets=${firstBarSets} firstPayload=${firstPayload} steadyStripSets=${steadyStrip} steadyPayloads=${steady.join(",")} barPayload=${barPayload} steadyBarSets=${steadyGrouped} againBarSets=${barSets - barsBefore} againStripSets=${groupedStrips} againStripBytes=${groupedStripBytes} againHotGets=${hotGets} againHotGetBytes=${hotGetBytes} heartbeat27=${heartbeatSum} heartbeatEach=${heartbeatPayloads[0] ?? 0} takeoverFlush=${takeoverFlush} VmHWM_kB=${hwm}`,
  );
  expect(hotAfter).toBeLessThan(8_000);
  // Loosened when the exception map stopped being wiped by the 4 KB cap.
  // The hot carries that map. It plateaus near 17 KB at 27 names and near 22 KB at 40.
  // 27 heartbeats: 250 KB -> 560 KB (measured 500,861).
  // One heartbeat: 12 KB -> 22 KB (measured 18,550).
  // Takeover flush: 16 KB -> 28 KB (measured 23,163).
  expect(heartbeatSum).toBeLessThan(560_000);
  for (const bytes of heartbeatPayloads) expect(bytes).toBeLessThan(22_000);
  expect(takeoverFlush).toBeGreaterThan(0);
  expect(takeoverFlush).toBeLessThan(28_000);
  expect(hwm).toBeLessThan(1024 * 1024);
  expect(hotAfter).toBeLessThan(HOT_MAX_BYTES);
  expect(firstBarSets).toBeGreaterThan(0);
  expect(firstPayload).toBeLessThan(1_048_576);
  expect(steadyGrouped).toBe(0);
  expect(steadyStrip).toBe(0);
  for (const bytes of steady) expect(bytes).toBeLessThan(1_048_576);
  expect(barPayload).toBeLessThan(1_048_576);
  expect(groupedStrips).toBe(1);
}, 60_000);

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
  expect(published.era).toBe(warmedEra);
  expect(published.keyEra).toBeUndefined();
  const publishedBase = (published as { base?: number }).base;
  expect(published.keySeq?.[bar4hKey("ETH-USD")] ?? publishedBase).toBe(ethSeq);
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
    delete hot.base;
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
    base?: number;
    keySeq?: Record<string, number>;
  };
  expect(published.seq).toBe(warmedSeq);
  expect(published.keySeq?.[bar4hKey("BTC-USD")] ?? published.base).toBe(warmedBarSeq);
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
  { name: "keySeq 1e12", patch: (hot) => { hot.seq = 3; hot.keySeq = hot.keySeq ?? {}; for (const key of Object.keys(hot.keySeq)) hot.keySeq[key] = 1e12; } },
];

for (const poison of POISON) {
  test(`poisoned sequence ${poison.name} saves the book and the next flush can cache`, async () => {
    const kv = memoryKv(clock);
    await seedBook(kv);
    const stored = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; keySeq?: Record<string, number> };
    if (!stored.keySeq || Object.keys(stored.keySeq).length === 0) stored.keySeq = { [LAST_RUN_KEY]: stored.seq ?? 1 };
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
    const second = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { era?: string; seq?: number; realizedUsd?: number; incidents?: string[] };
    expect(second.realizedUsd).toBe(88);
    expect(second.era).toMatch(/^[0-9a-f]{16}$/);
    expect(typeof second.seq).toBe("number");
    expect(second.incidents ?? []).not.toContain("seq invalid");
    expect(host.book.incidents).not.toContain("seq invalid");
    expect(host.seqInvalid).toBe(1);
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
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq: number; keySeq?: Record<string, number> };
  hot.keySeq = hot.keySeq ?? {};
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
  expect(last.incidents ?? []).not.toContain("seq invalid");
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
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { era?: string; seq: number; base?: number; keySeq?: Record<string, number> };
  const barKey = bar4hKey("BTC-USD");
  hot.keySeq = hot.keySeq ?? {};
  const barSeq = hot.keySeq[barKey] ?? hot.base;
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

test("a same-era sequence change reloads that key", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as {
    seq: number;
    era: string;
    base?: number;
    keySeq?: Record<string, number>;
  };
  const ethKey = bar4hKey("ETH-USD");
  const cached = standby.redisKeySeq?.get(ethKey);
  if (cached == null || cached < 2 || standby.redisSeenEra !== hot.era) throw new Error("same-era setup");
  hot.keySeq = { ...(hot.keySeq ?? {}), [ethKey]: cached - 1 };
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const ethTs = TODAY - 730 * 14_400;
  const eth = JSON.parse((await kv.get(ethKey)) ?? "[]") as ReturnType<typeof ohlc>[];
  eth.push({ ...ohlc(ethTs), close: 44 });
  await kv.set(ethKey, JSON.stringify(eth));
  const watch = watchMget(kv);
  await holder.reload();
  watch.restore();
  expect(watch.full()).toBe(0);
  expect(watch.calls.flat()).toContain(ethKey);
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

test("chained standbys keep the sequence a second reload just read", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const standby = startPaperHost(PRODUCTS, {});
  standby.clock = clock;
  const warmed = await loadSplit(kv, standby);
  if (!warmed) throw new Error("warm");
  installPaperState(standby, warmed);
  const warmSeq = standby.redisSeq;
  const btcTs = TODAY - 720 * 14_400;
  await saveSinceWarm(kv, clock, (editor) => {
    const rows = editor.fourBars.get("BTC-USD") ?? [];
    rows.push({ ...ohlc(btcTs), close: 11 });
    editor.fourBars.set("BTC-USD", rows);
    editor.book.realizedUsd = 31;
  });
  const first = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number };
  const firstSeq = first.seq;
  if (firstSeq == null) throw new Error("seq");
  const body = await reloadSplit(kv, standby);
  if (!body) throw new Error("reload");
  installPaperState(standby, body);
  expect(standby.redisSeq).toBe(firstSeq);
  expect(standby.redisSeq).not.toBe(warmSeq);
  const ethTs = TODAY - 710 * 14_400;
  await saveSinceWarm(kv, clock, (editor) => {
    const rows = editor.fourBars.get("ETH-USD") ?? [];
    rows.push({ ...ohlc(ethTs), close: 12 });
    editor.fourBars.set("ETH-USD", rows);
    editor.book.realizedUsd = 32;
  });
  const second = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number };
  const secondSeq = second.seq;
  if (secondSeq == null) throw new Error("seq");
  const again = await reloadSplit(kv, standby);
  if (!again) throw new Error("second reload");
  installPaperState(standby, again);
  expect(standby.redisSeq).toBe(secondSeq);
  expect(standby.redisSeq).not.toBe(firstSeq);
  expect(standby.fourBars.get("BTC-USD")?.some((bar) => bar.ts === btcTs && bar.close === 11)).toBe(true);
  expect(standby.fourBars.get("ETH-USD")?.some((bar) => bar.ts === ethTs && bar.close === 12)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("a moved acct marker is reloaded", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  expect(standby.book.acctFromDay).toBe("2026-10-13");
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq: number; base?: number; keySeq?: Record<string, number> };
  const cached = standby.redisKeySeq?.get(ACCT_KEY);
  if (cached == null || cached < 2) throw new Error("acct seq");
  hot.keySeq = { ...(hot.keySeq ?? {}), [ACCT_KEY]: cached - 1 };
  await kv.set(HOT_KEY, JSON.stringify(hot));
  await kv.set(ACCT_KEY, JSON.stringify({ rev: 2, fromDay: "2026-10-01" }));
  await holder.reload();
  expect(standby.book.acctFromDay).toBe("2026-10-01");
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("a bar missing from the cached raw map is reloaded", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  const loaded = await loadSplit(kv, host);
  if (!loaded) throw new Error("load");
  installPaperState(host, loaded);
  const key = bar4hKey("BTC-USD");
  if (!host.redisRaw?.has(key)) throw new Error("cached bar");
  host.redisRaw.delete(key);
  const ts = TODAY - 690 * 14_400;
  const rows = JSON.parse((await kv.get(key)) ?? "[]") as ReturnType<typeof ohlc>[];
  rows.push({ ...ohlc(ts), close: 57 });
  await kv.set(key, JSON.stringify(rows));
  const body = await reloadSplit(kv, host);
  if (!body) throw new Error("reload");
  installPaperState(host, body);
  expect(host.fourBars.get("BTC-USD")?.some((bar) => bar.ts === ts && bar.close === 57)).toBe(true);
});

test("a hot with no era after a valid warm is loaded in full", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  if (standby.redisSeq == null || standby.redisSeenEra == null) throw new Error("warm era");
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as Record<string, unknown>;
  delete hot.era;
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const key = bar4hKey("SOL-USD");
  const ts = TODAY - 680 * 14_400;
  const rows = JSON.parse((await kv.get(key)) ?? "[]") as ReturnType<typeof ohlc>[];
  rows.push({ ...ohlc(ts), close: 63 });
  await kv.set(key, JSON.stringify(rows));
  const watch = watchMget(kv);
  await holder.reload();
  watch.restore();
  expect(watch.full()).toBeGreaterThan(0);
  expect(standby.fourBars.get("SOL-USD")?.some((bar) => bar.ts === ts && bar.close === 63)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("one 4h change is the only bar exception and matches a full load", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const ts = TODAY - 670 * 14_400;
  await saveSinceWarm(kv, clock, (editor) => {
    const rows = editor.fourBars.get("XRP-USD") ?? [];
    rows.push({ ...ohlc(ts), close: 28 });
    editor.fourBars.set("XRP-USD", rows);
  });
  const published = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; base?: number; keySeq?: Record<string, number> };
  const changed = bar4hKey("XRP-USD");
  expect(published.keySeq?.[changed]).toBe(published.seq);
  expect(published.base).not.toBe(published.seq);
  for (const productId of PRODUCTS) {
    if (productId === "XRP-USD") continue;
    expect(published.keySeq?.[bar4hKey(productId)]).toBeUndefined();
    expect(published.keySeq?.[bar1hKey(productId)]).toBeUndefined();
    expect(published.keySeq?.[d1Key(productId)]).toBeUndefined();
  }
  await holder.reload();
  expect(standby.fourBars.get("XRP-USD")?.some((bar) => bar.ts === ts && bar.close === 28)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("an era is minted once per poison and does not flap", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  host.warmupStored = true;
  const loaded = await loadSplit(kv, host);
  if (!loaded) throw new Error("load");
  installPaperState(host, loaded);
  const firstEra = host.redisEra ?? host.redisSeenEra;
  if (!firstEra) throw new Error("era");
  for (let i = 0; i < 4; i += 1) {
    host.book.realizedUsd = 10 + i;
    await persistSplit(kv, host);
    expect(host.redisEra).toBe(firstEra);
  }
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number };
  hot.seq = 1e300;
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const poisonedLoad = await loadSplit(kv, host);
  if (!poisonedLoad) throw new Error("poison load");
  installPaperState(host, poisonedLoad);
  expect(host.redisPoison).toBe(true);
  host.book.realizedUsd = 70;
  await persistSplit(kv, host);
  const stripped = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: unknown; incidents?: string[] };
  expect(stripped.seq).toBeUndefined();
  expect(stripped.incidents).toContain("seq invalid");
  expect(host.seqInvalid).toBe(1);
  host.book.realizedUsd = 71;
  await persistSplit(kv, host);
  const recovered = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { era?: string; incidents?: string[] };
  expect(recovered.era).toMatch(/^[0-9a-f]{16}$/);
  expect(recovered.era).not.toBe(firstEra);
  expect(recovered.incidents ?? []).not.toContain("seq invalid");
  expect(host.book.incidents).not.toContain("seq invalid");
  const nextEra = recovered.era;
  for (let i = 0; i < 3; i += 1) {
    host.book.realizedUsd = 80 + i;
    await persistSplit(kv, host);
    const published = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { era?: string };
    expect(published.era).toBe(nextEra);
  }
});

test("an exception map past the cap restamps and still saves", async () => {
  const boot = await bootCap();
  const flip = capFlip(boot.carried, boot.next, boot.cap);
  expect(flip.overBytes).toBeGreaterThan(boot.cap);
  expect(seqMapExceedsCap(flip.overBytes, boot.count)).toBe(true);
  for (let i = 0; i < flip.over; i += 1) boot.host.fifteen.push(fifteen("BTC-USD", capExtra(i).startSec));
  const { kv, host, era } = boot;
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  let threw = false;
  try {
    host.book.realizedUsd = 55;
    await persistSplit(kv, host);
  } catch {
    threw = true;
  } finally {
    console.log = log;
  }
  expect(threw).toBe(false);
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as {
    era?: string;
    seq?: number;
    base?: number;
    keySeq?: Record<string, number>;
    realizedUsd?: number;
    incidents?: string[];
  };
  expect(lines).toContain("seq map overflow");
  expect(host.seqOverflow).toBeGreaterThanOrEqual(1);
  expect(hot.incidents ?? []).not.toContain("seq map overflow");
  expect(host.book.incidents).not.toContain("seq map overflow");
  expect(hot.era).toMatch(/^[0-9a-f]{16}$/);
  expect(hot.era).not.toBe(era);
  expect(hot.keySeq).toBeUndefined();
  expect(hot.base).toBe(hot.seq);
  expect(hot.realizedUsd).toBe(55);
  expect(redisLogLine(host)).toContain("seqOverflow=1");
  expect(seqMapExceedsCap(Buffer.byteLength(JSON.stringify(hot.keySeq ?? {})), mutablePlanCount(host))).toBe(false);
  const standby = startPaperHost(["BTC-USD"], {});
  standby.clock = clock;
  const loaded = await loadSplit(kv, standby);
  if (!loaded) throw new Error("load");
  installPaperState(standby, loaded);
  host.book.realizedUsd = 56;
  await persistSplit(kv, host);
  const watch = watchMget(kv);
  const body = await reloadSplit(kv, standby);
  watch.restore();
  if (!body) throw new Error("reload");
  installPaperState(standby, body);
  expect(watch.full()).toBe(0);
  expect(standby.book.realizedUsd).toBe(56);
});

async function horizon(names: string[]): Promise<{ heartbeatSum: number; takeoverFlush: number; hotBytes: number; mapKeys: number; mapBytes: number; readBytes: number; fullBytes: number }> {
  let t = NOW;
  // The lease TTL follows the Kv clock. The book clock is the one that walks 14 days.
  const kv = memoryKv(() => NOW);
  expect(await tryAcquire(kv, "holder", NOW + 60 * 86_400_000, NOW)).toBe(true);
  const lease = decodeLease(await kv.get(LEASE_KEY));
  if (!lease?.token) throw new Error("lease");
  const host = startPaperHost(names, {});
  host.clock = () => t;
  host.warmupStored = true;
  host.leaseToken = lease.token;
  host.holderId = "holder";
  for (const productId of names) host.fourBars.set(productId, [ohlc(TODAY - 14_400)]);
  const payloads: number[] = [];
  const ownedFlush = kv.ownedFlush.bind(kv);
  kv.ownedFlush = async (leaseKey, token, nowMs, payload) => {
    payloads.push(Buffer.byteLength(payload));
    return ownedFlush(leaseKey, token, nowMs, payload);
  };
  await persistSplit(kv, host);
  const eras = new Set<string>();
  if (host.redisEra) eras.add(host.redisEra);
  let heartbeatSum = 0;
  for (let step = 0; step < 28; step += 1) {
    t += 12 * 60 * 60 * 1000;
    host.book.realizedUsd = step + 1;
    const before = payloads.length;
    await persistSplit(kv, host);
    heartbeatSum += payloads[before] ?? 0;
    if (host.redisEra) eras.add(host.redisEra);
  }
  expect(eras.size).toBe(1);
  const published = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { keySeq?: Record<string, number>; era?: string };
  const mapKeys = Object.keys(published.keySeq ?? {});
  expect(mapKeys.some((key) => key.startsWith("p6:tape:"))).toBe(false);
  expect(mapKeys.length).toBeLessThanOrEqual(8);
  const mapBytes = Buffer.byteLength(JSON.stringify(published.keySeq ?? {}));
  const standby = startPaperHost(names, {});
  standby.clock = () => t;
  expect(seqMapExceedsCap(mapBytes, mutablePlanCount(standby))).toBe(false);
  const fullBefore = standby.readBytes;
  const loaded = await loadSplit(kv, standby);
  if (!loaded) throw new Error("horizon load");
  installPaperState(standby, loaded);
  const fullBytes = standby.readBytes - fullBefore;
  standby.readBytes = 0;
  host.book.realizedUsd = 900;
  const beforeTake = payloads.length;
  await persistSplit(kv, host);
  const takeoverFlush = payloads[beforeTake] ?? 0;
  const partial = await reloadSplit(kv, standby);
  if (!partial) throw new Error("horizon reload");
  installPaperState(standby, partial);
  expect(standby.book.realizedUsd).toBe(900);
  const hotBytes = Buffer.byteLength((await kv.get(HOT_KEY)) ?? "");
  return { heartbeatSum, takeoverFlush, hotBytes, mapKeys: mapKeys.length, mapBytes, readBytes: standby.readBytes, fullBytes };
}

test("a 14-day takeover on 27 products keeps the sequence map inside the plan", async () => {
  const path = fileURLToPath(new URL("../../data/reports/universe-membership.json", import.meta.url));
  const membership = JSON.parse(readFileSync(path, "utf8")) as { members: { date: string; names: string[] }[] };
  const names = membership.members[membership.members.length - 1]?.names ?? [];
  expect(names.length).toBe(27);
  const measured = await horizon(names);
  const status = readFileSync("/proc/self/status", "utf8");
  const hwm = Number(status.match(/VmHWM:\s+(\d+)/)?.[1] ?? 0);
  console.log(
    `t1 horizon27 heartbeatSum=${measured.heartbeatSum} takeoverFlush=${measured.takeoverFlush} hotBytes=${measured.hotBytes} mapKeys=${measured.mapKeys} mapBytes=${measured.mapBytes} readBytes=${measured.readBytes} fullBytes=${measured.fullBytes} VmHWM_kB=${hwm}`,
  );
  expect(measured.heartbeatSum).toBeLessThan(250_000);
  expect(measured.takeoverFlush).toBeLessThan(16_000);
  expect(hwm).toBeLessThan(1024 * 1024);
}, 60_000);

test("a 14-day takeover on 40 products keeps the sequence map inside the plan", async () => {
  const path = fileURLToPath(new URL("../../data/reports/universe-membership.json", import.meta.url));
  const membership = JSON.parse(readFileSync(path, "utf8")) as { members: { date: string; names: string[] }[] };
  const names = [...(membership.members[membership.members.length - 1]?.names ?? [])];
  while (names.length < 40) names.push(`SYN-${String(names.length).padStart(2, "0")}-USD`);
  expect(names.length).toBe(40);
  const measured = await horizon(names);
  console.log(
    `t1 horizon40 heartbeatSum=${measured.heartbeatSum} takeoverFlush=${measured.takeoverFlush} hotBytes=${measured.hotBytes} mapKeys=${measured.mapKeys} mapBytes=${measured.mapBytes} readBytes=${measured.readBytes} fullBytes=${measured.fullBytes}`,
  );
  expect(measured.heartbeatSum).toBeLessThan(250_000);
  expect(measured.takeoverFlush).toBeLessThan(16_000);
}, 60_000);

function planDays(nowMs: number): string[] {
  const today = Math.floor(nowMs / 1000 / 86_400) * 86_400;
  const days: string[] = [];
  for (let i = 0; i < 8; i += 1) days.push(new Date((today - i * 86_400) * 1000).toISOString().slice(0, 10));
  return days;
}

function mutableWrittenKey(key: string): boolean {
  if (key === SEED_CURSOR_KEY || key === LAST_RUN_KEY || key === ACCT_KEY) return true;
  return (
    key.startsWith("p6:bar15:") ||
    key.startsWith("p6:bar4h:") ||
    key.startsWith("p6:bar1h:") ||
    key.startsWith("p6:d1:") ||
    key.startsWith("p6:ring1m:") ||
    key.startsWith("p6:seed:wm:")
  );
}

async function seedLagBook(kv: Kv, atMs: number): Promise<void> {
  const host = startPaperHost(PRODUCTS, {});
  host.clock = () => atMs;
  host.warmupStored = true;
  host.book.positions = [position("open-1")];
  host.book.realizedUsd = 3;
  for (const productId of PRODUCTS) {
    for (let day = 0; day < 8; day += 1) host.fifteen.push(fifteen(productId, TODAY - day * 86_400 + 900));
  }
  await persistSplit(kv, host);
}

/** Writer clock lags the bar. The bar's day is the writer's next UTC day, which today's plan does not list. */
async function dayRoll(lagSec: number, aheadDays: number): Promise<void> {
  const midnight = Date.parse("2026-10-13T00:00:00.000Z");
  const writerMs = midnight - lagSec * 1000;
  const writerToday = Math.floor(writerMs / 86_400_000) * 86_400_000;
  const tomorrowMs = writerToday + 86_400_000;
  const outsideMs = tomorrowMs + aheadDays * 86_400_000;
  const readerMs = outsideMs;
  const barTimes = aheadDays > 0 ? [tomorrowMs, outsideMs] : [tomorrowMs];
  const kv = memoryKv(() => NOW);
  await seedLagBook(kv, writerMs);
  const reader = startPaperHost(PRODUCTS, {});
  reader.clock = () => readerMs;
  const warmed = await loadSplit(kv, reader);
  if (!warmed) throw new Error("warm");
  installPaperState(reader, warmed);
  const writer = startPaperHost(PRODUCTS, {});
  writer.clock = () => writerMs;
  writer.warmupStored = true;
  const loaded = await loadSplit(kv, writer);
  if (!loaded) throw new Error("writer");
  installPaperState(writer, loaded);
  const writerDays = planDays(writerMs);
  const readerDays = planDays(readerMs);
  for (const barMs of barTimes) {
    const day = new Date(barMs).toISOString().slice(0, 10);
    expect(writerDays).not.toContain(day);
    expect(readerDays).toContain(day);
    writer.fifteen.push(fifteen("BTC-USD", Math.floor(barMs / 1000)));
  }
  writer.book.realizedUsd = 9;
  const written = new Set<string>();
  const origSet = kv.set.bind(kv);
  kv.set = async (key, value, opts) => {
    written.add(key);
    return origSet(key, value, opts);
  };
  await persistSplit(kv, writer);
  kv.set = origSet;
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; base?: number; era?: string; keySeq?: Record<string, number> };
  if (hot.seq == null || hot.base == null || !hot.era) throw new Error("stamp");
  const mutable = [...written].filter(mutableWrittenKey);
  expect(mutable.length).toBeGreaterThan(0);
  for (const key of mutable) expect(hot.keySeq?.[key] ?? hot.base).toBe(hot.seq);
  for (const barMs of barTimes) {
    const day = new Date(barMs).toISOString().slice(0, 10);
    const key = bar15Key("BTC-USD", day);
    expect(written.has(key)).toBe(true);
    expect(hot.keySeq?.[key] ?? hot.base).toBe(hot.seq);
  }
  const writeSeq = hot.seq;
  const era = hot.era;
  if (aheadDays === 0) {
    writer.book.realizedUsd = 10;
    await persistSplit(kv, writer);
    const after = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; era?: string; keySeq?: Record<string, number> };
    expect(after.era).toBe(era);
    expect(after.seq).not.toBeUndefined();
    expect(after.seq).toBeGreaterThan(writeSeq);
    const day = new Date(tomorrowMs).toISOString().slice(0, 10);
    expect(after.keySeq?.[bar15Key("BTC-USD", day)]).toBe(writeSeq);
  }
  const body = await reloadSplit(kv, reader);
  if (!body) throw new Error("reload");
  installPaperState(reader, body);
  const twin = startPaperHost(PRODUCTS, {});
  twin.clock = () => readerMs;
  await oldReload(twin, kv, "standby");
  expect(snap(reader)).toEqual(snap(twin));
  for (const barMs of barTimes) {
    const startSec = Math.floor(barMs / 1000);
    expect(reader.fifteen.some((bar) => bar.productId === "BTC-USD" && bar.startSec === startSec)).toBe(true);
  }
}

for (const lag of [0, 120, 600, 1200, 3600]) {
  test(`a day-roll ${lag}s before the next UTC day matches a full load`, async () => {
    await dayRoll(lag, 0);
  });
}

test("a reader clock a day ahead of a lagged writer matches a full load", async () => {
  await dayRoll(3600, 1);
});

test("every written mutable key is stamped under clock lag", async () => {
  await dayRoll(3600, 0);
});

test("a ledger row written outside the flush is reloaded", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const editor = startPaperHost(PRODUCTS, {});
  editor.clock = clock;
  editor.warmupStored = true;
  const loaded = await loadSplit(kv, editor);
  if (!loaded) throw new Error("load");
  installPaperState(editor, loaded);
  editor.book.closed.push({
    id: "ledger-1",
    classId: "C",
    productId: "BTC-USD",
    netR: 1,
    netUsd: 4,
    grossUsd: 4,
    costUsd: 0,
    riskUsd: 1,
    notionalUsd: 1,
    entryDate: "2026-10-12",
    exitTs: NOW,
    exitKind: "test",
  });
  await writeThroughBook(kv, editor);
  await holder.reload();
  expect(standby.book.closed.map((trade) => trade.id)).toContain("ledger-1");
  const twin = await twinOf(kv);
  expect(standby.book.closed.map((trade) => trade.id)).toEqual(twin.book.closed.map((trade) => trade.id));
  expect(snap(standby)).toEqual(snap(twin));
});

test("a hot rewrite with the same sequence between the token and the confirm reloads in full", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const rawGet = kv.get.bind(kv);
  const rawSet = kv.set.bind(kv);
  let flipped = false;
  kv.get = async (key) => {
    const value = await rawGet(key);
    if (key !== HOT_KEY || flipped || value == null) return value;
    flipped = true;
    const hot = JSON.parse(value) as { realizedUsd?: number; seq?: number };
    const seq = hot.seq;
    hot.realizedUsd = 4242;
    await rawSet(HOT_KEY, JSON.stringify(hot));
    const stored = JSON.parse((await rawGet(HOT_KEY)) ?? "{}") as { seq?: number };
    if (stored.seq !== seq) throw new Error("seq changed");
    return value;
  };
  const watch = watchMget(kv);
  await holder.reload();
  watch.restore();
  kv.get = rawGet;
  expect(flipped).toBe(true);
  expect(watch.full()).toBeGreaterThan(0);
  expect(standby.book.realizedUsd).toBe(4242);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

test("the sequence cap is two plan copies at 40 bytes and never under 16KB", () => {
  expect(SEQ_ENTRY_BYTES).toBe(40);
  expect(SEQ_MAP_FLOOR_BYTES).toBe(16 * 1024);
  expect(seqMapCapBytes(0)).toBe(16 * 1024);
  expect(seqMapCapBytes(100)).toBe(16 * 1024);
  expect(seqMapCapBytes(204)).toBe(16 * 1024);
  expect(seqMapCapBytes(205)).toBe(2 * 205 * 40);
  expect(seqMapCapBytes(300)).toBe(2 * 300 * 40);
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  const count = mutablePlanCount(host);
  expect(count).toBeGreaterThan(0);
  expect(seqMapCapBytes(count)).toBe(Math.max(SEQ_MAP_FLOOR_BYTES, 2 * count * SEQ_ENTRY_BYTES));
  const wide = startPaperHost(
    Array.from({ length: 40 }, (_, index) => `N${String(index).padStart(2, "0")}-USD`),
    {},
  );
  wide.clock = clock;
  const wideCount = mutablePlanCount(wide);
  expect(seqMapCapBytes(wideCount)).toBe(2 * wideCount * SEQ_ENTRY_BYTES);
  expect(seqMapCapBytes(wideCount)).toBeGreaterThan(SEQ_MAP_FLOOR_BYTES);
});

test("a map of exactly the cap does not overflow and one extra byte does", () => {
  for (const keys of [0, 100, 205, 300]) {
    const cap = seqMapCapBytes(keys);
    expect(seqMapExceedsCap(cap, keys)).toBe(false);
    expect(seqMapExceedsCap(cap + 1, keys)).toBe(true);
    expect(seqMapExceedsCap(cap - 1, keys)).toBe(false);
  }
});

function exceptionBytes(entries: Map<string, number>, base = 1): number {
  const body: Record<string, number> = {};
  for (const key of [...entries.keys()].sort()) {
    const value = entries.get(key)!;
    if (value !== base) body[key] = value;
  }
  return Buffer.byteLength(JSON.stringify(body));
}

function capExtra(index: number): { key: string; startSec: number } {
  const startSec = Date.UTC(1999, 0, 1) / 1000 + index * 86_400;
  return { key: bar15Key("BTC-USD", new Date(startSec * 1000).toISOString().slice(0, 10)), startSec };
}

async function bootCap(): Promise<{
  kv: Kv;
  host: PaperHost;
  era: string;
  next: number;
  cap: number;
  count: number;
  carried: Map<string, number>;
}> {
  const kv = memoryKv(clock);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = clock;
  host.warmupStored = true;
  await persistSplit(kv, host);
  if (!host.redisEra || host.redisSeq == null || !host.redisKeySeq || host.redisBase == null) throw new Error("cap boot");
  const count = mutablePlanCount(host);
  const cap = seqMapCapBytes(count);
  const next = Math.max(host.redisSeq + 1, Math.floor(host.clock() / 1000));
  host.redisBase = 1;
  for (const key of host.redisKeySeq.keys()) host.redisKeySeq.set(key, 2);
  const carried = new Map<string, number>();
  for (const key of host.redisKeySeq.keys()) carried.set(key, 2);
  for (const key of [LAST_RUN_KEY, SEED_CURSOR_KEY, ACCT_KEY]) carried.set(key, next);
  return { kv, host, era: host.redisEra, next, cap, count, carried };
}

function capFlip(carried: Map<string, number>, next: number, cap: number): { under: number; over: number; underBytes: number; overBytes: number } {
  const trial = new Map(carried);
  if (exceptionBytes(trial) > cap) throw new Error(`plan exceptions already exceed the cap (${exceptionBytes(trial)} > ${cap})`);
  for (let i = 0; i < 4000; i += 1) {
    trial.set(capExtra(i).key, next);
    const bytes = exceptionBytes(trial);
    if (bytes > cap) {
      const underMap = new Map(trial);
      underMap.delete(capExtra(i).key);
      return { under: i, over: i + 1, underBytes: exceptionBytes(underMap), overBytes: bytes };
    }
  }
  throw new Error("cap never flipped");
}

test("an exception map inside the cap does not mint an era", async () => {
  const boot = await bootCap();
  const flip = capFlip(boot.carried, boot.next, boot.cap);
  expect(flip.underBytes).toBeLessThanOrEqual(boot.cap);
  expect(seqMapExceedsCap(flip.underBytes, boot.count)).toBe(false);
  expect(seqMapExceedsCap(flip.underBytes + 1, boot.count)).toBe(flip.underBytes + 1 > boot.cap);
  for (let i = 0; i < flip.under; i += 1) boot.host.fifteen.push(fifteen("BTC-USD", capExtra(i).startSec));
  boot.host.book.realizedUsd = 41;
  await persistSplit(boot.kv, boot.host);
  expect(boot.host.seqOverflow).toBe(0);
  expect(boot.host.redisEra).toBe(boot.era);
  const hot = JSON.parse((await boot.kv.get(HOT_KEY)) ?? "{}") as { keySeq?: Record<string, number>; era?: string };
  expect(hot.era).toBe(boot.era);
  expect(Buffer.byteLength(JSON.stringify(hot.keySeq ?? {}))).toBe(flip.underBytes);
  expect(seqMapExceedsCap(Buffer.byteLength(JSON.stringify(hot.keySeq ?? {})), boot.count)).toBe(false);
});

function universeNames(padTo = 0): string[] {
  const path = fileURLToPath(new URL("../../data/reports/universe-membership.json", import.meta.url));
  const membership = JSON.parse(readFileSync(path, "utf8")) as { members: { date: string; names: string[] }[] };
  const names = [...(membership.members[membership.members.length - 1]?.names ?? [])];
  while (names.length < padTo) names.push(`SYN-${String(names.length).padStart(2, "0")}-USD`);
  return names;
}

async function sim14(names: string[]): Promise<{ hot: number; read: number; write: number; heartbeat: number; partial: number; grouped: number }> {
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  let t = start;
  const kv = memoryKv(() => start);
  expect(await tryAcquire(kv, "holder", start + 60 * 86_400_000, start)).toBe(true);
  const lease = decodeLease(await kv.get(LEASE_KEY));
  if (!lease?.token) throw new Error("lease");
  const host = startPaperHost(names, {});
  host.clock = () => t;
  host.warmupStored = true;
  host.leaseToken = lease.token;
  host.holderId = "holder";
  const payloads: number[] = [];
  const ownedFlush = kv.ownedFlush.bind(kv);
  kv.ownedFlush = async (leaseKey, token, nowMs, payload) => {
    payloads.push(Buffer.byteLength(payload));
    return ownedFlush(leaseKey, token, nowMs, payload);
  };
  const ownedSet = kv.ownedSet.bind(kv);
  let grouped = 0;
  kv.ownedSet = async (leaseKey, token, key, value, opts) => {
    if (key === HOT_KEY) {
      const body = JSON.parse(value) as { seq?: unknown };
      if (body.seq == null) grouped += 1;
    }
    return ownedSet(leaseKey, token, key, value, opts);
  };
  await persistSplit(kv, host);
  const era = host.redisEra;
  if (!era) throw new Error("era");
  expect(host.seqOverflow).toBe(0);
  expect(host.seqInvalid).toBe(0);
  const savedBaseline = host.saveBytes;
  const slots = 96;
  for (let day = 0; day < 14; day += 1) {
    const daySec = Math.floor(t / 1000);
    for (const productId of names) {
      for (let slot = 0; slot < slots; slot += 1) host.fifteen.push(fifteen(productId, daySec + slot * 900));
    }
    host.book.realizedUsd = day + 1;
    await persistSplit(kv, host);
    expect(host.redisEra).toBe(era);
    expect(host.seqOverflow).toBe(0);
    expect(host.seqInvalid).toBe(0);
    expect(host.book.incidents.some((item) => item.includes("1 MB") || item === "seq map overflow" || item === "seq invalid")).toBe(false);
    t += 86_400_000;
  }
  const write = host.saveBytes - savedBaseline;
  const hot = Buffer.byteLength((await kv.get(HOT_KEY)) ?? "");
  const reader = startPaperHost(names, {});
  reader.clock = () => t;
  const loaded = await loadSplit(kv, reader);
  if (!loaded) throw new Error("sim load");
  installPaperState(reader, loaded);
  const read = reader.readBytes;
  host.book.realizedUsd = 900;
  const mark = payloads.length;
  await persistSplit(kv, host);
  const heartbeat = payloads[mark] ?? 0;
  expect(host.redisEra).toBe(era);
  expect(host.seqOverflow).toBe(0);
  expect(payloads).toHaveLength(16);
  reader.readBytes = 0;
  const partialBody = await reloadSplit(kv, reader);
  if (!partialBody) throw new Error("sim reload");
  installPaperState(reader, partialBody);
  expect(reader.book.realizedUsd).toBe(900);
  return { hot, read, write, heartbeat, partial: reader.readBytes, grouped };
}

test("a realistic 14-day book on 27 names mints no era outside the first flush", async () => {
  const names = universeNames();
  expect(names).toHaveLength(27);
  const measured = await sim14(names);
  const hwm = Number(readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s+(\d+)/)?.[1] ?? 0);
  console.log(
    `t1 sim14 names=27 days=14 eras=1 seqOverflow=0 hot=${measured.hot} read=${measured.read} write=${measured.write} heartbeat=${measured.heartbeat} partial=${measured.partial} grouped=${measured.grouped} VmHWM_kB=${hwm}`,
  );
  expect(measured.hot).toBeGreaterThan(0);
  expect(measured.read).toBeGreaterThan(0);
  expect(measured.write).toBeGreaterThan(0);
  expect(measured.heartbeat).toBeGreaterThan(0);
}, 180_000);

test("tape keys stay unstamped and a 1200s holder lag matches a full load", async () => {
  const midnight = Date.parse("2026-10-13T00:00:00.000Z");
  const writerMs = midnight - 1200 * 1000;
  const readerMs = midnight;
  const kv = memoryKv(() => NOW);
  await seedLagBook(kv, writerMs);
  const reader = startPaperHost(PRODUCTS, {});
  reader.clock = () => readerMs;
  const warmed = await loadSplit(kv, reader);
  if (!warmed) throw new Error("warm");
  installPaperState(reader, warmed);
  const writer = startPaperHost(PRODUCTS, {});
  writer.clock = () => writerMs;
  writer.warmupStored = true;
  const loaded = await loadSplit(kv, writer);
  if (!loaded) throw new Error("writer");
  installPaperState(writer, loaded);
  const tomorrowMs = Math.floor(writerMs / 86_400_000) * 86_400_000 + 86_400_000;
  const startSec = Math.floor(tomorrowMs / 1000);
  writer.fifteen.push(fifteen("BTC-USD", startSec));
  const minute = Math.floor(writerMs / 1000 / 60) * 60 - 60;
  writer.trades.push({ productId: "BTC-USD", tsSec: minute + 5, price: 123.5, size: 0.25, side: "buy" });
  writer.book.realizedUsd = 9;
  const written = new Set<string>();
  const origSet = kv.set.bind(kv);
  kv.set = async (key, value, opts) => {
    written.add(key);
    return origSet(key, value, opts);
  };
  await persistSplit(kv, writer);
  kv.set = origSet;
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; base?: number; keySeq?: Record<string, number> };
  if (hot.seq == null || hot.base == null) throw new Error("stamp");
  expect(hot.base).not.toBe(hot.seq);
  const tapeWritten = [...written].filter((key) => key.startsWith("p6:tape:"));
  expect(tapeWritten.length).toBeGreaterThan(0);
  expect(tapeWritten).toContain(tapeKey(minute));
  for (const key of tapeWritten) expect(hot.keySeq?.[key]).toBeUndefined();
  expect([...written].some((key) => hot.keySeq?.[key] === hot.seq)).toBe(true);
  const body = await reloadSplit(kv, reader);
  if (!body) throw new Error("reload");
  installPaperState(reader, body);
  const twin = startPaperHost(PRODUCTS, {});
  twin.clock = () => readerMs;
  await oldReload(twin, kv, "standby");
  expect(snap(reader)).toEqual(snap(twin));
  expect(reader.fifteen.some((bar) => bar.productId === "BTC-USD" && bar.startSec === startSec)).toBe(true);
  expect(reader.trades.some((trade) => trade.tsSec === minute + 5)).toBe(twin.trades.some((trade) => trade.tsSec === minute + 5));
});

test("a missing era is not accepted and a changed bar is loaded in full", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as Record<string, unknown>;
  if (typeof hot.seq !== "number" || typeof hot.base !== "number") throw new Error("stamp");
  delete hot.era;
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  const loaded = await loadSplit(kv, host);
  if (!loaded) throw new Error("load");
  installPaperState(host, loaded);
  expect(host.redisPoison).toBe(false);
  expect(host.redisSeq).toBeNull();
  expect(host.redisSeenEra).toBeNull();
  const key = bar4hKey("ETH-USD");
  const ts = TODAY - 660 * 14_400;
  const rows = JSON.parse((await kv.get(key)) ?? "[]") as ReturnType<typeof ohlc>[];
  rows.push({ ...ohlc(ts), close: 64 });
  await kv.set(key, JSON.stringify(rows));
  const watch = watchMget(kv);
  const body = await reloadSplit(kv, host);
  watch.restore();
  if (!body) throw new Error("reload");
  installPaperState(host, body);
  expect(watch.full()).toBeGreaterThan(0);
  expect(host.fourBars.get("ETH-USD")?.some((bar) => bar.ts === ts && bar.close === 64)).toBe(true);
  expect(snap(host)).toEqual(snap(await twinOf(kv)));
});

test("an era that fails the hex pattern is not adopted", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { era?: string };
  hot.era = "not-a-valid-era";
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  host.warmupStored = true;
  const loaded = await loadSplit(kv, host);
  if (!loaded) throw new Error("load");
  installPaperState(host, loaded);
  expect(host.redisSeenEra).toBeNull();
  host.book.realizedUsd = 81;
  await persistSplit(kv, host);
  const published = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { era?: string; realizedUsd?: number };
  expect(published.realizedUsd).toBe(81);
  expect(published.era).toMatch(/^[0-9a-f]{16}$/);
  expect(published.era).not.toBe("not-a-valid-era");
});

test("a non-number keySeq value is poison and the changed bar is loaded", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const { standby, holder } = await warmStandby(kv);
  const key = bar4hKey("BTC-USD");
  const base = standby.redisBase;
  if (base == null) throw new Error("base");
  expect(standby.redisKeySeq?.get(key)).toBe(base);
  const hot = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; base?: number; keySeq?: Record<string, unknown> };
  if (hot.seq == null || hot.base == null) throw new Error("stamp");
  hot.keySeq = { ...(hot.keySeq ?? {}), [key]: "7" };
  await kv.set(HOT_KEY, JSON.stringify(hot));
  const ts = TODAY - 650 * 14_400;
  const rows = JSON.parse((await kv.get(key)) ?? "[]") as ReturnType<typeof ohlc>[];
  rows.push({ ...ohlc(ts), close: 65 });
  await kv.set(key, JSON.stringify(rows));
  const watch = watchMget(kv);
  await holder.reload();
  watch.restore();
  expect(standby.redisPoison).toBe(true);
  expect(watch.full()).toBeGreaterThan(0);
  expect(standby.fourBars.get("BTC-USD")?.some((bar) => bar.ts === ts && bar.close === 65)).toBe(true);
  expect(snap(standby)).toEqual(snap(await twinOf(kv)));
});

async function expectBasePoison(base: number): Promise<void> {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const stored = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; base?: number };
  if (typeof stored.seq !== "number") throw new Error("seq");
  stored.base = base;
  await kv.set(HOT_KEY, JSON.stringify(stored));
  const host = startPaperHost(PRODUCTS, {});
  host.clock = clock;
  host.warmupStored = true;
  const loaded = await loadSplit(kv, host);
  if (!loaded) throw new Error("load");
  installPaperState(host, loaded);
  expect(host.redisPoison).toBe(true);
  expect(host.redisSeq).toBeNull();
  host.book.realizedUsd = 77;
  await persistSplit(kv, host);
  const first = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: unknown; realizedUsd?: number; incidents?: string[] };
  expect(first.realizedUsd).toBe(77);
  expect(first.seq).toBeUndefined();
  expect(host.seqInvalid).toBe(1);
  expect(host.book.incidents).toContain("seq invalid");
}

test("a base above seq is poison and the book is still saved", async () => {
  const kv = memoryKv(clock);
  await seedBook(kv);
  const stored = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number };
  if (typeof stored.seq !== "number") throw new Error("seq");
  await expectBasePoison(stored.seq + 1000);
});

test("a huge base is poison and the book is still saved", async () => {
  await expectBasePoison(1e300);
});

async function expectClassStamp(key: string, mutate: (host: PaperHost) => void): Promise<void> {
  const kv = memoryKv(clock);
  await seedBook(kv);
  await saveSinceWarm(kv, clock, mutate);
  const published = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { seq?: number; keySeq?: Record<string, number> };
  expect(published.seq).toBeGreaterThan(0);
  expect(published.keySeq?.[key]).toBe(published.seq);
}

test("every written 4h key is stamped", async () => {
  const ts = TODAY - 640 * 14_400;
  await expectClassStamp(bar4hKey("BTC-USD"), (editor) => {
    const rows = editor.fourBars.get("BTC-USD") ?? [];
    rows.push({ ...ohlc(ts), close: 44 });
    editor.fourBars.set("BTC-USD", rows);
  });
});

test("every written 1h key is stamped", async () => {
  const ts = TODAY - 390 * 3_600;
  await expectClassStamp(bar1hKey("ETH-USD"), (editor) => {
    const rows = editor.hourWarm.get("ETH-USD") ?? [];
    rows.push({ ...ohlc(ts), close: 18 });
    editor.hourWarm.set("ETH-USD", rows);
  });
});

test("every written daily key is stamped", async () => {
  const ts = TODAY - 30 * 86_400;
  await expectClassStamp(d1Key("SOL-USD"), (editor) => {
    const rows = editor.dailyBars.get("SOL-USD") ?? [];
    rows.push({ ...ohlc(ts), close: 22 });
    editor.dailyBars.set("SOL-USD", rows);
  });
});

test("every written ring key is stamped", async () => {
  const ts = (Math.floor(NOW / 1000 / 60) * 60 - 180) * 1000;
  await expectClassStamp(ringKey("XRP-USD"), (editor) => {
    editor.book.mids.completed.push({ productId: "XRP-USD", ts, open: 5, high: 5, low: 5, close: 5, volumeBase: 1 });
  });
});

test("every written seed mark is stamped", async () => {
  await expectClassStamp(seedMarkKey("BTC-USD"), (editor) => {
    editor.seedMarks.set("BTC-USD", { oldestTs: 1, newestTs: 2, status: "cold", reason: "qa" });
  });
});

test("a 1200s lag keeps the next-day bar in keySeq after the heartbeat", async () => {
  await dayRoll(1200, 0);
});

test("a realistic 14-day book on 40 names reaches day 14 with no extra era", async () => {
  const names = universeNames(40);
  expect(names).toHaveLength(40);
  const measured = await sim14(names);
  const hwm = Number(readFileSync("/proc/self/status", "utf8").match(/VmHWM:\s+(\d+)/)?.[1] ?? 0);
  console.log(
    `t1 sim14 names=40 days=14 eras=1 seqOverflow=0 hot=${measured.hot} read=${measured.read} write=${measured.write} heartbeat=${measured.heartbeat} partial=${measured.partial} grouped=${measured.grouped} VmHWM_kB=${hwm}`,
  );
  expect(measured.hot).toBeGreaterThan(0);
  expect(measured.read).toBeGreaterThan(0);
  expect(measured.write).toBeGreaterThan(0);
  expect(measured.heartbeat).toBeGreaterThan(0);
}, 180_000);
