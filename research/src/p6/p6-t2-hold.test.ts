import { expect, test } from "bun:test";
import { ACCT_KEY, corruptHotKey, CORRUPT_HOT_TTL_MS, FILLS_KEY, hotResumeToken, LAST_RUN_KEY, liftHold, loadSplit, markHotRestored, noteKvRead, persistSplit, reloadSplit, tryResumeEntries, writeThroughBook } from "./hot-store";
import { EQ_FIRST_KEY } from "./pnl-block";
import { acceptRestBar, installPaperState, startPaperHost } from "./paper-host";
import { beginWireAccount, decodeLease, endWireAccount, HOT_KEY, memoryKv, peekStored, plantStored, takeListWire, tryAcquire } from "./relay";
import { hostHolder } from "./vercel-live";
import { classifyStored, encodeStored, GZIP_PREFIX } from "./redis-gzip";

const NOW = Date.parse("2026-10-12T17:01:00Z");

function clock(): number {
  return NOW;
}

function hostOf(kvClock: () => number = clock) {
  const kv = memoryKv(kvClock);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = clock;
  host.warmupStored = true;
  host.book.realizedUsd = 4;
  return { kv, host };
}

async function storedHot(): Promise<{ kv: ReturnType<typeof memoryKv>; raw: string }> {
  const { kv, host } = hostOf();
  await persistSplit(kv, host);
  const logical = await kv.get(HOT_KEY);
  if (!logical) throw new Error("hot");
  const raw = encodeStored(HOT_KEY, logical);
  plantStored(kv, HOT_KEY, raw);
  return { kv, raw };
}

test("a fresh load of a corrupt gz1 hot holds, logs, and does not rewrite", async () => {
  const { kv, raw } = await storedHot();
  plantStored(kv, HOT_KEY, `${GZIP_PREFIX}!!!!`);
  const bar = "p6:bar15:BTC-USD:2026-10-12";
  plantStored(kv, bar, "[]");
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.leaseToken = "holder";
  reader.holdSleep = async () => {};
  reader.runStartedMs = 50;
  const body = await loadSplit(kv, reader);
  expect(body).toBeNull();
  expect(reader.entriesHeld).toBe(true);
  expect(reader.book.realizedUsd).toBe(0);
  expect(reader.fifteen).toHaveLength(0);
  expect(reader.book.incidents.includes("hot unreadable")).toBe(true);
  expect(reader.hotHold?.attempts).toBe(3);
  expect(reader.hotHold?.header).toBe("gz1:");
  expect(reader.runStartedMs).toBe(50);
  expect(peekStored(kv, HOT_KEY)).toBe(`${GZIP_PREFIX}!!!!`);
  expect(peekStored(kv, bar)).toBe("[]");
  await persistSplit(kv, reader);
  expect(peekStored(kv, HOT_KEY)).toBe(`${GZIP_PREFIX}!!!!`);
  const logged = JSON.parse((await kv.get("p6:incidents")) ?? "[]") as { kind?: string; bytes?: number; attempts?: number }[];
  expect(logged.some((row) => row.kind === "hot unreadable" && row.bytes === Buffer.byteLength(`${GZIP_PREFIX}!!!!`) && row.attempts === 3)).toBe(true);
  void raw;
});

test("a fresh load of a truncated gz1 hot holds and leaves the bytes", async () => {
  const { kv, raw } = await storedHot();
  const torn = GZIP_PREFIX + Buffer.from(raw.slice(GZIP_PREFIX.length), "base64").subarray(0, 8).toString("base64");
  plantStored(kv, HOT_KEY, torn);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.leaseToken = "holder";
  reader.holdSleep = async () => {};
  expect(await loadSplit(kv, reader)).toBeNull();
  expect(reader.entriesHeld).toBe(true);
  expect(reader.hotHold?.header).toBe("gz1:");
  expect(peekStored(kv, HOT_KEY)).toBe(torn);
  await persistSplit(kv, reader);
  expect(peekStored(kv, HOT_KEY)).toBe(torn);
});

