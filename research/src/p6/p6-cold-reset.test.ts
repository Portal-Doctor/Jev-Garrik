import { expect, test } from "bun:test";
import { loadSplit } from "./hot-store";
import { coldResetEnabled, seedMarkKey, SEED_CURSOR_KEY, stageColdReset, startPaperHost, type PaperHost, type SeedMark } from "./paper-host";
import { decodeLease, HOT_KEY, LEASE_KEY, memoryKv, runInvocation, tryAcquire } from "./relay";
import { hostHolder } from "./vercel-live";

const NOW = Date.parse("2026-10-15T18:00:00.000Z");
const COLD = ["NEAR-USD", "SUI-USD", "ZEC-USD"];
const WARM = ["ETH-USD", "SOL-USD"];

function mark(status: "cold" | "warm"): SeedMark {
  return { oldestTs: 1, newestTs: 2, status, reason: status === "cold" ? "hole" : "seeded" };
}

function hostFor(ids: readonly string[]): PaperHost {
  const host = startPaperHost(ids, {});
  host.clock = () => NOW;
  host.products = [...ids];
  host.shards = [];
  host.openSockets = [];
  host.seedCursor = { order: [...ids], idx: 0, runId: "seed", retry: ["ZEC-USD"] };
  return host;
}

async function hold(kv: ReturnType<typeof memoryKv>, self = "cron") {
  expect(await tryAcquire(kv, self, NOW + 1_800_000, NOW)).toBe(true);
  const lease = decodeLease(await kv.get(LEASE_KEY));
  expect(lease?.token).toBeTruthy();
  return lease!;
}

async function plant(host: PaperHost, kv: ReturnType<typeof memoryKv>) {
  for (const id of COLD) {
    host.seedMarks.set(id, mark("cold"));
    host.cold.add(id);
    await kv.set(seedMarkKey(id), JSON.stringify(mark("cold")));
  }
  for (const id of WARM) {
    host.seedMarks.set(id, mark("warm"));
    host.fourFlushed.add(id);
    await kv.set(seedMarkKey(id), JSON.stringify(mark("warm")));
  }
}

async function cursorOf(kv: ReturnType<typeof memoryKv>) {
  return JSON.parse((await kv.get(SEED_CURSOR_KEY)) ?? "null") as { retry?: string[]; coldReset?: boolean; runId?: string } | null;
}

test("cold reset is armed only by P6_RESET_COLD=1", () => {
  expect(coldResetEnabled({})).toBe(false);
  expect(coldResetEnabled({ P6_RESET_COLD: "" })).toBe(false);
  expect(coldResetEnabled({ P6_RESET_COLD: "0" })).toBe(false);
  expect(coldResetEnabled({ P6_RESET_COLD: "true" })).toBe(false);
  expect(coldResetEnabled({ P6_RESET_COLD: "1" })).toBe(true);
});

test("only the live cold marks are cleared, queued, and persisted", async () => {
  const previous = process.env.P6_RESET_COLD;
  process.env.P6_RESET_COLD = "1";
  const lines: string[] = [];
  const log = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const kv = memoryKv(() => NOW);
    const lease = await hold(kv);
    const ids = [...COLD, ...WARM];
    const host = hostFor(ids);
    await plant(host, kv);
    const holder = hostHolder(host, kv, [], "cron");
    await holder.resetCold();
    expect(lines).toEqual([`p6 cold reset ${COLD.length}: ${COLD.join(" ")}`]);
    expect(lines.join(" ")).not.toContain(lease.token ?? "");
    for (const id of COLD) {
      expect(host.seedMarks.has(id)).toBe(false);
      expect(await kv.get(seedMarkKey(id))).toBeNull();
    }
    for (const id of WARM) {
      expect(host.seedMarks.get(id)?.status).toBe("warm");
      expect(await kv.get(seedMarkKey(id))).toBe(JSON.stringify(mark("warm")));
    }
    const cursor = await cursorOf(kv);
    expect(cursor?.coldReset).toBe(true);
    expect(cursor?.runId).toBe("seed");
    expect(cursor?.retry).toEqual(["ZEC-USD", "NEAR-USD", "SUI-USD"]);
    expect(host.seedDropKeys).toEqual([]);
    expect(host.seedCursor.coldReset).toBe(true);
  } finally {
    console.log = log;
    if (previous === undefined) delete process.env.P6_RESET_COLD;
    else process.env.P6_RESET_COLD = previous;
  }
});

test("a stopped or stale holder does not clear cold marks", async () => {
  const kv = memoryKv(() => NOW);
  const lease = await hold(kv, "cron");
  const host = hostFor(COLD);
  await plant(host, kv);
  host.stopped = true;
  expect(stageColdReset(host, true, "cron", lease)).toBeNull();
  expect(await kv.get(seedMarkKey("ZEC-USD"))).toContain("cold");

  host.stopped = false;
  host.leaseToken = "other-token";
  expect(stageColdReset(host, true, "cron", lease)).toBeNull();
  expect(host.seedMarks.get("ZEC-USD")?.status).toBe("cold");
  expect(await kv.get(SEED_CURSOR_KEY)).toBeNull();

  expect(stageColdReset(host, true, "cron", { ...lease, holder: "other" })).toBeNull();
  expect(stageColdReset(host, true, "cron", { ...lease, release: "deadline" })).toBeNull();
  expect(stageColdReset(host, true, "cron", null)).toBeNull();
  expect(host.seedCursor.coldReset).toBeUndefined();
});

