import { readFileSync } from "node:fs";
import { expect, test } from "bun:test";
import { DEPLOYABLE_USD } from "../../vendor/87b35d0/config.ts";
import { CLUSTER_MAX_OPEN, OPEN_RISK_CAP_USD } from "../p3/design-rules";
import { readP6Page } from "./dashboard-read";
import { freshBook, openExitCostUsd, paperPnl, replayInjected, type Book, type ForwardEvent, type Position } from "./engine";
import { captureHot, persistSplit } from "./hot-store";
import { startPaperHost } from "./paper-host";
import {
  CASH_LABEL,
  CHECKS_INCOMPLETE,
  CHECKS_SKIPPED,
  EMPTY_POSITIONS,
  ENTRY_FEE_NOTE,
  MARK_FALLBACK,
  POSITION_FIELD_CAP,
  POSITION_ROW_CAP,
  POSITIONS_IDENTITY,
  POSITIONS_UNREPORTED,
  STABLECOIN_NOTE,
  ageText,
  formatUsd,
  positionSnapBuild,
  positionSnaps,
  positionsFooter,
  snapBytes,
  type PositionSnap,
} from "./positions-view";
import { memoryKv, tryAcquire, decodeLease, LEASE_KEY } from "./relay";

const SAT = Date.parse("2026-10-17T12:00:00.000Z");

function x1(id: string, productId: string, tsMs: number, stop: number): ForwardEvent {
  return {
    kind: "x1",
    id,
    classId: "C",
    productId,
    tsMs,
    nextOpen: 100,
    stop,
    atr1h: 1,
    bid: 100,
    ask: 100,
    bookTsMs: tsMs,
    sendTsMs: tsMs + 5,
    decisionMid: 100,
  };
}

function openTakers(products: readonly string[]): Book {
  const events: ForwardEvent[] = [{ kind: "clock", tsMs: SAT - 60_000 }];
  products.forEach((productId, index) => events.push(x1(`c${index}`, productId, SAT, 90)));
  return replayInjected(events);
}

function viewOf(book: Book, nowMs = SAT, equityUsd?: number) {
  const pnl = paperPnl(book);
  return positionsFooter({
    snaps: positionSnaps(book),
    nowMs,
    markTs: SAT,
    equityUsd: equityUsd ?? pnl.equityUsd,
    realizedUsd: pnl.realizedUsd,
    unrealizedUsd: pnl.unrealizedUsd,
    startingUsd: pnl.startingUsd,
  });
}

test("flat, one, and several positions tie cash + active - exit costs to equity", () => {
  expect(POSITIONS_IDENTITY).toContain("equity = cash + total active investment - est. exit costs");
  const flat = viewOf(freshBook());
  expect(flat.empty).toBe(true);
  expect(flat.activeUsd).toBe(0);
  expect(flat.exitCostUsd).toBe(0);
  expect(flat.atCostUsd).toBe(0);
  expect(flat.cashUsd).toBe(DEPLOYABLE_USD);
  expect(flat.cashUsd).toBe(flat.equityUsd);
  expect(flat.reconciled).toBe(true);
  expect(flat.checkText).toBe("reconciled");
  expect(flat.unrealizedMatch).toBe(true);
  expect(flat.riskText).toBe(`open risk $0.00 of $${OPEN_RISK_CAP_USD} cap`);
  expect(flat.clusters).toEqual([]);

  const one = openTakers(["ETH-USD"]);
  const eth = one.positions[0]!;
  one.marks["ETH-USD"] = 101;
  const single = viewOf(one);
  const exit = openExitCostUsd(one, eth, 101);
  const cost = eth.units * eth.fillPrice + eth.entryFeeUsd;
  expect(single.rows).toHaveLength(1);
  expect(single.rows[0]!.markSrc).toBeUndefined();
  expect(single.activeUsd).toBeCloseTo(101 * eth.units, 6);
  expect(single.atCostUsd).toBeCloseTo(cost, 6);
  expect(single.exitCostUsd).toBeCloseTo(exit, 6);
  expect(single.cashUsd).toBeCloseTo(DEPLOYABLE_USD - cost, 6);
  expect(single.tieUsd).toBeCloseTo(single.equityUsd, 6);
  expect(single.reconciled).toBe(true);
  expect(single.rowUnrealizedUsd).toBeCloseTo(single.openUnrealizedUsd, 6);
  expect(single.unrealizedText).toBe("row unrealized matches open now");
  expect(single.rows[0]!.unrealized).toBeCloseTo(101 * eth.units - exit - cost, 6);
  expect(single.rows[0]!.netR).toBeCloseTo(single.rows[0]!.unrealized / eth.riskUsd, 6);

  const two = openTakers(["ETH-USD", "SOL-USD"]);
  two.marks["ETH-USD"] = 101;
  two.marks["SOL-USD"] = 99;
  const several = viewOf(two);
  expect(several.rows).toHaveLength(2);
  expect(several.rows.map((row) => row.product).sort()).toEqual(["ETH-USD", "SOL-USD"]);
  expect(several.activeUsd).toBeCloseTo(several.rows.reduce((sum, row) => sum + row.notional, 0), 8);
  expect(Math.abs(several.tieUsd - several.equityUsd)).toBeLessThanOrEqual(0.01);
  expect(several.reconciled).toBe(true);
  expect(several.unrealizedMatch).toBe(true);
  expect(several.riskUsd).toBeCloseTo(several.rows.reduce((sum, row) => sum + row.risk, 0), 8);
  expect(several.clusters.every((row) => row.text.endsWith(`of max ${CLUSTER_MAX_OPEN}`))).toBe(true);
});

