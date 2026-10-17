import type { PnlWindowId } from "./pnl-block";

/** The only ?w= values the summary page renders. */
export const SUMMARY_WINDOWS = ["8h", "24h", "7d", "30d"] as const;

/**
 * Server-side ?w= allowlist.
 * An array uses the first element. Empty, markup, the wrong case, whitespace,
 * and anything longer than these ids (including a 2 KB string) fall back to
 * 24h with the breakdown closed. The raw text is not returned.
 */
export function parseSummaryWindow(value: string | readonly string[] | undefined | null): { id: PnlWindowId; open: boolean } {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8) return { id: "24h", open: false };
  for (const id of SUMMARY_WINDOWS) {
    if (raw === id) return { id, open: true };
  }
  return { id: "24h", open: false };
}
