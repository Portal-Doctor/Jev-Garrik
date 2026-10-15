/**
 * One-time-code sign-in for the read-only /p6 view.
 * This file does not open a socket and does not import the host, the relay, or the hot store.
 *
 * Env Brian sets in Vercel:
 * - RESEND_API_KEY
 * - P6_LOGIN_FROM
 * - P6_SESSION_SECRET
 * Optional override of the single allowlisted address: P6_LOGIN_EMAIL
 * Code storage reuses the existing REDIS_URL. Tooling still uses DASHBOARD_TOKEN.
 */

import { createHash, createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { dashboardAuthorized } from "./dashboard-read";

export const P6_LOGIN_EMAIL_ENV = "P6_LOGIN_EMAIL";
export const P6_SESSION_SECRET_ENV = "P6_SESSION_SECRET";
export const P6_LOGIN_FROM_ENV = "P6_LOGIN_FROM";
export const RESEND_API_KEY_ENV = "RESEND_API_KEY";

export const DEFAULT_LOGIN_EMAIL = "grandmobiusbrian@netscape.net";
export const CODE_KEY = "p6:login:code";
export const TRIES_KEY = "p6:login:tries";
export const SENDS_KEY = "p6:login:sends";
export const COOKIE_NAME = "p6_session";

export const CODE_TTL_MS = 10 * 60 * 1000;
export const CODE_TTL_SEC = 600;
export const MAX_TRIES = 5;
export const SEND_LIMIT = 3;
export const SEND_WINDOW_MS = 15 * 60 * 1000;
export const SESSION_TTL_SEC = 12 * 60 * 60;
export const MIN_SECRET_LENGTH = 32;
export const MAX_EMAIL_LENGTH = 320;
export const MIN_RESPONSE_MS = 400;
export const RESEND_EMAILS_URL = "https://api.resend.com/emails";

const DUMMY_CODE = "p6-login-dummy";

export interface LoginEnv {
  [key: string]: string | undefined;
  P6_LOGIN_EMAIL?: string;
  P6_SESSION_SECRET?: string;
  P6_LOGIN_FROM?: string;
  RESEND_API_KEY?: string;
  DASHBOARD_TOKEN?: string;
  REDIS_URL?: string;
}

export interface LoginStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSec: number): Promise<void>;
  del(key: string): Promise<void>;
  incr(key: string, ttlSec: number): Promise<number>;
  /** Delete key only when its current value is still expected. Also deletes alsoDelete. */
  delIfEquals(key: string, expected: string, alsoDelete: string): Promise<boolean>;
  /** Sliding window. True when this send is within the limit and was recorded. */
  reserveSend(key: string, nowMs: number, windowMs: number, limit: number): Promise<boolean>;
}

export interface LoginEmail {
  to: string;
  from: string;
  subject: string;
  text: string;
}

interface CodeRecord {
  hash: string;
  exp: number;
}

export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase().slice(0, MAX_EMAIL_LENGTH);
}

function usableAddress(email: string): boolean {
  if (email.length < 3 || email.length > MAX_EMAIL_LENGTH) return false;
  const at = email.indexOf("@");
  if (at <= 0 || at !== email.lastIndexOf("@")) return false;
  if (/[\s,]/.test(email)) return false;
  return true;
}

/** The one address that may receive a code. An override replaces the default; it does not add a second address. */
export function allowlistedEmail(env: LoginEnv): { email: string; usable: boolean } {
  const raw = env.P6_LOGIN_EMAIL;
  const chosen = typeof raw === "string" && raw.trim() ? raw : DEFAULT_LOGIN_EMAIL;
  const email = normalizeEmail(chosen);
  return { email, usable: usableAddress(email) };
}

export function emailsMatch(submitted: string, allow: string): boolean {
  const a = createHash("sha256").update(normalizeEmail(submitted), "utf8").digest();
  const b = createHash("sha256").update(normalizeEmail(allow), "utf8").digest();
  return timingSafeEqual(a, b);
}

export function sessionSecret(env: LoginEnv): string | null {
  const raw = env.P6_SESSION_SECRET;
  if (typeof raw !== "string") return null;
  const secret = raw.trim();
  if (secret.length < MIN_SECRET_LENGTH) return null;
  return secret;
}

export function generateCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

export function hashCode(code: string, secret: string): string {
  return createHmac("sha256", secret).update(code, "utf8").digest("hex");
}

/** Constant-time compare of a submitted code against a stored HMAC hex digest. */
export function codesMatch(submitted: string, storedHash: string, secret: string): boolean {
  const actual = createHmac("sha256", secret).update(submitted, "utf8").digest();
  const expected = Buffer.from(storedHash, "hex");
  if (expected.length !== actual.length) {
    timingSafeEqual(actual, actual);
    return false;
  }
  return timingSafeEqual(actual, expected);
}

