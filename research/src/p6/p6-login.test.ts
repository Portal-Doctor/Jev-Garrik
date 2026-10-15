import { expect, test } from "bun:test";
import { createServer, type Socket } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardAuthorized } from "./dashboard-read";
import { cronAuthorized } from "./relay";
import {
  CODE_KEY,
  CODE_TTL_MS,
  COOKIE_NAME,
  DEFAULT_LOGIN_EMAIL,
  RESEND_EMAILS_URL,
  SEND_WINDOW_MS,
  SESSION_TTL_SEC,
  TRIES_KEY,
  allowlistedEmail,
  codesMatch,
  emailsMatch,
  generateCode,
  hashCode,
  memoryLoginStore,
  p6ViewAuthorized,
  readLoginBody,
  sameOrigin,
  sendLoginCode,
  sendViaResend,
  sessionSetCookie,
  sessionValid,
  verifyLoginCode,
  type LoginEmail,
  type LoginEnv,
  type LoginStore,
} from "./p6-login";
import { assertLoginKey, openLoginStore } from "./p6-login-store";

const SECRET = "test-session-secret-at-least-32-chars";
const FROM = "sign-in@example.com";
const API_KEY = "re_test_not_a_real_key";

function env(over: LoginEnv = {}): LoginEnv {
  return {
    P6_SESSION_SECRET: SECRET,
    P6_LOGIN_FROM: FROM,
    RESEND_API_KEY: API_KEY,
    DASHBOARD_TOKEN: "view-token",
    ...over,
  };
}

function harness(now = 1_700_000_000_000) {
  let clock = now;
  const store = memoryLoginStore(() => clock);
  const sent: LoginEmail[] = [];
  return {
    store,
    sent,
    get now() {
      return clock;
    },
    set now(value: number) {
      clock = value;
    },
    async send(email: string, over: LoginEnv = {}) {
      return sendLoginCode({
        email,
        env: env(over),
        store,
        sendEmail: async (message) => {
          sent.push(message);
        },
        now: clock,
        clock: () => clock,
        sleep: async () => undefined,
        minElapsedMs: 0,
        randomCode: () => "042317",
      });
    },
    async verify(email: string, code: string, over: LoginEnv = {}) {
      return verifyLoginCode({
        email,
        code,
        env: env(over),
        store,
        now: clock,
        clock: () => clock,
        sleep: async () => undefined,
        minElapsedMs: 0,
      });
    },
  };
}

test("a code expires after 10 minutes and is single use", async () => {
  const h = harness();
  await h.send(DEFAULT_LOGIN_EMAIL);
  expect(h.sent).toHaveLength(1);
  const stored = await h.store.get(CODE_KEY);
  expect(stored).toBeTruthy();
  expect(stored).not.toContain("042317");
  expect(JSON.parse(stored ?? "{}").hash).toBe(hashCode("042317", SECRET));

  h.now += CODE_TTL_MS;
  const expired = await h.verify(DEFAULT_LOGIN_EMAIL, "042317");
  expect(expired.ok).toBe(false);
  expect(await h.store.get(CODE_KEY)).toBeNull();

  h.now += 1;
  await h.send(DEFAULT_LOGIN_EMAIL);
  const first = await h.verify(DEFAULT_LOGIN_EMAIL, "042317");
  expect(first.ok).toBe(true);
  const second = await h.verify(DEFAULT_LOGIN_EMAIL, "042317");
  expect(second.ok).toBe(false);
  expect(await h.store.get(CODE_KEY)).toBeNull();
  expect(await h.store.get(TRIES_KEY)).toBeNull();
});

test("five wrong tries invalidate the code", async () => {
  const h = harness();
  await h.send(DEFAULT_LOGIN_EMAIL);
  for (let i = 0; i < 4; i += 1) {
    const failed = await h.verify(DEFAULT_LOGIN_EMAIL, "111111");
    expect(failed.ok).toBe(false);
    expect(await h.store.get(CODE_KEY)).toBeTruthy();
  }
  const locked = await h.verify(DEFAULT_LOGIN_EMAIL, "222222");
  expect(locked.ok).toBe(false);
  expect(await h.store.get(CODE_KEY)).toBeNull();
  const after = await h.verify(DEFAULT_LOGIN_EMAIL, "042317");
  expect(after.ok).toBe(false);
});

