import { test, expect } from "bun:test";
import { withDeadline } from "./engine";

test("withDeadline resolves when the work finishes in time", async () => {
  await expect(withDeadline(Promise.resolve(7), 50, "fast")).resolves.toBe(7);
});

test("withDeadline rejects a hung promise so a pair can fire again", async () => {
  const hung = new Promise<number>(() => {});
  await expect(withDeadline(hung, 20, "decide AVAX-USD")).rejects.toThrow("decide AVAX-USD timed out after 20ms");
});
