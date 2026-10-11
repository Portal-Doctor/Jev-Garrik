import { expect, test } from "bun:test";
import { assertLoopbackHost, assertSafeToStart } from "./src/safety";
import { boot } from "./src/index";

test("safety guard refuses COINBASE_API_* and other order-capable credentials", () => {
  expect(assertSafeToStart({ PATH: "/usr/bin" }).ok).toBe(true);
  expect(assertSafeToStart({ COINBASE_API_KEY: "" }).ok).toBe(true);
  for (const key of ["COINBASE_API_KEY", "COINBASE_API_SECRET", "COINBASE_API_KEY_NAME", "COINBASE_API_PRIVATE_KEY", "CDP_API_KEY"]) {
    const result = assertSafeToStart({ [key]: "present" });
    expect(result.ok).toBe(false);
    expect(result.reason.includes(key)).toBe(true);
  }
  expect(boot({ COINBASE_API_KEY: "abc" }).ok).toBe(false);
  expect(boot({ PATH: "/usr/bin" }).ok).toBe(true);
});

test("report host must be loopback", () => {
  expect(() => assertLoopbackHost("127.0.0.1")).not.toThrow();
  expect(() => assertLoopbackHost("0.0.0.0")).toThrow("loopback");
});