test("the fourth wrong try still allows the real code", async () => {
  const h = harness();
  await h.send(DEFAULT_LOGIN_EMAIL);
  for (let i = 0; i < 4; i += 1) expect((await h.verify(DEFAULT_LOGIN_EMAIL, "999999")).ok).toBe(false);
  expect((await h.verify(DEFAULT_LOGIN_EMAIL, "042317")).ok).toBe(true);
});

test("send emails only the allowlisted address and answers the same way either way", async () => {
  const h = harness();
  const denied = await h.send("someone@example.com");
  const allowed = await h.send(`  ${DEFAULT_LOGIN_EMAIL.toUpperCase()}  `);
  const alias = await h.send("grandmobiusbrian+tag@netscape.net");
  expect(denied).toEqual(allowed);
  expect(alias).toEqual(allowed);
  expect(h.sent.map((message) => message.to)).toEqual([DEFAULT_LOGIN_EMAIL]);
  expect(h.sent[0]?.text).toContain("042317");
  expect(h.sent[0]?.from).toBe(FROM);
});

test("a disallowed address cannot burn the send budget", async () => {
  const h = harness();
  for (let i = 0; i < 10; i += 1) await h.send("other@example.com");
  await h.send(DEFAULT_LOGIN_EMAIL);
  expect(h.sent).toHaveLength(1);
});

test("sending is limited to 3 per 15 minutes", async () => {
  const h = harness();
  await h.send(DEFAULT_LOGIN_EMAIL);
  await h.send(DEFAULT_LOGIN_EMAIL);
  await h.send(DEFAULT_LOGIN_EMAIL);
  await h.send(DEFAULT_LOGIN_EMAIL);
  expect(h.sent).toHaveLength(3);
  const still = await h.store.get(CODE_KEY);
  h.now += SEND_WINDOW_MS;
  await h.send(DEFAULT_LOGIN_EMAIL);
  expect(h.sent).toHaveLength(4);
  expect(await h.store.get(CODE_KEY)).not.toBe(still);
});

test("missing secret, sender, or api key does not email", async () => {
  const h = harness();
  await h.send(DEFAULT_LOGIN_EMAIL, { P6_SESSION_SECRET: `  ${SECRET}\n` });
  expect(h.sent).toHaveLength(1);
  expect((await h.verify(DEFAULT_LOGIN_EMAIL, "042317", { P6_SESSION_SECRET: SECRET })).ok).toBe(true);
  h.sent.length = 0;
  await h.send(DEFAULT_LOGIN_EMAIL, { P6_SESSION_SECRET: "too-short" });
  await h.send(DEFAULT_LOGIN_EMAIL, { P6_LOGIN_FROM: "  " });
  await h.send(DEFAULT_LOGIN_EMAIL, { RESEND_API_KEY: undefined });
  expect(h.sent).toHaveLength(0);
  expect((await h.verify(DEFAULT_LOGIN_EMAIL, "042317", { P6_SESSION_SECRET: "too-short" })).ok).toBe(false);
});

test("an env override replaces the default address", async () => {
  const h = harness();
  await h.send(DEFAULT_LOGIN_EMAIL, { P6_LOGIN_EMAIL: "brian@example.com" });
  await h.send("brian@example.com", { P6_LOGIN_EMAIL: "brian@example.com" });
  expect(h.sent.map((message) => message.to)).toEqual(["brian@example.com"]);
  expect(allowlistedEmail({ P6_LOGIN_EMAIL: "  " }).email).toBe(DEFAULT_LOGIN_EMAIL);
  expect(allowlistedEmail({}).usable).toBe(true);
});

test("code compare is constant time and ignores a non-digit shape", () => {
  expect(codesMatch("042317", hashCode("042317", SECRET), SECRET)).toBe(true);
  expect(codesMatch("042318", hashCode("042317", SECRET), SECRET)).toBe(false);
  expect(codesMatch("042317", "zz", SECRET)).toBe(false);
  expect(emailsMatch(` ${DEFAULT_LOGIN_EMAIL.toUpperCase()} `, DEFAULT_LOGIN_EMAIL)).toBe(true);
  expect(emailsMatch("other@example.com", DEFAULT_LOGIN_EMAIL)).toBe(false);
  for (let i = 0; i < 20; i += 1) expect(generateCode()).toMatch(/^\d{6}$/);
});

