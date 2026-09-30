import { expect, test } from "bun:test";
import type { Candle } from "./backtest";
import {
  LIVE_PAIRS,
  SCREEN_WINDOW_DAYS,
  clipFromLiquidity,
  fourHourRealizedVolBps,
  listingReason,
  parseSpotProduct,
  scoreRow,
  thirtyDayNotionalUsd,
} from "./screen";

const hour = (i: number, close: number, volume = 1): Candle => ({
  ts: i * 3_600_000,
  open: close,
  high: close,
  low: close,
  close,
  volume,
});

test("the screen window is the same 180 days the adoption tape uses", () => {
  expect(SCREEN_WINDOW_DAYS).toBe(180);
});

test("USD spot on CBE stays, USDC quote and stables and wrappers drop", () => {
  const usdRaw = {
    product_id: "DOGE-USD",
    base_currency_id: "DOGE",
    quote_currency_id: "USD",
    status: "online",
    trading_disabled: false,
    product_type: "SPOT",
    product_venue: "CBE",
  };
  expect(listingReason(parseSpotProduct(usdRaw)!)).toBe("kept");
  expect(listingReason(parseSpotProduct({ ...usdRaw, quote_currency_id: "USDC", product_id: "DOGE-USDC" })!)).toBe(
    "not_usd_spot",
  );
  expect(listingReason(parseSpotProduct({ product_id: "USDT-USD", base_currency_id: "USDT", quote_currency_id: "USD", status: "online", product_type: "SPOT", product_venue: "CBE" })!)).toBe(
    "stable",
  );
  expect(listingReason(parseSpotProduct({ product_id: "CBETH-USD", base_currency_id: "CBETH", quote_currency_id: "USD", status: "online", product_type: "SPOT", product_venue: "CBE" })!)).toBe(
    "wrapper",
  );
  expect(listingReason(parseSpotProduct({ product_id: "UNI-USD", base_currency_id: "UNI", quote_currency_id: "USD", status: "online", product_type: "SPOT", product_venue: "CBE" })!)).toBe(
    "live_book",
  );
  expect(LIVE_PAIRS).toHaveLength(6);
});

test("a disabled listing is not a candidate", () => {
  const p = parseSpotProduct({
    product_id: "FOO-USD",
    base_currency_id: "FOO",
    quote_currency_id: "USD",
    status: "online",
    trading_disabled: true,
    product_type: "SPOT",
    product_venue: "CBE",
  })!;
  expect(listingReason(p)).toBe("disabled");
});

test("4h realized vol is the sample stdev of close-to-close bps on completed buckets", () => {
  // Enough hourly bars for 20+ completed 4h buckets (aggregate drops the last open group).
  const hourly: Candle[] = [];
  for (let i = 0; i < 200; i++) {
    const bucket = Math.floor(i / 4);
    hourly.push(hour(i, bucket % 2 === 0 ? 100 : 110));
  }
  const { volBps, bars } = fourHourRealizedVolBps(hourly, 0, 200 * 3_600_000);
  expect(bars).toBeGreaterThanOrEqual(20);
  expect(volBps).not.toBeNull();
  // Returns are +1000 bps and about -909 bps alternating. Stdev is well above 800 bps.
  expect(volBps!).toBeGreaterThan(800);
});

test("a flat tape has ~0 realized vol once there are enough 4h bars", () => {
  const hourly = Array.from({ length: 200 }, (_, i) => hour(i, 50));
  const { volBps, bars } = fourHourRealizedVolBps(hourly, 0, 200 * 3_600_000);
  expect(bars).toBeGreaterThanOrEqual(20);
  expect(volBps).toBeCloseTo(0, 8);
});

test("30-day notional sums close times base volume inside the window only", () => {
  const now = 40 * 86_400_000;
  const hourly = [
    { ts: now - 40 * 86_400_000, open: 2, high: 2, low: 2, close: 2, volume: 100 },
    { ts: now - 10 * 86_400_000, open: 3, high: 3, low: 3, close: 3, volume: 10 },
    { ts: now - 1_000, open: 4, high: 4, low: 4, close: 4, volume: 5 },
  ];
  expect(thirtyDayNotionalUsd(hourly, now)).toBe(3 * 10 + 4 * 5);
});

test("illiquid means below the ARB 30-day notional floor, not a guessed dollar cutoff", () => {
  const dropped = scoreRow({
    pair: "FOO-USD",
    listing: "kept",
    volBps: 500,
    bars4h: 200,
    notional30dUsd: 99,
    arb30dUsd: 100,
  });
  expect(dropped.keep).toBe(false);
  expect(dropped.reason).toBe("illiquid");
  const kept = scoreRow({
    pair: "FOO-USD",
    listing: "kept",
    volBps: 500,
    bars4h: 200,
    notional30dUsd: 100,
    arb30dUsd: 100,
  });
  expect(kept.keep).toBe(true);
});

test("clip interpolates between ARB $300 and UNI $600 without leaving the live range", () => {
  expect(clipFromLiquidity(100, 100, 400)).toBe(300);
  expect(clipFromLiquidity(400, 100, 400)).toBe(600);
  expect(clipFromLiquidity(250, 100, 400)).toBe(500);
  expect(clipFromLiquidity(50, 100, 400)).toBe(300);
});
