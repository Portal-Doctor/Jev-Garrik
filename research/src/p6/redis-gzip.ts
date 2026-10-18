/**
 * Stored form of p6:hot and p6:lastRun.
 *
 * The bytes are the ASCII prefix "gz1:" plus base64 of a gzip (mtime 0). A reader
 * sees the prefix without decoding. Base64 keeps the value inside the UTF-8 Redis
 * client; raw gzip bytes would be torn by that client. A value that does not start
 * with the prefix is legacy JSON and is returned unchanged.
 *
 * Gunzip failure, a truncated body, or output that is not a JSON value becomes null.
 * It does not throw. Callers already treat null as a missing hot and take a full load.
 *
 * seq, era, base, and keySeq stay inside the JSON. Kv.get gunzips once, then the
 * existing token compare reads those fields. A second decodeStored on that JSON is
 * only a prefix check. A partial reload pays for two hot GETs (the token and the confirm).
 *
 * The 256 KB cap is the JSON size, applied before this encoding.
 */

import { gzipSync, gunzipSync } from "node:zlib";

/** ASCII marker. Versioned so a later layout can use a different prefix. */
export const GZIP_PREFIX = "gz1:";

const GZIP_KEYS: ReadonlySet<string> = new Set(["p6:hot", "p6:lastRun"]);

export function storesGzip(key: string): boolean {
  return GZIP_KEYS.has(key);
}

/** Gzip a logical JSON string. A value that is already stored form is kept as-is. */
export function encodeStored(key: string, value: string): string {
  if (!storesGzip(key)) return value;
  if (value.startsWith(GZIP_PREFIX)) return value;
  return GZIP_PREFIX + gzipSync(Buffer.from(value, "utf8"), { mtime: 0 }).toString("base64");
}

/**
 * Logical JSON, or null when a gzip value cannot be read.
 * Legacy JSON is returned unchanged, including JSON that later fails to parse.
 */
export function decodeStored(key: string, value: string | null): string | null {
  if (value == null) return null;
  if (!storesGzip(key) || !value.startsWith(GZIP_PREFIX)) return value;
  try {
    const json = gunzipSync(Buffer.from(value.slice(GZIP_PREFIX.length), "base64")).toString("utf8");
    const head = json[0];
    if (head !== "{" && head !== "[") return null;
    return json;
  } catch {
    return null;
  }
}

interface FlushWire {
  hot?: string;
  extra?: { key?: string; value?: string }[];
}

/**
 * The EVAL argument with p6:hot and p6:lastRun replaced by their stored form.
 * FLUSH_LUA is unchanged: it still SETs body.hot and each extra value.
 * Other fields, including bars, are the JSON the flush built.
 */
export function gzipFlushPayload(payload: string): string {
  let body: FlushWire;
  try {
    body = JSON.parse(payload) as FlushWire;
  } catch {
    return payload;
  }
  if (typeof body.hot === "string" && body.hot !== "") body.hot = encodeStored("p6:hot", body.hot);
  if (Array.isArray(body.extra)) {
    for (const row of body.extra) {
      if (!row || typeof row.key !== "string" || typeof row.value !== "string") continue;
      row.value = encodeStored(row.key, row.value);
    }
  }
  return JSON.stringify(body);
}

/**
 * Payload sent to FLUSH_LUA. When gzip would push a payload that fits in `maxBytes`
 * over that limit, the plain payload is sent. Readers accept both forms.
 */
export function redisFlushPayload(payload: string, maxBytes: number): string {
  const wire = gzipFlushPayload(payload);
  if (Buffer.byteLength(wire) > maxBytes && Buffer.byteLength(payload) <= maxBytes) return payload;
  return wire;
}
