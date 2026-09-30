/**
 * Fetch Advanced Trade USD spot listings and rank 6-month 4h realized vol.
 *
 *   bun run cb/screen-run.ts
 *
 * Writes docs/HIGH-VOL-PAIR-SCREEN.md. Does not change CB_PAIRS or rebuild the engine.
 */

import { fetchCandles } from "./backtest";
import {
  LIVE_PAIRS,
  LIQUIDITY_FLOOR_PAIR,
  SCREEN_WINDOW_DAYS,
  listingReason,
  parseSpotProduct,
  fourHourRealizedVolBps,
  scoreRow,
  thirtyDayNotionalUsd,
  type ScreenRow,
  type SpotProduct,
} from "./screen";

const DAY_MS = 86_400_000;
const ADVANCED = "https://api.coinbase.com/api/v3/brokerage/market/products?product_type=SPOT&limit=250";

async function fetchProducts(): Promise<SpotProduct[]> {
  const out: SpotProduct[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const url = cursor ? `${ADVANCED}&cursor=${encodeURIComponent(cursor)}` : ADVANCED;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`products ${res.status}`);
    const body = (await res.json()) as { products?: Array<Record<string, unknown>>; cursor?: string };
    for (const raw of body.products ?? []) {
      const p = parseSpotProduct(raw);
      if (p) out.push(p);
    }
    cursor = body.cursor && body.cursor.length > 0 ? body.cursor : null;
    if (!cursor) break;
  }
  return out;
}

async function loadHourly(pair: string, fromMs: number, toMs: number): Promise<Awaited<ReturnType<typeof fetchCandles>>> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await fetchCandles(pair, fromMs, toMs, 3600);
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt === 4) throw e;
      const wait = 1000 * 2 ** attempt;
      console.error(`retry ${pair} in ${wait}ms: ${msg}`);
      await Bun.sleep(wait);
    }
  }
  return [];
}

const usd = (n: number | null) => (n == null ? "-" : `$${Math.round(n).toLocaleString("en-US")}`);
const bps = (n: number | null) => (n == null ? "-" : n.toFixed(1));

const now = Date.now();
const windowStartTs = now - SCREEN_WINDOW_DAYS * DAY_MS;
const products = await fetchProducts();
const usdSpot = products.filter((p) => p.quote === "USD" && (p.productType === "SPOT" || p.productType === ""));

const needTape = usdSpot.filter((p) => {
  const r = listingReason(p);
  return r === "kept" || r === "live_book";
});

console.log(`Listings ${products.length}. USD spot ${usdSpot.length}. Tape fetches ${needTape.length}.`);
console.log(`Window ${new Date(windowStartTs).toISOString()} to ${new Date(now).toISOString()}`);

const hourlyByPair = new Map<string, Awaited<ReturnType<typeof fetchCandles>>>();
for (const p of needTape) {
  process.stdout.write(`hourly ${p.productId}\n`);
  try {
    hourlyByPair.set(p.productId, await loadHourly(p.productId, windowStartTs, now));
  } catch (e) {
    console.error(`skip ${p.productId}:`, (e as Error).message);
  }
}

const arbHourly = hourlyByPair.get(LIQUIDITY_FLOOR_PAIR) ?? [];
const arb30d = thirtyDayNotionalUsd(arbHourly, now);

const rows: ScreenRow[] = [];
for (const p of usdSpot) {
  const listing = listingReason(p);
  const hourly = hourlyByPair.get(p.productId) ?? [];
  const vol = hourly.length ? fourHourRealizedVolBps(hourly, windowStartTs, now) : { volBps: null, bars: 0 };
  const notional = hourly.length ? thirtyDayNotionalUsd(hourly, now) : null;
  rows.push(
    scoreRow({
      pair: p.productId,
      listing,
      volBps: vol.volBps,
      bars4h: vol.bars,
      notional30dUsd: listing === "stable" || listing === "wrapper" || listing === "not_usd_spot" || listing === "disabled" ? p.quoteVolume24h : notional,
      arb30dUsd: arb30d,
    }),
  );
}

// For dropped listings without a tape, keep the 24h quote volume in the notional column as context.
for (const row of rows) {
  if (row.notional30dUsd == null) {
    const p = usdSpot.find((x) => x.productId === row.pair);
    if (p?.quoteVolume24h != null) row.notional30dUsd = p.quoteVolume24h;
  }
}

const ranked = rows.slice().sort((a, b) => (b.volBps ?? -1) - (a.volBps ?? -1));
const kept = ranked.filter((r) => r.keep);
const live = ranked.filter((r) => r.reason === "live_book");

const md: string[] = [];
md.push("# High-vol pair screen");
md.push("");
md.push("Source: Coinbase Advanced Trade public SPOT products, quote USD, venue CBE.");
md.push(`Window: ${new Date(windowStartTs).toISOString()} to ${new Date(now).toISOString()} (${SCREEN_WINDOW_DAYS} days, same as adoption).`);
md.push("Vol: sample stdev of completed 4-hour close-to-close simple returns, in bps, not annualized. Hourly Exchange candles, last open 4-hour bucket dropped.");
md.push(`Liquidity floor: 30-day USD notional (sum of hourly close times base volume) at or above live ${LIQUIDITY_FLOOR_PAIR} on this tape (${usd(arb30d)}).`);
md.push("Stables, wrappers, disabled listings, and non-USD quotes are dropped. The live six are ranked for reference and are not new candidates.");
md.push("This file does not add pairs to the running 24h window.");
md.push("");
md.push(`ARB 30-day notional floor: ${usd(arb30d)}.`);
md.push("");
md.push("## Kept candidates, ranked by 4h realized vol");
md.push("");
md.push("| Rank | Pair | 4h vol bps | 30d notional | 4h bars | Why kept |");
md.push("|---:|---|---:|---:|---:|---|");
kept.forEach((r, i) => {
  md.push(`| ${i + 1} | ${r.pair} | ${bps(r.volBps)} | ${usd(r.notional30dUsd)} | ${r.bars4h} | ${r.note} |`);
});
if (kept.length === 0) md.push("| | (none) | | | | |");
md.push("");
md.push("## Live six, same definition");
md.push("");
md.push("| Pair | 4h vol bps | 30d notional | 4h bars |");
md.push("|---|---:|---:|---:|");
for (const r of live.sort((a, b) => (b.volBps ?? 0) - (a.volBps ?? 0))) {
  md.push(`| ${r.pair} | ${bps(r.volBps)} | ${usd(r.notional30dUsd)} | ${r.bars4h} |`);
}
md.push("");
md.push("## Dropped USD spot listings");
md.push("");
md.push("| Pair | Reason | 4h vol bps | 30d or 24h USD | Note |");
md.push("|---|---|---:|---:|---|");
for (const r of ranked.filter((x) => !x.keep && x.reason !== "live_book")) {
  md.push(`| ${r.pair} | ${r.reason} | ${bps(r.volBps)} | ${usd(r.notional30dUsd)} | ${r.note} |`);
}
md.push("");

await Bun.write("docs/HIGH-VOL-PAIR-SCREEN.md", md.join("\n"));
await Bun.write("docs/screen-kept.json", JSON.stringify({ now, windowStartTs, arb30dUsd: arb30d, kept }, null, 2));
console.log(`Kept ${kept.length}. Live ${LIVE_PAIRS.length}. Wrote docs/HIGH-VOL-PAIR-SCREEN.md`);
for (const r of kept.slice(0, 20)) console.log(`${r.pair} vol=${bps(r.volBps)} 30d=${usd(r.notional30dUsd)}`);
