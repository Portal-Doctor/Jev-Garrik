import { createPrivateKey, sign as nodeSign, generateKeyPairSync, KeyObject } from "node:crypto";
import { config } from "./config";

/**
 * CDP API key JWT signing for Coinbase Advanced Trade and CDP REST.
 *
 * Market-data channels (level2, market_trades, heartbeats) are currently unauthenticated, so the
 * feed does not need this yet. Implement it now: public channels have required auth before, and
 * the live/user channel (M5) will. ES256 is the documented CDP/Advanced Trade algorithm; Ed25519
 * (EdDSA) is also accepted for keys the current portal issues.
 *
 * `buildJwt(uri)` accepts either a request descriptor (`GET api.coinbase.com/api/v3/...`) or
 * nothing (websocket / unscoped). Credentials: COINBASE_API_KEY_NAME + COINBASE_API_PRIVATE_KEY.
 */

export const hasCredentials = (): boolean => Boolean(config.apiKeyName && config.apiPrivateKey);

export interface JwtParts {
  header: Record<string, unknown>;
  payload: Record<string, unknown>;
  sig: Buffer;
}

const b64url = (buf: Buffer | string) =>
  Buffer.from(typeof buf === "string" ? buf : buf).toString("base64url");

const pemFromEnv = (raw: string) => raw.replace(/\\n/g, "\n").trim();

function nonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

function isEd25519Secret(secret: string): boolean {
  if (secret.includes("BEGIN")) return false;
  try {
    return Buffer.from(secret, "base64").length === 64;
  } catch {
    return false;
  }
}

function ecKey(pem: string): KeyObject {
  return createPrivateKey({ key: pemFromEnv(pem), format: "pem" });
}

/**
 * Build a short-lived JWT for a WS subscription or REST request.
 * `uri` is `METHOD host/path` (Advanced Trade / CDP). Omit for websocket-style tokens.
 */
export async function buildJwt(uri?: string): Promise<string> {
  if (!hasCredentials()) throw new Error("CDP JWT: COINBASE_API_KEY_NAME and COINBASE_API_PRIVATE_KEY are required");
  const keyName = config.apiKeyName!;
  const secret = config.apiPrivateKey!;
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    sub: keyName,
    iss: "cdp",
    nbf: now,
    iat: now,
    exp: now + 120,
  };
  if (uri) {
    payload.uri = uri;
    payload.uris = [uri];
  }

  if (isEd25519Secret(secret)) return signEd25519(keyName, secret, payload);
  return signEs256(keyName, secret, payload);
}

function signEs256(keyName: string, secret: string, payload: Record<string, unknown>): string {
  const header = { alg: "ES256", kid: keyName, nonce: nonce(), typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = ecKey(secret);
  const sig = nodeSign("SHA256", Buffer.from(signingInput), { key, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(sig)}`;
}

function signEd25519(keyName: string, secret: string, payload: Record<string, unknown>): string {
  const decoded = Buffer.from(secret, "base64");
  if (decoded.length !== 64) throw new Error("CDP JWT: Ed25519 secret must decode to 64 bytes");
  const header = { alg: "EdDSA", kid: keyName, nonce: nonce(), typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const pkcs8 = ed25519Pkcs8(decoded.subarray(0, 32));
  const key = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
  const sig = nodeSign(null, Buffer.from(signingInput), key);
  return `${signingInput}.${b64url(sig)}`;
}

/** PKCS8 DER wrapping a 32-byte Ed25519 seed (RFC 8410). */
function ed25519Pkcs8(seed: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    seed,
  ]);
}

/** Authenticated GET against Coinbase Advanced Trade. Falls back to the public market URL if no keys. */
export async function coinbaseGet(path: string, host = "api.coinbase.com"): Promise<unknown> {
  const url = `https://${host}${path}`;
  const headers: Record<string, string> = { accept: "application/json" };
  if (hasCredentials()) {
    headers.Authorization = `Bearer ${await buildJwt(`GET ${host}${path}`)}`;
  }
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`coinbase GET ${path}: HTTP ${res.status}`);
  return res.json();
}

/** Test helper: generate a throwaway ES256 PEM pair. Never used in production. */
export function generateTestEcKey(): { privateKey: string; publicKey: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey,
  };
}

export function decodeJwt(token: string): JwtParts {
  const [h, p, s] = token.split(".");
  if (!h || !p || !s) throw new Error("malformed JWT");
  return {
    header: JSON.parse(Buffer.from(h, "base64url").toString()),
    payload: JSON.parse(Buffer.from(p, "base64url").toString()),
    sig: Buffer.from(s, "base64url"),
  };
}
