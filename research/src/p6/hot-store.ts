/**
 * Split book. p6:hot is the small snapshot. Bars, rings, and tape are their own keys.
 * A save checks the lease token in the same Redis script as the write.
 */

import type { BarOHLC } from "../p3/signals";
import {
  DAILY_CLOSE_DAYS,
  FOUR_KEEP,
  HOUR_KEEP,
  type DailyClose,
  type PaperHost,
  type PaperStateBody,
  retainDailyCloses,
} from "./paper-host";
import { HOT_KEY, LEASE_KEY, VALUE_MAX_BYTES, type Kv } from "./relay";

/** Heartbeat payload cap. A larger write is an incident and is not sent. */
export const HOT_MAX_BYTES = 256 * 1024;
export const BAR15_TTL_MS = 9 * 24 * 60 * 60 * 1000;
export const RING_TTL_MS = 2 * 60 * 60 * 1000;
export const TAPE_TTL_MS = 2 * 60 * 60 * 1000;
export const TAPE_LOOKBACK_MIN = 10;

/**
 * Published Upstash Redis limits checked 2026-10-12.
 * https://upstash.com/docs/redis/overall/billing
 * Free and PAYG: max request 10 MB, max record 100 MB.
 * Free bandwidth 10 GB/month and 500K commands/month.
 * PAYG bandwidth 200 GB/month then $0.03/GB. Commands $0.20 per 100K.
 * Fixed 250 MB: bandwidth 50 GB, request 10 MB, record 100 MB.
 * Fixed 1 GB: bandwidth 100 GB, request 10 MB, record 200 MB.
 * This process refuses a value over 1 MB, under those request caps.
 */
export const UPSTASH_LIMITS = {
  maxRequestBytes: 10 * 1024 * 1024,
  maxRecordBytes: 100 * 1024 * 1024,
  freeBandwidthBytes: 10 * 1024 * 1024 * 1024,
  paygBandwidthBytes: 200 * 1024 * 1024 * 1024,
  fixed250BandwidthBytes: 50 * 1024 * 1024 * 1024,
  fixed1GbBandwidthBytes: 100 * 1024 * 1024 * 1024,
} as const;

export function bar15Key(productId: string, day: string): string {
  return `p6:bar15:${productId}:${day}`;
}

export function bar4hKey(productId: string): string {
  return `p6:bar4h:${productId}`;
}

export function bar1hKey(productId: string): string {
  return `p6:bar1h:${productId}`;
}

export function d1Key(productId: string): string {
  return `p6:d1:${productId}`;
}

export function ringKey(productId: string): string {
  return `p6:ring1m:${productId}`;
}

export function tapeKey(productId: string, minute: number): string {
  return `p6:tape:${productId}:${minute}`;
}

/** One product's daily warmup. A single blob of every product exceeds the 1 MB value guard. */
export function warmupKey(productId: string): string {
  return `p6:warmup:${productId}`;
}

export function utcDay(startSec: number): string {
  return new Date(startSec * 1000).toISOString().slice(0, 10);
}

interface HotBody {
  products: string[];
  positions: PaperStateBody["positions"];
  closed: PaperStateBody["closed"];
  kelly: PaperStateBody["kelly"];
  pairs: PaperStateBody["pairs"];
  realizedUsd: number;
  incidents: string[];
  aPickConfig: string | null;
  classes: PaperStateBody["classes"];
  day: string | null;
  week: string | null;
  dayStartEquity: number;
  weekStartEquity: number;
  peakEquity: number;
  killSwitch: boolean;
  rejected: PaperStateBody["rejected"];
  haltWeeks: string[];
  momentumDates: string[];
  restCursor: [string, number][];
  appliedThrough: [string, number][];
  queued: PaperStateBody["queued"];
  jevPackets: number;
  jevSkipped: number;
  gapFills: number;
  gaps: { startMs: number; endMs: number; cause: string }[];
  dSubmitted: number;
  dIndeterminate: number;
  feedCursor: PaperStateBody["feedCursor"];
  jevMeter: PaperStateBody["jevMeter"];
  emitted: string[];
  weeks: PaperStateBody["weeks"];
  feedCut: PaperStateBody["feedCut"];
  overflowByDay: [string, number][];
  fourSeedSrc: [string, "research" | "rest_1h"][];
  ema200: [string, "seeded" | "live"][];
  fourSeedThrough: [string, number][];
  overlapSeen: boolean;
}