test("a truncated hot that succeeds on retry does not incident", async () => {
  const { kv, raw } = await storedHot();
  plantStored(kv, HOT_KEY, `${GZIP_PREFIX}!!!!`);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.leaseToken = "holder";
  let slept = 0;
  reader.holdSleep = async () => {
    slept += 1;
    if (slept === 1) plantStored(kv, HOT_KEY, raw);
  };
  const body = await loadSplit(kv, reader);
  expect(body?.realizedUsd).toBe(4);
  expect(slept).toBe(1);
  expect(reader.entriesHeld).toBe(false);
  expect(reader.hotHold).toBeNull();
  expect(reader.book.incidents.includes("hot unreadable")).toBe(false);
  expect(await kv.get("p6:incidents")).toBeNull();
});

test("a standby warm schedules a re-read and a clean reload clears the hold", async () => {
  const { kv, raw } = await storedHot();
  plantStored(kv, HOT_KEY, `${GZIP_PREFIX}!!!!`);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  let slept = 0;
  reader.holdSleep = async () => {
    slept += 1;
  };
  expect(await loadSplit(kv, reader)).toBeNull();
  expect(slept).toBe(0);
  expect(reader.hotReread).toBe(true);
  expect(reader.entriesHeld).toBe(true);
  expect(reader.hotHold).toBeNull();
  expect(reader.book.incidents.includes("hot unreadable")).toBe(false);
  expect(await kv.get("p6:incidents")).toBeNull();
  // H15: a clean post-lease reload clears the standby hold. R8: no cached sequence still reloads.
  plantStored(kv, HOT_KEY, raw);
  reader.leaseToken = "holder";
  const body = await reloadSplit(kv, reader);
  expect(body?.realizedUsd).toBe(4);
  expect(slept).toBe(0);
  expect(reader.entriesHeld).toBe(false);
  expect(reader.hotReread).toBe(false);
  expect(reader.hotHold).toBeNull();
  expect(reader.book.incidents.includes("hot unreadable")).toBe(false);
  expect(await kv.get("p6:incidents")).toBeNull();
  reader.book.realizedUsd = 9;
  reader.leaseToken = null;
  await persistSplit(kv, reader);
  const written = await kv.get(HOT_KEY);
  expect(written).toContain('"realizedUsd":9');
  expect(peekStored(kv, HOT_KEY)).not.toBe(`${GZIP_PREFIX}!!!!`);
});

test("a standby hold that is still unreadable after the lease declares the incident", async () => {
  const { kv } = await storedHot();
  plantStored(kv, HOT_KEY, `${GZIP_PREFIX}!!!!`);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.holdSleep = async () => {};
  expect(await loadSplit(kv, reader)).toBeNull();
  expect(reader.hotHold).toBeNull();
  reader.leaseToken = "holder";
  expect(await reloadSplit(kv, reader)).toBeNull();
  expect(reader.entriesHeld).toBe(true);
  expect(reader.hotReread).toBe(false);
  expect(reader.hotHold?.attempts).toBe(3);
  expect(reader.book.incidents.includes("hot unreadable")).toBe(true);
  const logged = JSON.parse((await kv.get("p6:incidents")) ?? "[]") as { kind?: string }[];
  expect(logged.some((row) => row.kind === "hot unreadable")).toBe(true);
  reader.book.realizedUsd = 9;
  await persistSplit(kv, reader);
  expect(peekStored(kv, HOT_KEY)).toBe(`${GZIP_PREFIX}!!!!`);
  expect(await kv.get(HOT_KEY)).toBeNull();
});

test("a declared hold is not cleared by a later readable hot", async () => {
  const { kv, raw } = await storedHot();
  plantStored(kv, HOT_KEY, `${GZIP_PREFIX}!!!!`);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.leaseToken = "holder";
  reader.holdSleep = async () => {};
  expect(await loadSplit(kv, reader)).toBeNull();
  const incidentId = reader.hotHold?.incidentId;
  expect(incidentId).toBeTruthy();
  expect(reader.hotReread).toBe(false);
  plantStored(kv, HOT_KEY, raw);
  const body = await reloadSplit(kv, reader);
  expect(body?.realizedUsd).toBe(4);
  expect(reader.entriesHeld).toBe(true);
  expect(reader.hotHold?.incidentId).toBe(incidentId);
  expect(reader.hotRewrite).toBe(false);
  expect(reader.hotReread).toBe(false);
  reader.book.realizedUsd = 9;
  reader.leaseToken = null;
  await persistSplit(kv, reader);
  const logical = await kv.get(HOT_KEY);
  expect(logical ?? "").not.toContain('"realizedUsd":9');
});

