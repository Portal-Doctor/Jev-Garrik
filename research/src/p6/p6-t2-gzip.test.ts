import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import {
  bar15Key,
  HOT_MAX_BYTES,
  LAST_RUN_KEY,
  loadSplit,
  persistSplit,
  reloadSplit,
} from "./hot-store";
import { FOUR_KEEP, HOUR_KEEP, installPaperState, startPaperHost, type PaperHost } from "./paper-host";
import {
  decodeLease,
  HOT_KEY,
  LEASE_KEY,
  memoryKv,
  peekStored,
  plantStored,
  tryAcquire,
  VALUE_MAX_BYTES,
  type Kv,
} from "./relay";
import { decodeStored, encodeStored, GZIP_PREFIX, gzipFlushPayload, installStoredEncoder, redisFlushPayload, storesGzip, takeGzipMismatches } from "./redis-gzip";

const previousGzipWrites = process.env.P6_GZIP_WRITES;
process.env.P6_GZIP_WRITES = "1";

const NOW = Date.parse("2026-10-12T17:01:00Z");
const TODAY = Math.floor(NOW / 1000 / 86_400) * 86_400;

function clock(): number {
  return NOW;
}

function fifteen(productId: string, startSec: number) {
  return { productId, startSec, open: 1, high: 2, low: 1, close: 1.5, volume: 3 };
}

function ohlc(ts: number) {
  return { ts, open: 1, high: 2, low: 1, close: 1.5, volume: 3 };
}

function watchMget(kv: Kv): { full: () => number; restore: () => void } {
  const calls: string[][] = [];
  const base = kv.mget.bind(kv);
  kv.mget = async (keys) => {
    calls.push([...keys]);
    return base(keys);
  };
  return {
    full: () => calls.filter((keys) => keys.includes(HOT_KEY)).length,
    restore() {
      kv.mget = base;
    },
  };
}

test("gzip round trip restores hot and lastRun and leaves other keys plain", async () => {
  const json = JSON.stringify({ seq: 3, era: "0123456789abcdef", base: 3, keySeq: { "p6:acct": 3 }, realizedUsd: 4 });
  const stored = encodeStored(HOT_KEY, json);
  expect(storesGzip(HOT_KEY)).toBe(true);
  expect(storesGzip(LAST_RUN_KEY)).toBe(true);
  expect(storesGzip("p6:acct")).toBe(false);
  expect(stored.startsWith(GZIP_PREFIX)).toBe(true);
  expect(/^[\x00-\x7f]*$/.test(stored)).toBe(true);
  expect(decodeStored(HOT_KEY, stored)).toBe(json);
  expect(encodeStored("p6:bar15:BTC-USD:2026-10-12", json)).toBe(json);
  expect(decodeStored(HOT_KEY, json)).toBe(json);

  const payload = JSON.stringify({
    hot: json,
    extra: [
      { key: LAST_RUN_KEY, value: JSON.stringify({ end: 1 }) },
      { key: "p6:acct", value: JSON.stringify({ rev: 2, fromDay: "2026-10-17" }), nx: true },
    ],
    bars: [{ key: "p6:bar15:BTC-USD:2026-10-12", value: "[]" }],
  });
  const wire = gzipFlushPayload(payload);
  const body = JSON.parse(wire) as {
    hot: string;
    extra: { key: string; value: string; nx?: boolean }[];
    bars: { value: string }[];
  };
  expect(body.hot.startsWith(GZIP_PREFIX)).toBe(true);
  expect(decodeStored(HOT_KEY, body.hot)).toBe(json);
  expect(body.extra[0]!.value.startsWith(GZIP_PREFIX)).toBe(true);
  expect(decodeStored(LAST_RUN_KEY, body.extra[0]!.value)).toBe(JSON.stringify({ end: 1 }));
  expect(body.extra[1]!.value).toBe(JSON.stringify({ rev: 2, fromDay: "2026-10-17" }));
  expect(body.extra[1]!.nx).toBe(true);
  expect(body.bars[0]!.value).toBe("[]");
  const sent = redisFlushPayload(payload, VALUE_MAX_BYTES);
  expect(sent).toBe(wire);

  const kv = memoryKv(clock);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = clock;
  host.warmupStored = true;
  host.book.realizedUsd = 4;
  const startSec = Math.floor(NOW / 1000) - 900;
  host.fifteen.push(fifteen("BTC-USD", startSec));
  await persistSplit(kv, host);
  const hotStored = peekStored(kv, HOT_KEY);
  const hotLogical = await kv.get(HOT_KEY);
  expect(hotStored?.startsWith(GZIP_PREFIX)).toBe(true);
  expect(hotLogical?.startsWith("{")).toBe(true);
  expect(decodeStored(HOT_KEY, hotStored)).toBe(hotLogical);
  const lastStored = peekStored(kv, LAST_RUN_KEY);
  const lastLogical = await kv.get(LAST_RUN_KEY);
  expect(lastStored?.startsWith(GZIP_PREFIX)).toBe(true);
  expect(decodeStored(LAST_RUN_KEY, lastStored)).toBe(lastLogical);
  const barKey = bar15Key("BTC-USD", new Date(startSec * 1000).toISOString().slice(0, 10));
  const bar = peekStored(kv, barKey);
  expect(bar).toBeTruthy();
  expect(bar!.startsWith(GZIP_PREFIX)).toBe(false);
  const again = startPaperHost(["BTC-USD"], {});
  again.clock = clock;
  const loaded = await loadSplit(kv, again);
  expect(loaded?.realizedUsd).toBe(4);
  expect(loaded?.fifteen.some((row) => row.startSec === startSec)).toBe(true);
});

