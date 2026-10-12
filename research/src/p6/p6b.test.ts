import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { monthlyClusters, trailingReturns } from "../p5/book";
import { alignedBeta, assignBetas } from "../p5/risk";
import { addDays } from "../p5/stats";
import type { SourceDay } from "../p3/bar-access";
import { latestClusterDate } from "./clusters";
import { assertDailyInventory, dailyByteHash, verifyDailyStore } from "./daily";
import { applyForward, freshBook } from "./engine";
import { entriesToEvents, forwardBarAnnotation, hourAtrAt, registeredAConfig, type GeneratedEntry } from "./generate";
import { kellyRulingBody, kellyRulingSupersededBody } from "./kelly";
import { FORWARD_PICK_SHA256, readForwardPick } from "./select";
import { barFromExchangeCandles } from "./rest-bars";
import { parsePublicMessage } from "./feed";
import {
  acceptRestBar,
  applyPublic,
  ingestSocketMessage,
  armShard,
  considerHeartbeatGap,
  dueRest,
  fallbackTradesBar,
  framesForShard,
  hostStatus,
  l2SequenceOk,
  loadPaperState,
  noteRest429,
  resumeRestCursor,
  noteRestMiss,
  observeHeartbeat,
  onSocketClosed,
  readOnlyResponse,
  restAction,
  savePaperState,
  startPaperHost,
  type PaperStore,
  writeHostFiles,
} from "./paper-host";

const flags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };
const dailyRoot = fileURLToPath(new URL("../../data/daily", import.meta.url));
/** The manifest is tracked. The sqlite bytes are not, so CI must not hash them. */
const dailyBytes = existsSync(join(dailyRoot, "candles", "00-USD", "2023-10.sqlite"));

test("deleting any daily month throws, including the first and the last", () => {
  const dir = mkdtempSync(join(tmpdir(), "p6-d1-"));
  const rels = ["candles/AAA-USD/2023-10.sqlite", "candles/AAA-USD/2024-06.sqlite", "candles/AAA-USD/2026-09.sqlite"];
  const writeMonths = () => {
    for (const rel of rels) {
      mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
      writeFileSync(join(dir, rel), `bytes ${rel}`);
    }
    writeFileSync(join(dir, "data-manifest.json"), JSON.stringify({ dataRootHash: "not-the-bytes", files: rels.map((path) => ({ path })) }));
  };
  writeMonths();
  expect(() => assertDailyInventory(dir)).not.toThrow();
  const hashed = dailyByteHash(dir);
  expect(hashed.files).toBe(3);
  expect(hashed.dailyRootHash).not.toBe("not-the-bytes");
  expect(hashed.dailyRootHash).toMatch(/^[0-9a-f]{64}$/);
  for (const rel of rels) {
    rmSync(join(dir, rel));
    expect(() => assertDailyInventory(dir)).toThrow(/missing data file/);
    writeFileSync(join(dir, rel), `bytes ${rel}`);
    expect(() => assertDailyInventory(dir)).not.toThrow();
  }
});

test.skipIf(!dailyBytes)("daily sqlite bytes match the frozen daily manifest", () => {
  const hashed = dailyByteHash(dailyRoot);
  expect(hashed.dailyRootHash).toBe("76c41956e5575bb2c3223d168e4c3dd62dbd3725d583aac717ad15a931ef4ad4");
  expect(hashed.files).toBeGreaterThan(0);
}, 180_000);

test("the forward pick is refused when its sidecar does not match the bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "p6-pick-"));
  const reports = join(root, "research/data/reports");
  mkdirSync(reports, { recursive: true });
  const bytes = readFileSync(fileURLToPath(new URL("../../data/reports/p6-forward-a.json", import.meta.url)));
  writeFileSync(join(reports, "p6-forward-a.json"), bytes);
  writeFileSync(join(reports, "p6-forward-a.sha256"), "00  research/data/reports/p6-forward-a.json\n");
  expect(() => readForwardPick(root)).toThrow(/does not match/);
  const actual = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(reports, "p6-forward-a.sha256"), `${actual}  research/data/reports/p6-forward-a.json\n`);
  expect(readForwardPick(root).config).toBe("A55-k3");
  const fake = Buffer.from("{\"chosen\":\"A20-k2\"}");
  const fakeHash = createHash("sha256").update(fake).digest("hex");
  writeFileSync(join(reports, "p6-forward-a.json"), fake);
  writeFileSync(join(reports, "p6-forward-a.sha256"), `${fakeHash}  research/data/reports/p6-forward-a.json\n`);
  expect(FORWARD_PICK_SHA256).toBe("5d6196ac314cb0744612126bb3d6d3c6e1ee2b3a36d87b03a54fe469cc907962");
  expect(() => readForwardPick(root)).toThrow(/5d6196ac/);
});