test("the session cookie is HttpOnly, Secure, SameSite=Strict, and lasts 12 hours", () => {
  const now = 1_700_000_000_000;
  const header = sessionSetCookie(SECRET, now);
  expect(header.startsWith(`${COOKIE_NAME}=`)).toBe(true);
  expect(header).toContain("HttpOnly");
  expect(header).toContain("Secure");
  expect(header).toContain("SameSite=Strict");
  expect(header).toContain("Path=/p6");
  expect(header).toContain(`Max-Age=${SESSION_TTL_SEC}`);
  expect(header).not.toContain(DEFAULT_LOGIN_EMAIL);
  expect(header).not.toContain(SECRET);
  expect(header).not.toContain("042317");
  const pair = header.split(";")[0] ?? "";
  expect(sessionValid(pair, SECRET, now + SESSION_TTL_SEC * 1000 - 1)).toBe(true);
  expect(sessionValid(pair, SECRET, now + SESSION_TTL_SEC * 1000)).toBe(false);
  expect(sessionValid(pair.replace(".", ".x"), SECRET, now)).toBe(false);
  expect(sessionValid(null, SECRET, now)).toBe(false);
});

test("bearer tooling still opens /p6 and so does a valid cookie", async () => {
  const h = harness();
  await h.send(DEFAULT_LOGIN_EMAIL);
  const verified = await h.verify(DEFAULT_LOGIN_EMAIL, "042317");
  expect(verified.ok).toBe(true);
  if (!verified.ok) return;
  const cookie = verified.setCookie;
  const base = {
    dashboardToken: "view-token",
    sessionSecret: SECRET,
    now: h.now,
  };
  expect(dashboardAuthorized("Bearer view-token", "view-token")).toBe(true);
  expect(dashboardAuthorized("Bearer cron-secret", "view-token")).toBe(false);
  expect(
    p6ViewAuthorized({ ...base, authorization: "Bearer view-token", cookie: null }),
  ).toBe(true);
  expect(p6ViewAuthorized({ ...base, authorization: null, cookie })).toBe(true);
  expect(p6ViewAuthorized({ ...base, authorization: "Bearer wrong", cookie: null })).toBe(false);
  expect(p6ViewAuthorized({ ...base, authorization: null, cookie: null })).toBe(false);
  expect(p6ViewAuthorized({ ...base, authorization: "Bearer cron-secret", cookie: null })).toBe(false);
  expect(p6ViewAuthorized({ ...base, authorization: null, cookie, sessionSecret: "short" })).toBe(false);
  expect(cronAuthorized("Bearer cron-secret", "cron-secret")).toBe(true);
  expect(cronAuthorized(cookie, "cron-secret")).toBe(false);
});

test("send and verify pad both paths to the same floor", async () => {
  const store = memoryLoginStore(() => 10);
  const sleeps: number[] = [];
  const run = (email: string) =>
    sendLoginCode({
      email,
      env: env(),
      store,
      sendEmail: async () => undefined,
      now: 10,
      clock: () => 10,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      minElapsedMs: 25,
      randomCode: () => "042317",
    });
  await run("other@example.com");
  await run(DEFAULT_LOGIN_EMAIL);
  expect(sleeps).toEqual([25, 25]);
});

test("a refused origin does not email or accept a code", async () => {
  const h = harness();
  await sendLoginCode({
    email: DEFAULT_LOGIN_EMAIL,
    env: env(),
    store: h.store,
    sendEmail: async (message) => {
      h.sent.push(message);
    },
    permit: false,
    now: h.now,
    clock: () => h.now,
    sleep: async () => undefined,
    minElapsedMs: 0,
    randomCode: () => "042317",
  });
  expect(h.sent).toHaveLength(0);
  await h.send(DEFAULT_LOGIN_EMAIL);
  const blocked = await verifyLoginCode({
    email: DEFAULT_LOGIN_EMAIL,
    code: "042317",
    env: env(),
    store: h.store,
    permit: false,
    now: h.now,
    clock: () => h.now,
    sleep: async () => undefined,
    minElapsedMs: 0,
  });
  expect(blocked.ok).toBe(false);
  expect(await h.store.get(CODE_KEY)).toBeTruthy();
});

test("resend is a fetch to the HTTPS API and nowhere else", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  await sendViaResend(
    { to: DEFAULT_LOGIN_EMAIL, from: FROM, subject: "P6 sign-in code", text: "Your P6 sign-in code is 042317." },
    { RESEND_API_KEY: API_KEY },
    async (url, init) => {
      calls.push({ url, init: init ?? {} });
      return new Response("{}", { status: 200 });
    },
  );
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe(RESEND_EMAILS_URL);
  const headers = calls[0]?.init.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
  const body = JSON.parse(String(calls[0]?.init.body)) as { from: string; to: string; text: string };
  expect(body.to).toBe(DEFAULT_LOGIN_EMAIL);
  expect(body.from).toBe(FROM);
  expect(body.to).not.toContain("other@");
  await expect(
    sendViaResend(
      { to: DEFAULT_LOGIN_EMAIL, from: FROM, subject: "s", text: "t" },
      { RESEND_API_KEY: API_KEY },
      async () => new Response("no", { status: 403 }),
    ),
  ).rejects.toThrow(/403/);
});