test("a legacy uncompressed hot and lastRun still load", async () => {
  const kv = memoryKv(clock);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = clock;
  host.warmupStored = true;
  host.book.realizedUsd = 7;
  await persistSplit(kv, host);
  const hot = await kv.get(HOT_KEY);
  const last = await kv.get(LAST_RUN_KEY);
  if (!hot || !last) throw new Error("missing");
  plantStored(kv, HOT_KEY, hot);
  plantStored(kv, LAST_RUN_KEY, last);
  expect(peekStored(kv, HOT_KEY)).toBe(hot);
  expect(peekStored(kv, LAST_RUN_KEY)).toBe(last);
  expect(hot.startsWith("{")).toBe(true);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  const loaded = await loadSplit(kv, reader);
  if (!loaded) throw new Error("load");
  expect(loaded.realizedUsd).toBe(7);
  expect(reader.redisSeq).not.toBeNull();
  expect(reader.redisSeenEra).toMatch(/^[0-9a-f]{16}$/);
  installPaperState(reader, loaded);
  reader.warmupStored = true;
  reader.book.realizedUsd = 8;
  await persistSplit(kv, reader);
  expect(peekStored(kv, HOT_KEY)?.startsWith(GZIP_PREFIX)).toBe(true);
  const upgraded = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { realizedUsd?: number };
  expect(upgraded.realizedUsd).toBe(8);
});

async function expectUnreadable(spoil: (stored: string) => string): Promise<void> {
  const kv = memoryKv(clock);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = clock;
  host.warmupStored = true;
  host.book.realizedUsd = 3;
  await persistSplit(kv, host);
  const good = peekStored(kv, HOT_KEY);
  if (!good?.startsWith(GZIP_PREFIX)) throw new Error("expected gzip");
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  const loaded = await loadSplit(kv, reader);
  if (!loaded) throw new Error("warm");
  installPaperState(reader, loaded);
  expect(reader.redisSeq).not.toBeNull();
  plantStored(kv, HOT_KEY, spoil(good));
  const watch = watchMget(kv);
  let threw = false;
  let body: unknown = "unread";
  try {
    body = await reloadSplit(kv, reader);
  } catch {
    threw = true;
  }
  watch.restore();
  expect(threw).toBe(false);
  expect(body).toBeNull();
  expect(watch.full()).toBeGreaterThan(0);
  expect(reader.book.realizedUsd).toBe(3);
  reader.book.realizedUsd = 11;
  let persistThrew = false;
  try {
    await persistSplit(kv, reader);
  } catch {
    persistThrew = true;
  }
  expect(persistThrew).toBe(false);
  const again = peekStored(kv, HOT_KEY);
  expect(again?.startsWith(GZIP_PREFIX)).toBe(true);
  expect(decodeStored(HOT_KEY, again)).toContain('"realizedUsd":11');
}

test("a corrupt gzip falls back to a full load and does not throw", async () => {
  await expectUnreadable(() => `${GZIP_PREFIX}!!!!`);
});

test("a truncated gzip falls back to a full load and does not throw", async () => {
  await expectUnreadable((stored) => {
    const buf = Buffer.from(stored.slice(GZIP_PREFIX.length), "base64");
    return GZIP_PREFIX + buf.subarray(0, Math.floor(buf.length / 2)).toString("base64");
  });
});

