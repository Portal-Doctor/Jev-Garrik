import { expect, test } from "bun:test";
import { fillRestingBuy, newEntryOrder } from "./src/fill";

test("maker fill takes the 0.5 haircut, charges 50 bps, and cancels at 120 seconds", () => {
  const order = newEntryOrder("o", "UNI-USD", 100, 100, 1_000_000);
  expect(order.expireTs - order.placedTs).toBe(120_000);
  const first = fillRestingBuy(order, { ts: 1_000_000, open: 101, high: 102, low: 99, close: 101, volume: 10 });
  expect(first.event.status).toBe("partial");
  expect(first.event.units).toBe(5);
  expect(first.event.price).toBe(100);
  expect(first.event.feeBps).toBe(50);
  expect(first.event.feeUsd).toBeCloseTo(2.5, 8);

  const capped = fillRestingBuy(
    { ...order, unitsRemaining: 2 },
    { ts: 1_000_000, open: 101, high: 102, low: 99, close: 101, volume: 10 },
  );
  expect(capped.event.status).toBe("filled");
  expect(capped.event.units).toBe(2);

  const missed = fillRestingBuy(order, { ts: 1_060_000, open: 102, high: 103, low: 101, close: 102, volume: 10 });
  expect(missed.event.status).toBe("none");

  const cross = fillRestingBuy(order, { ts: 1_000_000, open: 100, high: 101, low: 99, close: 100, volume: 10 });
  expect(cross.event.reason).toBe("would_cross");
  expect(cross.event.units).toBe(0);

  const late = fillRestingBuy(order, { ts: 1_120_000, open: 101, high: 102, low: 99, close: 101, volume: 10 });
  expect(late.event.reason).toBe("timeout");
  expect(late.event.units).toBe(0);
});