export function captureHot(host: PaperHost): HotBody {
  const book = host.book;
  return {
    products: [...host.products],
    positions: book.positions,
    closed: book.closed.slice(-40),
    kelly: book.kelly,
    pairs: book.pairs,
    realizedUsd: book.realizedUsd,
    incidents: book.incidents.slice(-40),
    aPickConfig: book.aPick?.config ?? null,
    classes: book.classes,
    day: book.day,
    week: book.week,
    dayStartEquity: book.dayStartEquity,
    weekStartEquity: book.weekStartEquity,
    peakEquity: book.peakEquity,
    killSwitch: book.killSwitch,
    rejected: book.rejected.slice(-40),
    haltWeeks: book.haltWeeks,
    momentumDates: book.momentumDates,
    restCursor: [...host.restCursor.entries()],
    appliedThrough: [...host.appliedThrough.entries()],
    queued: [...host.queued.values()].slice(-40),
    jevPackets: book.jevPackets,
    jevSkipped: book.jevSkipped,
    gapFills: book.gapFills,
    gaps: host.gaps,
    dSubmitted: book.submittedByClass.D,
    dIndeterminate: book.indeterminateByClass.D,
    feedCursor: { ...host.feedCursor },
    jevMeter: { ...host.jevMeter },
    emitted: [...host.emitted].slice(-80),
    weeks: [...host.weeks.entries()],
    feedCut: host.feedCut,
    overflowByDay: [...host.overflowByDay.entries()],
    fourSeedSrc: [...host.fourSeedSrc.entries()],
    ema200: [...host.ema200.entries()],
    fourSeedThrough: [...host.fourSeedThrough.entries()],
    overlapSeen: host.overlapSeen,
  };
}

export function hotBytes(host: PaperHost): number {
  return Buffer.byteLength(JSON.stringify(captureHot(host)));
}

async function writeOwned(kv: Kv, host: PaperHost, key: string, value: string, px?: number): Promise<void> {
  if (Buffer.byteLength(value) > VALUE_MAX_BYTES) throw new Error("kv value exceeds 1 MB");
  if (host.leaseToken) {
    const ok = await kv.ownedSet(LEASE_KEY, host.leaseToken, key, value, px != null ? { px } : undefined);
    if (!ok) throw new Error("lease lost");
    return;
  }
  const wrote = await kv.set(key, value, px != null ? { px } : undefined);
  if (!wrote) throw new Error(`kv set ${key} failed`);
}

async function appendOwned(
  kv: Kv,
  host: PaperHost,
  key: string,
  member: unknown,
  field: string,
  id: string,
  max: number,
  px?: number,
): Promise<"applied" | "duplicate" | "lost" | "oversize"> {
  const payload = JSON.stringify(member);
  if (Buffer.byteLength(payload) > VALUE_MAX_BYTES) return "oversize";
  if (!host.leaseToken) {
    const current = await kv.get(key);
    const list = current ? (JSON.parse(current) as Record<string, unknown>[]) : [];
    if (list.some((row) => String(row[field]) === id)) return "duplicate";
    list.push(JSON.parse(payload) as Record<string, unknown>);
    const trimmed = max > 0 && list.length > max ? list.slice(list.length - max) : list;
    const encoded = JSON.stringify(trimmed);
    if (Buffer.byteLength(encoded) > VALUE_MAX_BYTES) return "oversize";
    const wrote = await kv.set(key, encoded, px != null ? { px } : undefined);
    if (!wrote) throw new Error(`kv set ${key} failed`);
    return "applied";
  }
  const code = await kv.ownedAppend(LEASE_KEY, host.leaseToken, key, payload, { id, field, max, ...(px != null ? { px } : {}) });
  if (code === 1) return "applied";
  if (code === 2) return "duplicate";
  if (code === 3) return "oversize";
  return "lost";
}

function leaseLost(error: unknown): boolean {
  return error instanceof Error && error.message.includes("lease lost");
}

function transportError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return message.includes("redis timeout") || message.includes("redis closed") || message.startsWith("redis ");
}

function writeIncident(host: PaperHost, error: unknown): void {
  const message = error instanceof Error ? error.message : "failed";
  host.book.incidents.push(message.startsWith("kv set") || message.includes("lease lost") ? message : `kv set ${message}`);
}

/** The next save of this product waits until this one finishes, including the append. */
function withProduct(host: PaperHost, productId: string, fn: () => Promise<void>): Promise<void> {
  const prev = host.productLocks.get(productId) ?? Promise.resolve();
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.productLocks.set(productId, prev.then(() => gate, () => gate));
  return prev.then(fn, fn).finally(release);
}

