import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { HANDOVER_MICRO_MS } from "./amendment-v6";
import type { Position } from "./engine";
import { bar15Key, bar4hKey, HOT_MAX_BYTES, loadSplit, persistSplit } from "./hot-store";
import { attachMemberCloses, FOUR_KEEP, HOUR_KEEP, installPaperState, startPaperHost, type PaperHost } from "./paper-host";
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
  expect(redisLogLine(host)).toBe(`redis cmds=4, bytes=9, readBytes=${Buffer.byteLength(hot) + Buffer.byteLength(four)}, duplicates=1`);
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
  const parsed = JSON.parse(stored) as { seq?: number; keySeq?: Record<string, number> };
  const keySeq = parsed.keySeq ?? {};
  const rest = { ...parsed } as { seq?: number; keySeq?: unknown };
  delete rest.seq;
  delete rest.keySeq;
  const hotBefore = Buffer.byteLength(JSON.stringify(rest));
  const hotAfter = Buffer.byteLength(stored);
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
  countGets = true;
  await persistSplit(kv, host);
  countGets = false;
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
