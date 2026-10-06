import { expect, test } from "bun:test";
import { parseBook } from "./config";

test("the judged paper fee fallback is 40/80, not a Coinbase published row", async () => {
  const src = await Bun.file("cb/config.ts").text();
  expect(src).toContain('num("CB_MAKER_FEE_BPS", 40)');
  expect(src).toContain('num("CB_TAKER_FEE_BPS", 80)');
  const env = await Bun.file(".env.example").text();
  expect(env).toMatch(/CB_MAKER_FEE_BPS=40\b/);
  expect(env).toMatch(/CB_TAKER_FEE_BPS=80\b/);
  expect(src).toContain("VVV-USD,ZEC-USD");
  expect(env).toContain("VVV-USD,ZEC-USD");
  expect(src).not.toMatch(/CB_PAIRS[^"]*PUMP-USD/);
  expect(env).not.toMatch(/CB_PAIRS=.*PUMP-USD/);
  expect(src).not.toMatch(/CB_PAIRS[^"]*XLM-USD/);
  expect(env).not.toMatch(/CB_PAIRS=.*XLM-USD/);
  expect(env).not.toMatch(/CB_PAIRS=.*TAO-USD/);
  expect(env).not.toMatch(/CB_PAIRS=.*ADA-USD/);
  expect(src).toContain('env("CB_BOOK", "breakout")');
  expect(env).toMatch(/CB_BOOK=breakout\b/);
  expect(env).not.toMatch(/CB_BOOK=pooled\b/);
});

test("the live default is split-clip breakout, and pooled is opt-in", () => {
  expect(parseBook(undefined)).toBe("breakout");
  expect(parseBook("breakout")).toBe("breakout");
  expect(parseBook("pooled")).toBe("pooled");
  expect(parseBook("htf")).toBe("htf");
});
