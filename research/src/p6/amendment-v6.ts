/**
 * Amendment V6. Brian approved the wording at 2026-10-12T13:45:00Z.
 * Quant and Trader confirmed it. Earlier amendment files are not edited.
 * The rules are live. There is no feature flag.
 */

import { AMENDMENT1_SHA256, AMENDMENT2_SHA256, REGISTRATION_SHA256 } from "./amendment2a";
import { AMENDMENT_2A_SHA256 } from "./amendment2b";
import { trailingCatchUpShare, trailingSkipGate, type JevDayCount, type JevSkipStatus } from "./jev-call";
import { missingMidShare } from "./mid-feed";

export const AMENDMENT_2B_SHA256 = "6bfa199e5d70660e887f73e006a548a4b4f803e8f9a7922dc755ff0966154f34";

/** Registered stale-feed kill: a gap over two minutes. The threshold is unchanged. */
export const STALE_FEED_KILL_MS = 120_000;
export const GAP_WEEK_CAP = 0.01;
export const GAP_MAX_MS = 15 * 60 * 1000;
export const VOL_HOUR_RATE_MULT = 2;
export const JEV_SKIP_CAP = 0.05;
export const SOAK_MS = 7 * 24 * 60 * 60 * 1000;
/** V6.1. A handover under this width can be covered. The record is p6-amendment-v61.json. */
export const HANDOVER_MICRO_MS = 1_000;

export const AMENDMENT_V6_RULE = [
  "D orders touching a gap are indeterminate.",
  "s_live and gap-17 snapshots fall back to the REST product book, flagged.",
  "Jev skips packets with a missing 1m bar; these count as indeterminate, and the week is flagged if more than 5% are skipped.",
  "Stops are stop-first on the REST 15m bar. If a gap covers a stop level, the stop fills at the first available price after the gap, using the existing gap-fill convention, and is logged as a gap fill.",
  "The stale-feed and 5%-missing kills stay as registered.",
  "Gap caps: at most 1% of time gapped per week; no single gap over 15 min; no-go if the gap rate in top-decile realized-vol hours exceeds 2x the overall rate.",
  "The soak lasts at least 7 days, and the same caps run as a weekly forward monitor that flags that week's Jev and D stats.",
].join(" ");

export function amendmentV6Body(): {
  registrationSha256: string;
  amendment1Sha256: string;
  amendment1File: string;
  amendment2Sha256: string;
  amendment2File: string;
  amendment2aSha256: string;
  amendment2aFile: string;
  amendment2bSha256: string;
  amendment2bFile: string;
  rule: string;
  live: true;
  featureFlag: false;
  registrationEdited: false;
  amendment1Edited: false;
  amendment2Edited: false;
  amendment2aEdited: false;
  amendment2bEdited: false;
} {
  return {
    registrationSha256: REGISTRATION_SHA256,
    amendment1Sha256: AMENDMENT1_SHA256,
    amendment1File: "research/data/reports/p4-amendment-1.json",
    amendment2Sha256: AMENDMENT2_SHA256,
    amendment2File: "research/data/reports/p6-amendment-2.json",
    amendment2aSha256: AMENDMENT_2A_SHA256,
    amendment2aFile: "research/data/reports/p6-amendment-2a.json",
    amendment2bSha256: AMENDMENT_2B_SHA256,
    amendment2bFile: "research/data/reports/p6-amendment-2b.json",
    rule: AMENDMENT_V6_RULE,
    live: true,
    featureFlag: false,
    registrationEdited: false,
    amendment1Edited: false,
    amendment2Edited: false,
    amendment2aEdited: false,
    amendment2bEdited: false,
  };
}