test("login body parsing stays small and same-origin checks the Host header", async () => {
  const ok = new Request("https://books.example/api/p6/login/send", {
    method: "POST",
    headers: { "content-type": "application/json", host: "books.example", origin: "https://books.example" },
    body: JSON.stringify({ email: DEFAULT_LOGIN_EMAIL, code: "042317" }),
  });
  expect(sameOrigin(ok.headers)).toBe(true);
  expect(await readLoginBody(ok)).toEqual({ email: DEFAULT_LOGIN_EMAIL, code: "042317" });
  const cross = new Request("https://books.example/api/p6/login/send", {
    headers: { host: "books.example", origin: "https://evil.example" },
  });
  expect(sameOrigin(cross.headers)).toBe(false);
  const huge = new Request("https://books.example/api/p6/login/send", {
    method: "POST",
    headers: { "content-type": "application/json", "content-length": "99999" },
    body: JSON.stringify({ email: DEFAULT_LOGIN_EMAIL }),
  });
  expect(await readLoginBody(huge)).toEqual({ email: "", code: "" });
});

test("the login redis client refuses keys outside p6:login:", async () => {
  expect(() => assertLoginKey("p6:hot")).toThrow(/refused/);
  const store = openLoginStore("redis://:pw@127.0.0.1:1");
  await expect(store.set("p6:hot", "{}", 10)).rejects.toThrow(/refused/);
  await expect(store.get("p6:lease")).rejects.toThrow(/refused/);
  await expect(store.delIfEquals("p6:login:code", "x", "p6:lease")).rejects.toThrow(/refused/);
});

