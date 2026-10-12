/**
 * Public market-data subscribe frames. No key, no signature, no order channel.
 * The socket is not opened here.
 */

import { candlesUrl } from "../data/public";
import { assertSafeToStart } from "../safety";
import { shardProducts } from "./mid-feed";

/**
 * Public Advanced Trade market data, no credentials.
 * The candles channel is five-minute, so it is not subscribed. 1m bars are
 * built from level2 mids. Strategy bars come from REST 15-minute candles.
 */
export const PUBLIC_WS_URL = "wss://advanced-trade-ws.coinbase.com";

export const PUBLIC_CHANNELS = ["heartbeats", "level2", "market_trades"] as const;

export type PublicChannel = (typeof PUBLIC_CHANNELS)[number];

const ORDER_CHANNELS = new Set(["user", "full", "orders", "level3"]);

const BANNED_FIELDS = ["signature", "passphrase", "api_key", "apiKey", "secret", "jwt", "key"];

export function feedProducts(members: readonly string[]): string[] {
  const ids = [...members];
  if (!ids.includes("BTC-USD")) ids.push("BTC-USD");
  return ids;
}

export function subscribeFrames(
  productIds: readonly string[],
  channels: readonly PublicChannel[] = PUBLIC_CHANNELS,
  env: Record<string, string | undefined> = process.env,
): string[] {
  const safety = assertSafeToStart(env);
  if (!safety.ok) throw new Error(safety.reason);
  if (productIds.length === 0) throw new Error("public subscribe needs a product");
  const frames: string[] = [];
  for (const channel of channels) {
    if (!PUBLIC_CHANNELS.includes(channel) || ORDER_CHANNELS.has(channel)) throw new Error(`refusing channel ${channel}`);
    for (const shard of shardProducts(productIds)) {
      const frame = JSON.stringify({ type: "subscribe", product_ids: [...shard], channel });
      assertPublicFrame(frame);
      frames.push(frame);
    }
  }
  return frames;
}

export function assertPublicFrame(raw: string): void {
  const value = JSON.parse(raw) as Record<string, unknown>;
  for (const field of Object.keys(value)) {
    if (BANNED_FIELDS.includes(field)) throw new Error("refusing a keyed subscribe");
  }
  const channels = [value.channel, ...(Array.isArray(value.channels) ? value.channels : [])];
  for (const channel of channels) {
    if (typeof channel === "string" && ORDER_CHANNELS.has(channel)) throw new Error(`refusing order channel ${channel}`);
  }
}

export function assertMarketDataUrl(url: string): void {
  if (/\/orders\b|\/fills\b|\/profiles\b|\/conversions\b/.test(url)) throw new Error("refusing an order endpoint");
}

/** Public REST candle backfill. Nothing is fetched. */
export function candleBackfillUrl(productId: string, startSec: number, endSecInclusive: number): string {
  const url = candlesUrl(productId, startSec, endSecInclusive, 60);
  assertMarketDataUrl(url);
  return url;
}

export function missingMinutes(have: readonly number[], fromSec: number, toSec: number): number[] {
  const seen = new Set(have);
  const out: number[] = [];
  for (let ts = fromSec; ts <= toSec; ts += 60) {
    if (!seen.has(ts)) out.push(ts);
  }
  return out;
}