test("an unreadable lastRun is not a first run and the next flush may rewrite it", async () => {
  const { kv, host } = hostOf();
  await persistSplit(kv, host);
  const last = await kv.get(LAST_RUN_KEY);
  if (!last) throw new Error("last");
  plantStored(kv, LAST_RUN_KEY, `${GZIP_PREFIX}!!!!`);
  const paper = JSON.stringify({ ts: 10, equity: 1, realized: 0, unrealized: 0, fees: 0, spreadSlip: 0 });
  plantStored(kv, EQ_FIRST_KEY, paper);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.leaseToken = "holder";
  reader.holdSleep = async () => {};
  reader.runStartedMs = 111;
  reader.runBaseFills = 4;
  reader.completedRun = { end: 5, cmds: 2, outcome: "deadline" };
  const body = await loadSplit(kv, reader);
  if (!body) throw new Error("load");
  installPaperState(reader, body);
  expect(reader.entriesHeld).toBe(false);
  expect(reader.lastRunUnreadable).toBe(true);
  expect(reader.runStartedMs).toBe(111);
  expect(reader.runBaseFills).toBe(4);
  expect(reader.completedRun).toEqual({ end: 5, cmds: 2, outcome: "deadline" });
  expect(peekStored(kv, EQ_FIRST_KEY)).toBe(paper);
  expect(peekStored(kv, LAST_RUN_KEY)).toBe(`${GZIP_PREFIX}!!!!`);
  expect(reader.book.incidents.includes("lastRun unreadable")).toBe(true);
  reader.leaseToken = null;
  await persistSplit(kv, reader);
  const rewritten = JSON.parse((await kv.get(LAST_RUN_KEY)) ?? "null") as { completed?: { end: number; cmds: number; outcome: string } | null };
  expect(rewritten.completed).toEqual({ end: 5, cmds: 2, outcome: "deadline" });
  expect(peekStored(kv, EQ_FIRST_KEY)).toBe(paper);
});

test("a flush remembers completed so a later unreadable lastRun is not rewritten as null", async () => {
  const { kv, host } = hostOf();
  host.runOutcome = "deadline";
  await persistSplit(kv, host);
  const before = JSON.parse((await kv.get(LAST_RUN_KEY)) ?? "null") as { completed?: { end: number; cmds: number; outcome: string } | null };
  const kept = before.completed ?? null;
  if (!kept) throw new Error("completed");
  expect(host.completedRun).toEqual(kept);
  plantStored(kv, LAST_RUN_KEY, `${GZIP_PREFIX}!!!!`);
  host.leaseToken = "holder";
  host.holdSleep = async () => {};
  const body = await loadSplit(kv, host);
  if (!body) throw new Error("load");
  installPaperState(host, body);
  expect(host.lastRunUnreadable).toBe(true);
  expect(host.completedRun).toEqual(kept);
  host.runOutcome = "running";
  host.leaseToken = null;
  await persistSplit(kv, host);
  const rewritten = JSON.parse((await kv.get(LAST_RUN_KEY)) ?? "null") as { completed?: { end: number; cmds: number; outcome: string } | null };
  expect(rewritten.completed).toEqual(kept);
});

test("plain JSON and gz1 hot both load", async () => {
  const { kv, host } = hostOf();
  delete process.env.P6_GZIP_WRITES;
  await persistSplit(kv, host);
  expect(peekStored(kv, HOT_KEY)?.startsWith("{")).toBe(true);
  const plain = startPaperHost(["BTC-USD"], {});
  plain.clock = clock;
  const plainBody = await loadSplit(kv, plain);
  expect(plainBody?.realizedUsd).toBe(4);
  const logical = await kv.get(HOT_KEY);
  plantStored(kv, HOT_KEY, encodeStored(HOT_KEY, logical ?? ""));
  const gz = startPaperHost(["BTC-USD"], {});
  gz.clock = clock;
  const gzBody = await loadSplit(kv, gz);
  expect(gzBody?.realizedUsd).toBe(4);
});