test("login redis commands round-trip against a local mock", async () => {
  const db = new Map<string, { value: string; exp: number }>();
  const zsets = new Map<string, { score: number; member: string }[]>();
  const server = createServer((socket) => {
    let buf = "";
    const write = (payload: string) => socket.write(payload);
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const parsed = parseResp(buf);
      if (!parsed.done) return;
      buf = parsed.rest;
      for (const cmd of parsed.cmds) write(exec(cmd, db, zsets));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const sockets: Socket[] = [];
  server.on("connection", (socket) => sockets.push(socket));
  try {
    const store: LoginStore = openLoginStore(`redis://:pw@127.0.0.1:${port}`);
    await store.set(CODE_KEY, "hash-1", 600);
    expect(await store.get(CODE_KEY)).toBe("hash-1");
    expect(await store.incr(TRIES_KEY, 600)).toBe(1);
    expect(await store.incr(TRIES_KEY, 600)).toBe(2);
    expect(await store.reserveSend("p6:login:sends", 1_000, 900_000, 3)).toBe(true);
    expect(await store.reserveSend("p6:login:sends", 1_001, 900_000, 1)).toBe(false);
    expect(await store.delIfEquals(CODE_KEY, "hash-1", TRIES_KEY)).toBe(true);
    expect(await store.get(CODE_KEY)).toBeNull();
    expect(await store.delIfEquals(CODE_KEY, "hash-1", TRIES_KEY)).toBe(false);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the page, proxy, and engine stay on their own auth", () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const page = readFileSync(join(root, "web/src/app/p6/page.tsx"), "utf8");
  const proxy = readFileSync(join(root, "web/src/proxy.ts"), "utf8");
  const loginPage = readFileSync(join(root, "web/src/app/p6/login/page.tsx"), "utf8");
  const loginForm = readFileSync(join(root, "web/src/app/p6/login/login-form.tsx"), "utf8");
  const sendRoute = readFileSync(join(root, "web/src/app/api/p6/login/send/route.ts"), "utf8");
  const verifyRoute = readFileSync(join(root, "web/src/app/api/p6/login/verify/route.ts"), "utf8");
  const engine = readFileSync(join(root, "web/src/app/api/engine/route.ts"), "utf8");
  const live = readFileSync(join(root, "research/src/p6/vercel-live.ts"), "utf8");
  expect(page.includes("DASHBOARD_TOKEN")).toBe(true);
  expect(page.includes("p6ViewAuthorized")).toBe(true);
  expect(page.includes("openLoginStore")).toBe(false);
  expect(page.includes(DEFAULT_LOGIN_EMAIL)).toBe(false);
  expect(proxy.includes('matcher: ["/p6"]')).toBe(true);
  expect(proxy.includes("p6ViewAuthorized")).toBe(true);
  expect(proxy.includes("CRON_SECRET")).toBe(false);
  expect(loginPage.includes(DEFAULT_LOGIN_EMAIL)).toBe(false);
  expect(loginForm.includes(DEFAULT_LOGIN_EMAIL)).toBe(false);
  expect(loginForm.includes("Send code")).toBe(true);
  expect(sendRoute.includes("sendViaResend")).toBe(true);
  expect(sendRoute.includes("memoryLoginStore")).toBe(false);
  expect(verifyRoute.includes("Set-Cookie")).toBe(true);
  expect(engine.includes("p6-login")).toBe(false);
  expect(engine.includes("p6_session")).toBe(false);
  expect(live.includes("P6_SESSION_SECRET")).toBe(false);
  expect(live.includes("p6_session")).toBe(false);
  const loginSource = readFileSync(join(import.meta.dir, "p6-login.ts"), "utf8");
  expect(loginSource.includes("randomInt")).toBe(true);
  expect(loginSource.includes("timingSafeEqual")).toBe(true);
});

function parseResp(buf: string): { done: boolean; cmds: string[][]; rest: string } {
  const cmds: string[][] = [];
  let rest = buf;
  while (rest.startsWith("*")) {
    const nl = rest.indexOf("\r\n");
    if (nl < 0) return { done: false, cmds, rest: buf };
    const count = Number(rest.slice(1, nl));
    let cursor = nl + 2;
    const parts: string[] = [];
    for (let i = 0; i < count; i += 1) {
      if (!rest.startsWith("$", cursor)) return { done: false, cmds, rest: buf };
      const nl2 = rest.indexOf("\r\n", cursor);
      if (nl2 < 0) return { done: false, cmds, rest: buf };
      const len = Number(rest.slice(cursor + 1, nl2));
      const start = nl2 + 2;
      if (rest.length < start + len + 2) return { done: false, cmds, rest: buf };
      parts.push(rest.slice(start, start + len));
      cursor = start + len + 2;
    }
    cmds.push(parts);
    rest = rest.slice(cursor);
  }
  return { done: cmds.length > 0, cmds, rest };
}

function bulk(value: string | null): string {
  if (value == null) return "$-1\r\n";
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

function exec(
  cmd: string[],
  db: Map<string, { value: string; exp: number }>,
  zsets: Map<string, { score: number; member: string }[]>,
): string {
  const op = cmd[0];
  if (op === "AUTH") return "+OK\r\n";
  if (op === "SET") {
    db.set(cmd[1] ?? "", { value: cmd[2] ?? "", exp: Date.now() + Number(cmd[4] ?? 1) * 1000 });
    return "+OK\r\n";
  }
  if (op === "GET") return bulk(db.get(cmd[1] ?? "")?.value ?? null);
  if (op === "DEL") {
    db.delete(cmd[1] ?? "");
    return ":1\r\n";
  }
  if (op === "EVAL" && (cmd[1] ?? "").includes("ZCARD")) {
    const key = cmd[3] ?? "";
    const now = Number(cmd[4]);
    const window = Number(cmd[5]);
    const limit = Number(cmd[6]);
    const member = cmd[7] ?? "";
    const kept = (zsets.get(key) ?? []).filter((row) => row.score > now - window);
    if (kept.length >= limit) {
      zsets.set(key, kept);
      return ":0\r\n";
    }
    kept.push({ score: now, member });
    zsets.set(key, kept);
    return ":1\r\n";
  }
  if (op === "EVAL" && (cmd[1] ?? "").includes("INCR")) {
    const key = cmd[3] ?? "";
    const current = Number(db.get(key)?.value ?? "0");
    const n = current + 1;
    const prev = db.get(key);
    db.set(key, { value: String(n), exp: prev?.exp ?? Date.now() + Number(cmd[4] ?? 1) * 1000 });
    return `:${n}\r\n`;
  }
  if (op === "EVAL" && (cmd[1] ?? "").includes("== ARGV[1]")) {
    const key = cmd[3] ?? "";
    const also = cmd[4] ?? "";
    if (db.get(key)?.value === cmd[5]) {
      db.delete(key);
      db.delete(also);
      return ":1\r\n";
    }
    return ":0\r\n";
  }
  return "-ERR unknown\r\n";
}