test("a second class on the same product stays its own row", () => {
  const book = openTakers(["ETH-USD"]);
  const first = book.positions[0]!;
  book.marks["ETH-USD"] = 100;
  const copy: Position = { ...first, id: "c-d", classId: "D", clusterId: first.clusterId };
  book.positions.push(copy);
  const view = viewOf(book);
  expect(view.rows.map((row) => row.id).sort()).toEqual(["c-d", first.id].sort());
  expect(view.rows.every((row) => row.product === "ETH-USD")).toBe(true);
  expect(view.clusters).toEqual([{ id: first.clusterId, n: 2, text: `${first.clusterId}: 2 of max ${CLUSTER_MAX_OPEN}` }]);
  expect(view.reconciled).toBe(true);
});

test("a missing mark falls back to the fill and a stale snapshot is flagged", () => {
  const book = openTakers(["ETH-USD"]);
  delete book.marks["ETH-USD"];
  const view = viewOf(book);
  expect(view.rows[0]!.markSrc).toBe("entry");
  expect(view.rows[0]!.mark).toBe(view.rows[0]!.fill);
  expect(MARK_FALLBACK).toBe("entry (no mark)");
  expect(view.reconciled).toBe(true);
  const stale = positionsFooter({
    snaps: positionSnaps(book),
    nowMs: SAT + 20 * 60 * 1000 + 1,
    markTs: SAT,
    equityUsd: paperPnl(book).equityUsd,
    realizedUsd: 0,
    unrealizedUsd: paperPnl(book).unrealizedUsd,
  });
  expect(stale.stale).toBe(true);
  const exact = positionsFooter({
    snaps: [],
    nowMs: SAT + 20 * 60 * 1000,
    markTs: SAT,
    equityUsd: DEPLOYABLE_USD,
    realizedUsd: 0,
    unrealizedUsd: 0,
  });
  expect(exact.stale).toBe(false);
  expect(ageText(3_600_000 + 60_000)).toBe("1h 1m");
});

test("a forced gap, negative cash, and a non-long side fail the check", () => {
  const book = openTakers(["ETH-USD"]);
  book.marks["ETH-USD"] = 100;
  const off = viewOf(book, SAT, paperPnl(book).equityUsd + 5);
  expect(off.reconciled).toBe(false);
  expect(off.checkText).toBe("NOT RECONCILED by $5.00");
  const snap = positionSnaps(book)[0]!;
  const fat: PositionSnap = { ...snap, u: 1_000, f: 100, e: 0, n: 100_000, ur: 0, x: 0, r: 20 };
  const negative = positionsFooter({
    snaps: [fat],
    nowMs: SAT,
    markTs: SAT,
    equityUsd: DEPLOYABLE_USD,
    realizedUsd: 0,
    unrealizedUsd: 0,
  });
  expect(negative.cashUsd).toBeCloseTo(DEPLOYABLE_USD - 100_000, 6);
  expect(negative.cashUsd).toBeLessThan(0);
  expect(negative.problems).toContain("negative cash");
  expect(negative.reconciled).toBe(true);
  const short = positionsFooter({
    snaps: [{ ...snap, side: "short" }],
    nowMs: SAT,
    markTs: SAT,
    equityUsd: paperPnl(book).equityUsd,
    realizedUsd: 0,
    unrealizedUsd: paperPnl(book).unrealizedUsd,
  });
  expect(short.problems).toContain("unsupported balance/side");
  expect(short.reconciled).toBe(true);
  const usdt = positionsFooter({
    snaps: [snap],
    nowMs: SAT,
    markTs: SAT,
    equityUsd: paperPnl(book).equityUsd,
    realizedUsd: 0,
    unrealizedUsd: paperPnl(book).unrealizedUsd,
    currency: "USDT",
  });
  expect(usdt.problems).toContain("unsupported balance/side");
});

