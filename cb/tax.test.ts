import { test, expect } from "bun:test";
import { buildTax, taxLotsCsv } from "./tax";
import type { FillRow } from "./db/store";

const fill = (over: Partial<FillRow>): FillRow => ({
  id: crypto.randomUUID(),
  run_id: "r",
  order_id: null,
  venue: "paper",
  external_id: crypto.randomUUID(),
  pair: "SOL-USD",
  side: "buy",
  price: 100,
  size_base: 1,
  notional_usd: 100,
  fee_usd: 0,
  liquidity: "maker",
  cost_basis_usd: 0,
  proceeds_usd: 0,
  source: "paper_sim",
  traded_at: 0,
  recorded_at: 0,
  ...over,
});

test("round trip buy then sell realizes proceeds minus fee-inclusive basis", () => {
  const t0 = Date.UTC(2026, 8, 1);
  const t1 = Date.UTC(2026, 8, 2);
  const report = buildTax(
    [
      fill({ side: "buy", size_base: 1, notional_usd: 1000, fee_usd: 5, price: 1000, traded_at: t0 }),
      fill({ side: "sell", size_base: 1, notional_usd: 1100, fee_usd: 5.5, price: 1100, traded_at: t1 }),
    ],
    { venue: "paper" },
  );
  expect(report.totals.realizedUsd).toBeCloseTo(1100 - 5.5 - 1005, 9);
  expect(report.totals.openLots).toBe(0);
  expect(report.lots).toHaveLength(1);
  expect(report.lots[0]!.holdMs).toBe(t1 - t0);
  expect(report.lines[0]!.kind).toBe("open");
  expect(report.lines[1]!.kind).toBe("close");
  expect(report.months[0]!.month).toBe("2026-09");
});

test("partial close keeps the leftover lot open", () => {
  const report = buildTax(
    [
      fill({ side: "buy", size_base: 2, notional_usd: 200, fee_usd: 2, price: 100, traded_at: 1 }),
      fill({ side: "sell", size_base: 1, notional_usd: 120, fee_usd: 1, price: 120, traded_at: 2 }),
    ],
    { venue: "paper" },
  );
  expect(report.totals.realizedUsd).toBeCloseTo(119 - 101, 9);
  expect(report.pairs[0]!.openSize).toBeCloseTo(1, 9);
  expect(report.pairs[0]!.openSide).toBe("long");
  expect(report.totals.openLots).toBe(1);
});

test("short then cover realizes cash received minus cover cost", () => {
  const report = buildTax(
    [
      fill({ side: "sell", size_base: 1, notional_usd: 100, fee_usd: 5, price: 100, traded_at: 1, pair: "UNI-USD", venue: "paper", source: "paper_sim" }),
      fill({ side: "buy", size_base: 1, notional_usd: 90, fee_usd: 4.5, price: 90, traded_at: 2, pair: "UNI-USD", venue: "paper", source: "paper_sim" }),
    ],
    { venue: "paper" },
  );
  expect(report.totals.realizedUsd).toBeCloseTo(95 - 94.5, 9);
  expect(report.lots[0]!.side).toBe("short");
  expect(report.totals.openLots).toBe(0);
});

test("pairs stay independent and a flip closes then opens the other way", () => {
  const report = buildTax(
    [
      fill({ pair: "AAA-USD", side: "buy", size_base: 1, notional_usd: 10, fee_usd: 0, traded_at: 1 }),
      fill({ pair: "BBB-USD", side: "buy", size_base: 1, notional_usd: 50, fee_usd: 0, traded_at: 2 }),
      fill({ pair: "AAA-USD", side: "sell", size_base: 2, notional_usd: 24, fee_usd: 0, traded_at: 3 }),
    ],
    { venue: "paper" },
  );
  const aaa = report.pairs.find((p) => p.pair === "AAA-USD")!;
  const bbb = report.pairs.find((p) => p.pair === "BBB-USD")!;
  expect(aaa.realizedUsd).toBeCloseTo(2, 9);
  expect(aaa.openSide).toBe("short");
  expect(aaa.openSize).toBeCloseTo(1, 9);
  expect(bbb.openSide).toBe("long");
  expect(report.lines.find((l) => l.pair === "AAA-USD" && l.side === "sell")!.kind).toBe("flip");
});

test("postgres bigint timestamps still produce a numeric closedAt", () => {
  const t0 = Date.UTC(2026, 8, 20, 0, 38);
  const t1 = t0 + 28_000;
  const report = buildTax(
    [
      fill({ side: "buy", size_base: 200, notional_usd: 4.9688, fee_usd: 0, traded_at: String(t0) as unknown as number, pair: "UNI-USD" }),
      fill({ side: "sell", size_base: 200, notional_usd: 4.9654, fee_usd: 0, traded_at: String(t1) as unknown as number, pair: "UNI-USD" }),
    ],
    { venue: "paper" },
  );
  expect(typeof report.lots[0]!.closedAt).toBe("number");
  expect(report.lots[0]!.closedAt).toBe(t1);
  expect(report.lots[0]!.holdMs).toBe(28_000);
  expect(new Date(report.lots[0]!.closedAt).getUTCFullYear()).toBe(2026);
});

test("lots csv has a header and one data row per closed lot", () => {
  const report = buildTax(
    [
      fill({ side: "buy", size_base: 1, notional_usd: 100, fee_usd: 0, traded_at: Date.UTC(2026, 0, 2), id: "a" }),
      fill({ side: "sell", size_base: 1, notional_usd: 110, fee_usd: 0, traded_at: Date.UTC(2026, 0, 5), id: "b" }),
    ],
    { venue: "paper" },
  );
  const csv = taxLotsCsv(report, "coinbase");
  const lines = csv.trim().split(/\r?\n/);
  expect(lines[0]).toContain("date_acquired");
  expect(lines[0]).toContain("realized_usd");
  expect(lines).toHaveLength(2);
  expect(lines[1]).toContain("coinbase");
  expect(lines[1]).toContain("2026-01-02");
  expect(lines[1]).toContain("2026-01-05");
});