/**
 * Mark the row, then append. The mark is set before the await, so a second save
 * does not send the same row. The append itself is idempotent if one still arrives.
 */
async function appendMarked(
  kv: Kv,
  host: PaperHost,
  mark: string,
  key: string,
  member: unknown,
  field: string,
  id: string,
  max: number,
  px?: number,
): Promise<void> {
  if (host.persistedBars.has(mark)) return;
  host.persistedBars.add(mark);
  const payloadBytes = Buffer.byteLength(JSON.stringify(member));
  try {
    const result = await appendOwned(kv, host, key, member, field, id, max, px);
    if (result === "lost") throw new Error("lease lost");
    if (result === "oversize") {
      host.persistedBars.delete(mark);
      host.book.incidents.push(`kv value exceeds 1 MB ${key}`);
      return;
    }
    host.saveCommands += 1;
    host.saveBytes += payloadBytes;
    if (result === "duplicate") host.duplicateAppends += 1;
  } catch (error) {
    host.persistedBars.delete(mark);
    throw error;
  }
}

async function noteWrite(host: PaperHost, bytes: number, write: () => Promise<void>): Promise<void> {
  await write();
  host.saveCommands += 1;
  host.saveBytes += bytes;
}

/** One heartbeat write of the small book, then appends for bars that are not stored yet. A failed hot or warmup write still appends. */
export async function persistSplit(kv: Kv, host: PaperHost): Promise<void> {
  const json = JSON.stringify(captureHot(host));
  const bytes = Buffer.byteLength(json);
  if (bytes > HOT_MAX_BYTES) {
    host.book.incidents.push(`heartbeat write ${bytes} exceeds 256 KB`);
  } else {
    try {
      await noteWrite(host, bytes, () => writeOwned(kv, host, HOT_KEY, json));
    } catch (error) {
      if (leaseLost(error) || transportError(error)) throw error;
      writeIncident(host, error);
    }
  }
  if (!host.warmupStored && host.warmup.size > 0) {
    let failed = false;
    for (const [productId, days] of host.warmup) {
      if (days.length === 0) continue;
      const payload = JSON.stringify(days);
      const warmBytes = Buffer.byteLength(payload);
      if (warmBytes > VALUE_MAX_BYTES) {
        host.book.incidents.push(`kv value exceeds 1 MB warmup ${productId}`);
        failed = true;
        continue;
      }
      try {
        await noteWrite(host, warmBytes, () => writeOwned(kv, host, warmupKey(productId), payload));
      } catch (error) {
        if (leaseLost(error) || transportError(error)) throw error;
        writeIncident(host, error);
        failed = true;
      }
    }
    if (!failed) host.warmupStored = true;
  }
  const products = new Set<string>([
    ...host.fifteen.map((bar) => bar.productId),
    ...host.fourBars.keys(),
    ...host.hourWarm.keys(),
    ...host.dailyBars.keys(),
    ...host.book.mids.completed.map((bar) => bar.productId),
    ...host.trades.map((trade) => trade.productId),
  ]);
  await Promise.all([...products].map((productId) => withProduct(host, productId, async () => {
    for (const bar of host.fifteen) {
      if (bar.productId !== productId) continue;
      await appendMarked(kv, host, `15:${productId}:${bar.startSec}`, bar15Key(productId, utcDay(bar.startSec)), bar, "startSec", String(bar.startSec), 96, BAR15_TTL_MS);
    }
    for (const bar of host.fourBars.get(productId) ?? []) {
      await appendMarked(kv, host, `4h:${productId}:${bar.ts}`, bar4hKey(productId), bar, "ts", String(bar.ts), FOUR_KEEP);
    }
    for (const bar of host.hourWarm.get(productId) ?? []) {
      await appendMarked(kv, host, `1h:${productId}:${bar.ts}`, bar1hKey(productId), bar, "ts", String(bar.ts), HOUR_KEEP);
    }
    for (const bar of host.dailyBars.get(productId) ?? []) {
      await appendMarked(kv, host, `d1:${productId}:${bar.ts}`, d1Key(productId), bar, "ts", String(bar.ts), DAILY_CLOSE_DAYS);
    }
    for (const bar of host.book.mids.completed) {
      if (bar.productId !== productId) continue;
      await appendMarked(kv, host, `m:${productId}:${bar.ts}`, ringKey(productId), bar, "ts", String(bar.ts), 120, RING_TTL_MS);
    }
    for (const trade of host.trades) {
      if (trade.productId !== productId) continue;
      const minute = Math.floor(trade.tsSec / 60) * 60;
      const id = `${trade.tsSec}:${trade.price}:${trade.size}`;
      await appendMarked(kv, host, `t:${productId}:${trade.tsSec}:${trade.price}:${trade.size}`, tapeKey(productId, minute), { ...trade, id }, "id", id, 0, TAPE_TTL_MS);
    }
  })));
}

