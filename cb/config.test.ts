import { expect, test } from "bun:test";

test("the judged paper fee fallback is 40/80, not a Coinbase published row", async () => {
  const src = await Bun.file("cb/config.ts").text();
  expect(src).toContain('num("CB_MAKER_FEE_BPS", 40)');
  expect(src).toContain('num("CB_TAKER_FEE_BPS", 80)');
  const env = await Bun.file(".env.example").text();
  expect(env).toMatch(/CB_MAKER_FEE_BPS=40\b/);
  expect(env).toMatch(/CB_TAKER_FEE_BPS=80\b/);
  expect(src).toContain("VVV-USD,ZEC-USD,PUMP-USD,XLM-USD");
  expect(env).toContain("VVV-USD,ZEC-USD,PUMP-USD,XLM-USD");
  expect(env).not.toMatch(/CB_PAIRS=.*TAO-USD/);
  expect(env).not.toMatch(/CB_PAIRS=.*ADA-USD/);
});