test("a flush that loses the lease does not keep the reset", async () => {
  const previous = process.env.P6_RESET_COLD;
  process.env.P6_RESET_COLD = "1";
  try {
    const kv = memoryKv(() => NOW);
    await hold(kv);
    const host = hostFor([...COLD, ...WARM]);
    await plant(host, kv);
    kv.ownedFlush = async () => 0;
    const holder = hostHolder(host, kv, [], "cron");
    await holder.resetCold();
    expect(host.stopped).toBe(true);
    expect(host.seedCursor.coldReset).toBeUndefined();
    expect(host.seedMarks.get("ZEC-USD")?.status).toBe("cold");
    expect(host.seedMarks.get("ETH-USD")?.status).toBe("warm");
    expect(await kv.get(seedMarkKey("ZEC-USD"))).toContain("cold");
    expect(await kv.get(SEED_CURSOR_KEY)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.P6_RESET_COLD;
    else process.env.P6_RESET_COLD = previous;
  }
});

test("a second run with the flag still set leaves a newly cold product alone", async () => {
  const previous = process.env.P6_RESET_COLD;
  process.env.P6_RESET_COLD = "1";
  try {
    const kv = memoryKv(() => NOW);
    await hold(kv);
    const host = hostFor([...COLD, ...WARM]);
    await plant(host, kv);
    const holder = hostHolder(host, kv, [], "cron");
    await holder.resetCold();
    host.products = [...host.products, "ATOM-USD"];
    host.seedMarks.set("ATOM-USD", mark("cold"));
    host.cold.add("ATOM-USD");
    await kv.set(seedMarkKey("ATOM-USD"), JSON.stringify(mark("cold")));
    await holder.resetCold();
    expect(host.seedMarks.get("ATOM-USD")?.status).toBe("cold");
    expect(await kv.get(seedMarkKey("ATOM-USD"))).toContain("cold");
    const next = startPaperHost([...COLD, ...WARM, "ATOM-USD"], {});
    next.clock = () => NOW;
    next.products = [...COLD, ...WARM, "ATOM-USD"];
    expect(await loadSplit(kv, next)).not.toBeNull();
    expect(next.seedCursor.coldReset).toBe(true);
    expect(stageColdReset(next, true, "cron", decodeLease(await kv.get(LEASE_KEY)))).toBeNull();
    expect(next.seedMarks.get("ATOM-USD")?.status).toBe("cold");
  } finally {
    if (previous === undefined) delete process.env.P6_RESET_COLD;
    else process.env.P6_RESET_COLD = previous;
  }
});

test("the flag off or unset does not clear cold marks", async () => {
  const previous = process.env.P6_RESET_COLD;
  delete process.env.P6_RESET_COLD;
  try {
    const kv = memoryKv(() => NOW);
    await hold(kv);
    const host = hostFor(COLD);
    await plant(host, kv);
    await hostHolder(host, kv, [], "cron").resetCold();
    expect(host.seedMarks.get("ZEC-USD")?.status).toBe("cold");
    expect(await kv.get(seedMarkKey("ZEC-USD"))).toContain("cold");
    expect(host.seedCursor.coldReset).toBeUndefined();
    process.env.P6_RESET_COLD = "true";
    await hostHolder(host, kv, [], "cron").resetCold();
    expect(await kv.get(SEED_CURSOR_KEY)).toBeNull();
  } finally {
    if (previous === undefined) delete process.env.P6_RESET_COLD;
    else process.env.P6_RESET_COLD = previous;
  }
});

test("runInvocation resets cold marks after it holds the lease", async () => {
  const previous = process.env.P6_RESET_COLD;
  process.env.P6_RESET_COLD = "1";
  try {
    const kv = memoryKv(() => NOW);
    const ids = [...COLD, ...WARM];
    const host = hostFor(ids);
    await plant(host, kv);
    const holder = hostHolder(host, kv, [], "cron");
    await runInvocation({
      kv,
      self: "cron",
      nowMs: NOW,
      deadlineMs: NOW,
      holder: { ...holder, confirmHandover: async () => true },
    });
    for (const id of COLD) expect(await kv.get(seedMarkKey(id))).toBeNull();
    expect(await kv.get(seedMarkKey("ETH-USD"))).not.toBeNull();
    const cursor = await cursorOf(kv);
    expect(cursor?.coldReset).toBe(true);
    expect(cursor?.retry).toEqual(["ZEC-USD", "NEAR-USD", "SUI-USD"]);
  } finally {
    if (previous === undefined) delete process.env.P6_RESET_COLD;
    else process.env.P6_RESET_COLD = previous;
  }
});