test("the engine loads the stamped A pick and tags every A entry with that config", () => {
  const engine = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");
  expect(engine.includes("ruleExitTs")).toBe(false);
  expect(() => freshBook({ aPick: null })).toThrow(/refusing a book with no A pick/);
  const book = freshBook({ members: ["ETH-USD", "SOL-USD"] });
  expect(book.aPick?.config).toBe("A55-k3");
  expect(book.aPick?.lookback).toBe(55);
  expect(book.aPick?.k).toBe(3);
  expect(book.config.monthlyASelect).toBe(false);
  const ts = Date.parse("2026-10-15T01:00:00.000Z");
  applyForward(book, { kind: "clock", tsMs: ts });
  applyForward(book, {
    kind: "x1",
    id: "untagged",
    classId: "A",
    productId: "ETH-USD",
    tsMs: ts,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: ts,
    sendTsMs: ts,
    decisionMid: 100,
  });
  expect(book.rejected.some((row) => row.id === "untagged" && row.reason === "a-config")).toBe(true);
  expect(book.positions).toHaveLength(0);
  applyForward(book, {
    kind: "x1",
    id: "tagged",
    classId: "A",
    productId: "ETH-USD",
    tsMs: ts,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: ts,
    sendTsMs: ts,
    decisionMid: 100,
    aConfig: "A55-k3",
  });
  expect(book.positions.find((position) => position.id === "tagged")?.aConfig).toBe("A55-k3");
  applyForward(book, {
    kind: "x1",
    id: "other",
    classId: "A",
    productId: "SOL-USD",
    tsMs: ts,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: ts,
    sendTsMs: ts,
    decisionMid: 100,
    aConfig: "A20-k2",
  });
  expect(book.rejected.some((row) => row.id === "other" && row.reason === "a-config")).toBe(true);
  expect(registeredAConfig(55, 3)).toBe("A55-k3");
  expect(registeredAConfig(20, 2.5)).toBe("A20-k2.5");
  const entry: GeneratedEntry = {
    kind: "x1",
    classId: "A",
    productId: "ETH-USD",
    tsMs: ts,
    nextOpen: 100,
    stop: 90,
    target: null,
    dailyAtr: 1,
    priorDailyCloses: [],
    signalDate: "2026-10-15",
    aConfig: "A55-k3",
  };
  const event = entriesToEvents([entry])[0];
  expect(event?.kind === "x1" && event.aConfig).toBe("A55-k3");
});

test("the Kelly ruling e099c022 is marked superseded without editing the ruling body", () => {
  expect(kellyRulingBody().registeredRiskUsd).toBe(60);
  const mark = kellyRulingSupersededBody();
  expect(mark.superseded).toBe(true);
  expect(mark.supersedesSha256).toBe("e099c0223e35712e78e4b7f0ef19f72d8f312a539a75e4d7f397816f57cd8e48");
  expect(mark.supersededLine).toBe("registeredRiskUsd: 60");
  expect(mark.rulingFileEdited).toBe(false);
  expect(mark.unpromotedRiskUsd).toBe(20);
  expect("registeredRiskUsd" in mark).toBe(false);
});