function markOf(book: Book, position: Position): number {
  const price = book.marks[position.productId];
  return typeof price === "number" && Number.isFinite(price) ? price : position.fillPrice;
}

test("row exit costs are the engine term and the identity does not use the reconcile band", () => {
  const live = openTakers(["ETH-USD", "SOL-USD"]);
  live.positions[0]!.sLiveBps = 4;
  live.positions[1]!.sLiveBps = 11;
  live.marks["ETH-USD"] = 103;
  live.marks["SOL-USD"] = 97;
  const parity = replayInjected(
    [
      { kind: "clock", tsMs: SAT - 60_000 },
      x1("p0", "ETH-USD", SAT, 90),
      x1("p1", "BTC-USD", SAT, 90),
    ],
    { parity: { riskUsd: 20, sBtBps: 8 }, members: ["ETH-USD", "BTC-USD"] },
  );
  parity.marks["ETH-USD"] = 110;
  parity.marks["BTC-USD"] = 94;
  for (const book of [live, parity]) {
    const snaps = positionSnaps(book);
    const pnl = paperPnl(book);
    let engineExit = 0;
    let active = 0;
    let cost = 0;
    let mtm = 0;
    for (const position of book.positions) {
      const mark = markOf(book, position);
      const row = snaps.find((snap) => snap.id === position.id)!;
      const notional = mark * position.units;
      const basis = position.units * position.fillPrice + position.entryFeeUsd;
      const exit = openExitCostUsd(book, position, mark);
      const roundedExit = Math.round(exit * 1e8) / 1e8;
      engineExit += exit;
      active += notional;
      cost += basis;
      mtm += notional - exit - basis;
      expect(row.x).toBe(roundedExit);
      expect(Math.abs(row.x - exit)).toBeLessThanOrEqual(1e-8);
    }
    expect(Math.abs(snaps.reduce((sum, row) => sum + row.x, 0) - engineExit)).toBeLessThanOrEqual(1e-8 * snaps.length);
    const cash = pnl.startingUsd + pnl.realizedUsd - cost;
    expect(pnl.equityUsd).toBe(pnl.startingUsd + pnl.realizedUsd + mtm);
    expect(pnl.equityUsd).toBe(cash + active - engineExit);
    const charged = book.positions.filter((position) => position.entryFeeUsd > 0);
    expect(charged.length).toBeGreaterThan(0);
    const view = positionsFooter({
      snaps,
      nowMs: SAT,
      markTs: SAT,
      equityUsd: pnl.equityUsd,
      realizedUsd: pnl.realizedUsd,
      unrealizedUsd: pnl.unrealizedUsd,
      startingUsd: pnl.startingUsd,
    });
    for (const position of charged) {
      const row = view.rows.find((item) => item.id === position.id)!;
      expect(row.entryFee).toBeGreaterThan(0);
      expect(row.costBasisUsd).toBe(row.units * row.fill + row.entryFee);
    }
    const tie = view.cashUsd + view.activeUsd - view.exitCostUsd;
    expect(Math.abs(tie - pnl.equityUsd)).toBeLessThanOrEqual(0.01);
  }
});

