import { expect, test } from "bun:test";
import { candlesUrl, productsUrl } from "./public";

test("public urls are the exchange product and candle routes", () => {
  expect(productsUrl()).toBe("https://api.exchange.coinbase.com/products");
  const url = candlesUrl("BTC-USD", 100, 200);
  expect(url).toBe("https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60&start=100&end=200");
  expect(url.includes("order")).toBe(false);
});