test("forward clusters and betas match P5 for one month and recompute at the fold start", () => {
  const dates: string[] = [];
  for (let i = 0; i < 220; i += 1) dates.push(addDays("2025-11-01", i));
  let btc = 100;
  let eth = 100;
  let sol = 100;
  const btcDays: { date: string; close: number }[] = [];
  const ethDays: { date: string; close: number }[] = [];
  const solDays: { date: string; close: number }[] = [];
  dates.forEach((date, i) => {
    const shock = Math.sin(i / 3) * 0.02 + ((i % 5) - 2) * 0.003;
    const ethRet = date < "2026-03-01" ? shock : Math.cos(i / 4) * 0.015;
    const solRet = date < "2026-03-01" ? shock : -shock * 0.8;
    btc *= 1 + shock;
    eth *= 1 + ethRet;
    sol *= 1 + solRet;
    btcDays.push({ date, close: btc });
    ethDays.push({ date, close: eth });
    solDays.push({ date, close: sol });
  });
  const names = [
    { productId: "BTC-USD", flags, days: btcDays },
    { productId: "ETH-USD", flags, days: ethDays },
    { productId: "SOL-USD", flags, days: solDays },
  ];
  const march = monthlyClusters(names, ["2026-03-01"]).get("2026-03-01")!;
  const mayMonth = monthlyClusters(names, ["2026-05-01"]).get("2026-05-01")!;
  const fold = monthlyClusters(names, ["2026-05-10"]).get("2026-05-10")!;
  expect(march.get("ETH-USD")).toBe(march.get("SOL-USD"));
  expect(fold.get("ETH-USD")).not.toBe(fold.get("SOL-USD"));
  const betasAt = (asOf: string) =>
    assignBetas([
      { id: "BTC-USD", beta: alignedBeta(btcDays, btcDays, asOf, trailingReturns) },
      { id: "ETH-USD", beta: alignedBeta(ethDays, btcDays, asOf, trailingReturns) },
      { id: "SOL-USD", beta: alignedBeta(solDays, btcDays, asOf, trailingReturns) },
    ]);
  const asDays = (rows: { date: string; close: number }[]): SourceDay[] =>
    rows.map((row) => ({ date: row.date, ts: Date.parse(`${row.date}T00:00:00.000Z`) / 1000, open: row.close, high: row.close, low: row.close, close: row.close, volume: 1, empty: false }));
  const book = freshBook({
    members: ["BTC-USD", "ETH-USD", "SOL-USD"],
    aPick: { config: "A55-k3", lookback: 55, k: 3, at: "2026-03-05", stats: [] },
    memberCloses: [
      { productId: "BTC-USD", flags, days: asDays(btcDays) },
      { productId: "ETH-USD", flags, days: asDays(ethDays) },
      { productId: "SOL-USD", flags, days: asDays(solDays) },
    ],
    btcCloses: btcDays,
  });
  const enter = (id: string, productId: string, day: string) => {
    const ts = Date.parse(`${day}T01:00:00.000Z`);
    applyForward(book, { kind: "clock", tsMs: ts });
    applyForward(book, {
      kind: "x1",
      id,
      classId: "A",
      productId,
      tsMs: ts,
      nextOpen: 100,
      stop: 90,
      atr1h: 1,
      bid: 100,
      ask: 100.1,
      bookTsMs: ts,
      sendTsMs: ts,
      decisionMid: 100,
      aConfig: "A55-k3",
    });
  };
  enter("eth", "ETH-USD", "2026-03-05");
  expect(book.clusterAsOf).toBe("2026-03-01");
  expect(latestClusterDate("2026-03-05")).toBe("2026-03-01");
  expect(book.positions.find((position) => position.id === "eth")?.clusterId).toBe(march.get("ETH-USD"));
  expect(book.betas["ETH-USD"]).toBe(betasAt("2026-03-01").get("ETH-USD"));
  expect(book.betas["SOL-USD"]).toBe(betasAt("2026-03-01").get("SOL-USD"));
  enter("sol", "SOL-USD", "2026-05-02");
  expect(book.clusterAsOf).toBe("2026-05-01");
  expect(book.positions.find((position) => position.id === "sol")?.clusterId).toBe(mayMonth.get("SOL-USD"));
  expect(book.positions.find((position) => position.id === "eth")?.clusterId).toBe(march.get("ETH-USD"));
  applyForward(book, { kind: "clock", tsMs: Date.parse("2026-05-12T00:00:00.000Z") });
  expect(book.clusterAsOf).toBe("2026-05-10");
  expect(latestClusterDate("2026-05-12")).toBe("2026-05-10");
  enter("btc", "BTC-USD", "2026-05-12");
  expect(book.positions.find((position) => position.id === "btc")?.clusterId).toBe(fold.get("BTC-USD"));
  expect(book.betas["BTC-USD"]).toBe(betasAt("2026-05-10").get("BTC-USD"));
  expect(book.positions.find((position) => position.id === "eth")?.clusterId).toBe(march.get("ETH-USD"));
});