test("corrupt acct and eq:first are not recreated", async () => {
  const { kv, host } = hostOf();
  await persistSplit(kv, host);
  plantStored(kv, ACCT_KEY, "not-json");
  plantStored(kv, EQ_FIRST_KEY, `${GZIP_PREFIX}!!!!`);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.leaseToken = "holder";
  reader.holdSleep = async () => {};
  const body = await loadSplit(kv, reader);
  if (!body) throw new Error("load");
  installPaperState(reader, body);
  expect(reader.acctRepair).toBe(false);
  expect(reader.acctUnreadable).toBe(true);
  expect(reader.eqFirstUnreadable).toBe(true);
  expect(reader.entriesHeld).toBe(false);
  expect(peekStored(kv, ACCT_KEY)).toBe("not-json");
  expect(peekStored(kv, EQ_FIRST_KEY)).toBe(`${GZIP_PREFIX}!!!!`);
  reader.leaseToken = null;
  await persistSplit(kv, reader);
  expect(peekStored(kv, ACCT_KEY)).toBe("not-json");
  expect(peekStored(kv, EQ_FIRST_KEY)).toBe(`${GZIP_PREFIX}!!!!`);
});

test("hold lifts only through the restore hook", async () => {
  const { kv } = await storedHot();
  plantStored(kv, HOT_KEY, `${GZIP_PREFIX}!!!!`);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.leaseToken = "holder";
  reader.holdSleep = async () => {};
  await loadSplit(kv, reader);
  expect(reader.entriesHeld).toBe(true);
  expect(liftHold(reader)).toBe(false);
  expect(reader.entriesHeld).toBe(true);
  markHotRestored(reader);
  expect(reader.entriesHeld).toBe(true);
  expect(reader.hotHold).not.toBeNull();
  expect(liftHold(reader)).toBe(true);
  expect(reader.entriesHeld).toBe(false);
  expect(reader.hotHold).toBeNull();
});

test("manual resume refuses a bad token and a match copies, overwrites, and stays paused", async () => {
  let now = NOW;
  const kv = memoryKv(() => now);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => now;
  host.warmupStored = true;
  host.book.realizedUsd = 4;
  await persistSplit(kv, host);
  const logical = await kv.get(HOT_KEY);
  const raw = encodeStored(HOT_KEY, logical ?? "");
  const torn = `${GZIP_PREFIX}!!!!`;
  plantStored(kv, HOT_KEY, torn);
  const bar = "p6:bar15:BTC-USD:2026-10-12";
  plantStored(kv, bar, "[1]");
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = () => now;
  reader.leaseToken = "holder";
  reader.holdSleep = async () => {};
  await loadSplit(kv, reader);
  const hold = reader.hotHold;
  if (!hold) throw new Error("hold");
  expect(await tryResumeEntries(kv, reader, "nope:1:aa")).toBe("refused");
  expect(await tryResumeEntries(kv, reader, `${hold.incidentId}:${hold.bytes}:deadbeef`)).toBe("refused");
  expect(await tryResumeEntries(kv, reader, `${hold.incidentId}:${hold.bytes + 1}:${hotResumeToken(hold).split(":")[2]}`)).toBe("refused");
  expect(peekStored(kv, corruptHotKey(hold.incidentId))).toBeNull();
  expect(peekStored(kv, HOT_KEY)).toBe(torn);
  expect(await tryResumeEntries(kv, reader, `${hotResumeToken(hold)}:extra`)).toBe("refused");
  expect(peekStored(kv, corruptHotKey(hold.incidentId))).toBeNull();
  expect(await tryResumeEntries(kv, reader, hotResumeToken(hold))).toBe("authorized");
  expect(peekStored(kv, corruptHotKey(hold.incidentId))).toBe(torn);
  expect(reader.entriesHeld).toBe(true);
  now = NOW + CORRUPT_HOT_TTL_MS - 1;
  expect(peekStored(kv, corruptHotKey(hold.incidentId))).toBe(torn);
  reader.leaseToken = null;
  await persistSplit(kv, reader);
  const written = peekStored(kv, HOT_KEY);
  expect(written?.startsWith("{")).toBe(true);
  expect(written).not.toBe(torn);
  const era = JSON.parse(written ?? "{}") as { era?: string };
  expect(era.era).toMatch(/^[0-9a-f]{16}$/);
  expect(peekStored(kv, bar)).toBe("[1]");
  expect(reader.entriesHeld).toBe(true);
  now = NOW + CORRUPT_HOT_TTL_MS;
  expect(await kv.get(corruptHotKey(hold.incidentId))).toBeNull();
  void raw;
});