function parseList<T>(raw: string | null): T[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as T[];
  return Array.isArray(parsed) ? parsed : [];
}

/** Rebuild the host from the split keys. Warmup is not read here. */
export async function loadSplit(kv: Kv, host: PaperHost): Promise<PaperStateBody | null> {
  const raw = await kv.get(HOT_KEY);
  if (!raw) return null;
  const hot = JSON.parse(raw) as HotBody;
  const products = [...new Set([...(hot.products ?? []), ...host.products])];
  const nowSec = Math.floor(host.clock() / 1000);
  const today = Math.floor(nowSec / 86400) * 86400;
  const days: string[] = [];
  for (let i = 0; i < 8; i += 1) days.push(new Date((today - i * 86400) * 1000).toISOString().slice(0, 10));
  const minute = Math.floor(nowSec / 60) * 60;
  const keys: string[] = [];
  for (const productId of products) {
    for (const day of days) keys.push(bar15Key(productId, day));
    keys.push(bar4hKey(productId), bar1hKey(productId), d1Key(productId), ringKey(productId));
    for (let i = 0; i < TAPE_LOOKBACK_MIN; i += 1) keys.push(tapeKey(productId, minute - i * 60));
  }
  const values = await Promise.all(keys.map((key) => kv.get(key)));
  const byKey = new Map(keys.map((key, index) => [key, values[index] ?? null]));
  const fifteen: PaperStateBody["fifteen"] = [];
  const hourWarm: [string, BarOHLC[]][] = [];
  const fourBars: [string, BarOHLC[]][] = [];
  const dailyBars: [string, BarOHLC[]][] = [];
  const dailyCloses: [string, DailyClose[]][] = [];
  const rings: PaperStateBody["rings"] = [];
  const tape: PaperStateBody["tape"] = [];
  for (const productId of products) {
    const bars = days
      .flatMap((day) => parseList<PaperStateBody["fifteen"][number]>(byKey.get(bar15Key(productId, day)) ?? null))
      .sort((a, b) => a.startSec - b.startSec);
    fifteen.push(...bars);
    for (const bar of bars) host.persistedBars.add(`15:${bar.productId}:${bar.startSec}`);
    const hours = parseList<BarOHLC>(byKey.get(bar1hKey(productId)) ?? null).sort((a, b) => a.ts - b.ts);
    const fours = parseList<BarOHLC>(byKey.get(bar4hKey(productId)) ?? null).sort((a, b) => a.ts - b.ts);
    const daily = parseList<BarOHLC>(byKey.get(d1Key(productId)) ?? null).sort((a, b) => a.ts - b.ts);
    if (hours.length > 0) hourWarm.push([productId, hours]);
    if (fours.length > 0) fourBars.push([productId, fours]);
    if (daily.length > 0) {
      dailyBars.push([productId, daily]);
      dailyCloses.push([
        productId,
        retainDailyCloses(daily.map((bar) => ({ date: new Date(bar.ts * 1000).toISOString().slice(0, 10), close: bar.close }))),
      ]);
    }
    for (const bar of hours) host.persistedBars.add(`1h:${productId}:${bar.ts}`);
    for (const bar of fours) host.persistedBars.add(`4h:${productId}:${bar.ts}`);
    for (const bar of daily) host.persistedBars.add(`d1:${productId}:${bar.ts}`);
    const ringsForProduct = parseList<PaperStateBody["rings"][number]>(byKey.get(ringKey(productId)) ?? null);
    rings.push(...ringsForProduct);
    for (const bar of ringsForProduct) host.persistedBars.add(`m:${productId}:${bar.ts}`);
    for (let i = TAPE_LOOKBACK_MIN - 1; i >= 0; i -= 1) {
      const rows = parseList<PaperStateBody["tape"][number] & { id?: string }>(byKey.get(tapeKey(productId, minute - i * 60)) ?? null);
      tape.push(...rows);
      for (const trade of rows) {
        const id = trade.id ?? `${trade.tsSec}:${trade.price}:${trade.size}`;
        host.persistedBars.add(`t:${productId}:${id}`);
      }
    }
  }
  return {
    ...hot,
    fifteen,
    hourWarm,
    fourBars,
    dailyBars,
    dailyCloses,
    rings,
    tape,
    applied: [],
    volHours: [],
  };
}
