/**
 * Split book. p6:hot is the small snapshot. Bars, rings, and tape are their own keys.
 * A save checks the lease token in the same Redis script as the write.
 */

import type { BarOHLC } from "../p3/signals";
import { paperPnl } from "./engine";
import { equityExtras, hourStartSec } from "./pnl-block";
import { positionSnaps } from "./positions-view";
import { boundJevDone, JEV_PACKET_TTL_MS, queuedForHandover, skipShareReport } from "./jev-call";
import { packMinute, type JevMinuteTuple } from "./jev-minute";
import {
  FOUR_KEEP,
  fourSeriesReady,
  HOUR_KEEP,
  SEED_CURSOR_KEY,
  seedMarkKey,
  seedRetryList,
  type DailyClose,
  type SeedMark,
  type PaperHost,
  type PaperStateBody,
  retainDailyCloses,
} from "./paper-host";
import { barMarker, HOT_KEY, LEASE_KEY, VALUE_MAX_BYTES, type Kv } from "./relay";

/** One record per flush. The dashboard reads this and does not recompute P/L. */
export const LAST_RUN_KEY = "p6:lastRun";

/** Account revision. Not part of p6:hot. NX so a successor cannot move fromDay. */
export const ACCT_KEY = "p6:acct";

/**
 * First full UTC day strictly after the write's UTC day.
 * A write at 23:59:59.999Z yields the next calendar day.
 * A write at 00:00:00.000Z yields the day after that, so the write day itself never counts.
 */
export function acctFromDay(nowMs: number): string {
  const dayStart = Math.floor(nowMs / 86_400_000) * 86_400_000;
  return new Date(dayStart + 86_400_000).toISOString().slice(0, 10);
}

export function parseAcctMarker(raw: string | null): { rev: 2; fromDay: string } | null {
  if (!raw) return null;
  let body: { rev?: unknown; fromDay?: unknown };
  try {
    body = JSON.parse(raw) as { rev?: unknown; fromDay?: unknown };
  } catch {
    return null;
  }
  if (body.rev !== 2 || typeof body.fromDay !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(body.fromDay)) return null;
  return { rev: 2, fromDay: body.fromDay };
}

/** Heartbeat payload cap. Over this, Jev fields are shed and the book is still written. */
export const HOT_MAX_BYTES = 256 * 1024;
/** Incident when the hot snapshot reaches 75% of the cap. */
export const HOT_WARN_BYTES = 192 * 1024;
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

/** One closed minute, every product, as one string block. */
export function tapeKey(minute: number): string {
  return `p6:tape:${minute}`;
}

export const FILLS_KEY = "p6:fills";
export const LEDGER_KEY = "p6:ledger";

