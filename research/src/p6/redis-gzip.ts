/**
 * Stored form of p6:hot and p6:lastRun.
 *
 * Readers always accept plain JSON and the ASCII prefix "gz1:" plus base64 of a
 * gzip (mtime 0). Base64 keeps the value inside the UTF-8 Redis client. Writes
 * gzip only when P6_GZIP_WRITES=1. The default is off: the next flush stores
 * plain JSON and does not delete the old value.
 *
 * Kv.read / Kv.readMany return a tagged result. A gz1: body that does not gunzip
 * to JSON, and plain text that does not parse, is `unreadable`, not missing.
 * seq, era, base, and keySeq stay inside the JSON. A partial reload pays for two
 * hot reads (the token and the confirm).
 *
 * The 256 KB cap is the JSON size, applied before encoding.
 * Quant soak review uses classifyStored and decodeStored from this file.
 */

import { gzipSync, gunzipSync, type ZlibOptions } from "node:zlib";

/** ASCII marker. Versioned so a later layout can use a different prefix. */
export const GZIP_PREFIX = "gz1:";

/**
 * Largest gunzip output accepted. Matches the 1 MB Redis value cap.
 * A larger expansion is unreadable. This does not change the 256 KB hot cap.
 */
export const GUNZIP_MAX_BYTES = 1_048_576;

const GZIP_KEYS: ReadonlySet<string> = new Set(["p6:hot", "p6:lastRun"]);

export function storesGzip(key: string): boolean {
  return GZIP_KEYS.has(key);
}

/** True only when writes should store gz1:. Default off. */
export function gzipWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.P6_GZIP_WRITES === "1";
}

/** Gzip a logical JSON string. A value that is already stored form is kept as-is. Ignores the write flag. */
export function encodeStored(key: string, value: string): string {
  if (!storesGzip(key)) return value;
  if (value.startsWith(GZIP_PREFIX)) return value;
  // mtime 0 keeps the stored bytes stable. @types/node omits it on ZlibOptions; Node still reads it.
  return GZIP_PREFIX + gzipSync(Buffer.from(value, "utf8"), { mtime: 0 } as ZlibOptions).toString("base64");
}

export type StoredHeader = "gz1:" | "{" | "other";

export type KvRead =
  | { tag: "missing" }
  | { tag: "unreadable"; raw: string; bytes: number; header: StoredHeader }
  | { tag: "value"; value: string; wireBytes: number };

const PARSED_KEYS: ReadonlySet<string> = new Set(["p6:hot", "p6:lastRun", "p6:acct", "p6:eq:first"]);

export function storedHeader(raw: string): StoredHeader {
  if (raw.startsWith(GZIP_PREFIX)) return "gz1:";
  if (raw.startsWith("{")) return "{";
  return "other";
}

/** Tagged read. Never null. Decode or JSON failure is unreadable, not missing. */
export function classifyStored(key: string, raw: string | null): KvRead {
  if (raw == null) return { tag: "missing" };
  const bytes = Buffer.byteLength(raw);
  if (raw.startsWith(GZIP_PREFIX) && (storesGzip(key) || PARSED_KEYS.has(key))) {
    const json = gunzipJson(raw);
    if (json == null) return { tag: "unreadable", raw, bytes, header: "gz1:" };
    return { tag: "value", value: json, wireBytes: bytes };
  }
  if (PARSED_KEYS.has(key)) {
    if (!parsesJson(raw)) return { tag: "unreadable", raw, bytes, header: storedHeader(raw) };
    return { tag: "value", value: raw, wireBytes: bytes };
  }
  return { tag: "value", value: raw, wireBytes: bytes };
}

export function readText(row: KvRead): string | null {
  return row.tag === "value" ? row.value : null;
}

function parsesJson(raw: string): boolean {
  try {
    JSON.parse(raw);
    return true;
  } catch {
    return false;
  }
}

function gunzipJson(raw: string): string | null {
  try {
    const json = gunzipSync(Buffer.from(raw.slice(GZIP_PREFIX.length), "base64"), { maxOutputLength: GUNZIP_MAX_BYTES }).toString("utf8");
    const head = json[0];
    if (head !== "{" && head !== "[") return null;
    JSON.parse(json);
    return json;
  } catch {
    return null;
  }
}

const mismatches: string[] = [];

/** Keys whose gzip did not round-trip since the last take. The plain JSON was stored instead. */
export function takeGzipMismatches(): string[] {
  const copy = mismatches.slice();
  mismatches.length = 0;
  return copy;
}

type StoredEncoder = (key: string, value: string) => string;

function defaultStoredEncoder(key: string, value: string): string {
  if (!gzipWritesEnabled() || !storesGzip(key)) return value;
  return encodeStored(key, value);
}

let storedEncoder: StoredEncoder = defaultStoredEncoder;

/** Test hook. A corrupting encoder is checked by the round-trip guard. Pass null to restore. */
export function installStoredEncoder(fn: StoredEncoder | null): void {
  storedEncoder = fn ?? defaultStoredEncoder;
}

/**
 * Bytes to store. Gzip runs only when the flag is on. After encoding, the value
 * is decoded and compared to the source. A mismatch stores the plain JSON.
 */
export function commitStored(key: string, value: string): string {
  if (!storesGzip(key)) return value;
  const encoded = storedEncoder(key, value);
  if (encoded === value) return value;
  if (decodeStored(key, encoded) !== value) {
    mismatches.push(key);
    console.log("gzip mismatch", { key, bytes: Buffer.byteLength(value) });
    return value;
  }
  return encoded;
}

/**
 * Logical JSON, or null when a gzip value cannot be read.
 * Legacy JSON is returned unchanged, including JSON that later fails to parse.
 */
export function decodeStored(key: string, value: string | null): string | null {
  if (value == null) return null;
  if (!storesGzip(key) || !value.startsWith(GZIP_PREFIX)) return value;
  try {
    const json = gunzipSync(Buffer.from(value.slice(GZIP_PREFIX.length), "base64"), { maxOutputLength: GUNZIP_MAX_BYTES }).toString("utf8");
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
  let changed = false;
  if (typeof body.hot === "string" && body.hot !== "") {
    const next = commitStored("p6:hot", body.hot);
    if (next !== body.hot) {
      body.hot = next;
      changed = true;
    }
  }
  if (Array.isArray(body.extra)) {
    for (const row of body.extra) {
      if (!row || typeof row.key !== "string" || typeof row.value !== "string") continue;
      const next = commitStored(row.key, row.value);
      if (next !== row.value) {
        row.value = next;
        changed = true;
      }
    }
  }
  if (!changed) return payload;
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
