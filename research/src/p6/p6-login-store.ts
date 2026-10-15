/**
 * Prefix-locked login store. Keys must start with p6:login:.
 * Writes never go through the read-only dashboard client.
 */

import { randomInt } from "node:crypto";
import { connect as connectNet, isIP } from "node:net";
import { connect as connectTls } from "node:tls";
import type { LoginStore } from "./p6-login";

export const LOGIN_KEY_PREFIX = "p6:login:";

const RATE_SCRIPT = `
local now = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now - window)
local n = redis.call('ZCARD', KEYS[1])
if n >= limit then
  return 0
end
redis.call('ZADD', KEYS[1], now, ARGV[4])
redis.call('PEXPIRE', KEYS[1], window)
return 1
`;

const INCR_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if redis.call('TTL', KEYS[1]) < 0 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return n
`;

const CONSUME_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[2])
  return 1
end
return 0
`;

export function assertLoginKey(key: string): void {
  if (!key.startsWith(LOGIN_KEY_PREFIX) || /[\s\r\n]/.test(key)) throw new Error("login store key refused");
}

type Reply = string | null | Reply[];

function encode(parts: readonly string[]): string {
  let out = `*${parts.length}\r\n`;
  for (const part of parts) out += `$${Buffer.byteLength(part)}\r\n${part}\r\n`;
  return out;
}

function take(buf: string): { reply: Reply; rest: string } | null {
  if (buf.startsWith("$-1")) {
    const end = "$-1\r\n".length;
    if (buf.length < end) return null;
    return { reply: null, rest: buf.slice(end) };
  }
  if (buf.startsWith("*")) {
    const nl = buf.indexOf("\r\n");
    if (nl < 0) return null;
    const count = Number(buf.slice(1, nl));
    if (count < 0) return { reply: null, rest: buf.slice(nl + 2) };
    let rest = buf.slice(nl + 2);
    const items: Reply[] = [];
    for (let i = 0; i < count; i += 1) {
      const part = take(rest);
      if (!part) return null;
      items.push(part.reply);
      rest = part.rest;
    }
    return { reply: items, rest };
  }
  if (buf.startsWith("+") || buf.startsWith(":") || buf.startsWith("-")) {
    const nl = buf.indexOf("\r\n");
    if (nl < 0) return null;
    const line = buf.slice(0, nl);
    if (line.startsWith("-")) throw new Error(line.slice(1));
    return { reply: line.slice(1), rest: buf.slice(nl + 2) };
  }
  if (buf.startsWith("$")) {
    const nl = buf.indexOf("\r\n");
    if (nl < 0) return null;
    const len = Number(buf.slice(1, nl));
    const start = nl + 2;
    if (buf.length < start + len + 2) return null;
    return { reply: buf.slice(start, start + len), rest: buf.slice(start + len + 2) };
  }
  return null;
}

function endpoint(url: string): { host: string; port: number; tls: boolean; username: string; password: string } {
  const parsed = new URL(url);
  if (parsed.protocol !== "redis:" && parsed.protocol !== "rediss:") throw new Error("REDIS_URL must be redis:// or rediss://");
  const tls = parsed.protocol === "rediss:";
  return {
    host: parsed.hostname,
    port: Number(parsed.port || (tls ? 6380 : 6379)),
    tls,
    username: parsed.username ? decodeURIComponent(parsed.username) : "",
    password: parsed.password ? decodeURIComponent(parsed.password) : "",
  };
}

function command(url: string, parts: readonly string[]): Promise<Reply> {
  const target = endpoint(url);
  const socket = target.tls
    ? connectTls({ host: target.host, port: target.port, ...(isIP(target.host) === 0 ? { servername: target.host } : {}) })
    : connectNet({ host: target.host, port: target.port });
  return new Promise((resolve, reject) => {
    let buf = "";
    const pending: string[] = [];
    const auth = target.username && target.password ? ["AUTH", target.username, target.password] : target.password ? ["AUTH", target.password] : null;
    if (auth) pending.push(encode(auth));
    pending.push(encode(parts));
    let authed = !auth;
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setTimeout(5_000, () => fail(new Error("redis timeout")));
    socket.on("error", (error: Error) => fail(error));
    socket.on("data", (chunk: Buffer) => {
      if (settled) return;
      buf += chunk.toString("utf8");
      try {
        if (!authed) {
          const first = take(buf);
          if (!first) return;
          if (first.reply !== "OK") return fail(new Error("redis auth failed"));
          buf = first.rest;
          authed = true;
        }
        const body = take(buf);
        if (!body) return;
        settled = true;
        resolve(body.reply);
        queueMicrotask(() => socket.destroy());
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("connect", () => {
      socket.write(pending.join(""));
    });
  });
}

function ttlSec(ttl: number): string {
  if (!Number.isFinite(ttl) || ttl < 1) return "1";
  return String(Math.floor(ttl));
}

/** A store that refuses every write. Used when REDIS_URL is unset so a code is never emailed. */
export function unavailableLoginStore(): LoginStore {
  return {
    get: async () => null,
    set: async () => {
      throw new Error("login store unavailable");
    },
    del: async () => undefined,
    incr: async () => {
      throw new Error("login store unavailable");
    },
    delIfEquals: async () => false,
    reserveSend: async () => false,
  };
}

export function openLoginStore(url: string): LoginStore {
  return {
    async get(key) {
      assertLoginKey(key);
      const reply = await command(url, ["GET", key]);
      return typeof reply === "string" ? reply : null;
    },
    async set(key, value, ttl) {
      assertLoginKey(key);
      await command(url, ["SET", key, value, "EX", ttlSec(ttl)]);
    },
    async del(key) {
      assertLoginKey(key);
      await command(url, ["DEL", key]);
    },
    async incr(key, ttl) {
      assertLoginKey(key);
      const reply = await command(url, ["EVAL", INCR_SCRIPT, "1", key, ttlSec(ttl)]);
      const n = typeof reply === "string" ? Number(reply) : Number.NaN;
      if (!Number.isFinite(n)) throw new Error("login incr failed");
      return n;
    },
    async delIfEquals(key, expected, alsoDelete) {
      assertLoginKey(key);
      assertLoginKey(alsoDelete);
      const reply = await command(url, ["EVAL", CONSUME_SCRIPT, "2", key, alsoDelete, expected]);
      return reply === "1";
    },
    async reserveSend(key, nowMs, windowMs, limit) {
      assertLoginKey(key);
      const member = `${nowMs}:${randomInt(0, 2 ** 31)}:${randomInt(0, 2 ** 31)}`;
      const reply = await command(url, ["EVAL", RATE_SCRIPT, "1", key, String(nowMs), String(windowMs), String(limit), member]);
      return reply === "1";
    },
  };
}

export function loginStoreFromEnv(env: { [key: string]: string | undefined }): LoginStore {
  return env.REDIS_URL ? openLoginStore(env.REDIS_URL) : unavailableLoginStore();
}
