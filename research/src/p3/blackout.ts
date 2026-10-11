import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface BlackoutEvent {
  kind: "CPI" | "NFP" | "FOMC";
  releaseAt: string;
  releaseLocal: string;
  zone: "America/New_York";
  source: string;
}

export interface BlackoutFile {
  contentSha256: string;
  hashInput: string;
  events: BlackoutEvent[];
}

/** Hash of the event list only. The contentSha256 field is not part of the input. */
export function blackoutContentSha256(events: readonly BlackoutEvent[]): string {
  const canonical = JSON.stringify(events);
  return createHash("sha256").update(canonical).digest("hex");
}

export function loadBlackoutCalendar(path: string): BlackoutFile {
  const file = JSON.parse(readFileSync(path, "utf8")) as BlackoutFile;
  const hash = blackoutContentSha256(file.events);
  if (hash !== file.contentSha256) throw new Error("blackout calendar hash does not match its events");
  return file;
}