/** Approval of the wording. It does not cite a hash of the amendment file. */
export function amendmentV6ApprovalBody(): {
  approvedBy: "Brian";
  approvedAt: "2026-10-12T13:45:00Z";
  confirmedBy: ["Quant", "Trader"];
  approvalOf: "wording";
  rule: string;
  registrationSha256: string;
  amendment1Sha256: string;
  amendment2Sha256: string;
  amendment2aSha256: string;
  amendment2bSha256: string;
  bindsToFileHash: false;
  note: string;
  registrationEdited: false;
  amendment1Edited: false;
  amendment2Edited: false;
  amendment2aEdited: false;
  amendment2bEdited: false;
} {
  return {
    approvedBy: "Brian",
    approvedAt: "2026-10-12T13:45:00Z",
    confirmedBy: ["Quant", "Trader"],
    approvalOf: "wording",
    rule: AMENDMENT_V6_RULE,
    registrationSha256: REGISTRATION_SHA256,
    amendment1Sha256: AMENDMENT1_SHA256,
    amendment2Sha256: AMENDMENT2_SHA256,
    amendment2aSha256: AMENDMENT_2A_SHA256,
    amendment2bSha256: AMENDMENT_2B_SHA256,
    bindsToFileHash: false,
    note: "Brian approved the wording at 8:45 AM CT on 2026-10-12. This record does not bind that approval to a file hash he has not seen.",
    registrationEdited: false,
    amendment1Edited: false,
    amendment2Edited: false,
    amendment2aEdited: false,
    amendment2bEdited: false,
  };
}

export function jevSkipShare(skipped: number, packets: number): { share: number; flagWeek: boolean } {
  if (!(packets > 0)) return { share: 0, flagWeek: false };
  const share = skipped / packets;
  return { share, flagWeek: share > JEV_SKIP_CAP };
}

/** The registered 5% missing-1m kill. The threshold is not amended. */
export function missingMidKill(expectedMinutes: number, presentMinutes: number): boolean {
  return missingMidShare(expectedMinutes, presentMinutes).kill;
}

/** The registered stale-feed kill. A gap over two minutes trips it. */
export function staleFeedKill(gapMs: number): boolean {
  return gapMs > STALE_FEED_KILL_MS;
}

export function soakElapsed(startedMs: number, nowMs: number): { elapsedMs: number; complete: boolean } {
  const elapsedMs = Math.max(0, nowMs - startedMs);
  return { elapsedMs, complete: elapsedMs >= SOAK_MS };
}

export interface VolHour {
  rv: number;
  gappedMs: number;
  hourMs: number;
  /** Set when the hour is one product. Hours are not merged across products. */
  productId?: string;
}

/**
 * Gap caps per week. The share is the worst week of length `weekMs`, not the sum of every gap
 * divided by one week. Top-decile realized-vol hours are the highest 10% by rv.
 * A no-go is a weekly forward-monitor flag on that week's Jev and D stats.
 */
/** Covered when the writer switch is under 1s and the incoming feed proved the reworded rule. */
export function handoverCause(widthMs: number, feedOk: boolean): "handover_micro" | "uncovered" {
  if (widthMs < HANDOVER_MICRO_MS && feedOk) return "handover_micro";
  return "uncovered";
}

