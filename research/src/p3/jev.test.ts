import { expect, test } from "bun:test";
import { assertSynthetic, syntheticPacket } from "./jev";

test("the Jev smoke packet is synthetic and a real pair is refused", () => {
  const packet = syntheticPacket(new Date("2026-10-11T00:00:00.000Z"));
  expect(packet.synthetic).toBe(true);
  expect(packet.asOf <= packet.decisionTs).toBe(true);
  assertSynthetic(packet);
  expect(() => assertSynthetic({ synthetic: true, pair: "BTC-USD" })).toThrow(/real candidate/);
});