test("persist applies the resume token before it refuses a hold", async () => {
  const { kv } = await storedHot();
  plantStored(kv, HOT_KEY, `${GZIP_PREFIX}!!!!`);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.leaseToken = "holder";
  reader.holdSleep = async () => {};
  await loadSplit(kv, reader);
  const hold = reader.hotHold;
  if (!hold) throw new Error("hold");
  const previous = process.env.P6_RESUME_ENTRIES;
  process.env.P6_RESUME_ENTRIES = hotResumeToken(hold);
  try {
    reader.leaseToken = null;
    await persistSplit(kv, reader);
  } finally {
    if (previous === undefined) delete process.env.P6_RESUME_ENTRIES;
    else process.env.P6_RESUME_ENTRIES = previous;
  }
  const written = await kv.get(HOT_KEY);
  expect(written?.startsWith("{")).toBe(true);
  expect(peekStored(kv, corruptHotKey(hold.incidentId))).toBe(`${GZIP_PREFIX}!!!!`);
  expect(reader.entriesHeld).toBe(true);
  expect(reader.hotRewrite).toBe(true);
});

test("a bad gzip is unreadable and get does not return the stored bytes", async () => {
  const torn = `${GZIP_PREFIX}!!!!`;
  const row = classifyStored(HOT_KEY, torn);
  expect(row.tag).toBe("unreadable");
  if (row.tag === "unreadable") {
    expect(row.header).toBe("gz1:");
    expect(row.bytes).toBe(Buffer.byteLength(torn));
  }
  const { kv, raw } = await storedHot();
  const logical = await kv.get(HOT_KEY);
  plantStored(kv, HOT_KEY, raw);
  expect(await kv.get(HOT_KEY)).toBe(logical);
  expect((await kv.read(HOT_KEY)).tag).toBe("value");
  plantStored(kv, HOT_KEY, torn);
  expect(await kv.get(HOT_KEY)).toBeNull();
  expect((await kv.read(HOT_KEY)).tag).toBe("unreadable");
  expect(await tryResumeEntries(kv, startPaperHost(["BTC-USD"], {}), "a:1:b")).toBe("absent");
});

test("a fresh process does not overwrite an unreadable lastRun with completed null", async () => {
  const { kv, host } = hostOf();
  host.runOutcome = "deadline";
  await persistSplit(kv, host);
  const logical = JSON.parse((await kv.get(LAST_RUN_KEY)) ?? "null") as { completed?: { outcome?: string } | null };
  expect(logical.completed?.outcome).toBe("deadline");
  const torn = `${GZIP_PREFIX}!!!!`;
  plantStored(kv, LAST_RUN_KEY, torn);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.leaseToken = "holder";
  reader.holdSleep = async () => {};
  const body = await loadSplit(kv, reader);
  if (!body) throw new Error("load");
  installPaperState(reader, body);
  expect(reader.lastRunUnreadable).toBe(true);
  expect(reader.completedRun).toBeNull();
  reader.leaseToken = null;
  await persistSplit(kv, reader);
  expect(peekStored(kv, LAST_RUN_KEY)).toBe(torn);
  expect(await kv.get(LAST_RUN_KEY)).toBeNull();
});

test("a held book does not queue entries", () => {
  const startSec = Math.floor(NOW / 1000) - 960;
  const nowSec = startSec + 900;
  const nowMs = nowSec * 1000 + 5_000;
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = () => nowMs;
  host.entriesHeld = true;
  host.generatedSec = nowSec;
  host.generated = {
    entries: [
      {
        kind: "x1",
        classId: "A",
        productId: "BTC-USD",
        tsMs: nowMs,
        nextOpen: 1,
        stop: 1,
        target: null,
        dailyAtr: 1,
        priorDailyCloses: [],
        signalDate: "2026-10-12",
      },
    ],
    weeks: [],
    atrByProduct: new Map(),
  };
  acceptRestBar(host, { productId: "BTC-USD", startSec, open: 1, high: 1, low: 1, close: 1, volume: 1 });
  expect(host.queued.size).toBe(0);
});