test("sixteen position rows stay under 3 KB and lastRun is the only new home", async () => {
  const book = openTakers(["ETH-USD"]);
  book.marks["ETH-USD"] = 101;
  const base = positionSnaps(book)[0]!;
  const rows = Array.from({ length: 16 }, (_, index) => ({ ...base, id: `c${index}`, p: `P${index}-USD`, k: `P${index}-USD` }));
  expect(snapBytes(rows)).toBeLessThan(3_072);
  expect(snapBytes(rows) / 16).toBeLessThan(220);
  const host = startPaperHost(["ETH-USD"], {});
  host.clock = () => SAT;
  host.book = book;
  const kv = memoryKv();
  expect(await tryAcquire(kv, "K", SAT + 86_400_000, SAT)).toBe(true);
  host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
  let flushes = 0;
  const owned = kv.ownedFlush.bind(kv);
  kv.ownedFlush = async (...args) => {
    flushes += 1;
    return owned(...args);
  };
  await persistSplit(kv, host);
  expect(flushes).toBe(1);
  const last = JSON.parse((await kv.get("p6:lastRun")) ?? "{}") as { positions?: PositionSnap[] };
  expect(last.positions).toHaveLength(1);
  const storedExit = openExitCostUsd(book, book.positions[0]!, 101);
  expect(last.positions?.[0]?.x).toBe(Math.round(storedExit * 1e8) / 1e8);
  expect(Math.abs((last.positions?.[0]?.x ?? 0) - storedExit)).toBeLessThanOrEqual(1e-8);
  expect(JSON.stringify(captureHot(host))).not.toContain("exitCost");
  expect(await kv.get("p6:positions")).toBeNull();
  let reads = 0;
  const reader = {
    mget: async (keys: string[]) => {
      reads += 1;
      return kv.mget(keys);
    },
  };
  await readP6Page(reader, SAT);
  expect(reads).toBe(2);
});

test("a missing positions array is not an empty book", () => {
  const base = { nowMs: SAT, markTs: SAT, equityUsd: 8050, realizedUsd: 50, unrealizedUsd: 0, startingUsd: 8000 };
  const missing = positionsFooter({ ...base, snaps: null });
  expect(missing.reported).toBe(false);
  expect(missing.empty).toBe(false);
  expect(missing.checkText).toBe(CHECKS_SKIPPED);
  expect(missing.checkText).not.toBe("reconciled");
  expect(missing.unrealizedText).toBe(CHECKS_SKIPPED);
  expect(POSITIONS_UNREPORTED).toBe("positions not yet reported");
  const flat = positionsFooter({ ...base, snaps: [], equityUsd: 8050 });
  expect(flat.reported).toBe(true);
  expect(flat.empty).toBe(true);
  expect(flat.checkText).toBe("reconciled");
  expect(flat.cashUsd).toBe(8050);
});

test("position rows cap at 64 and product, class, id, and cluster cap at 32", () => {
  const book = openTakers(["ETH-USD"]);
  const seed = book.positions[0]!;
  const longId = `C-ETH-USD-${"1790".repeat(12)}`;
  book.positions = Array.from({ length: POSITION_ROW_CAP + 1 }, (_, index) => ({
    ...seed,
    id: `${longId}-${index}`,
    productId: `${"PAIR".repeat(20)}-${index}`,
    classId: "C".repeat(40) as Position["classId"],
    clusterId: `CLUSTER-${"X".repeat(40)}-${index}`,
  }));
  const built = positionSnapBuild(book);
  expect(built.snaps).toHaveLength(POSITION_ROW_CAP);
  expect(built.omitted).toBe(1);
  expect(built.skipped).toBe(0);
  expect(built.snaps[0]!.p).toHaveLength(POSITION_FIELD_CAP);
  expect(built.snaps[0]!.c).toHaveLength(POSITION_FIELD_CAP);
  expect(built.snaps[0]!.id).toHaveLength(POSITION_FIELD_CAP);
  expect(built.snaps[0]!.k).toHaveLength(POSITION_FIELD_CAP);
  expect(POSITION_ROW_CAP).toBe(64);
  expect(POSITION_FIELD_CAP).toBe(32);
  const raw = Array.from({ length: POSITION_ROW_CAP + 1 }, (_, index) => ({
    ...built.snaps[0]!,
    id: `${"i".repeat(40)}${index}`,
    k: "k".repeat(40),
    p: "p".repeat(40),
  }));
  const view = positionsFooter({
    snaps: raw,
    nowMs: SAT,
    markTs: SAT,
    equityUsd: paperPnl(book).equityUsd,
    realizedUsd: 0,
    unrealizedUsd: 0,
  });
  expect(view.rows).toHaveLength(POSITION_ROW_CAP);
  expect(view.omitted).toBe(1);
  expect(view.reconciled).toBe(false);
  expect(view.unrealizedMatch).toBe(false);
  expect(view.checkText).toBe(CHECKS_INCOMPLETE);
  expect(view.unrealizedText).toBe(CHECKS_INCOMPLETE);
  expect(view.rows[0]!.id).toHaveLength(POSITION_FIELD_CAP);
  expect(view.rows[0]!.cluster).toHaveLength(POSITION_FIELD_CAP);
  expect(view.rows[0]!.product).toHaveLength(POSITION_FIELD_CAP);
  expect(CHECKS_INCOMPLETE).toBe("checks incomplete");
});