test("seq and era are read from the gunzipped hot", async () => {
  const kv = memoryKv(clock);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = clock;
  host.warmupStored = true;
  host.book.realizedUsd = 3;
  await persistSplit(kv, host);
  expect(peekStored(kv, HOT_KEY)?.startsWith(GZIP_PREFIX)).toBe(true);
  const standby = startPaperHost(["BTC-USD"], {});
  standby.clock = clock;
  const warmed = await loadSplit(kv, standby);
  if (!warmed) throw new Error("warm");
  installPaperState(standby, warmed);
  const era = standby.redisSeenEra;
  const seq = standby.redisSeq;
  expect(era).toMatch(/^[0-9a-f]{16}$/);
  expect(seq).toBeGreaterThan(0);
  const writer = startPaperHost(["BTC-USD"], {});
  writer.clock = clock;
  writer.warmupStored = true;
  const saved = await loadSplit(kv, writer);
  if (!saved) throw new Error("writer");
  installPaperState(writer, saved);
  writer.book.realizedUsd = 9;
  await persistSplit(kv, writer);
  expect(peekStored(kv, HOT_KEY)?.startsWith(GZIP_PREFIX)).toBe(true);
  const published = JSON.parse((await kv.get(HOT_KEY)) ?? "{}") as { era?: string; seq?: number; realizedUsd?: number };
  expect(published.era).toBe(era ?? undefined);
  expect(published.seq).toBeGreaterThan(seq ?? 0);
  expect(published.realizedUsd).toBe(9);
  const watch = watchMget(kv);
  const body = await reloadSplit(kv, standby);
  watch.restore();
  if (!body) throw new Error("reload");
  expect(watch.full()).toBe(0);
  expect(body.realizedUsd).toBe(9);
  expect(standby.redisSeenEra).toBe(era);
  expect(standby.redisSeq).toBe(published.seq ?? null);
});

test("the 256 KB hot cap is the uncompressed JSON", async () => {
  const kv = memoryKv(clock);
  const host = startPaperHost(["ETH-USD"], {});
  host.clock = clock;
  host.warmupStored = true;
  const startSec = Math.floor(NOW / 1000) - 900;
  host.fifteen.push(fifteen("ETH-USD", startSec));
  host.book.incidents.push("x".repeat(HOT_MAX_BYTES));
  await persistSplit(kv, host);
  expect(host.book.incidents.some((row) => row.includes("exceeds 256 KB"))).toBe(true);
  const logical = await kv.get(HOT_KEY);
  const stored = peekStored(kv, HOT_KEY);
  if (!logical || !stored) throw new Error("hot");
  expect(stored.startsWith(GZIP_PREFIX)).toBe(true);
  expect(Buffer.byteLength(logical)).toBeGreaterThan(HOT_MAX_BYTES);
  expect(Buffer.byteLength(stored)).toBeLessThan(HOT_MAX_BYTES);
  expect(Buffer.byteLength(stored)).toBeLessThan(Buffer.byteLength(logical));
  const barKey = bar15Key("ETH-USD", new Date(startSec * 1000).toISOString().slice(0, 10));
  expect(peekStored(kv, barKey)?.startsWith("[")).toBe(true);
});

test("writes stay plain when P6_GZIP_WRITES is off and a planted gz1 value still loads", async () => {
  delete process.env.P6_GZIP_WRITES;
  try {
    const kv = memoryKv(clock);
    const host = startPaperHost(["BTC-USD"], {});
    host.clock = clock;
    host.warmupStored = true;
    host.book.realizedUsd = 6;
    await persistSplit(kv, host);
    const stored = peekStored(kv, HOT_KEY);
    expect(stored?.startsWith("{")).toBe(true);
    expect(stored?.startsWith(GZIP_PREFIX)).toBe(false);
    const logical = await kv.get(HOT_KEY);
    expect(logical).toBe(stored);
    const gz = encodeStored(HOT_KEY, logical ?? "");
    plantStored(kv, HOT_KEY, gz);
    plantStored(kv, LAST_RUN_KEY, encodeStored(LAST_RUN_KEY, (await kv.get(LAST_RUN_KEY)) ?? "{}"));
    const reader = startPaperHost(["BTC-USD"], {});
    reader.clock = clock;
    const loaded = await loadSplit(kv, reader);
    expect(loaded?.realizedUsd).toBe(6);
    expect(peekStored(kv, HOT_KEY)).toBe(gz);
  } finally {
    process.env.P6_GZIP_WRITES = "1";
  }
});

