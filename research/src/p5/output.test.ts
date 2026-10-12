import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { assertP5OutputPath, P5_V31_RESULTS, P5_V3_RESULTS } from "./output";

test("the v3.1 rerun writes a new file and refuses the v3 record", () => {
  expect(P5_V31_RESULTS).toBe("p5-v31-results.json");
  expect(P5_V3_RESULTS).toBe("p5-registered.json");
  expect(() => assertP5OutputPath("research/data/reports/p5-registered.json")).toThrow("refusing to overwrite p5-registered.json");
  const dir = join(tmpdir(), `p5-out-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const fresh = join(dir, P5_V31_RESULTS);
  expect(() => assertP5OutputPath(fresh)).not.toThrow();
  writeFileSync(fresh, "{}\n");
  expect(() => assertP5OutputPath(fresh)).toThrow("refusing to overwrite p5-v31-results.json");
});