test("the page renders the positions footer and does not write", () => {
  const page = readFileSync(new URL("../../../web/src/app/p6/page.tsx", import.meta.url), "utf8");
  expect(page.includes("positionsFooter")).toBe(true);
  expect(page.includes("EMPTY_POSITIONS")).toBe(true);
  expect(page.includes("POSITIONS_UNREPORTED")).toBe(true);
  expect(page.includes("CHECKS_SKIPPED")).toBe(true);
  expect(page.includes("as of last run")).toBe(true);
  expect(page.includes("!view.reported")).toBe(true);
  expect(page.includes("CASH_LABEL")).toBe(true);
  expect(page.includes("STABLECOIN_NOTE")).toBe(true);
  expect(page.includes("ENTRY_FEE_NOTE")).toBe(true);
  expect(page.includes("MARK_FALLBACK")).toBe(true);
  expect(page.includes("total active investment")).toBe(true);
  expect(page.includes("est. exit costs")).toBe(true);
  expect(page.includes("already deducted in unrealized")).toBe(true);
  expect(page.includes("cash balance")).toBe(true);
  expect(page.includes("= equity")).toBe(true);
  expect(page.includes("view.checkText")).toBe(true);
  expect(page.includes("view.riskText")).toBe(true);
  expect(page.includes("view.unrealizedText")).toBe(true);
  expect(page.includes("positions not shown")).toBe(true);
  expect(page.includes("formatUsd(view.cashUsd)")).toBe(true);
  expect(page.includes("positionsOmitted")).toBe(true);
  expect(page.includes("positionsSkipped")).toBe(true);
  expect(page.includes("tileMarkedGrey(tile)")).toBe(true);
  expect(page.includes("tile.since")).toBe(true);
  expect(page.includes("tile.anchorLabel")).toBe(true);
  expect(page.split("trades unknown").length - 1).toBe(2);
  expect(page.includes("tile.hourNote")).toBe(true);
  expect(page.includes("partial")).toBe(false);
  expect(page.includes("of max 2")).toBe(false);
  expect(page.includes("of max 3")).toBe(false);
  const viewSrc = readFileSync(new URL("./positions-view.ts", import.meta.url), "utf8");
  expect(viewSrc.includes("CLUSTER_MAX_OPEN")).toBe(true);
  expect(viewSrc.includes("of max ${CLUSTER_MAX_OPEN}")).toBe(true);
  expect(viewSrc.includes("of max 2")).toBe(false);
  expect(viewSrc.includes("of max 3")).toBe(false);
  expect(/of max \d/.test(viewSrc)).toBe(false);
  expect(/of max \d/.test(page)).toBe(false);
  expect(page.includes("ownedFlush")).toBe(false);
  expect(page.includes(".set(")).toBe(false);
  expect(formatUsd(-2121.6)).toBe("-$2,121.60");
  expect(formatUsd(2121.6)).toBe("$2,121.60");
  expect(formatUsd(0)).toBe("$0.00");
  expect(EMPTY_POSITIONS).toBe("No open positions");
  expect(CASH_LABEL).toBe("USD (paper, derived)");
  expect(STABLECOIN_NOTE).toBe("book holds no stablecoins");
  expect(ENTRY_FEE_NOTE).toBe("unrealized includes the entry fee");
});

test("a one-cent gap reconciles and 1.1 cents does not, on both checks", () => {
  const base = { snaps: [] as PositionSnap[], nowMs: SAT, markTs: SAT, realizedUsd: 0, unrealizedUsd: 0, startingUsd: 8000 };
  const cent = positionsFooter({ ...base, equityUsd: 8000.01 });
  expect(cent.gapUsd).toBeCloseTo(-0.01, 10);
  expect(cent.reconciled).toBe(true);
  expect(cent.checkText).toBe("reconciled");
  const dust = positionsFooter({ ...base, equityUsd: 8000 - 0.0100000000002 });
  expect(Math.abs(dust.gapUsd)).toBeGreaterThan(0.01);
  expect(dust.reconciled).toBe(true);
  const over = positionsFooter({ ...base, equityUsd: 8000.011 });
  expect(over.reconciled).toBe(false);
  expect(over.checkText.startsWith("NOT RECONCILED")).toBe(true);
  const rowCent = positionsFooter({ ...base, equityUsd: 8000, unrealizedUsd: 0.01 });
  expect(rowCent.reconciled).toBe(true);
  expect(rowCent.unrealizedMatch).toBe(true);
  expect(rowCent.unrealizedText).toBe("row unrealized matches open now");
  const rowOver = positionsFooter({ ...base, equityUsd: 8000, unrealizedUsd: 0.011 });
  expect(rowOver.reconciled).toBe(true);
  expect(rowOver.unrealizedMatch).toBe(false);
  expect(rowOver.unrealizedText).toBe("row unrealized does not match open now");
  const loose = positionsFooter({ ...base, equityUsd: 8000.02 });
  expect(loose.reconciled).toBe(false);
  const tenth = positionsFooter({ ...base, equityUsd: 8000.1, unrealizedUsd: 0.1 });
  expect(tenth.reconciled).toBe(false);
  expect(tenth.unrealizedMatch).toBe(false);
});