test("a held book does not cold-reset or apply due bars", async () => {
  const previous = process.env.P6_RESET_COLD;
  process.env.P6_RESET_COLD = "1";
  try {
    const kv = memoryKv(clock);
    expect(await tryAcquire(kv, "K", NOW + 3_600_000, NOW)).toBe(true);
    const host = startPaperHost(["BTC-USD"], {});
    host.clock = clock;
    host.leaseToken = decodeLease(await kv.get("p6:lease"))?.token ?? null;
    host.seedMarks.set("BTC-USD", { oldestTs: 1, newestTs: 2, status: "cold", reason: "short" });
    host.entriesHeld = true;
    const holder = hostHolder(host, kv, [], "K");
    await holder.resetCold();
    expect(host.seedMarks.get("BTC-USD")?.status).toBe("cold");
    const startSec = Math.floor(NOW / 1000) - 1_800;
    const due = hostHolder(host, kv, [{ productId: "BTC-USD", startSec, open: 1, high: 1, low: 1, close: 2, volume: 1 }], "K");
    expect(await due.applyDueBars()).toEqual([]);
    expect(host.fifteen.some((bar) => bar.startSec === startSec)).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.P6_RESET_COLD;
    else process.env.P6_RESET_COLD = previous;
  }
});

test("a held book does not write fills through", async () => {
  const kv = memoryKv(clock);
  expect(await tryAcquire(kv, "K", NOW + 3_600_000, NOW)).toBe(true);
  const host = startPaperHost(["BTC-USD"], {});
  host.clock = clock;
  host.kv = kv;
  host.leaseToken = decodeLease(await kv.get("p6:lease"))?.token ?? null;
  host.entriesHeld = true;
  host.book.legs.push({
    id: "f1",
    productId: "BTC-USD",
    classId: "A",
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
  await writeThroughBook(kv, host);
  expect(peekStored(kv, FILLS_KEY)).toBeNull();
  expect(host.fillStored).toBe(0);
});

test("an unreadable hot returns before ring and lastRun reads", async () => {
  const { kv } = await storedHot();
  plantStored(kv, HOT_KEY, `${GZIP_PREFIX}!!!!`);
  plantStored(kv, LAST_RUN_KEY, `${GZIP_PREFIX}!!!!`);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.leaseToken = "holder";
  reader.holdSleep = async () => {};
  let lists = 0;
  const orig = kv.readLists.bind(kv);
  kv.readLists = async (keys) => {
    lists += 1;
    return orig(keys);
  };
  expect(await loadSplit(kv, reader)).toBeNull();
  expect(lists).toBe(0);
  expect(reader.lastRunUnreadable).toBe(false);
});

test("a clean retry clears a standby hold that was already set", async () => {
  const { kv, raw } = await storedHot();
  plantStored(kv, HOT_KEY, `${GZIP_PREFIX}!!!!`);
  const reader = startPaperHost(["BTC-USD"], {});
  reader.clock = clock;
  reader.leaseToken = "holder";
  reader.entriesHeld = true;
  reader.hotReread = true;
  let slept = 0;
  reader.holdSleep = async () => {
    slept += 1;
    if (slept === 1) plantStored(kv, HOT_KEY, raw);
  };
  const body = await loadSplit(kv, reader);
  expect(body?.realizedUsd).toBe(4);
  expect(slept).toBe(1);
  expect(reader.entriesHeld).toBe(false);
  expect(reader.hotReread).toBe(false);
  expect(reader.hotHold).toBeNull();
});

test("wire accounting skips incident keys and counts an unreadable read and a list", async () => {
  const kv = memoryKv(clock);
  beginWireAccount(kv);
  await kv.set("p6:bar15:BTC-USD:2026-10-12", "[]");
  await kv.set("p6:incidents", "[1]");
  await kv.set("p6:hot:corrupt:abc", "raw");
  expect(endWireAccount(kv)).toBe(Buffer.byteLength("[]"));
  await kv.set("p6:ring:BTC-USD", JSON.stringify(["abcd"]));
  await kv.readLists(["p6:ring:BTC-USD"]);
  expect(takeListWire(kv)).toBe(Buffer.byteLength(JSON.stringify(["abcd"])));
  plantStored(kv, HOT_KEY, `${GZIP_PREFIX}!!!!`);
  const host = startPaperHost(["BTC-USD"], {});
  const row = await kv.read(HOT_KEY);
  noteKvRead(host, row);
  expect(row.tag).toBe("unreadable");
  expect(host.wireReadBytes).toBe(Buffer.byteLength(`${GZIP_PREFIX}!!!!`));
  expect(await kv.mget([HOT_KEY])).toEqual([null]);
});