test("a corrupting encoder stores plain JSON and logs the mismatch", async () => {
  takeGzipMismatches();
  const kv = memoryKv(clock);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = clock;
  host.warmupStored = true;
  host.book.realizedUsd = 2;
  installStoredEncoder(() => `${GZIP_PREFIX}!!!!`);
  try {
    await persistSplit(kv, host);
  } finally {
    installStoredEncoder(null);
  }
  const stored = peekStored(kv, HOT_KEY);
  expect(stored?.startsWith("{")).toBe(true);
  expect(JSON.parse(stored ?? "{}")).toMatchObject({ realizedUsd: 2 });
  expect(await kv.get(HOT_KEY)).toBe(stored);
  expect(host.book.incidents.some((row) => row === "gzip mismatch p6:hot")).toBe(true);
});

function universeNames(padTo = 0): string[] {
  const path = fileURLToPath(new URL("../../data/reports/universe-membership.json", import.meta.url));
  const membership = JSON.parse(readFileSync(path, "utf8")) as { members: { date: string; names: string[] }[] };
  const names = [...(membership.members[membership.members.length - 1]?.names ?? [])];
  while (names.length < padTo) names.push(`SYN-${String(names.length).padStart(2, "0")}-USD`);
  return names;
}

function bench(fn: () => void, n = 100): number {
  for (let i = 0; i < 5; i += 1) fn();
  const start = process.hrtime.bigint();
  for (let i = 0; i < n; i += 1) fn();
  return Number(process.hrtime.bigint() - start) / n / 1e6;
}

interface SizePair {
  logical: number;
  gzip: number;
}

function pair(logical: string | null, gzip: string | null): SizePair {
  return { logical: Buffer.byteLength(logical ?? ""), gzip: Buffer.byteLength(gzip ?? "") };
}

function watchFlush(kv: Kv): { logical: number; wire: number; hot: SizePair; last: SizePair; lastPayload: string; restore: () => void } {
  const owned = kv.ownedFlush.bind(kv);
  const ownedSet = kv.ownedSet.bind(kv);
  const stats = { logical: 0, wire: 0, hot: { logical: 0, gzip: 0 }, last: { logical: 0, gzip: 0 }, lastPayload: "" };
  let inFlush = false;
  kv.ownedFlush = async (leaseKey, token, nowMs, payload) => {
    stats.logical += Buffer.byteLength(payload);
    const wire = redisFlushPayload(payload, VALUE_MAX_BYTES);
    stats.wire += Buffer.byteLength(wire);
    stats.lastPayload = payload;
    const body = JSON.parse(payload) as { hot?: string; extra?: { key: string; value: string }[] };
    if (body.hot) {
      stats.hot.logical += Buffer.byteLength(body.hot);
      stats.hot.gzip += Buffer.byteLength(encodeStored(HOT_KEY, body.hot));
    }
    const last = body.extra?.find((row) => row.key === LAST_RUN_KEY)?.value;
    if (last) {
      stats.last.logical += Buffer.byteLength(last);
      stats.last.gzip += Buffer.byteLength(encodeStored(LAST_RUN_KEY, last));
    }
    inFlush = true;
    try {
      return await owned(leaseKey, token, nowMs, payload);
    } finally {
      inFlush = false;
    }
  };
  // Bar SETs and the unsequenced hot strip sit outside the EVAL. The hot SET inside ownedFlush is not a second Redis write.
  kv.ownedSet = async (leaseKey, token, key, value, opts) => {
    if (!inFlush) {
      stats.logical += Buffer.byteLength(value);
      stats.wire += Buffer.byteLength(encodeStored(key, value));
      if (key === HOT_KEY) {
        stats.hot.logical += Buffer.byteLength(value);
        stats.hot.gzip += Buffer.byteLength(encodeStored(key, value));
      }
    }
    return ownedSet(leaseKey, token, key, value, opts);
  };
  return {
    get logical() {
      return stats.logical;
    },
    get wire() {
      return stats.wire;
    },
    get hot() {
      return stats.hot;
    },
    get last() {
      return stats.last;
    },
    get lastPayload() {
      return stats.lastPayload;
    },
    restore() {
      kv.ownedFlush = owned;
      kv.ownedSet = ownedSet;
    },
  };
}

