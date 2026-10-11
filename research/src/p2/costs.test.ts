import { expect, test } from "bun:test";
import { spreadCost, takerLegCost } from "./costs";

test("both cost rows at the 5 bp floor and the 15 bp cap", () => {
  const floor = spreadCost(0);
  expect(floor).toEqual({ baseBps: 5, stressBps: 10 });
  const stillFloor = spreadCost(8);
  expect(stillFloor).toEqual({ baseBps: 5, stressBps: 10 });
  const cap = spreadCost(40);
  expect(cap).toEqual({ baseBps: 15, stressBps: 30 });
  const atCap = spreadCost(30);
  expect(atCap).toEqual({ baseBps: 15, stressBps: 30 });
  const mid = spreadCost(20);
  expect(mid).toEqual({ baseBps: 10, stressBps: 20 });
});

test("maker legs pay none and the stress row doubles only the capped base", () => {
  expect(takerLegCost(["taker", "maker"], 40, false)).toBe(15);
  expect(takerLegCost(["taker", "maker"], 40, true)).toBe(30);
  expect(takerLegCost(["maker", "maker"], 40, true)).toBe(0);
  expect(takerLegCost(["taker", "taker"], 0, true)).toBe(20);
});
