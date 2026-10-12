import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { registeredFlags } from "./flags";

test("the registration's per-name flags agree with the overlap lists", () => {
  const registration = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "data", "reports", "p4-registration.json"), "utf8")) as {
    overlap: { priceGroupFailNames: string[]; volumeGroupFailNames: string[]; boundarySavesCloses: string[] };
    barAccess: { names: { productId: string; priceGroupPasses: boolean; volumeGroupPasses: boolean; boundarySaved: boolean }[] };
  };
  const ids = registration.barAccess.names.map((row) => row.productId);
  const book = registeredFlags(registration, ids);
  expect(book.conflicts).toEqual([]);
  expect(book.missing).toEqual([]);
  expect(book.byId.get("AAVE-USD")).toEqual({ priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false });
  expect(book.byId.get("AVNT-USD")).toEqual({ priceGroupPasses: false, volumeGroupPasses: true, boundarySaved: true });
  expect(book.byId.get("LIGHTER-USD")?.volumeGroupPasses).toBe(false);
  expect(book.byId.get("WIF-USD")?.volumeGroupPasses).toBe(false);
});

test("a name missing from barAccess is not given a flag", () => {
  const book = registeredFlags({ barAccess: { names: [] }, overlap: { priceGroupFailNames: [], volumeGroupFailNames: [], boundarySavesCloses: [] } }, ["MISSING-USD"]);
  expect(book.byId.has("MISSING-USD")).toBe(false);
  expect(book.missing).toEqual(["MISSING-USD"]);
});

test("a disagreeing overlap list drops the name instead of picking a side", () => {
  const book = registeredFlags(
    {
      overlap: { priceGroupFailNames: ["AAA-USD"], volumeGroupFailNames: [], boundarySavesCloses: [] },
      barAccess: { names: [{ productId: "AAA-USD", priceGroupPasses: true, volumeGroupPasses: true, boundarySaved: false }] },
    },
    ["AAA-USD"],
  );
  expect(book.byId.has("AAA-USD")).toBe(false);
  expect(book.missing).toEqual(["AAA-USD"]);
  expect(book.conflicts[0]).toContain("AAA-USD");
});