function watchRead(kv: Kv): { wire: number; reset: () => void; restore: () => void } {
  let wire = 0;
  const get = kv.get.bind(kv);
  const mget = kv.mget.bind(kv);
  const lists = kv.readLists.bind(kv);
  kv.get = async (key) => {
    const raw = peekStored(kv, key);
    if (raw) wire += Buffer.byteLength(raw);
    return get(key);
  };
  kv.mget = async (keys) => {
    const values = await mget(keys);
    for (const key of keys) {
      const raw = peekStored(kv, key);
      if (raw) wire += Buffer.byteLength(raw);
    }
    return values;
  };
  kv.readLists = async (keys) => {
    const rows = await lists(keys);
    for (const list of rows) for (const row of list) wire += Buffer.byteLength(row);
    return rows;
  };
  return {
    get wire() {
      return wire;
    },
    reset() {
      wire = 0;
    },
    restore() {
      kv.get = get;
      kv.mget = mget;
      kv.readLists = lists;
    },
  };
}

async function leasedHost(names: string[], kvClock: () => number, bookClock: () => number): Promise<{ kv: Kv; host: PaperHost }> {
  const kv = memoryKv(kvClock);
  expect(await tryAcquire(kv, "holder", kvClock() + 60 * 86_400_000, kvClock())).toBe(true);
  const lease = decodeLease(await kv.get(LEASE_KEY));
  if (!lease?.token) throw new Error("lease");
  const host = startPaperHost(names, {});
  host.clock = bookClock;
  host.warmupStored = true;
  host.leaseToken = lease.token;
  host.holderId = "holder";
  return { kv, host };
}

test("gzip sizes on the 27-name and 40-name books", async () => {
  const rows: Record<string, unknown>[] = [];
  for (const width of [27, 40] as const) {
    rows.push(await measurePlateau(width));
    rows.push(await measureSim(width));
  }
  for (const row of rows) console.log(`t2 ${JSON.stringify(row)}`);
  for (const row of rows) {
    const hot = row.hot as SizePair;
    const last = row.last as SizePair;
    expect(hot.gzip).toBeGreaterThan(0);
    expect(hot.gzip).toBeLessThan(hot.logical);
    expect(last.gzip).toBeLessThan(last.logical);
    expect(row.wireWrite as number).toBeLessThan(row.logicalWrite as number);
    expect(row.wireRead as number).toBeLessThan(row.logicalRead as number);
  }
}, 240_000);

async function measurePlateau(width: 27 | 40): Promise<Record<string, unknown>> {
  const names = universeNames(width);
  expect(names).toHaveLength(width);
  const { kv, host } = await leasedHost(names, clock, clock);
  const day0 = Math.floor(Date.parse("2025-11-10T00:00:00Z") / 1000);
  const dailyCount = Math.floor((TODAY - day0) / 86_400);
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
  const flush = watchFlush(kv);
  await persistSplit(kv, host);
  const opened = pair(await kv.get(HOT_KEY), peekStored(kv, HOT_KEY));
  host.persistedBars.clear();
  await persistSplit(kv, host);
  host.book.realizedUsd = 1;
  await persistSplit(kv, host);
  flush.restore();
  const hot = pair(await kv.get(HOT_KEY), peekStored(kv, HOT_KEY));
  const last = pair(await kv.get(LAST_RUN_KEY), peekStored(kv, LAST_RUN_KEY));
  const read = watchRead(kv);
  const reader = startPaperHost(names, {});
  reader.clock = clock;
  reader.readBytes = 0;
  read.reset();
  const loaded = await loadSplit(kv, reader);
  if (!loaded) throw new Error("plateau load");
  const logicalRead = reader.readBytes;
  const wireRead = read.wire;
  read.restore();
  const hotJson = (await kv.get(HOT_KEY)) ?? "";
  const lastJson = (await kv.get(LAST_RUN_KEY)) ?? "";
  const hotGz = peekStored(kv, HOT_KEY) ?? "";
  const lastGz = peekStored(kv, LAST_RUN_KEY) ?? "";
  const seqBody = JSON.parse(hotJson) as { keySeq?: Record<string, number> };
  return {
    fixture: "plateau",
    names: width,
    hotOpen: opened,
    keySeqBytes: Buffer.byteLength(JSON.stringify(seqBody.keySeq ?? {})),
    keySeqKeys: Object.keys(seqBody.keySeq ?? {}).length,
    hot,
    last,
    logicalWrite: flush.logical,
    wireWrite: flush.wire,
    hotWrite: flush.hot,
    lastWrite: flush.last,
    logicalRead,
    wireRead,
    gzipHotMs: bench(() => encodeStored(HOT_KEY, hotJson)),
    gunzipHotMs: bench(() => decodeStored(HOT_KEY, hotGz)),
    gzipLastMs: bench(() => encodeStored(LAST_RUN_KEY, lastJson)),
    gunzipLastMs: bench(() => decodeStored(LAST_RUN_KEY, lastGz)),
    flushRewriteMs: bench(() => redisFlushPayload(flush.lastPayload, VALUE_MAX_BYTES)),
  };
}