export function sessionSetCookie(secret: string, now: number): string {
  const exp = now + SESSION_TTL_SEC * 1000;
  const payload = Buffer.from(JSON.stringify({ v: 1, exp }), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
  const value = `${payload}.${sig}`;
  return `${COOKIE_NAME}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/p6; Max-Age=${SESSION_TTL_SEC}`;
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    return part.slice(eq + 1).trim();
  }
  return null;
}

export function sessionValid(cookieHeader: string | null, secret: string, now: number): boolean {
  const raw = readCookie(cookieHeader, COOKIE_NAME);
  if (!raw) return false;
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = raw.slice(0, dot);
  const sig = raw.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload, "utf8").digest("base64url");
  const actual = Buffer.from(sig);
  const wanted = Buffer.from(expected);
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) return false;
  try {
    const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v?: unknown; exp?: unknown };
    if (body.v !== 1 || typeof body.exp !== "number" || !Number.isFinite(body.exp)) return false;
    return body.exp > now;
  } catch {
    return false;
  }
}

/** Bearer DASHBOARD_TOKEN or a valid login cookie. A cron secret is neither. */
export function p6ViewAuthorized(input: {
  authorization: string | null;
  cookie: string | null;
  dashboardToken: string | undefined;
  sessionSecret: string | undefined;
  now: number;
}): boolean {
  if (dashboardAuthorized(input.authorization, input.dashboardToken)) return true;
  const secret = sessionSecret({ P6_SESSION_SECRET: input.sessionSecret });
  if (!secret) return false;
  return sessionValid(input.cookie, secret, input.now);
}

export function sameOrigin(headers: { get(name: string): string | null }): boolean {
  const origin = headers.get("origin");
  if (!origin) return true;
  const host = headers.get("host");
  if (!host) return false;
  try {
    const hostName = host.split(",")[0]?.trim();
    if (!hostName) return false;
    return new URL(origin).host === hostName;
  } catch {
    return false;
  }
}

export async function readLoginBody(request: Request): Promise<{ email: string; code: string }> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 4096) return { email: "", code: "" };
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().includes("application/json")) return { email: "", code: "" };
  try {
    const body = (await request.json()) as { email?: unknown; code?: unknown };
    return {
      email: typeof body.email === "string" ? body.email.slice(0, MAX_EMAIL_LENGTH) : "",
      code: typeof body.code === "string" ? body.code.slice(0, 32) : "",
    };
  } catch {
    return { email: "", code: "" };
  }
}

function parseRecord(raw: string | null): CodeRecord | null {
  if (!raw) return null;
  try {
    const body = JSON.parse(raw) as { hash?: unknown; exp?: unknown };
    if (typeof body.hash !== "string" || typeof body.exp !== "number" || !Number.isFinite(body.exp)) return null;
    return { hash: body.hash, exp: body.exp };
  } catch {
    return null;
  }
}

function remainingSec(exp: number, now: number): number {
  return Math.max(1, Math.ceil((exp - now) / 1000));
}

async function pad(started: number, clock: () => number, minElapsedMs: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  const wait = Math.max(0, minElapsedMs - (clock() - started));
  if (wait > 0) await sleep(wait);
}

export async function sendLoginCode(input: {
  email: string;
  env: LoginEnv;
  store: LoginStore;
  sendEmail: (message: LoginEmail) => Promise<void>;
  permit?: boolean;
  now?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minElapsedMs?: number;
  randomCode?: () => string;
}): Promise<{ ok: true }> {
  const now = input.now ?? Date.now();
  const clock = input.clock ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const minElapsedMs = input.minElapsedMs ?? MIN_RESPONSE_MS;
  const started = clock();
  try {
    const allow = allowlistedEmail(input.env);
    const allowed = emailsMatch(input.email, allow.email);
    const secret = sessionSecret(input.env);
    const from = typeof input.env.P6_LOGIN_FROM === "string" ? input.env.P6_LOGIN_FROM.trim() : "";
    const apiKey = typeof input.env.RESEND_API_KEY === "string" ? input.env.RESEND_API_KEY.trim() : "";
    const code = (input.randomCode ?? generateCode)();
    const configured = Boolean(secret && from && apiKey && allow.usable);
    if (input.permit !== false && allowed && configured && secret) {
      const reserved = await input.store.reserveSend(SENDS_KEY, now, SEND_WINDOW_MS, SEND_LIMIT);
      if (reserved) {
        const exp = now + CODE_TTL_MS;
        const record = JSON.stringify({ hash: hashCode(code, secret), exp });
        await input.store.set(CODE_KEY, record, CODE_TTL_SEC);
        await input.store.set(TRIES_KEY, "0", CODE_TTL_SEC);
        try {
          await input.sendEmail({
            to: allow.email,
            from,
            subject: "P6 sign-in code",
            text: `Your P6 sign-in code is ${code}. It expires in 10 minutes. If you did not request this, you can ignore this email.`,
          });
        } catch {
          await input.store.del(CODE_KEY).catch(() => undefined);
          await input.store.del(TRIES_KEY).catch(() => undefined);
        }
      }
    } else {
      await input.store.get(CODE_KEY);
    }
  } catch {
    // The HTTP response stays the generic body. Delivery failure is not surfaced.
  }
  await pad(started, clock, minElapsedMs, sleep);
  return { ok: true };
}