test("the public paper host shards, reconnects on a heartbeat gap, and falls back to trades", () => {
  expect(() => startPaperHost(["ETH-USD"], { COINBASE_API_FOO: "present" })).toThrow(/order-capable/);
  const ids = Array.from({ length: 11 }, (_, index) => `N${index}-USD`);
  const wide = startPaperHost(ids, {});
  expect(wide.shards.map((shard) => shard.length)).toEqual([10, 1]);
  expect(wide.frames.some((frame) => frame.includes("\"user\"") || frame.includes("\"orders\""))).toBe(false);
  expect(wide.frames.some((frame) => frame.includes("level2"))).toBe(true);
  expect(wide.frames.some((frame) => frame.includes("market_trades"))).toBe(true);
  expect(wide.frames.some((frame) => frame.includes("heartbeats"))).toBe(true);

  const host = startPaperHost(["ETH-USD"], {});
  observeHeartbeat(host, 0, 0);
  expect(considerHeartbeatGap(host, 0, 16_000)).toBe(true);
  expect(host.reconnects).toBe(1);
  expect(host.gapEvents).toBe(1);
  observeHeartbeat(host, 0, 17_000);
  expect(host.book.heartbeatGaps).toBe(1);
  expect(host.reconnects).toBe(1);

  applyPublic(host, 0, [{ kind: "l2-snapshot", productId: "ETH-USD", bids: [["100", "1"]], asks: [["100.2", "1"]] }], 1_000);
  applyPublic(host, 0, [{ kind: "l2-snapshot", productId: "ETH-USD", bids: [["101", "1"]], asks: [["101.2", "1"]] }], 61_000);
  expect(host.book.mids.completed).toHaveLength(1);
  expect(host.book.mids.completed[0]?.close).toBeCloseTo(100.1, 6);

  const due = dueRest(host, 915_000);
  expect(due.map((row) => row.action)).toEqual(["fetch"]);
  noteRestMiss(host, due[0]!.slot);
  const slot = host.rest.get("ETH-USD:0")!;
  expect(restAction(slot, 920_000)).toBe("wait");
  expect(restAction(slot, 925_000)).toBe("fetch");
  expect(restAction(slot, 1_035_000)).toBe("fallback");
  host.trades.push({ productId: "ETH-USD", tsSec: 100, price: 50, size: 2 });
  const built = fallbackTradesBar(host, slot);
  expect(built?.close).toBe(50);
  expect(host.book.incidents.some((row) => row.includes("trades-built"))).toBe(true);
  expect(host.book.marks["ETH-USD"]).toBe(50);

  const rest = barFromExchangeCandles("ETH-USD", 900, [[900, 1, 3, 2, 2.5, 4]]);
  expect(rest?.open).toBe(2);
  acceptRestBar(host, rest!);
  expect(host.book.marks["ETH-USD"]).toBe(2.5);

  expect(() => writeHostFiles(mkdtempSync(join(tmpdir(), "p6-host-")), host)).toThrow(/data\/runtime/);
  const dir = join(fileURLToPath(new URL("../../data/runtime", import.meta.url)), `p6-host-${process.pid}`);
  writeHostFiles(dir, host);
  expect(existsSync(join(dir, "status.json"))).toBe(true);
  expect(existsSync(join(dir, "book.json"))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
  expect(readOnlyResponse(host, "GET", "/status").status).toBe(200);
  expect(readOnlyResponse(host, "GET", "/book").status).toBe(200);
  expect(readOnlyResponse(host, "POST", "/book").status).toBe(405);
  expect(JSON.parse(readOnlyResponse(host, "GET", "/status").body).orderChannel).toBe(false);
});

test("a shard with no heartbeat reconnects, and silence after that reconnects again", () => {
  const host = startPaperHost(["ETH-USD"], {});
  armShard(host, 0, 0);
  expect(considerHeartbeatGap(host, 0, 16_000)).toBe(true);
  expect(considerHeartbeatGap(host, 0, 17_000)).toBe(false);
  expect(considerHeartbeatGap(host, 0, 32_000)).toBe(true);
  expect(host.reconnects).toBe(2);
  expect(host.gapOpen[0]).toBe(false);
  onSocketClosed(host, 0);
  expect(host.book.incidents.some((row) => row.includes("closed"))).toBe(true);
  expect(considerHeartbeatGap(host, 0, 32_000)).toBe(true);
  expect(l2SequenceOk(null, 4)).toBe(true);
  expect(l2SequenceOk(4, 4)).toBe(true);
  expect(l2SequenceOk(4, 5)).toBe(true);
  expect(l2SequenceOk(4, 6)).toBe(false);
  applyPublic(host, 0, [
    { kind: "l2-update", productId: "ETH-USD", side: "bid", price: "1", size: "1", sequence: 1 },
    { kind: "l2-update", productId: "ETH-USD", side: "bid", price: "2", size: "1", sequence: 1 },
  ], 1);
  expect(host.l2Gaps).toBe(0);
  applyPublic(host, 0, [{ kind: "l2-update", productId: "ETH-USD", side: "bid", price: "1", size: "2", sequence: 3 }], 2);
  expect(host.l2Gaps).toBe(1);
  expect(host.needsReconnect[0]).toBe(true);
  const sent = framesForShard(host, 0);
  expect(sent.length).toBe(3);
  expect(sent.every((frame) => host.frames.includes(frame))).toBe(true);
});

test("socket sequence counts subscriptions, heartbeats, and trades, not only level2", () => {
  const host = startPaperHost(["BTC-USD", "ETH-USD"], {});
  const frame = (sequence_num: number, channel: string, events: unknown[]) =>
    ingestSocketMessage(host, 0, { sequence_num, channel, events }, sequence_num);
  frame(0, "subscriptions", []);
  frame(1, "l2_data", [{
    type: "snapshot",
    product_id: "BTC-USD",
    updates: [
      { side: "bid", price_level: "1", new_quantity: "2" },
      { side: "offer", price_level: "3", new_quantity: "4" },
    ],
  }]);
  frame(2, "heartbeats", []);
  frame(3, "l2_data", [{
    type: "update",
    product_id: "BTC-USD",
    updates: [
      { side: "bid", price_level: "1", new_quantity: "5" },
      { side: "bid", price_level: "1.5", new_quantity: "1" },
    ],
  }]);
  frame(4, "market_trades", [{ trades: [{ product_id: "BTC-USD", price: "2", size: "1", side: "BUY", time: "2026-10-12T00:00:00.000Z" }] }]);
  frame(5, "l2_data", [{ type: "snapshot", product_id: "ETH-USD", updates: [{ side: "bid", price_level: "9", new_quantity: "1" }, { side: "offer", price_level: "10", new_quantity: "1" }] }]);
  expect(host.l2Gaps).toBe(0);
  expect(host.needsReconnect[0]).toBe(false);
  expect(host.book.quotes["BTC-USD"]?.bid).toBe(1.5);
  expect(host.book.quotes["BTC-USD"]?.ask).toBe(3);
  expect(hostStatus(host).quotedProducts).toBe(2);
  frame(7, "l2_data", [{ type: "update", product_id: "ETH-USD", updates: [{ side: "bid", price_level: "9", new_quantity: "2" }] }]);
  expect(host.l2Gaps).toBe(1);
});

test("REST backs off on 429, drops a late bar, and backfills a bounded gap", () => {
  const host = startPaperHost(["ETH-USD", "SOL-USD"], {});
  const due = dueRest(host, 915_000);
  expect(due).toHaveLength(2);
  const slot = due[0]!.slot;
  const attempts = slot.attempts;
  noteRest429(slot, 915_000, 30_000);
  expect(slot.attempts).toBe(attempts);
  expect(restAction(slot, 920_000)).toBe("wait");
  expect(restAction(slot, 1_035_000)).toBe("fetch");
  expect(restAction(slot, 1_035_000 + 30_000)).toBe("fallback");
  host.trades.push({ productId: "ETH-USD", tsSec: 10, price: 4, size: 1 });
  fallbackTradesBar(host, host.rest.get("ETH-USD:0")!);
  const late = acceptRestBar(host, { productId: "ETH-USD", startSec: 0, open: 9, high: 9, low: 9, close: 9, volume: 1 });
  expect(late).toBe("drop-late");
  expect(host.book.marks["ETH-USD"]).toBe(4);
  const later = startPaperHost(["ETH-USD"], {});
  dueRest(later, 915_000);
  dueRest(later, 915_000 + 12 * 900_000);
  const starts = [...later.rest.values()].map((row) => row.barStartSec).sort((a, b) => a - b);
  expect(starts[0]).toBe(0);
  expect(starts).toHaveLength(9);
  expect(starts[starts.length - 1]).toBe(7_200);
});

test("a bar applies once, and a restart continues from the last applied bar", () => {
  const host = startPaperHost(["ETH-USD"], {});
  host.clock = () => 915_000;
  dueRest(host, 915_000);
  const bar = { productId: "ETH-USD", startSec: 0, open: 2, high: 3, low: 1, close: 2.5, volume: 4 };
  expect(acceptRestBar(host, bar)).toBe("accepted");
  expect(acceptRestBar(host, bar)).toBe("already");
  expect(host.fifteen.filter((row) => row.startSec === 0)).toHaveLength(1);
  let saved: ReturnType<PaperStore["load"]> = null;
  const store: PaperStore = {
    load: () => saved,
    save(body) {
      saved = body;
    },
  };
  savePaperState("", host, store);
  const next = startPaperHost(["ETH-USD"], {});
  expect(loadPaperState("", next, store)).toBe(true);
  expect(next.restCursor.get("ETH-USD")).toBe(900);
  expect(acceptRestBar(next, bar)).toBe("already");
  const scheduled = startPaperHost(["ETH-USD"], {});
  dueRest(scheduled, 915_000);
  expect(scheduled.restCursor.get("ETH-USD")).toBe(900);
  let pending: ReturnType<PaperStore["load"]> = null;
  const pendingStore: PaperStore = {
    load: () => pending,
    save(body) {
      pending = body;
    },
  };
  savePaperState("", scheduled, pendingStore);
  const resumed = startPaperHost(["ETH-USD"], {});
  expect(loadPaperState("", resumed, pendingStore)).toBe(true);
  expect(resumed.restCursor.get("ETH-USD")).toBe(0);
  expect(resumeRestCursor(8_100, undefined)).toBe(900);
  expect(resumeRestCursor(8_100, 7_200)).toBe(8_100);
});

test("trades use the exchange time and the maker side", () => {
  const host = startPaperHost(["BTC-USD"], {});
  const [trade] = parsePublicMessage({
    channel: "market_trades",
    events: [{ trades: [{ product_id: "BTC-USD", price: "10", size: "2", time: "2026-10-12T00:00:30.000Z", side: "SELL" }] }],
  });
  expect(trade?.kind === "trade" && trade.side).toBe("SELL");
  applyPublic(host, 0, [trade!], Date.parse("2026-10-12T00:05:00.000Z"));
  expect(host.trades[0]?.tsSec).toBe(Date.parse("2026-10-12T00:00:30.000Z") / 1000);
  const [bare] = parsePublicMessage({ channel: "market_trades", events: [{ trades: [{ product_id: "BTC-USD", price: "9.9", size: "4" }] }] });
  expect(bare?.kind === "trade" && bare.side).toBeUndefined();
  applyPublic(host, 0, [bare!], 1_000);
  expect(host.book.legs.filter((leg) => leg.side === "entry")).toHaveLength(0);
});

test("a stale level2 snapshot rejects the entry and the exit leg records it", () => {
  const book = freshBook({ members: ["ETH-USD"] });
  const ts = Date.parse("2026-10-15T01:00:00.000Z");
  applyForward(book, { kind: "clock", tsMs: ts });
  applyForward(book, {
    kind: "x1",
    id: "stale",
    classId: "A",
    productId: "ETH-USD",
    tsMs: ts,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: ts - 20_000,
    sendTsMs: ts,
    decisionMid: 100,
    aConfig: "A55-k3",
  });
  expect(book.rejected.some((row) => row.id === "stale" && row.reason === "missed_send_stale_quote")).toBe(true);
  applyForward(book, {
    kind: "x1",
    id: "fresh",
    classId: "B",
    productId: "ETH-USD",
    tsMs: ts,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: ts,
    sendTsMs: ts,
    decisionMid: 100,
  });
  const start = Math.floor(ts / 1000) + 86_400;
  applyForward(book, { kind: "bar15", productId: "ETH-USD", startSec: start, nowSec: start + 900, open: 80, high: 81, low: 70, close: 80 });
  const exit = book.legs.find((leg) => leg.side === "exit");
  expect(exit?.stale).toBe(true);
  expect(book.closed[0]?.exitKind).toBe("stop");
});

test("the book reloads from the runtime file and ignores a mutated pick", () => {
  const host = startPaperHost(["ETH-USD"], {});
  const ts = Date.parse("2026-10-15T01:00:00.000Z");
  applyForward(host.book, { kind: "clock", tsMs: ts });
  applyForward(host.book, {
    kind: "x1",
    id: "kept",
    classId: "A",
    productId: "ETH-USD",
    tsMs: ts,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.1,
    bookTsMs: ts,
    sendTsMs: ts,
    decisionMid: 100,
    aConfig: "A55-k3",
  });
  const dir = join(fileURLToPath(new URL("../../data/runtime", import.meta.url)), `p6-state-${process.pid}`);
  savePaperState(dir, host);
  const next = startPaperHost(["ETH-USD"], {});
  expect(loadPaperState(dir, next)).toBe(true);
  expect(next.book.positions[0]?.id).toBe("kept");
  expect(next.book.aPick?.config).toBe("A55-k3");
  const saved = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as { aPickConfig: string };
  saved.aPickConfig = "A20-k2";
  writeFileSync(join(dir, "state.json"), JSON.stringify(saved));
  const reloaded = startPaperHost(["ETH-USD"], {});
  loadPaperState(dir, reloaded);
  expect(reloaded.book.aPick?.config).toBe("A55-k3");
  expect(reloaded.book.incidents.some((row) => row.includes("saved A pick"))).toBe(true);
  rmSync(dir, { recursive: true, force: true });
});

test("a 15m bar carries 1h ATR, daily ATR, and the day-close flag", () => {
  const hour = Array.from({ length: 20 }, (_, index) => ({
    ts: index * 3_600,
    open: 100,
    high: 100 + index,
    low: 99,
    close: 100 + index * 0.1,
    volume: 1,
  }));
  expect(hourAtrAt(hour, 20 * 3_600)).toBeGreaterThan(0);
  const dayClose = 86_400 - 900;
  const note = forwardBarAnnotation({ entries: [], weeks: [{ date: "1970-01-01", rows: [{ id: "ETH-USD", score: 1, member: true }] }], atrByProduct: new Map([["ETH-USD", new Map([["1970-01-01", 2]])]]) }, hour, "ETH-USD", dayClose);
  expect(note.dailyClose).toBe(true);
  expect(note.dailyAtr).toBe(2);
  expect(note.bScores?.[0]?.id).toBe("ETH-USD");
  expect(note.atr1h).toBeGreaterThan(0);
});

test("daily bytes can be checked for a member subset, and a corrupt or extra file still throws", () => {
  const dir = mkdtempSync(join(tmpdir(), "p6-members-"));
  const rels = ["candles/BTC-USD/2024-01.sqlite", "candles/ETH-USD/2024-01.sqlite", "candles/SOL-USD/2024-06.sqlite"];
  const files = rels.map((path) => {
    mkdirSync(join(dir, path.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(join(dir, path), `bytes ${path}`);
    return { path, sha256: createHash("sha256").update(`bytes ${path}`).digest("hex"), bytes: `bytes ${path}`.length };
  });
  writeFileSync(join(dir, "data-manifest.json"), JSON.stringify({ files }));
  const full = verifyDailyStore(dir);
  expect(full.mode).toBe("full");
  expect(full.files).toBe(3);
  rmSync(join(dir, rels[2]!));
  const subset = verifyDailyStore(dir, ["ETH-USD"]);
  expect(subset.mode).toBe("members");
  expect(subset.files).toBe(2);
  expect(() => verifyDailyStore(dir, ["SOL-USD"])).toThrow(/missing data file/);
  writeFileSync(join(dir, rels[2]!), `bytes ${rels[2]}`);
  writeFileSync(join(dir, rels[0]!), "nope");
  expect(() => verifyDailyStore(dir, ["ETH-USD"])).toThrow(/do not match/);
  writeFileSync(join(dir, rels[0]!), `bytes ${rels[0]}`);
  const extra = "candles/DOGE-USD/2024-01.sqlite";
  mkdirSync(join(dir, "candles/DOGE-USD"), { recursive: true });
  writeFileSync(join(dir, extra), "extra");
  expect(() => verifyDailyStore(dir, ["ETH-USD"])).toThrow(/not in the manifest/);
});