test("a zero mark leaves the stop distance blank", () => {
  const book = openTakers(["ETH-USD"]);
  const snap = positionSnaps(book)[0]!;
  const view = positionsFooter({
    snaps: [{ ...snap, m: 0 }],
    nowMs: SAT,
    markTs: SAT,
    equityUsd: paperPnl(book).equityUsd,
    realizedUsd: 0,
    unrealizedUsd: paperPnl(book).unrealizedUsd,
  });
  expect(view.rows[0]!.stopDistancePct).toBeNull();
});

test("a malformed position is skipped and the flush still writes", async () => {
  const book = openTakers(["ETH-USD"]);
  book.positions.push({ productId: "ETH-USD" } as unknown as Position);
  const built = positionSnapBuild(book);
  expect(built.skipped).toBe(1);
  expect(built.snaps).toHaveLength(1);
  const only = freshBook();
  only.positions.push({ productId: "BTC-USD" } as unknown as Position);
  expect(positionSnapBuild(only)).toEqual({ snaps: [], omitted: 0, skipped: 1 });
  const host = startPaperHost(["ETH-USD"], {});
  host.clock = () => SAT;
  host.book = book;
  const kv = memoryKv();
  expect(await tryAcquire(kv, "K", SAT + 86_400_000, SAT)).toBe(true);
  host.leaseToken = decodeLease(await kv.get(LEASE_KEY))?.token ?? null;
  await persistSplit(kv, host);
  const last = JSON.parse((await kv.get("p6:lastRun")) ?? "{}") as {
    positions?: PositionSnap[];
    positionsSkipped?: number;
    pnl?: { equityUsd: number; realizedUsd: number; unrealizedUsd: number; startingUsd: number };
  };
  expect(last.positionsSkipped).toBe(1);
  expect(last.positions).toHaveLength(1);
  const view = positionsFooter({
    snaps: last.positions ?? [],
    skipped: last.positionsSkipped,
    nowMs: SAT,
    markTs: SAT,
    equityUsd: last.pnl?.equityUsd ?? 0,
    realizedUsd: last.pnl?.realizedUsd ?? 0,
    unrealizedUsd: last.pnl?.unrealizedUsd ?? 0,
    startingUsd: last.pnl?.startingUsd,
  });
  expect(view.reconciled).toBe(false);
  expect(view.checkText).toBe(CHECKS_INCOMPLETE);
  expect(view.checkText).not.toBe("reconciled");
});

test("sixteen realistic rows stay under 3 KB", () => {
  const book = openTakers(["ETH-USD"]);
  book.marks["ETH-USD"] = 101;
  const seed = book.positions[0]!;
  const products = ["ETH-USD", "SOL-USD", "BTC-USD", "AVAX-USD", "LINK-USD", "DOGE-USD", "ADA-USD", "DOT-USD", "ATOM-USD", "NEAR-USD", "APT-USD", "SUI-USD", "LTC-USD", "BCH-USD", "UNI-USD", "AAVE-USD"];
  book.positions = products.map((productId, index) => {
    book.marks[productId] = 101;
    return {
      ...seed,
      id: `C-${productId}-${SAT + index}`,
      productId,
      clusterId: productId,
    };
  });
  const built = positionSnapBuild(book);
  expect(built.omitted).toBe(0);
  expect(built.snaps).toHaveLength(16);
  expect(built.snaps[0]!.k).toBeUndefined();
  expect(snapBytes(built.snaps)).toBeLessThan(3_072);
  expect(snapBytes(built.snaps) / 16).toBeLessThan(220);
});
