/**
 * Runner for the fee tier replay. Prints the two Result tables the profitability work order
 * asks for, in markdown, plus the turnover reading each tier is judged reachable against.
 *
 *   bun run cb/fee-tier-replay.ts
 */

import { ADVANCED_VIP_LADDER, US_ANNOUNCED_TIERS, tiersInReach, type SpotFeeTier } from "./feetiers";
import { replayFeeTiers, type TierBookResult } from "./feereplay";

const usd = (n: number) => (n < 0 ? `-${Math.abs(n).toFixed(2)}` : n.toFixed(2));
const vol = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;

function tierLabel(t: SpotFeeTier): string {
  const cutoff = t.thirtyDayVolumeUsd > 0 ? vol(t.thirtyDayVolumeUsd) : "under $10,000";
  return `${t.name} (${cutoff}, ${t.makerBps}/${t.takerBps} bps)`;
}

function perPairTable(rows: TierBookResult[]): string {
  const pairs = rows[0]?.perPair.map((p) => p.pair) ?? [];
  const head = `| Tier | 30d volume needed | Maker bps | Taker bps | Reachable | ${pairs.join(" | ")} | Total |`;
  const sep = `|---|---:|---:|---:|---|${pairs.map(() => "---:").join("|")}|---:|`;
  const body = rows.map((r) => {
    const cells = r.perPair.map((p) => usd(p.netUsd));
    const cutoff = r.tier.thirtyDayVolumeUsd > 0 ? vol(r.tier.thirtyDayVolumeUsd) : "$0";
    return `| ${r.tier.name} | ${cutoff} | ${r.tier.makerBps} | ${r.tier.takerBps} | ${r.reachable ? "yes" : "no"} | ${cells.join(" | ")} | ${usd(r.totalNetUsd)} |`;
  });
  return [head, sep, ...body].join("\n");
}

function perMonthTable(rows: TierBookResult[]): string {
  const months = [...new Set(rows.flatMap((r) => r.perMonth.map((m) => m.month)))].sort();
  const head = `| Tier | ${months.join(" | ")} | Total |`;
  const sep = `|---|${months.map(() => "---:").join("|")}|---:|`;
  const body = rows.map((r) => {
    const byMonth = new Map(r.perMonth.map((m) => [m.month, m.netUsd]));
    const cells = months.map((m) => usd(byMonth.get(m) ?? 0));
    return `| ${r.tier.name} | ${cells.join(" | ")} | ${usd(r.totalNetUsd)} |`;
  });
  return [head, sep, ...body].join("\n");
}

function turnoverTable(rows: TierBookResult[]): string {
  const head = "| Tier | Tape filled notional | Scaled to 30 days | Busiest 30 days | Cutoff | Reaches cutoff |";
  const sep = "|---|---:|---:|---:|---:|---|";
  const body = rows.map((r) => {
    const cutoff = r.tier.thirtyDayVolumeUsd > 0 ? vol(r.tier.thirtyDayVolumeUsd) : "$0";
    return `| ${r.tier.name} | ${vol(r.turnover.totalUsd)} | ${vol(r.turnover.scaledThirtyDayUsd)} | ${vol(r.turnover.busiestThirtyDayUsd)} | ${cutoff} | ${r.reachable ? "yes" : "no"} |`;
  });
  return [head, sep, ...body].join("\n");
}

const entry = US_ANNOUNCED_TIERS[0]!;
console.log(`Measuring turnover at the live tier: ${tierLabel(entry)}`);
const probe = await replayFeeTiers([entry]);
const measured = Math.max(
  probe.breakout[0]!.turnover.scaledThirtyDayUsd,
  probe.breakout[0]!.turnover.busiestThirtyDayUsd,
  probe.fixedTarget[0]!.turnover.scaledThirtyDayUsd,
  probe.fixedTarget[0]!.turnover.busiestThirtyDayUsd,
);
console.log(`Measured 30 day filled notional (larger of the two books): ${vol(measured)}`);

const candidates: SpotFeeTier[] = [...US_ANNOUNCED_TIERS, ...ADVANCED_VIP_LADDER];
const selected = tiersInReach(candidates, measured, 10);
console.log(`Tiers within ten times that turnover: ${selected.map((t) => t.name).join(", ")}`);

const replay = await replayFeeTiers(selected, probe.toTs);

console.log(`\nWindow: ${new Date(replay.fromTs).toISOString()} to ${new Date(replay.toTs).toISOString()}\n`);
console.log("## Tier sources\n");
console.log("| Tier | Source |");
console.log("|---|---|");
for (const t of selected) console.log(`| ${t.name} | ${t.source} |`);

for (const [label, rows] of [
  ["Locked breakout", replay.breakout],
  ["HTF fixed-target", replay.fixedTarget],
] as const) {
  console.log(`\n## ${label}: net USD per pair\n`);
  console.log(perPairTable(rows));
  console.log(`\n## ${label}: net USD per calendar month, six pairs combined\n`);
  console.log(perMonthTable(rows));
  console.log(`\n## ${label}: turnover against each cutoff\n`);
  console.log(turnoverTable(rows));
}
