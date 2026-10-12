/** v3.1 rerun output. The v3 registered file stays where it is. A written v3.1 file stays where it is too. */

import { existsSync } from "node:fs";

export const P5_V31_RESULTS = "p5-v31-results.json";
export const P5_V3_RESULTS = "p5-registered.json";

export function assertP5OutputPath(name: string): void {
  const base = name.split("/").pop();
  if (base === P5_V3_RESULTS) throw new Error("refusing to overwrite p5-registered.json");
  if (base === P5_V31_RESULTS && existsSync(name)) throw new Error("refusing to overwrite p5-v31-results.json");
}