export function tapeBlock(trades: readonly { productId: string; tsSec: number; price: number; size: number; side?: string }[]): string {
  const byProduct = new Map<string, string[]>();
  for (const trade of trades) {
    const row = `${trade.tsSec},${trade.price},${trade.size},${trade.side ?? ""}`;
    const list = byProduct.get(trade.productId) ?? [];
    list.push(row);
    byProduct.set(trade.productId, list);
  }
  const body: Record<string, string> = {};
  for (const [productId, rows] of [...byProduct.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) body[productId] = rows.join(";");
  return JSON.stringify(body);
}

export function tradesFromBlock(minuteRaw: string | null): { productId: string; tsSec: number; price: number; size: number; side?: string }[] {
  if (!minuteRaw) return [];
  const body = JSON.parse(minuteRaw) as Record<string, string>;
  if (!body || Array.isArray(body)) return [];
  const out: { productId: string; tsSec: number; price: number; size: number; side?: string }[] = [];
  for (const [productId, packed] of Object.entries(body)) {
    if (typeof packed !== "string" || packed === "") continue;
    for (const row of packed.split(";")) {
      const [ts, price, size, side] = row.split(",");
      const tsSec = Number(ts);
      const px = Number(price);
      const sz = Number(size);
      if (!Number.isFinite(tsSec) || !Number.isFinite(px) || !Number.isFinite(sz)) continue;
      out.push({ productId, tsSec, price: px, size: sz, ...(side ? { side } : {}) });
    }
  }
  return out;
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
  jevMinutes?: JevMinuteTuple[];
  jevDone?: PaperStateBody["jevDone"];
  jevAnswers?: PaperStateBody["jevAnswers"];
  jevSkip?: PaperStateBody["jevSkip"];
  jevCatchUps?: PaperStateBody["jevCatchUps"];
  jevFirst?: PaperStateBody["jevFirst"];
  jevThrough?: PaperStateBody["jevThrough"];
  jevLegacy?: PaperStateBody["jevLegacy"];
  jevPrev?: PaperStateBody["jevPrev"];
  jevBarSec?: PaperStateBody["jevBarSec"];
  jevQueue?: PaperStateBody["jevQueue"];
  emitted: string[];
  weeks: PaperStateBody["weeks"];
  feedCut: PaperStateBody["feedCut"];
  overflowByDay: [string, number][];
  fourSeedSrc: [string, "research" | "rest_1h"][];
  ema200: [string, "seeded" | "live"][];
  fourSeedThrough: [string, number][];
  overlapSeen: boolean;
  working?: PaperStateBody["working"];
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
    jevMinutes: compactJevMinutes(host),
    jevDone: boundJevDone([...host.jevDone], Math.floor(host.clock() / 1000)),
    jevAnswers: host.jevAnswers.slice(-20).map((row) => ({
      pair: row.pair,
      barStartSec: row.barStartSec,
      reason: row.reason,
      answer: row.answer,
      tokens: row.tokens ?? null,
      costUsd: row.costUsd,
      answeredAtMs: row.answeredAtMs,
      latencyMs: row.latencyMs,
      packetHash: row.packetHash,
      ...(row.holder ? { holder: row.holder } : {}),
      ...(row.handoverMinutes != null ? { handoverMinutes: row.handoverMinutes } : {}),
      ...(row.guardIncluded != null ? { guardIncluded: row.guardIncluded } : {}),
      ...(row.scoreMid !== undefined ? { scoreMid: row.scoreMid } : {}),
    })),
    jevSkip: host.jevSkip,
    jevCatchUps: host.jevCatchUps,
    jevFirst: host.jevFirst,
    jevThrough: { ...host.jevThrough },
    ...(host.jevLegacy ? { jevLegacy: { ...host.jevLegacy } } : {}),
    ...(host.jevPrev ? { jevPrev: host.jevPrev } : {}),
    ...(host.book.jevBarSec != null ? { jevBarSec: host.book.jevBarSec } : {}),
    jevQueue: queuedForHandover(host.jevQueue, host.jevDone),
    emitted: [...host.emitted].slice(-80),
    weeks: [...host.weeks.entries()],
    feedCut: host.feedCut,
    overflowByDay: [...host.overflowByDay.entries()],
    fourSeedSrc: [...host.fourSeedSrc.entries()],
    ema200: [...host.ema200.entries()],
    fourSeedThrough: [...host.fourSeedThrough.entries()],
    overlapSeen: host.overlapSeen,
    ...(book.working.length > 0 ? { working: book.working } : {}),
  };
}

export function hotBytes(host: PaperHost): number {
  return Buffer.byteLength(JSON.stringify(captureHot(host)));
}

function compactJevMinutes(host: PaperHost): JevMinuteTuple[] {
  const open = new Set(host.book.positions.map((position) => position.productId));
  open.add("BTC-USD");
  return host.jevTape
    .exportMinutes({ holder: host.holderId, leaseFromMs: host.leaseFromMs, leaseUntilMs: host.leaseUntilMs })
    .filter((row) => open.has(row.productId))
    .map(packMinute);
}

function jevShed(host: PaperHost, shed: { answers: boolean; minutes: boolean; done: boolean; first: boolean }): HotBody {
  const body = captureHot(host);
  if (shed.answers) body.jevAnswers = [];
  if (shed.minutes) body.jevMinutes = [];
  if (shed.done) body.jevDone = [];
  if (shed.first) body.jevFirst = [];
  if (!host.leaseToken) {
    body.jevQueue = [];
    body.jevAnswers = [];
    body.jevDone = [];
    body.jevMinutes = [];
    body.jevFirst = [];
  }
  return body;
}