export async function verifyLoginCode(input: {
  email: string;
  code: string;
  env: LoginEnv;
  store: LoginStore;
  permit?: boolean;
  now?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  minElapsedMs?: number;
}): Promise<{ ok: true; setCookie: string } | { ok: false }> {
  const now = input.now ?? Date.now();
  const clock = input.clock ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const minElapsedMs = input.minElapsedMs ?? MIN_RESPONSE_MS;
  const started = clock();
  let result: { ok: true; setCookie: string } | { ok: false } = { ok: false };
  try {
    const secret = sessionSecret(input.env);
    const allow = allowlistedEmail(input.env);
    const emailOk = Boolean(secret) && allow.usable && emailsMatch(input.email, allow.email);
    const submitted = input.code.trim();
    const raw = secret ? await input.store.get(CODE_KEY) : null;
    const record = parseRecord(raw);
    const live = Boolean(record && secret && record.exp > now);
    const hash = live && record && secret ? record.hash : hashCode(DUMMY_CODE, secret ?? DUMMY_CODE);
    const match = Boolean(secret) && codesMatch(submitted, hash, secret ?? DUMMY_CODE) && /^\d{6}$/.test(submitted);
    if (input.permit !== false && emailOk && live && match && secret && raw && record) {
      const deleted = await input.store.delIfEquals(CODE_KEY, raw, TRIES_KEY);
      if (deleted) result = { ok: true, setCookie: sessionSetCookie(secret, now) };
    } else if (emailOk && live && secret && record) {
      const tries = await input.store.incr(TRIES_KEY, remainingSec(record.exp, now));
      if (tries >= MAX_TRIES) {
        await input.store.del(CODE_KEY);
        await input.store.del(TRIES_KEY);
      }
    } else if (record && record.exp <= now) {
      await input.store.del(CODE_KEY);
      await input.store.del(TRIES_KEY);
    } else if (secret) {
      codesMatch(submitted, hashCode(DUMMY_CODE, secret), secret);
    }
  } catch {
    result = { ok: false };
  }
  await pad(started, clock, minElapsedMs, sleep);
  return result;
}

export async function sendViaResend(
  message: LoginEmail,
  env: LoginEnv,
  fetchImpl: (url: string, init: RequestInit) => Promise<Pick<Response, "ok" | "status">> = fetch,
): Promise<void> {
  const key = env.RESEND_API_KEY?.trim();
  if (!key) throw new Error("resend unconfigured");
  const res = await fetchImpl(RESEND_EMAILS_URL, {
    method: "POST",
    redirect: "manual",
    signal: AbortSignal.timeout(8_000),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    }),
  });
  if (!res.ok) throw new Error(`resend status ${res.status}`);
}

interface MemoryRow {
  value: string;
  exp: number;
}

/** In-memory stand-in for tests. Production uses the prefix-locked Redis store. */
export function memoryLoginStore(now: () => number = Date.now): LoginStore {
  const rows = new Map<string, MemoryRow>();
  const sends = new Map<string, number[]>();

  function live(key: string): MemoryRow | null {
    const row = rows.get(key);
    if (!row) return null;
    if (row.exp <= now()) {
      rows.delete(key);
      return null;
    }
    return row;
  }

  return {
    async get(key) {
      return live(key)?.value ?? null;
    },
    async set(key, value, ttlSec) {
      rows.set(key, { value, exp: now() + ttlSec * 1000 });
    },
    async del(key) {
      rows.delete(key);
    },
    async incr(key, ttlSec) {
      const row = live(key);
      const n = (row ? Number(row.value) : 0) + 1;
      const exp = row ? row.exp : now() + ttlSec * 1000;
      rows.set(key, { value: String(n), exp });
      return n;
    },
    async delIfEquals(key, expected, alsoDelete) {
      const row = live(key);
      if (!row || row.value !== expected) return false;
      rows.delete(key);
      rows.delete(alsoDelete);
      return true;
    },
    async reserveSend(key, nowMs, windowMs, limit) {
      const cutoff = nowMs - windowMs;
      const kept = (sends.get(key) ?? []).filter((score) => score > cutoff);
      if (kept.length >= limit) {
        sends.set(key, kept);
        return false;
      }
      kept.push(nowMs);
      sends.set(key, kept);
      return true;
    },
  };
}
