import { expect, test } from "bun:test";
import { atrScaledShares, blankAllocator, equalShares, release, reserve } from "./src/allocator";

test("equal shares split deployable capital across the enabled pairs", () => {
  const shares = equalShares(8_000, ["A", "B", "C", "D"]);
  expect(shares).toEqual({ A: 2_000, B: 2_000, C: 2_000, D: 2_000 });
  expect(Object.values(shares).reduce((s, n) => s + n, 0)).toBe(8_000);
});

test("ATR-scaled shares weight by inverse ATR and still sum to deployable capital", () => {
  const shares = atrScaledShares(8_000, { A: 1, B: 3 });
  expect(shares.A).toBeCloseTo(6_000, 6);
  expect(shares.B).toBeCloseTo(2_000, 6);
  expect(shares.A! + shares.B!).toBeCloseTo(8_000, 6);
  const missing = atrScaledShares(8_000, { A: 1, B: 0 });
  expect(missing.B).toBe(0);
  expect(missing.A).toBeCloseTo(8_000, 6);
});

test("POOL equal reserves up to the total cap and refuses the over-commit without changing state", () => {
  const pairs = ["A", "B"];
  const opts = { enabledPairs: pairs, atrByPair: {}, allocatableUsd: 100 };
  const first = reserve({ ...blankAllocator("POOL", "equal"), deployable: 100 }, "A", 50, opts);
  expect(first.ok).toBe(true);
  expect(first.state.total).toBe(50);
  const second = reserve(first.state, "B", 50, opts);
  expect(second.ok).toBe(true);
  const blown = { ...second.state, total: 90, byPair: { A: 40, B: 50 } };
  const refused = reserve(blown, "A", 20, opts);
  expect(refused.ok).toBe(false);
  expect(refused.reason).toBe("total cap");
  expect(refused.state).toBe(blown);
  expect(refused.state.total).toBe(90);
});

test("SILO refuses a second draw on the same bucket and still allows the other pair", () => {
  const pairs = ["A", "B"];
  const opts = { enabledPairs: pairs, atrByPair: {}, allocatableUsd: 100 };
  let state = { ...blankAllocator("SILO", "equal"), deployable: 100 };
  const a = reserve(state, "A", 50, opts);
  expect(a.ok).toBe(true);
  state = a.state;
  const again = reserve(state, "A", 10, opts);
  expect(again.ok).toBe(false);
  expect(again.reason).toBe("silo bucket");
  expect(again.state.total).toBe(50);
  const b = reserve(state, "B", 50, opts);
  expect(b.ok).toBe(true);
  expect(b.state.total).toBe(100);
});

test("POOL ATR-scaled reserve uses the inverse-ATR share", () => {
  const opts = { enabledPairs: ["A", "B"], atrByPair: { A: 1, B: 3 }, allocatableUsd: 8_000 };
  const state = blankAllocator("POOL", "atr_scaled");
  const a = reserve(state, "A", 6_000, opts);
  expect(a.ok).toBe(true);
  const tooMuch = reserve(state, "B", 3_000, opts);
  expect(tooMuch.ok).toBe(false);
  expect(tooMuch.reason).toBe("above formula share");
  expect(tooMuch.state.total).toBe(0);
  const b = reserve(a.state, "B", 2_000, opts);
  expect(b.ok).toBe(true);
  expect(b.state.total).toBe(8_000);
});

test("release returns reserved cash and the $2,000 reserve cannot be allocated", () => {
  const opts = { enabledPairs: ["A", "B"], atrByPair: {}, allocatableUsd: 10 };
  const state = { ...blankAllocator("POOL", "equal"), deployable: 100 };
  const refused = reserve(state, "A", 50, opts);
  expect(refused.ok).toBe(false);
  expect(refused.reason).toBe("reserve protected");
  expect(refused.state.total).toBe(0);
  const held = reserve(state, "A", 50, { ...opts, allocatableUsd: 8_000 });
  expect(held.ok).toBe(true);
  const back = release(held.state, "A", 50);
  expect(back.total).toBe(0);
});
