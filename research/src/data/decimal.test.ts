import { expect, test } from "bun:test";
import { addDecimal, compareDecimal, formatDecimal, parseDecimal } from "./decimal";

test("decimal tokens keep their exact value", () => {
  expect(formatDecimal(parseDecimal("5.21333114"))).toBe("5.21333114");
  expect(formatDecimal(parseDecimal("0.1712"))).toBe("0.1712");
  expect(formatDecimal(addDecimal(parseDecimal("1.50"), parseDecimal("2.25")))).toBe("3.75");
  expect(compareDecimal(parseDecimal("10.0"), parseDecimal("10"))).toBe(0);
  expect(compareDecimal(parseDecimal("1.8"), parseDecimal("1.79"))).toBe(1);
});