async function measureSim(width: 27 | 40): Promise<Record<string, unknown>> {
  const names = universeNames(width);
  const start = Date.parse("2026-10-01T00:00:00.000Z");
  let t = start;
  const { kv, host } = await leasedHost(names, () => start, () => t);
  const flush = watchFlush(kv);
  await persistSplit(kv, host);
  const openLogical = flush.logical;
  const openWire = flush.wire;
  const saveAtOpen = host.saveBytes;
  const slots = 96;
  for (let day = 0; day < 14; day += 1) {
    const daySec = Math.floor(t / 1000);
    for (const productId of names) {
      for (let slot = 0; slot < slots; slot += 1) host.fifteen.push(fifteen(productId, daySec + slot * 900));
    }
    host.book.realizedUsd = day + 1;
    await persistSplit(kv, host);
    t += 86_400_000;
  }
  const dayLogical = flush.logical - openLogical;
  const dayWire = flush.wire - openWire;
  const saveBytesDay = host.saveBytes - saveAtOpen;
  const hotJson = (await kv.get(HOT_KEY)) ?? "";
  const lastJson = (await kv.get(LAST_RUN_KEY)) ?? "";
  const hotGz = peekStored(kv, HOT_KEY) ?? "";
  const lastGz = peekStored(kv, LAST_RUN_KEY) ?? "";
  const hot = pair(hotJson, hotGz);
  const last = pair(lastJson, lastGz);
  const seqBody = JSON.parse(hotJson || "{}") as { keySeq?: Record<string, number> };
  const keySeqBytes = Buffer.byteLength(JSON.stringify(seqBody.keySeq ?? {}));
  const keySeqKeys = Object.keys(seqBody.keySeq ?? {}).length;
  const read = watchRead(kv);
  const reader = startPaperHost(names, {});
  reader.clock = () => t;
  reader.readBytes = 0;
  read.reset();
  const loaded = await loadSplit(kv, reader);
  if (!loaded) throw new Error("sim load");
  installPaperState(reader, loaded);
  const logicalRead = reader.readBytes;
  const wireRead = read.wire;
  const beforeBeat = flush.logical;
  const beforeBeatWire = flush.wire;
  host.book.realizedUsd = 900;
  await persistSplit(kv, host);
  const beatLogical = flush.logical - beforeBeat;
  const beatWire = flush.wire - beforeBeatWire;
  flush.restore();
  read.reset();
  reader.readBytes = 0;
  const partial = await reloadSplit(kv, reader);
  if (!partial) throw new Error("sim reload");
  const logicalPartial = reader.readBytes;
  const wirePartial = read.wire;
  read.restore();
  const hotAfter = pair(await kv.get(HOT_KEY), peekStored(kv, HOT_KEY));
  return {
    fixture: "sim14",
    names: width,
    keySeqBytes,
    keySeqKeys,
    hot,
    hotAfter,
    last,
    dayLogical,
    dayWire,
    saveBytesDay,
    beatLogical,
    beatWire,
    logicalWrite: flush.logical,
    wireWrite: flush.wire,
    hotWrite: flush.hot,
    lastWrite: flush.last,
    logicalRead,
    wireRead,
    logicalPartial,
    wirePartial,
    gzipHotMs: bench(() => encodeStored(HOT_KEY, hotJson)),
    gunzipHotMs: bench(() => decodeStored(HOT_KEY, hotGz)),
    gzipLastMs: bench(() => encodeStored(LAST_RUN_KEY, lastJson)),
    gunzipLastMs: bench(() => decodeStored(LAST_RUN_KEY, lastGz)),
    flushRewriteMs: bench(() => redisFlushPayload(flush.lastPayload, VALUE_MAX_BYTES)),
  };
}