/** Shed Jev fields in order when hot is over the cap, and always return a snapshot. */
export function hotSnapshot(host: PaperHost): string {
  const shed = { answers: false, minutes: false, done: false, first: false };
  let json = JSON.stringify(jevShed(host, shed));
  let bytes = Buffer.byteLength(json);
  if (bytes >= HOT_WARN_BYTES && !host.book.incidents.some((row) => row.includes("75% of 256 KB"))) {
    host.book.incidents.push(`hot ${bytes} bytes at 75% of 256 KB`);
    json = JSON.stringify(jevShed(host, shed));
    bytes = Buffer.byteLength(json);
  }
  if (bytes > HOT_MAX_BYTES) {
    shed.answers = true;
    json = JSON.stringify(jevShed(host, shed));
    bytes = Buffer.byteLength(json);
  }
  if (bytes > HOT_MAX_BYTES) {
    shed.minutes = true;
    json = JSON.stringify(jevShed(host, shed));
    bytes = Buffer.byteLength(json);
  }
  if (bytes > HOT_MAX_BYTES) {
    shed.done = true;
    json = JSON.stringify(jevShed(host, shed));
    bytes = Buffer.byteLength(json);
  }
  if (bytes > HOT_MAX_BYTES) {
    shed.first = true;
    json = JSON.stringify(jevShed(host, shed));
    bytes = Buffer.byteLength(json);
  }
  if (bytes > HOT_MAX_BYTES && !host.book.incidents.some((row) => row.includes("exceeds 256 KB"))) {
    host.book.incidents.push(`heartbeat write ${bytes} exceeds 256 KB`);
    json = JSON.stringify(jevShed(host, shed));
  }
  return json;
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

interface FlushPiece {
  key: string;
  value: string;
  id: string;
  field: string;
  max: number;
  px: number;
  mark: string;
}

interface FlushPlan {
  payload: string;
  bytes: number;
  marks: string[];
  minutes: number[];
}

function queueFlush(host: PaperHost, fn: () => Promise<void>): Promise<void> {
  const prev = host.flushChain;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = prev.then(fn, fn).finally(release);
  host.flushChain = prev.then(() => gate, () => gate);
  return run;
}

/** Fills and the ledger are written before the next event, not on the 60s flush. */
export async function writeThroughBook(kv: Kv, host: PaperHost): Promise<void> {
  while (host.fillStored < host.book.legs.length) {
    const leg = host.book.legs[host.fillStored]!;
    const result = await appendOwned(kv, host, FILLS_KEY, leg, "id", leg.id, 0);
    if (result === "lost") throw new Error("lease lost");
    if (result === "oversize") {
      host.book.incidents.push("kv value exceeds 1 MB p6:fills");
      return;
    }
    host.fillStored += 1;
    if (result !== "duplicate") {
      host.saveCommands += 1;
      host.saveBytes += Buffer.byteLength(JSON.stringify(leg));
    }
  }
  while (host.ledgerStored < host.book.closed.length) {
    const trade = host.book.closed[host.ledgerStored]!;
    const result = await appendOwned(kv, host, LEDGER_KEY, trade, "id", trade.id, 0);
    if (result === "lost") throw new Error("lease lost");
    if (result === "oversize") {
      host.book.incidents.push("kv value exceeds 1 MB p6:ledger");
      return;
    }
    host.ledgerStored += 1;
    if (result !== "duplicate") {
      host.saveCommands += 1;
      host.saveBytes += Buffer.byteLength(JSON.stringify(trade));
    }
  }
}

export function kickDurable(host: PaperHost): void {
  if (!host.kv || !host.leaseToken) return;
  const kv = host.kv;
  host.durableChain = host.durableChain.then(() => writeThroughBook(kv, host), () => writeThroughBook(kv, host));
}

function buildFlush(host: PaperHost): FlushPlan {
  const nowSec = Math.floor(host.clock() / 1000);
  const openMinute = Math.floor(nowSec / 60) * 60;
  const marks: string[] = [];
  const bars: FlushPiece[] = [];
  const rings: { key: string; value: string; id: string; px: number }[] = [];
  const claim = (mark: string, piece: FlushPiece) => {
    if (host.persistedBars.has(mark)) return;
    host.persistedBars.add(mark);
    marks.push(mark);
    bars.push(piece);
  };
  for (const bar of host.closingMarks) {
    const marker = `bar:${bar.productId}:${bar.startSec}`;
    if (host.persistedBars.has(marker)) continue;
    host.persistedBars.add(marker);
    marks.push(marker);
  }
  for (const bar of host.fifteen) {
    claim(`15:${bar.productId}:${bar.startSec}`, {
      key: bar15Key(bar.productId, utcDay(bar.startSec)),
      value: JSON.stringify(bar),
      id: String(bar.startSec),
      field: "startSec",
      max: 96,
      px: BAR15_TTL_MS,
      mark: `15:${bar.productId}:${bar.startSec}`,
    });
    const marker = `bar:${bar.productId}:${bar.startSec}`;
    if (!host.persistedBars.has(marker)) {
      host.persistedBars.add(marker);
      marks.push(marker);
    }
  }
  for (const [productId, rows] of host.fourBars) {
    for (const bar of rows) {
      claim(`4h:${productId}:${bar.ts}`, {
        key: bar4hKey(productId),
        value: JSON.stringify(bar),
        id: String(bar.ts),
        field: "ts",
        max: FOUR_KEEP,
        px: 0,
        mark: `4h:${productId}:${bar.ts}`,
      });
    }
  }
  for (const [productId, rows] of host.hourWarm) {
    for (const bar of rows) {
      claim(`1h:${productId}:${bar.ts}`, {
        key: bar1hKey(productId),
        value: JSON.stringify(bar),
        id: String(bar.ts),
        field: "ts",
        max: HOUR_KEEP,
        px: 0,
        mark: `1h:${productId}:${bar.ts}`,
      });
    }
  }
  for (const [productId, rows] of host.dailyBars) {
    for (const bar of rows) {
      claim(`d1:${productId}:${bar.ts}`, {
        key: d1Key(productId),
        value: JSON.stringify(bar),
        id: String(bar.ts),
        field: "ts",
        max: 0,
        px: 0,
        mark: `d1:${productId}:${bar.ts}`,
      });
    }
  }
  for (const bar of host.book.mids.completed) {
    const mark = `m:${bar.productId}:${bar.ts}`;
    if (host.persistedBars.has(mark)) continue;
    host.persistedBars.add(mark);
    marks.push(mark);
    rings.push({ key: ringKey(bar.productId), value: JSON.stringify(bar), id: String(bar.ts), px: RING_TTL_MS });
  }
  const tapes: { key: string; value: string; px: number }[] = [];
  const pendingMinutes = new Set<number>();
  for (const trade of host.trades) {
    const at = Math.floor(trade.tsSec / 60) * 60;
    if (at >= 0 && at < openMinute && !host.tapeWritten.has(at)) pendingMinutes.add(at);
  }
  const minutes = [...pendingMinutes].sort((a, b) => a - b);
  for (const at of minutes) {
    const rows = host.trades.filter((trade) => Math.floor(trade.tsSec / 60) * 60 === at);
    if (rows.length === 0) continue;
    tapes.push({ key: tapeKey(at), value: tapeBlock(rows), px: TAPE_TTL_MS });
  }
  const hot = hotSnapshot(host);
  const seenMark = new Set<string>();
  const marksOut: { key: string; value: string }[] = [];
  for (const bar of [...host.closingMarks, ...host.fifteen]) {
    const marker = `bar:${bar.productId}:${bar.startSec}`;
    if (!marks.includes(marker) || seenMark.has(marker)) continue;
    seenMark.add(marker);
    marksOut.push({ key: `p6:bar:${bar.productId}:${bar.startSec}`, value: barMarker(bar.productId, bar.startSec) });
  }
  for (const tape of tapes) noteValue(host, tape.value);
  for (const bar of bars) noteValue(host, bar.value);
  for (const ring of rings) noteValue(host, ring.value);
  const extra = flushExtra(host, hot ?? "", new Set(bars.map((bar) => bar.key)));
  for (const row of extra) noteValue(host, row.value);
  const drop = (host.seedDropKeys ?? []).filter((key) => key.startsWith("p6:seed:wm:"));
  const payload = JSON.stringify({
    ...(hot ? { hot } : {}),
    tapes,
    rings,
    bars: bars.map(({ key, value, id, field, max, px }) => ({ key, value, id, field, max, px })),
    marks: marksOut,
    ...(drop.length > 0 ? { drop } : {}),
    extra,
  });
  return { payload, bytes: Buffer.byteLength(payload), marks, minutes };
}

function noteValue(host: PaperHost, value: string): void {
  const bytes = Buffer.byteLength(value);
  if (bytes > host.maxValueBytes) host.maxValueBytes = bytes;
}

/**
 * Marks to publish with this flush. This does not change host.seedMarks.
 * A warm mark is published only when its 4h bars are in this same write, or were committed earlier.
 * A full series whose bars are not in this write is left untouched, so a flush cannot store `short` over it.
 */
function marksForFlush(host: PaperHost, barKeys: ReadonlySet<string>): [string, SeedMark][] {
  const out: [string, SeedMark][] = [];
  for (const [id, mark] of host.seedMarks) {
    if (mark.status === "cold") {
      out.push([id, mark]);
      continue;
    }
    const ready = fourSeriesReady(host.fourBars.get(id) ?? []);
    const committed = barKeys.has(bar4hKey(id)) || host.fourFlushed.has(id);
    if (ready && committed) {
      const warm: SeedMark = mark.status === "warm" ? mark : { ...mark, status: "warm", reason: "seeded" };
      out.push([id, warm]);
      continue;
    }
    if (!ready) {
      const short: SeedMark = mark.status === "short" ? mark : { ...mark, status: "short", reason: "short" };
      out.push([id, short]);
      continue;
    }
  }
  return out;
}

/** Warm marks whose 4h bars have already been committed. This is the count Redis holds after a flush. */
export function warmReadyCount(host: PaperHost): number {
  let count = 0;
  for (const [id, mark] of host.seedMarks) {
    if (mark.status !== "warm" || !host.fourFlushed.has(id)) continue;
    if (fourSeriesReady(host.fourBars.get(id) ?? [])) count += 1;
  }
  return count;
}

function promoteFlushed(host: PaperHost, productId: string): void {
  host.fourFlushed.add(productId);
  const mark = host.seedMarks.get(productId);
  if (!mark || mark.status === "cold" || mark.status === "warm") return;
  if (!fourSeriesReady(host.fourBars.get(productId) ?? [])) return;
  host.seedMarks.set(productId, { ...mark, status: "warm", reason: "seeded" });
}

function flushExtra(host: PaperHost, hot: string, barKeys: ReadonlySet<string>): { key: string; value: string }[] {
  noteValue(host, hot);
  const resetting = (host.seedDropKeys ?? []).some((key) => key.startsWith("p6:seed:wm:"));
  const storedMarks = resetting ? [] : marksForFlush(host, barKeys);
  const cold = storedMarks
    .filter(([, mark]) => mark.status === "cold")
    .map(([id, mark]) => ({ id, reason: mark.reason }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const warm = storedMarks.filter(([, mark]) => mark.status === "warm").length;
  const pending = host.products.filter((id) => {
    const mark = storedMarks.find(([productId]) => productId === id)?.[1];
    return !mark || mark.status === "short";
  }).length;
  const jevReport = skipShareReport(host.jevSkip, host.clock());
  const finished = host.runOutcome !== "" && host.runOutcome !== "running";
  const completed = finished
    ? { end: host.clock(), cmds: host.saveCommands + 1, outcome: host.runOutcome }
    : host.completedRun;
  const last = {
    start: host.runStartedMs,
    end: host.clock(),
    deadlineMs: host.deadlineMs,
    outcome: host.runOutcome || "running",
    applied: host.runApplied,
    decisions: Math.max(0, host.emitted.size - host.runBaseDecisions),
    fills: Math.max(0, host.book.legs.length - host.runBaseFills),
    rest: { n: host.restRun.stats.n, r429: host.restRun.stats.r429, waitedMs: host.restRun.stats.waitedMs },
    redis: { cmds: host.saveCommands + 1, bytes: host.saveBytes, maxValueBytes: host.maxValueBytes },
    cold,
    warm,
    pending,
    seedIdx: host.seedCursor.idx,
    completed,
    pnl: paperPnl(host.book),
    positions: positionSnaps(host.book),
      jev: {
      totalUsd: host.jevMeter.cumulativeUsd,
      todayUsd: host.jevMeter.today === new Date(host.clock()).toISOString().slice(0, 10) ? host.jevMeter.todayUsd : 0,
      calls: host.jevMeter.calls ?? 0,
      capUsd: host.jevMeter.capUsd,
      byReason: { ...host.jevSkip.byReason },
      skips: jevReport,
      latency: { ...jevReport.latency },
      handoverMinutes: host.jevTape.handoverMinutes,
      holder: host.holderId ?? "",
      catchUp: jevReport.catchUp,
      onTime: jevReport.onTime,
      catchUpShare: jevReport.catchUpShare,
      catchUpFlag: jevReport.catchUpFlag,
      skipShare: jevReport.skipShare,
      skipStatus: jevReport.skipStatus,
      skipDays: jevReport.skipDays,
      skipScheduled: jevReport.skipScheduled,
      skipSkipped: jevReport.skipSkipped,
      skipAnswered: jevReport.skipAnswered,
      skipWilson: jevReport.skipWilson,
      skipLabel: jevReport.skipLabel,
      legacySkipped: host.jevLegacy?.jevSkipped ?? 0,
      legacyPackets: host.jevLegacy?.jevPackets ?? 0,
    },
  };
  let encoded = JSON.stringify(last);
  const lastBytes = Buffer.byteLength(encoded);
  if (lastBytes > host.maxValueBytes) {
    host.maxValueBytes = lastBytes;
    last.redis.maxValueBytes = lastBytes;
    encoded = JSON.stringify(last);
  }
  const extra: { key: string; value: string; px?: number; nx?: boolean }[] = [
    { key: SEED_CURSOR_KEY, value: JSON.stringify(host.seedCursor) },
    ...storedMarks.map(([id, mark]) => ({ key: seedMarkKey(id), value: JSON.stringify(mark) })),
    { key: LAST_RUN_KEY, value: encoded },
  ];
  // Hourly equity points ride in this same EVAL. A book reset must delete p6:eq:* (deferred; not built).
  host.eqPlanHour = hourStartSec(host.clock());
  extra.push(
    ...equityExtras({
      nowMs: host.clock(),
      eqHourDone: host.eqHourDone ?? 0,
      pnl: last.pnl,
      closed: host.book.closed,
    }),
  );
  const fromDay = host.book.acctFromDay ?? acctFromDay(host.clock());
  extra.push({ key: ACCT_KEY, value: JSON.stringify({ rev: 2, fromDay }), nx: true });
  if (host.leaseToken) {
    for (const row of host.jevPacketWrites ?? []) extra.push({ key: row.key, value: row.value, px: JEV_PACKET_TTL_MS, nx: true });
  }
  return extra;
}

async function writeWarmupOnce(kv: Kv, host: PaperHost): Promise<void> {
  if (host.warmupStored || host.warmup.size === 0) return;
  let failed = false;
  for (const [productId, days] of host.warmup) {
    if (days.length === 0 || host.warmupDone.has(productId)) continue;
    const payload = JSON.stringify(days);
    if (Buffer.byteLength(payload) > VALUE_MAX_BYTES) {
      host.book.incidents.push(`kv value exceeds 1 MB warmup ${productId}`);
      failed = true;
      continue;
    }
    try {
      await writeOwned(kv, host, warmupKey(productId), payload);
      host.warmupDone.add(productId);
      host.saveCommands += 1;
      host.saveBytes += Buffer.byteLength(payload);
    } catch (error) {
      if (leaseLost(error) || transportError(error)) throw error;
      writeIncident(host, error);
      failed = true;
    }
  }
  if (!failed) host.warmupStored = true;
}

function payloadTooBig(plan: FlushPlan): boolean {
  if (plan.bytes <= VALUE_MAX_BYTES) return false;
  const body = JSON.parse(plan.payload) as { hot?: string; tapes?: { value: string }[]; bars?: { value: string }[]; rings?: { value: string }[]; extra?: { value: string }[] };
  const values = [
    body.hot ?? "",
    ...(body.tapes ?? []).map((row) => row.value),
    ...(body.bars ?? []).map((row) => row.value),
    ...(body.rings ?? []).map((row) => row.value),
    ...(body.extra ?? []).map((row) => row.value),
  ];
  return values.some((value) => Buffer.byteLength(value) > VALUE_MAX_BYTES);
}

function releaseMarks(host: PaperHost, marks: string[]): void {
  for (const mark of marks) host.persistedBars.delete(mark);
}

async function applyUnowned(kv: Kv, host: PaperHost, plan: FlushPlan): Promise<void> {
  const body = JSON.parse(plan.payload) as {
    hot?: string;
    tapes?: { key: string; value: string; px: number }[];
    rings?: { key: string; value: string; id: string; px: number }[];
    bars?: { key: string; value: string; id: string; field: string; max: number; px: number }[];
    marks?: { key: string; value: string }[];
    warm?: { key: string; value: string }[];
    extra?: { key: string; value: string; px?: number; nx?: boolean }[];
  };
  if (body.hot) {
    const wrote = await kv.set(HOT_KEY, body.hot);
    if (!wrote) throw new Error("kv set p6:hot failed");
  }
  for (const tape of body.tapes ?? []) {
    const wrote = await kv.set(tape.key, tape.value, { px: tape.px });
    if (!wrote) throw new Error(`kv set ${tape.key} failed`);
  }
  for (const bar of body.bars ?? []) {
    const result = await appendOwned(kv, host, bar.key, JSON.parse(bar.value) as unknown, bar.field, bar.id, bar.max, bar.px || undefined);
    if (result === "oversize") {
      host.book.incidents.push(`kv value exceeds 1 MB ${bar.key}`);
      continue;
    }
    if (result === "duplicate") host.duplicateAppends += 0;
  }
  for (const ring of body.rings ?? []) {
    const result = await appendOwned(kv, host, ring.key, JSON.parse(ring.value) as unknown, "ts", ring.id, 120, ring.px);
    if (result === "oversize") host.book.incidents.push(`kv value exceeds 1 MB ${ring.key}`);
  }
  for (const mark of body.marks ?? []) {
    if (await kv.get(mark.key)) continue;
    await kv.set(mark.key, mark.value);
  }
  for (const row of body.extra ?? []) {
    if (row.nx && (await kv.get(row.key))) continue;
    const wrote = await kv.set(row.key, row.value, row.px != null && row.px > 0 ? { px: row.px } : undefined);
    if (!wrote) throw new Error(`kv set ${row.key} failed`);
  }
}

async function writeGroupedBars(kv: Kv, host: PaperHost, plan: FlushPlan): Promise<void> {
  const body = JSON.parse(plan.payload) as { bars?: { key: string; value: string; id: string; field: string; max: number; px: number }[] };
  const groups = new Map<string, { field: string; max: number; px: number; rows: Record<string, unknown>[] }>();
  for (const bar of body.bars ?? []) {
    const group = groups.get(bar.key) ?? { field: bar.field, max: bar.max, px: bar.px, rows: [] };
    group.rows.push(JSON.parse(bar.value) as Record<string, unknown>);
    groups.set(bar.key, group);
  }
  for (const [key, group] of groups) {
    const current = await kv.get(key);
    const list = current ? (JSON.parse(current) as Record<string, unknown>[]) : [];
    for (const row of group.rows) {
      if (list.some((item) => String(item[group.field]) === String(row[group.field]))) continue;
      list.push(row);
    }
    const trimmed = group.max > 0 && list.length > group.max ? list.slice(list.length - group.max) : list;
    const encoded = JSON.stringify(trimmed);
    if (Buffer.byteLength(encoded) > VALUE_MAX_BYTES) {
      host.book.incidents.push(`kv value exceeds 1 MB ${key}`);
      continue;
    }
    await writeOwned(kv, host, key, encoded, group.px > 0 ? group.px : undefined);
    host.saveCommands += 1;
    host.saveBytes += Buffer.byteLength(encoded);
    if (!key.startsWith("p6:bar4h:") || !fourSeriesReady(trimmed as { ts: number }[])) continue;
    const productId = key.slice("p6:bar4h:".length);
    promoteFlushed(host, productId);
    const mark = host.seedMarks.get(productId);
    if (!mark || mark.status !== "warm") continue;
    const markJson = JSON.stringify(mark);
    // Ordered after the bar key. One Redis command sets one key, and a second
    // EVAL that carried both would put a near-1 MB bar plus the mark over the
    // 1 MB payload limit. A crash between the two leaves the mark short (or
    // absent). loadSplit promotes a series of FOUR_KEEP contiguous 4h bars,
    // or an offline fold that still covers FOUR_KEEP, so the next process
    // does not re-fetch.
    await writeOwned(kv, host, seedMarkKey(productId), markJson);
    host.saveCommands += 1;
    host.saveBytes += Buffer.byteLength(markJson);
  }
}

async function persistSplitBody(kv: Kv, host: PaperHost): Promise<void> {
  if (host.stopped) throw new Error("lease lost");
  if (host.kv && host.leaseToken) await host.durableChain;
  await writeWarmupOnce(kv, host);
  let plan = buildFlush(host);
  if (plan.bytes > VALUE_MAX_BYTES && !payloadTooBig(plan)) {
    await writeGroupedBars(kv, host, plan);
    const rings = plan.marks.filter((mark) => mark.startsWith("m:"));
    releaseMarks(host, rings);
    const seeded = plan.marks.filter((mark) => !mark.startsWith("bar:") && !mark.startsWith("m:"));
    plan = buildFlush(host);
    plan.marks.push(...seeded);
  }
  if (plan.bytes > VALUE_MAX_BYTES || payloadTooBig(plan)) {
    releaseMarks(host, plan.marks);
    host.book.incidents.push("kv value exceeds 1 MB");
    return;
  }
  try {
    if (!host.leaseToken) {
      await applyUnowned(kv, host, plan);
    } else {
      const code = await kv.ownedFlush(LEASE_KEY, host.leaseToken, host.clock(), plan.payload);
      if (code === 0) throw new Error("lease lost");
      if (code === 3) {
        releaseMarks(host, plan.marks);
        host.book.incidents.push("kv value exceeds 1 MB");
        return;
      }
      host.seedDropKeys = [];
      host.jevPacketSent = host.jevPacketSent ?? new Set();
      for (const row of host.jevPacketWrites ?? []) host.jevPacketSent.add(row.key);
      host.jevPacketWrites = [];
      const body = JSON.parse(plan.payload) as { warm?: unknown[] };
      if ((body.warm ?? []).length > 0) host.warmupStored = true;
    }
    for (const minute of plan.minutes) host.tapeWritten.add(minute);
    const flushed = JSON.parse(plan.payload) as { bars?: { key: string }[] };
    for (const bar of flushed.bars ?? []) {
      if (!bar.key.startsWith("p6:bar4h:")) continue;
      const productId = bar.key.slice("p6:bar4h:".length);
      if (fourSeriesReady(host.fourBars.get(productId) ?? [])) promoteFlushed(host, productId);
    }
    host.closingMarks = host.closingMarks.filter((bar) => !host.persistedBars.has(`bar:${bar.productId}:${bar.startSec}`));
    host.saveCommands += 1;
    host.saveBytes += plan.bytes;
    host.eqHourDone = host.eqPlanHour;
    if (host.book.acctFromDay == null) host.book.acctFromDay = acctFromDay(host.clock());
  } catch (error) {
    releaseMarks(host, plan.marks);
    if (leaseLost(error) || transportError(error)) throw error;
    writeIncident(host, error);
  }
}

/**
 * One flush for every product. With a lease token this is one EVAL: the token
 * is checked, the lease is renewed, then hot, the last closed tape minute,
 * the ring, and any closed bars are written. A value over 1 MB is not written.
 */
export function persistSplit(kv: Kv, host: PaperHost): Promise<void> {
  return queueFlush(host, () => persistSplitBody(kv, host));
}

function parseList<T>(raw: string | null): T[] {
  if (!raw) return [];
  const parsed = JSON.parse(raw) as T[];
  return Array.isArray(parsed) ? parsed : [];
}

/** Rebuild the host from one MGET of hot and the last 10 tape minutes, plus the bar strings in that same read. */
export async function loadSplit(kv: Kv, host: PaperHost): Promise<PaperStateBody | null> {
  const nowSec = Math.floor(host.clock() / 1000);
  const today = Math.floor(nowSec / 86400) * 86400;
  const days: string[] = [];
  for (let i = 0; i < 8; i += 1) days.push(new Date((today - i * 86400) * 1000).toISOString().slice(0, 10));
  const minute = Math.floor(nowSec / 60) * 60;
  const products = [...new Set(host.products)];
  const tapeMinutes: number[] = [];
  for (let i = 0; i < TAPE_LOOKBACK_MIN; i += 1) tapeMinutes.push(minute - i * 60);
  const keys: string[] = [HOT_KEY, FILLS_KEY, LEDGER_KEY, SEED_CURSOR_KEY, LAST_RUN_KEY, ACCT_KEY];
  for (const at of tapeMinutes) keys.push(tapeKey(at));
  for (const productId of products) {
    for (const day of days) keys.push(bar15Key(productId, day));
    keys.push(bar4hKey(productId), bar1hKey(productId), d1Key(productId), seedMarkKey(productId));
  }
  const values = await kv.mget(keys);
  const byKey = new Map(keys.map((key, index) => [key, values[index] ?? null]));
  const raw = byKey.get(HOT_KEY) ?? null;
  if (!raw) return null;
  const hot = JSON.parse(raw) as HotBody;
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
  }
  const ringKeys = products.map((productId) => ringKey(productId));
  const ringRows = await kv.readLists(ringKeys);
  ringRows.forEach((rows, index) => {
    const productId = products[index]!;
    for (const rawRow of rows) {
      const bar = JSON.parse(rawRow) as PaperStateBody["rings"][number];
      rings.push(bar);
      host.persistedBars.add(`m:${productId}:${bar.ts}`);
    }
  });
  for (const at of [...tapeMinutes].sort((a, b) => a - b)) {
    const rows = tradesFromBlock(byKey.get(tapeKey(at)) ?? null);
    if (rows.length > 0) host.tapeWritten.add(at);
    tape.push(...rows);
  }
  const legs = parseList<NonNullable<PaperStateBody["legs"]>[number]>(byKey.get(FILLS_KEY) ?? null);
  const ledger = parseList<PaperStateBody["closed"][number]>(byKey.get(LEDGER_KEY) ?? null);
  host.fillStored = legs.length;
  host.ledgerStored = ledger.length > 0 ? ledger.length : (hot.closed ?? []).length;
  if (!host.seedChecked) {
    const cursorRaw = byKey.get(SEED_CURSOR_KEY) ?? null;
    if (cursorRaw) {
      const cursor = JSON.parse(cursorRaw) as { order?: string[]; idx?: number; runId?: string; retry?: unknown; coldReset?: unknown };
      if (Array.isArray(cursor.order)) {
        host.seedCursor = {
          order: cursor.order,
          idx: cursor.idx ?? 0,
          runId: cursor.runId ?? "",
          retry: seedRetryList(cursor),
          ...(cursor.coldReset === true ? { coldReset: true } : {}),
        };
      }
    }
    for (const productId of products) {
      const raw = byKey.get(seedMarkKey(productId)) ?? null;
      const bars = fourBars.find(([id]) => id === productId)?.[1] ?? [];
      const ready = fourSeriesReady(bars);
      if (!raw) {
        if (!ready) continue;
        const newest = bars[bars.length - 1]!.ts;
        const oldest = bars[0]!.ts;
        host.seedMarks.set(productId, { oldestTs: oldest, newestTs: newest, status: "warm", reason: "seeded" });
        host.fourFlushed.add(productId);
        continue;
      }
      const mark = JSON.parse(raw) as SeedMark;
      if (mark.status === "warm" && !ready) {
        host.seedMarks.set(productId, { ...mark, status: "short", reason: "short" });
        continue;
      }
      if (mark.status !== "cold" && ready) {
        host.seedMarks.set(productId, { ...mark, status: "warm", reason: mark.status === "warm" ? mark.reason : "seeded" });
        host.fourFlushed.add(productId);
        continue;
      }
      host.seedMarks.set(productId, mark);
      if (mark.status === "cold") host.cold.add(productId);
    }
    const lastRaw = byKey.get(LAST_RUN_KEY) ?? null;
    if (lastRaw) {
      const prev = JSON.parse(lastRaw) as { outcome?: string; end?: number; redis?: { cmds?: number }; completed?: { end: number; cmds: number; outcome: string } | null };
      if (prev.outcome && prev.outcome !== "running") {
        host.completedRun = prev.completed ?? { end: prev.end ?? 0, cmds: prev.redis?.cmds ?? 0, outcome: prev.outcome };
      } else if (prev.completed) host.completedRun = prev.completed;
    }
    host.seedChecked = true;
  }
  const acct = parseAcctMarker(byKey.get(ACCT_KEY) ?? null);
  if (acct) host.book.acctFromDay = acct.fromDay;
  return {
    ...hot,
    ...(ledger.length > 0 ? { closed: ledger } : {}),
    legs,
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
