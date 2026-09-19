import { config } from "./config";

/**
 * CDP API key JWT (ES256) signing for Coinbase Advanced Trade.
 *
 * Market-data channels (level2, market_trades, heartbeats) are currently unauthenticated, so the
 * feed does not need this yet. It is scaffolded here because the later live/user channel (M5) does,
 * and keeping the seam now costs little. Verify channel auth requirements against current docs when
 * building M5: they have changed before.
 */

export const hasCredentials = (): boolean => Boolean(config.apiKeyName && config.apiPrivateKey);

/**
 * Build a short-lived JWT for a WS subscription or REST request. Not implemented until M5 (live /
 * user channel); throws so a misconfigured live run fails loudly rather than sending unsigned auth.
 */
export async function buildJwt(_uri?: string): Promise<string> {
  throw new Error("CDP JWT signing is not implemented yet (live/user channel is M5). Market data needs no auth.");
}
