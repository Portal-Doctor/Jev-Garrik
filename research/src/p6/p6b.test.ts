import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "bun:test";
import { monthlyClusters, trailingReturns } from "../p5/book";
import { alignedBeta, assignBetas } from "../p5/risk";
import { addDays } from "../p5/stats";
import { latestClusterDate } from "./clusters";
import { assertDailyInventory, dailyByteHash } from "./daily";
import { applyForward, freshBook } from "./engine";
import { entriesToEvents, registeredAConfig, type GeneratedEntry } from "./generate";
import { kellyRulingBody, kellyRulingSupersededBody } from "./kelly";
import { readForwardPick } from "./select";
import { barFromExchangeCandles } from "./rest-bars";
import {
  acceptRestBar,
  applyPublic,
  considerHeartbeatGap,
  dueRest,
  fallbackTradesBar,
  noteRestMiss,
  observeHeartbeat,
  readOnlyResponse,
  restAction,
  startPaperHost,
  writeHostFiles,
} from "./paper-host";

const flags = { priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false };
const dailyRoot = fileURLToPath(new URL("../../data/daily", import.meta.url));

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

test.skipIf(!existsSync(join(dailyRoot, "data-manifest.json")))("daily sqlite bytes match the frozen daily manifest", () => {
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
});

test("the engine loads the stamped A pick and tags every A entry with that config", () => {
  const engine = readFileSync(fileURLToPath(new URL("./engine.ts", import.meta.url)), "utf8");
  expect(engine.includes("ruleExitTs")).toBe(false);
  const book = freshBook({ members: ["ETH-USD", "SOL-USD"] });
  expect(book.aPick?.config).toBe("A55-k3");
  expect(book.aPick?.lookback).toBe(55);
  expect(book.aPick?.k).toBe(3);
  expect(book.config.monthlyASelect).toBe(false);
  const ts = Date.parse("2026-10-15T01:00:00.000Z");
  applyForward(book, { kind: "clock", tsMs: ts });
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
  const book = freshBook({
    members: ["BTC-USD", "ETH-USD", "SOL-USD"],
    aPick: null,
    memberCloses: [
      { productId: "BTC-USD", days: btcDays },
      { productId: "ETH-USD", days: ethDays },
      { productId: "SOL-USD", days: solDays },
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

  const dir = mkdtempSync(join(tmpdir(), "p6-host-"));
  writeHostFiles(dir, host);
  expect(existsSync(join(dir, "status.json"))).toBe(true);
  expect(existsSync(join(dir, "book.json"))).toBe(true);
  expect(readOnlyResponse(host, "GET", "/status").status).toBe(200);
  expect(readOnlyResponse(host, "GET", "/book").status).toBe(200);
  expect(readOnlyResponse(host, "POST", "/book").status).toBe(405);
  expect(JSON.parse(readOnlyResponse(host, "GET", "/status").body).orderChannel).toBe(false);
});
