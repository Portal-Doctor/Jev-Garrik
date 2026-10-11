import { expect, test } from "bun:test";
import { classifyStatus, isProbeTarget, usdSpotFromExchange } from "./products";

const RAW = JSON.stringify([
  { id: "BTC-USD", base_currency: "BTC", quote_currency: "USD", status: "online", quote_increment: "0.01", trading_disabled: false },
  { id: "LRC-USD", base_currency: "LRC", quote_currency: "USD", status: "delisted", quote_increment: "0.0001", trading_disabled: true },
  { id: "ABC-USD", base_currency: "ABC", quote_currency: "USD", status: "offline", quote_increment: "0.01", trading_disabled: true },
  { id: "ODD-USD", base_currency: "ODD", quote_currency: "USD", status: "internal", quote_increment: "0.5", trading_disabled: false },
  { id: "ETH-EUR", base_currency: "ETH", quote_currency: "EUR", status: "online", quote_increment: "0.01", trading_disabled: false },
]);

test("USD spot snapshot keeps status, tick, and a null listing date", () => {
  const products = usdSpotFromExchange(RAW);
  expect(products.map((product) => product.productId)).toEqual(["ABC-USD", "BTC-USD", "LRC-USD", "ODD-USD"]);
  expect(products.find((product) => product.productId === "BTC-USD")).toMatchObject({
    base: "BTC",
    quote: "USD",
    status: "online",
    tickSize: "0.01",
    listingDate: null,
  });
  expect(products.find((product) => product.productId === "LRC-USD")?.status).toBe("delisted");
  expect(products.find((product) => product.productId === "ODD-USD")?.status).toBe("other");
  expect(classifyStatus("offline")).toBe("other");
  const probe = products.filter(isProbeTarget).map((product) => product.productId);
  expect(probe).toEqual(["ABC-USD", "LRC-USD"]);
});