export function gapWeekReport(opts: {
  weekMs: number;
  gaps: readonly { startMs: number; endMs: number; cause?: string }[];
  hours: readonly VolHour[];
  jevSkipped: number;
  jevPackets: number;
  dIndeterminate: number;
  dSubmitted: number;
  /** Daily catch-up counters. The trailing-7 flag reads these. */
  catchUpDays?: readonly JevDayCount[];
  /** Clock for the trailing window. Today is included. */
  nowMs?: number;
}): {
  gappedMs: number;
  gappedShare: number;
  longestMs: number;
  volRate: number;
  overallRate: number;
  /** Trailing 7 UTC days of on-time packets. Not the lifetime book counters. */
  jevSkipShare: number;
  jevSkipStatus: JevSkipStatus;
  jevSkipDays: number;
  jevSkipScheduled: number;
  jevSkipWilson: number;
  jevSkipLabel: string;
  /** Trailing 7 UTC days including today. Zero when the window is empty. */
  jevCatchUpShare: number;
  dIndeterminateShare: number | null;
  noGo: boolean;
  flagWeek: boolean;
  flags: string[];
  /** V6.1. Count of covered handovers in each week. They are not part of gappedShare. */
  handoverMicroByWeek: { weekStartMs: number; count: number }[];
} {
  const weekMs = opts.weekMs > 0 ? opts.weekMs : 7 * 24 * 60 * 60 * 1000;
  let longestMs = 0;
  const byWeek = new Map<number, number>();
  const micro = new Map<number, number>();
  for (const gap of opts.gaps) {
    if (gap.cause === "handover_micro") {
      const index = Math.floor(gap.endMs / weekMs);
      micro.set(index, (micro.get(index) ?? 0) + 1);
      continue;
    }
    const width = Math.max(0, gap.endMs - gap.startMs);
    if (width > longestMs) longestMs = width;
    if (!(gap.endMs > gap.startMs)) continue;
    let cursor = gap.startMs;
    while (cursor < gap.endMs) {
      const index = Math.floor(cursor / weekMs);
      const weekEnd = (index + 1) * weekMs;
      const sliceEnd = Math.min(gap.endMs, weekEnd);
      byWeek.set(index, (byWeek.get(index) ?? 0) + (sliceEnd - cursor));
      cursor = sliceEnd;
    }
  }
  let gappedMs = 0;
  for (const width of byWeek.values()) if (width > gappedMs) gappedMs = width;
  const gappedShare = gappedMs / weekMs;
  const hourMs = opts.hours.reduce((sum, hour) => sum + Math.max(0, hour.hourMs), 0);
  const hourGap = opts.hours.reduce((sum, hour) => sum + Math.max(0, hour.gappedMs), 0);
  const overallRate = hourMs > 0 ? hourGap / hourMs : 0;
  const ranked = opts.hours.slice().sort((a, b) => b.rv - a.rv);
  const decile = Math.max(1, Math.ceil(ranked.length / 10));
  const top = ranked.slice(0, ranked.length === 0 ? 0 : decile);
  const topMs = top.reduce((sum, hour) => sum + Math.max(0, hour.hourMs), 0);
  const topGap = top.reduce((sum, hour) => sum + Math.max(0, hour.gappedMs), 0);
  const volRate = topMs > 0 ? topGap / topMs : 0;
  // Lifetime jevSkipped / jevPackets stay on the book for the archive. They do not feed this gate.
  void opts.jevSkipped;
  void opts.jevPackets;
  const gate = trailingSkipGate(opts.catchUpDays ?? [], opts.nowMs ?? 0);
  const dIndeterminateShare = opts.dSubmitted > 0 ? opts.dIndeterminate / opts.dSubmitted : null;
  const flags: string[] = [];
  if (gappedShare > GAP_WEEK_CAP) flags.push("gap-share");
  if (longestMs > GAP_MAX_MS) flags.push("gap-length");
  if (overallRate > 0 && volRate > VOL_HOUR_RATE_MULT * overallRate) flags.push("vol-hours");
  if (gate.flag) flags.push("jev-skip");
  const trail = trailingCatchUpShare(opts.catchUpDays ?? [], opts.nowMs ?? 0);
  if (trail.flag) flags.push("jev-catchup");
  const noGo = flags.includes("gap-share") || flags.includes("gap-length") || flags.includes("vol-hours");
  const flagWeek = noGo || flags.includes("jev-skip") || flags.includes("jev-catchup");
  return {
    gappedMs,
    gappedShare,
    longestMs,
    volRate,
    overallRate,
    jevSkipShare: gate.share,
    jevSkipStatus: gate.status,
    jevSkipDays: gate.days,
    jevSkipScheduled: gate.scheduled,
    jevSkipWilson: gate.wilsonLower,
    jevSkipLabel: gate.label,
    jevCatchUpShare: trail.share,
    dIndeterminateShare,
    noGo,
    flagWeek,
    flags,
    handoverMicroByWeek: [...micro.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, count]) => ({ weekStartMs: index * weekMs, count })),
  };
}
