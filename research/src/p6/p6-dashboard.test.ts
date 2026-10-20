import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { absoluteDashboardLocation, applyDashboardProxy, dashboardAuthorized, dashboardCookieValue, dashboardSetCookie, formatP6Public, openDashboardKv, P6_COOKIE_NAME, readP6Dashboard, redactP6View } from "./dashboard-read";
import { cronAuthorized } from "./relay";
import { handleEngineRequest } from "./vercel-live";
import { applyForward, paperPnl, replayInjected } from "./engine";
import { delayBps } from "./legs";
import { memoryKv } from "./relay";

test("the cron secret does not authorize the dashboard", () => {
  expect(dashboardAuthorized("Bearer cron-secret", "view-token")).toBe(false);
  expect(dashboardAuthorized("Bearer view-token", "view-token")).toBe(true);
  expect(dashboardAuthorized("Bearer view-token", undefined)).toBe(false);
  expect(dashboardAuthorized(null, "view-token")).toBe(false);
});

test("a write to /p6 accepts the bearer, the cookie, or a token query", () => {
  const token = "view-token";
  const cookie = `${P6_COOKIE_NAME}=${dashboardCookieValue(token)}`;
  const other = `${P6_COOKIE_NAME}=${dashboardCookieValue("other-token")}`;
  const header = applyDashboardProxy(new Request("https://example.test/p6", { method: "POST", headers: { authorization: "Bearer view-token" } }), token);
  expect(header.status).toBe(200);
  expect(header.headers["Cache-Control"]).toBe("no-store");
  expect(header.headers["Referrer-Policy"]).toBe("no-referrer");

  const fromCookie = applyDashboardProxy(new Request("https://example.test/p6", { method: "POST", headers: { cookie } }), token);
  expect(fromCookie.status).toBe(200);

  const opened = applyDashboardProxy(new Request("https://example.test/p6?token=view-token&panel=spend", { method: "POST" }), token);
  expect(opened.status).toBe(302);
  expect(opened.headers.Location).toBe("/p6?panel=spend");
  expect(opened.body).toBeNull();
  const setCookie = opened.headers["Set-Cookie"] ?? "";
  expect(setCookie.startsWith(`${P6_COOKIE_NAME}=${dashboardCookieValue(token)}`)).toBe(true);
  expect(setCookie.includes("HttpOnly")).toBe(true);
  expect(setCookie.includes("Secure")).toBe(true);
  expect(setCookie.includes("SameSite=Strict")).toBe(true);
  expect(setCookie.includes("Path=/p6")).toBe(true);
  expect(setCookie.includes("Max-Age=2592000")).toBe(true);
  expect(setCookie.includes(token)).toBe(false);
  expect(opened.headers["Cache-Control"]).toBe("no-store");
  expect(opened.headers["Referrer-Policy"]).toBe("no-referrer");

  const wrong = applyDashboardProxy(new Request("https://example.test/p6?token=nope", { method: "POST", headers: { authorization: "Bearer view-token", cookie } }), token);
  expect(wrong.status).toBe(401);
  expect(wrong.body).toBe("unauthorized");
  const empty = applyDashboardProxy(new Request("https://example.test/p6?token=", { method: "POST", headers: { cookie } }), token);
  expect(empty.status).toBe(401);
  const malformed = applyDashboardProxy(new Request("https://example.test/p6", { method: "POST", headers: { cookie: `${P6_COOKIE_NAME}=not-a-cookie` } }), token);
  expect(malformed.status).toBe(401);
  const tampered = dashboardCookieValue(token).slice(0, -1) + (dashboardCookieValue(token).endsWith("a") ? "b" : "a");
  expect(applyDashboardProxy(new Request("https://example.test/p6", { method: "POST", headers: { cookie: `${P6_COOKIE_NAME}=${tampered}` } }), token).status).toBe(401);
  expect(applyDashboardProxy(new Request("https://example.test/p6", { method: "POST", headers: { cookie: other } }), token).status).toBe(401);

  const allValid = applyDashboardProxy(new Request("https://example.test/p6?token=view-token", { method: "POST", headers: { authorization: "Bearer view-token", cookie } }), token);
  expect(allValid.status).toBe(302);
  expect(allValid.headers.Location).toBe("/p6");
  const bearerWins = applyDashboardProxy(new Request("https://example.test/p6", { method: "POST", headers: { authorization: "Bearer view-token", cookie: other } }), token);
  expect(bearerWins.status).toBe(200);
  const cookieWins = applyDashboardProxy(new Request("https://example.test/p6", { method: "POST", headers: { authorization: "Bearer nope", cookie } }), token);
  expect(cookieWins.status).toBe(200);
  expect(applyDashboardProxy(new Request("https://example.test/p6", { method: "POST", headers: { authorization: "Bearer nope", cookie: other } }), token).status).toBe(401);
  expect(applyDashboardProxy(new Request("https://example.test/p6", { method: "POST" }), undefined).status).toBe(401);

  expect(cronAuthorized("Bearer view-token", "cron-secret")).toBe(false);
  expect(cronAuthorized(`Bearer ${token}`, "cron-secret")).toBe(false);
  const root = join(import.meta.dir, "..", "..", "..");
  const engine = readFileSync(join(root, "web/src/app/api/engine/route.ts"), "utf8");
  const relay = readFileSync(join(import.meta.dir, "relay.ts"), "utf8");
  const cron = relay.slice(relay.indexOf("export function cronAuthorized"));
  expect(engine.includes(P6_COOKIE_NAME)).toBe(false);
  expect(engine.includes("DASHBOARD_TOKEN")).toBe(false);
  expect(cron.includes(P6_COOKIE_NAME)).toBe(false);
  expect(cron.includes("token=")).toBe(false);
});

const nextUrlPath = join(import.meta.dir, "..", "..", "..", "web/node_modules/next/dist/server/web/next-url.js");

test("a write with ?token= Location is absolute, drops the token, and keeps the cookie", () => {
  const token = "view-token";
  const requestUrl = "https://dash.example/p6?token=view-token&panel=spend";
  const opened = applyDashboardProxy(new Request(requestUrl, { method: "POST" }), token);
  expect(opened.status).toBe(302);
  const location = absoluteDashboardLocation(requestUrl, opened.headers.Location ?? "");
  expect(location).toBe("https://dash.example/p6?panel=spend");
  const parsed = new URL(location ?? "about:blank");
  expect(parsed.pathname).toBe("/p6");
  expect(parsed.searchParams.has("token")).toBe(false);
  expect(parsed.searchParams.get("panel")).toBe("spend");
  const bare = absoluteDashboardLocation("https://dash.example/p6?token=view-token", "/p6");
  expect(bare).toBe("https://dash.example/p6");
  expect(bare?.endsWith("/p6")).toBe(true);
  const setCookie = opened.headers["Set-Cookie"] ?? "";
  expect(setCookie).toBe(dashboardSetCookie(token));
  expect(setCookie.includes("HttpOnly")).toBe(true);
  expect(setCookie.includes("Secure")).toBe(true);
  expect(setCookie.includes("SameSite=Strict")).toBe(true);
  expect(setCookie.includes("Path=/p6")).toBe(true);
  expect(setCookie.includes(token)).toBe(false);
  expect(opened.headers["Cache-Control"]).toBe("no-store");
  expect(opened.headers["Referrer-Policy"]).toBe("no-referrer");
  expect(absoluteDashboardLocation(requestUrl, "//evil.example/p6")).toBeNull();
  expect(absoluteDashboardLocation(requestUrl, "/elsewhere")).toBeNull();
});

test.skipIf(!existsSync(nextUrlPath))("NextURL accepts the absolute /p6 Location", async () => {
  const nextUrlFile = nextUrlPath;
  const proxyFile = join(import.meta.dir, "..", "..", "..", "web/src/proxy.ts");
  const { NextURL } = (await import(nextUrlFile)) as {
    NextURL: new (input: string, options?: { forceLocale?: boolean }) => { pathname: string };
  };
  const { proxy } = (await import(proxyFile)) as {
    proxy: (request: Request) => { status: number; headers: Headers };
  };
  const previous = process.env.DASHBOARD_TOKEN;
  process.env.DASHBOARD_TOKEN = "view-token";
  try {
    const request = new Request("https://dash.example/p6?token=view-token&panel=spend", { method: "POST" });
    const response = proxy(request);
    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).toBe("https://dash.example/p6?panel=spend");
    const parsed = new NextURL(location ?? "", { forceLocale: false });
    expect(parsed.pathname).toBe("/p6");
    expect(String(parsed)).toContain("/p6?panel=spend");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toBe(dashboardSetCookie("view-token"));
    expect(() => new NextURL("/p6", { forceLocale: false })).toThrow();
  } finally {
    if (previous === undefined) delete process.env.DASHBOARD_TOKEN;
    else process.env.DASHBOARD_TOKEN = previous;
  }
});

test("the page path only reads Redis", async () => {
  const kv = memoryKv();
  await kv.set("p6:lastRun", JSON.stringify({ outcome: "handover", warm: 1, pnl: { equityUsd: 8000 } }));
  await kv.set("p6:hot", JSON.stringify({ incidents: ["see https://example.test/secret"], killSwitch: false, positions: [], gaps: [] }));
  await kv.set("p6:lease", JSON.stringify({ holder: "cron-1", untilMs: 10, token: "secret-token", release: "none" }));
  const writes = ["set", "del", "cas", "ownedSet", "ownedAppend", "ownedFlush"] as const;
  for (const name of writes) {
    kv[name] = (async () => {
      throw new Error(`write ${name}`);
    }) as never;
  }
  const view = await readP6Dashboard(kv);
  expect(view.lease).toEqual({ holder: "cron-1", untilMs: 10 });
  expect(JSON.stringify(view)).not.toContain("secret-token");
  expect(view.incidents[0]).toBe("see [url]");
  expect((view.lastRun?.pnl as { equityUsd: number }).equityUsd).toBe(8000);
  await expect(openDashboardKv("redis://:pw@127.0.0.1:1").set("p6:hot", "{}")).rejects.toThrow(/read-only/);
});

test("a large mget split across packets is still the snapshot", async () => {
  const body = "x".repeat(8_000);
  const payload = `+OK\r\n*1\r\n$${body.length}\r\n${body}\r\n`;
  let chunks = 0;
  const server = createServer((socket) => {
    socket.write(payload.slice(0, 12));
    setTimeout(() => {
      chunks += 1;
      socket.write(payload.slice(12));
    }, 30);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const sockets: Socket[] = [];
  server.on("connection", (socket) => sockets.push(socket));
  try {
    const got = await openDashboardKv(`redis://:pw@127.0.0.1:${port}`).get("p6:lastRun");
    expect(chunks).toBe(1);
    expect(got).toBe(body);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("the proxy matcher covers /p6 and every subpath", () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const proxy = readFileSync(join(root, "web/src/proxy.ts"), "utf8");
  expect(proxy.includes('matcher: ["/p6", "/p6/:path*"]')).toBe(true);
  const token = "view-token";
  const cookie = `${P6_COOKIE_NAME}=${dashboardCookieValue(token)}`;
  const routes = ["/p6", "/p6/positions", "/p6/trades", "/p6/gates", "/p6/jev", "/p6/health"];
  for (const route of routes) {
    expect(applyDashboardProxy(new Request(`https://example.test${route}`, { method: "GET" }), token).status, route).toBe(200);
    expect(applyDashboardProxy(new Request(`https://example.test${route}`, { method: "POST" }), token).status, route).toBe(401);
    expect(applyDashboardProxy(new Request(`https://example.test${route}`, { method: "POST", headers: { authorization: "Bearer view-token" } }), token).status, route).toBe(200);
    expect(applyDashboardProxy(new Request(`https://example.test${route}`, { method: "POST", headers: { cookie } }), token).status, route).toBe(200);
    const opened = applyDashboardProxy(new Request(`https://example.test${route}?token=view-token&w=8h`, { method: "POST" }), token);
    expect(opened.status, route).toBe(302);
    expect(opened.headers.Location, route).toBe(`${route}?w=8h`);
    expect(opened.headers.Location?.includes("token="), route).toBe(false);
    expect(opened.headers["Set-Cookie"]?.includes("Path=/p6"), route).toBe(true);
    expect(opened.headers["Set-Cookie"]?.includes("Path=/p6/"), route).toBe(false);
    expect(applyDashboardProxy(new Request(`https://example.test${route}?token=nope&w=24h`, { method: "POST" }), token).status, route).toBe(401);
  }
});

test("a no-cookie GET /p6 returns 200 and the public output is redacted", () => {
  const open = applyDashboardProxy(new Request("https://example.test/p6", { method: "GET" }), undefined);
  expect(open.status).toBe(200);
  const holder = "lease-holder-cron-9";
  const rawMarker = "raw-last-run-object";
  const jevError = "Jev caller Error: invalid api key sk-live-jev-secret";
  const shown = redactP6View({
    lease: { holder, untilMs: 10 },
    lastRun: {
      outcome: "handover",
      warm: 1,
      secretBlob: rawMarker,
      jev: { holder, totalUsd: 1, error: jevError },
      redis: { cmds: 3, host: "redis.internal:6379" },
    },
    killSwitch: false,
    incidents: [`kv set redis://default:pw@redis.internal:6379 down`, jevError, "connect ECONNREFUSED 10.1.2.3:6379"],
    gaps: [],
    positions: [],
    closed: [],
    emitted: [],
  });
  const output = JSON.stringify(shown);
  expect(output).not.toContain(holder);
  expect(output).not.toContain(rawMarker);
  expect(output).not.toContain("redis.internal");
  expect(output).not.toContain("redis://");
  expect(output).not.toContain("10.1.2.3");
  expect(output).not.toContain("sk-live-jev-secret");
  expect(output).toContain("handover");
  expect(shown.lease?.holder).toBe("");
  expect(shown.lease?.untilMs).toBe(10);
  expect(shown.incidents[0]).toBe("redacted");
  expect(shown.incidents[1]).toBe("call_error");
  expect(shown.incidents[2]).toBe("redacted");
  const rendered = formatP6Public(shown);
  expect(rendered.incidents).toBe("redacted · call_error · redacted");
  expect(rendered.outcome).toBe("handover");
  const root = join(import.meta.dir, "..", "..", "..");
  const page = readFileSync(join(root, "web/src/app/p6/page.tsx"), "utf8");
  expect(page.includes("redactP6View(")).toBe(true);
  expect(page.includes("formatP6Public(view)")).toBe(true);
  expect(page.includes("shown.incidents")).toBe(true);
  expect(page.includes("shown.decisions")).toBe(true);
  expect(page.includes("lease?.holder")).toBe(false);
  expect(page.includes("lease.holder")).toBe(false);
  expect(page.includes("loaded.view.emitted")).toBe(false);
  expect(page.includes("loaded.view.incidents")).toBe(false);
  expect(page.includes("JSON.stringify(last)")).toBe(false);
  expect(page.includes("JSON.stringify(view.lastRun)")).toBe(false);
});

function publicView(over: Partial<ReturnType<typeof redactP6View>> = {}) {
  return {
    lease: null,
    lastRun: null,
    killSwitch: false,
    incidents: [] as string[],
    gaps: [] as { startMs: number; endMs: number; cause?: string }[],
    positions: [],
    closed: [],
    emitted: [] as string[],
    ...over,
  };
}

test("unknown incident text renders as a generic code", () => {
  const leaks = [
    "getaddrinfo ENOTFOUND x.upstash.io",
    "[::1]:6379",
    "::1",
    "[2001:db8::7]:6380",
    "user:PASSWORD@host:6379",
    "rediss%3A%2F%2Fdefault%3Apw%40x.upstash.io%3A6379",
    '{"host":"x.upstash.io","port":6379}',
    "x.upstash.\nio",
    "h.example.com:6",
    "x.upstash.io.",
  ];
  const shown = redactP6View(publicView({ incidents: ["lease lost", ...leaks], lastRun: { outcome: "handover" } }));
  const rendered = formatP6Public(shown);
  expect(shown.incidents[0]).toBe("lease lost");
  expect(shown.incidents.slice(1)).toEqual(leaks.map(() => "redacted"));
  expect(rendered.incidents.startsWith("lease lost · redacted")).toBe(true);
  const output = `${rendered.incidents}\n${JSON.stringify(shown)}`;
  for (const secret of ["upstash", "PASSWORD", "::1", "2001:db8", "example.com", "rediss%3A", "getaddrinfo", "host"]) {
    expect(output.includes(secret), secret).toBe(false);
  }
});

test("a gap cause outside the allowlist renders as redacted", () => {
  const shown = redactP6View(publicView({
    gaps: [
      { startMs: 1, endMs: 2, cause: "uncovered" },
      { startMs: 3, endMs: 4, cause: "uncovered BTC-USD" },
      { startMs: 5, endMs: 6, cause: "getaddrinfo ENOTFOUND x.upstash.io" },
    ],
  }));
  const rendered = formatP6Public(shown);
  expect(shown.gaps.map((gap) => gap.cause)).toEqual(["uncovered", "uncovered BTC-USD", "redacted"]);
  expect(rendered.causes).toBe("uncovered · uncovered BTC-USD · redacted");
  expect(rendered.causes.includes("upstash")).toBe(false);
});

test("decision ids outside the allowlist are not rendered", () => {
  const kept = "A-BTC-USD-1710000000000";
  const shown = redactP6View(publicView({ emitted: [kept, "user:PASSWORD@host:6379", "x.upstash.io"] }));
  const rendered = formatP6Public(shown);
  expect(shown.emitted).toEqual([kept, "redacted", "redacted"]);
  expect(rendered.decisions).toBe(`${kept}, redacted, redacted`);
  expect(rendered.decisions.includes("PASSWORD")).toBe(false);
  expect(rendered.decisions.includes("upstash")).toBe(false);
});

test("a jev-call failed string renders as call_error", () => {
  const line = "jev-call failed: connect ECONNREFUSED x.upstash.io";
  const shown = redactP6View(publicView({ incidents: [line], lastRun: { outcome: "handover", jev: { error: line, calls: 2 } } }));
  const rendered = formatP6Public(shown);
  expect(shown.incidents).toEqual(["call_error"]);
  expect(rendered.incidents).toBe("call_error");
  expect(JSON.stringify(shown).includes("jev-call failed")).toBe(false);
  expect(JSON.stringify(shown).includes("upstash")).toBe(false);
  expect((shown.lastRun?.jev as { error?: string; calls?: number }).error).toBe("call_error");
  expect((shown.lastRun?.jev as { calls?: number }).calls).toBe(2);
});

test("benign stack text maps to redacted and is not rewritten as a host", () => {
  const shown = redactP6View(publicView({ incidents: ["at net.js:12"] }));
  const rendered = formatP6Public(shown);
  expect(shown.incidents).toEqual(["redacted"]);
  expect(rendered.incidents).toBe("redacted");
  expect(rendered.incidents.includes("[redis]")).toBe(false);
  expect(rendered.incidents.includes("net.js")).toBe(false);
});

test("a HEAD of /p6 with no cookie returns 200", () => {
  const head = applyDashboardProxy(new Request("https://example.test/p6", { method: "HEAD" }), undefined);
  expect(head.status).toBe(200);
  expect(head.body).toBeNull();
  expect(head.headers["X-Robots-Tag"]).toBe("noindex");
  const sub = applyDashboardProxy(new Request("https://example.test/p6/positions", { method: "HEAD" }), undefined);
  expect(sub.status).toBe(200);
  expect(sub.headers["X-Robots-Tag"]).toBe("noindex");
});

test("jev counts stay on the public last run", () => {
  const shown = redactP6View(publicView({
    lastRun: {
      outcome: "handover",
      jev: { calls: 4, totalUsd: 0.5, byReason: { call_error: 2, timeout: 1 }, holder: "lease-holder-cron-9", error: "jev caller secret" },
    },
  }));
  const jev = shown.lastRun?.jev as { calls?: number; byReason?: { call_error?: number }; holder?: string; error?: string };
  expect(jev.calls).toBe(4);
  expect(jev.byReason?.call_error).toBe(2);
  expect(jev.holder).toBeUndefined();
  expect(jev.error).toBe("call_error");
  expect(JSON.stringify(shown).includes("lease-holder-cron-9")).toBe(false);
  expect(formatP6Public(shown).outcome).toBe("handover");
});

test("a planted host in closed trades and positions is not rendered", () => {
  const host = "x.upstash.io";
  const shown = redactP6View(publicView({
    closed: [
      { productId: "BTC-USD", classId: "A", netUsd: 12 },
      { productId: host, classId: host, netUsd: host as never },
    ],
    positions: [
      { productId: "ETH-USD", id: "A-ETH-USD-1710000000000" },
      { productId: host, id: host },
    ],
    lastRun: {
      outcome: "handover",
      positions: [{ p: host, c: host, id: host, productId: host }],
      pnl: { pairs: [{ productId: host, classId: host, side: host }] },
    },
  }));
  const rendered = formatP6Public(shown);
  expect(rendered.trades.map((row) => row.label)).toEqual(["BTC-USD · A", "redacted · redacted"]);
  expect(rendered.trades[1]?.netUsd).toBeNull();
  expect(rendered.positions).toBe("ETH-USD A-ETH-USD-1710000000000 | redacted redacted");
  expect(shown.closed[0]).toEqual({ productId: "BTC-USD", classId: "A", netUsd: 12 });
  expect(shown.positions[0]).toEqual({ productId: "ETH-USD", id: "A-ETH-USD-1710000000000" });
  const output = `${JSON.stringify(rendered)}\n${JSON.stringify(shown)}`;
  expect(output.includes(host)).toBe(false);
  expect(output.includes("upstash")).toBe(false);
});

test("the generic string fallback does not return raw text", () => {
  const host = "x.upstash.io";
  const shown = redactP6View(publicView({ lastRun: { outcome: "handover", pnl: { footnote: host } } }));
  expect((shown.lastRun?.pnl as { footnote?: string }).footnote).toBe("redacted");
  expect(JSON.stringify(shown).includes(host)).toBe(false);
});

test("a product id must be the whole value", () => {
  const dirty = "host.upstash.io BTC-USD";
  const shown = redactP6View(publicView({
    closed: [{ productId: dirty, classId: "B", netUsd: 1 }],
    positions: [{ productId: "BTC-USD" }],
  }));
  const rendered = formatP6Public(shown);
  expect(shown.closed[0]?.productId).toBe("redacted");
  expect(shown.positions[0]?.productId).toBe("BTC-USD");
  expect(rendered.trades[0]?.label).toBe("redacted · B");
  expect(`${rendered.trades[0]?.label}\n${JSON.stringify(shown)}`.includes("upstash")).toBe(false);
});

test("a reconnect line keeps only real product ids", () => {
  const shown = redactP6View(publicView({
    incidents: [
      "socket reconnect 1 closed: BTC-USD,ETH-USD",
      "socket reconnect 3 heartbeat: FOX-UPSTASH-IO",
    ],
  }));
  const rendered = formatP6Public(shown);
  expect(shown.incidents[0]).toBe("socket reconnect 1 closed: BTC-USD,ETH-USD");
  expect(shown.incidents[1]).toBe("redacted");
  expect(rendered.incidents.includes("UPSTASH")).toBe(false);
  expect(rendered.incidents.includes("FOX")).toBe(false);
});

test("fixed kv and redis incidents stay verbatim", () => {
  const lines = [
    "kv set p6:hot failed",
    "kv set p6:warmup failed",
    "kv set p6:lease-meta failed",
    "kv set lease lost",
    "redis timeout",
    "redis closed",
  ];
  const shown = redactP6View(publicView({ incidents: lines }));
  expect(shown.incidents).toEqual(lines);
  expect(formatP6Public(shown).incidents).toBe(lines.join(" · "));
});

test("rest book and saved A pick only keep a real product id", () => {
  const shown = redactP6View(publicView({
    incidents: [
      "rest book BTC-USD failed",
      "rest book FOX-UPSTASH-IO failed",
      "saved A pick BTC-USD ignored",
      "saved A pick host.upstash.io ignored",
    ],
  }));
  expect(shown.incidents).toEqual([
    "rest book BTC-USD failed",
    "redacted",
    "saved A pick BTC-USD ignored",
    "redacted",
  ]);
  expect(formatP6Public(shown).incidents.includes("UPSTASH")).toBe(false);
  expect(formatP6Public(shown).incidents.includes("upstash")).toBe(false);
});

test("a GET with ?token= redirects and the token is not rendered", () => {
  const token = "view-token";
  const opened = applyDashboardProxy(new Request("https://example.test/p6?token=view-token&w=8h", { method: "GET" }), token);
  expect(opened.status).toBe(302);
  expect(opened.body).toBeNull();
  expect(opened.headers.Location).toBe("/p6?w=8h");
  expect(opened.headers.Location?.includes("token=")).toBe(false);
  expect(opened.headers["Set-Cookie"]?.includes(token)).toBe(false);
  const head = applyDashboardProxy(new Request("https://example.test/p6/positions?token=view-token", { method: "HEAD" }), token);
  expect(head.status).toBe(302);
  expect(head.headers.Location).toBe("/p6/positions");
  expect(head.body).toBeNull();
  const wrongToken = "not-the-dashboard-token";
  const wrong = applyDashboardProxy(new Request(`https://example.test/p6?token=${wrongToken}`, { method: "GET" }), token);
  expect(wrong.status).toBe(401);
  expect(wrong.body).toBe("unauthorized");
  expect(wrong.body?.includes(wrongToken)).toBe(false);
  const root = join(import.meta.dir, "..", "..", "..");
  const page = readFileSync(join(root, "web/src/app/p6/page.tsx"), "utf8");
  expect(page.includes("query.token")).toBe(false);
  expect(page.includes("searchParams.token")).toBe(false);
  expect(page.includes("shown.trades")).toBe(true);
  expect(page.includes("view.closed")).toBe(false);
  expect(page.includes("loaded.view.closed")).toBe(false);
});

test("a token query is stripped regardless of key case", () => {
  const token = "view-token";
  const upper = applyDashboardProxy(new Request("https://example.test/p6?TOKEN=view-token&w=8h", { method: "GET" }), token);
  expect(upper.status).toBe(302);
  expect(upper.body).toBeNull();
  expect(upper.headers.Location).toBe("/p6?w=8h");
  expect(upper.headers.Location?.toLowerCase().includes("token=")).toBe(false);
  expect(upper.headers.Location?.includes(token)).toBe(false);
  const mixed = applyDashboardProxy(new Request("https://example.test/p6/positions?Token=view-token", { method: "HEAD" }), token);
  expect(mixed.status).toBe(302);
  expect(mixed.headers.Location).toBe("/p6/positions");
  expect(mixed.body).toBeNull();
  const wrongToken = "not-the-dashboard-token";
  const wrong = applyDashboardProxy(new Request(`https://example.test/p6?TOKEN=${wrongToken}`, { method: "GET" }), token);
  expect(wrong.status).toBe(401);
  expect(wrong.body).toBe("unauthorized");
  expect(wrong.body?.includes(wrongToken)).toBe(false);
});

test("the /p6 page sends a noindex meta tag and an X-Robots-Tag header", () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const open = applyDashboardProxy(new Request("https://example.test/p6", { method: "GET" }), undefined);
  expect(open.status).toBe(200);
  expect(open.headers["X-Robots-Tag"]).toBe("noindex");
  const sub = applyDashboardProxy(new Request("https://example.test/p6/positions", { method: "GET" }), undefined);
  expect(sub.headers["X-Robots-Tag"]).toBe("noindex");
  const layout = readFileSync(join(root, "web/src/app/p6/layout.tsx"), "utf8");
  expect(layout.includes('robots: "noindex"')).toBe(true);
});

test("a GET of /p6 needs no cookie or token", () => {
  const open = applyDashboardProxy(new Request("https://example.test/p6", { method: "GET" }), "view-token");
  expect(open.status).toBe(200);
  expect(open.body).toBeNull();
  expect(open.headers.Location).toBeUndefined();
  expect(open.headers["Set-Cookie"]).toBeUndefined();
  const missing = applyDashboardProxy(new Request("https://example.test/p6", { method: "GET" }), undefined);
  expect(missing.status).toBe(200);
});

test("a GET of a /p6 subpath needs no cookie or token", () => {
  const route = "/p6/positions";
  const open = applyDashboardProxy(new Request(`https://example.test${route}`, { method: "GET" }), undefined);
  expect(open.status).toBe(200);
  expect(open.body).toBeNull();
  expect(open.headers.Location).toBeUndefined();
  expect(open.headers["Set-Cookie"]).toBeUndefined();
  const nested = applyDashboardProxy(new Request("https://example.test/p6/positions/open", { method: "GET" }), undefined);
  expect(nested.status).toBe(200);
});

test("POST, PUT, and DELETE on /p6 still refuse a missing cookie", () => {
  for (const method of ["POST", "PUT", "DELETE"]) {
    for (const route of ["/p6", "/p6/positions"]) {
      const response = applyDashboardProxy(new Request(`https://example.test${route}`, { method }), "view-token");
      expect(response.status, `${method} ${route}`).toBe(401);
      expect(response.body, `${method} ${route}`).toBe("unauthorized");
      expect(response.headers["Set-Cookie"], `${method} ${route}`).toBeUndefined();
    }
  }
});

test("the cron route still refuses a request with no authorization", async () => {
  const urls = ["https://example.test/api/engine", "https://example.test/api/engine?read=1"];
  for (const method of ["GET", "POST"]) {
    for (const url of urls) {
      const response = await handleEngineRequest(new Request(url, { method }), { CRON_SECRET: "cron-secret" });
      expect(response.status, `${method} ${url}`).toBe(401);
      expect(await response.text(), `${method} ${url}`).toBe("unauthorized");
    }
  }
});

test("a token redirect keeps the path under /p6 and rejects look-alikes", () => {
  const token = "view-token";
  const kept = applyDashboardProxy(new Request("https://example.test/p6/positions?w=8h&token=view-token&x=1", { method: "POST" }), token);
  expect(kept.status).toBe(302);
  expect(kept.headers.Location).toBe("/p6/positions?w=8h&x=1");
  expect(kept.headers["Set-Cookie"]?.includes("Path=/p6")).toBe(true);
  const requestUrl = "https://dash.example/p6/positions?token=view-token&w=8h";
  expect(absoluteDashboardLocation(requestUrl, "/p6/positions?w=8h")).toBe("https://dash.example/p6/positions?w=8h");
  expect(absoluteDashboardLocation("https://dash.example/p6/gates?token=view-token", "/p6/gates")).toBe("https://dash.example/p6/gates");
  const rejected = [
    "https://example.test/p6evil?token=view-token&w=8h",
    "https://example.test//evil.com?token=view-token",
    "https://example.test/\\evil.com?token=view-token",
    "https://example.test/p6/../secret?token=view-token&w=8h",
    "https://example.test/p6/%2e%2e/secret?token=view-token",
    "https://example.test/p6/positions/../../etc?token=view-token",
    "https://example.test/%2f%2fevil.com?token=view-token",
  ];
  for (const url of rejected) {
    const opened = applyDashboardProxy(new Request(url, { headers: { authorization: "Bearer view-token" } }), token);
    expect(opened.status, url).toBe(401);
    expect(opened.body, url).toBe("unauthorized");
    expect(opened.headers.Location, url).toBeUndefined();
    expect(opened.headers["Set-Cookie"], url).toBeUndefined();
  }
  expect(absoluteDashboardLocation(requestUrl, "/p6evil")).toBeNull();
  expect(absoluteDashboardLocation(requestUrl, "//evil.com")).toBeNull();
  expect(absoluteDashboardLocation(requestUrl, "//evil.com/p6")).toBeNull();
  expect(absoluteDashboardLocation(requestUrl, "/p6/../secret")).toBeNull();
  expect(absoluteDashboardLocation(requestUrl, "/p6/%2e%2e/secret")).toBeNull();
  expect(absoluteDashboardLocation(requestUrl, "https://evil.example/p6")).toBeNull();
  expect(absoluteDashboardLocation(requestUrl, "/elsewhere")).toBeNull();
});

test("the page does not import the cron secret, auth, or a Redis write", () => {
  const root = join(import.meta.dir, "..", "..", "..");
  const files = [
    join(root, "web/src/app/p6/page.tsx"),
    join(root, "web/src/app/p6/countdown.tsx"),
    join(root, "web/src/proxy.ts"),
    join(import.meta.dir, "dashboard-read.ts"),
  ];
  const banned = ["CRON_SECRET", "cb/auth", "vercel-live", "hot-store", "FLUSH_LUA", "redis.call"];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    for (const token of banned) expect(source.includes(token), `${file} ${token}`).toBe(false);
    for (const line of source.split("\n")) {
      if (!line.includes("relay") || !line.includes("from")) continue;
      expect(line.includes("import type "), line).toBe(true);
    }
  }
  const page = readFileSync(join(root, "web/src/app/p6/page.tsx"), "utf8");
  expect(page.includes("DASHBOARD_TOKEN")).toBe(false);
  expect(page.includes("dashboardAccess")).toBe(false);
  expect(page.includes("Unauthorized.")).toBe(false);
  const proxy = readFileSync(join(root, "web/src/proxy.ts"), "utf8");
  expect(proxy.includes("process.env.DASHBOARD_TOKEN")).toBe(true);
  expect(proxy.includes("applyDashboardProxy")).toBe(true);
  expect(page.includes("readP6Page")).toBe(true);
  expect(page.includes("last?.completed")).toBe(true);
  expect(page.includes("kill R")).toBe(true);
  expect(page.includes("Arrival delay bps")).toBe(true);
  expect(page.includes("Jev spend")).toBe(true);
  expect(page.includes("Jev today")).toBe(true);
  expect(page.includes("Jev calls")).toBe(true);
  expect(page.includes("Jev cap")).toBe(true);
  expect(page.includes("no_1m_input")).toBe(true);
  expect(page.includes("invalid_response")).toBe(true);
  expect(page.includes("last?.jev")).toBe(true);
  expect(page.includes("muted")).toBe(false);
  expect(page.includes("var(--muted)")).toBe(false);
  expect(page.includes("closedNote(tile.closedN)")).toBe(true);
  expect(page.includes("drawdownText(")).toBe(true);
  expect(page.includes("hourly (may understate the intrahour low)")).toBe(true);
  expect(page.includes("trades unknown")).toBe(true);
  expect(page.includes("Partial · since start")).toBe(true);
  expect(page.includes("pnlTileGrey")).toBe(false);
  expect(page.includes("pnlStale")).toBe(false);
  expect(page.includes("#4b5563")).toBe(false);
  expect(page.includes("anchorLabel")).toBe(true);
  expect(page.includes("parseSummaryWindow")).toBe(true);
  expect(page.includes("?w=${id}#breakdown")).toBe(true);
  expect(page.split("query.w").length - 1).toBe(1);
});

test("paper P/L separates equity, fees, spread, drawdown, and the backstops", () => {
  const wednesday = Date.parse("2026-03-04T00:00:00.000Z");
  const x1 = {
    kind: "x1" as const,
    id: "a1",
    classId: "A" as const,
    productId: "ETH-USD",
    tsMs: wednesday,
    nextOpen: 100,
    stop: 90,
    atr1h: 1,
    bid: 100,
    ask: 100.2,
    bookTsMs: wednesday,
    sendTsMs: wednesday + 5,
    decisionMid: 100.05,
    aConfig: "A55-k3",
  };
  const opened = replayInjected([
    { kind: "realize", id: "win", classId: "A", productId: "BTC-USD", netR: 5, netUsd: 100, riskUsd: 20, entryDate: "2026-03-01", exitTs: wednesday - 3 * 86_400_000 },
    { kind: "realize", id: "give", classId: "A", productId: "BTC-USD", netR: -1, netUsd: -20, riskUsd: 20, entryDate: "2026-03-02", exitTs: wednesday - 2 * 86_400_000 },
    { kind: "clock", tsMs: wednesday },
    x1,
  ]);
  const startSec = Math.floor(wednesday / 1000);
  const marked = applyForward(opened, {
    kind: "bar15",
    productId: "ETH-USD",
    startSec,
    nowSec: startSec + 900,
    open: 99,
    high: 99,
    low: 98,
    close: 98,
  });
  const position = marked.positions[0]!;
  const mark = 98;
  const exitCost = (mark * position.units * (90 + position.sLiveBps)) / 10_000;
  const unrealized = (mark - position.fillPrice) * position.units - exitCost - position.entryFeeUsd;
  const pnl = paperPnl(marked);
  expect(pnl.startingUsd).toBe(8000);
  expect(pnl.realizedUsd).toBeCloseTo(80, 6);
  expect(pnl.unrealizedUsd).toBeCloseTo(unrealized, 6);
  expect(pnl.equityUsd).toBeCloseTo(8000 + pnl.realizedUsd + pnl.unrealizedUsd, 6);
  expect(pnl.feesUsd).toBeCloseTo(marked.legs.reduce((sum, leg) => sum + leg.feesUsd, 0), 6);
  expect(pnl.feesUsd).toBeGreaterThan(0);
  expect(pnl.spreadSlipUsd).toBeCloseTo(position.entrySpreadUsd, 6);
  expect(pnl.spreadSlipUsd).not.toBeCloseTo(pnl.feesUsd, 4);
  expect(pnl.book.hwmUsd).toBeCloseTo(8100, 6);
  expect(pnl.book.drawdownUsd).toBeCloseTo(pnl.book.hwmUsd - pnl.equityUsd, 6);
  expect(pnl.book.haltUsd).toBe(1600);
  expect(pnl.book.roomUsd).toBeCloseTo(1600 - pnl.book.drawdownUsd, 6);
  expect(pnl.classBackstopUsd).toBe(1200);
  expect(pnl.pairBackstopUsd).toBe(500);
  expect(pnl.feeBps).toEqual({ maker: 50, taker: 90 });
  expect(pnl.classes.A.drawdownR).toBeCloseTo(1, 6);
  expect(pnl.classes.A.killed).toBe(false);
  const pair = pnl.pairs.find((row) => row.productId === "ETH-USD")!;
  const cumulative = pair.realizedUsd + pair.unrealizedUsd;
  expect(pair.latched).toBe(false);
  expect(pair.roomUsd).toBeCloseTo(Math.max(0, 500 + cumulative), 6);
  const arrivalMid = (100 + 100.2) / 2;
  expect(pnl.arrivalDelayBps).toBeCloseTo(delayBps(100.05, arrivalMid)!, 6);
  expect(pnl.arrivalDelayBps).not.toBeCloseTo(delayBps(100.05, position.fillPrice)!, 4);

  const losses = Array.from({ length: 20 }, (_, index) => ({
    kind: "realize" as const,
    id: `k${index}`,
    classId: "A" as const,
    productId: "BTC-USD",
    netR: -1,
    netUsd: -20,
    riskUsd: 20,
    entryDate: "2026-03-01",
    exitTs: wednesday + index,
  }));
  const killed = paperPnl(replayInjected(losses));
  expect(killed.classes.A.killed).toBe(true);
  expect(killed.classes.A.drawdownR).toBeGreaterThanOrEqual(20);
  expect(killed.classes.A.paused).toBe(true);
  expect(killed.book.drawdownUsd).toBeCloseTo(400, 6);
  expect(killed.book.haltUsd).toBe(1600);
  expect(killed.classBackstopUsd).toBe(1200);
  expect(killed.pairBackstopUsd).toBe(500);
});

test("a planted host in the new public fields is absent from the HTML and the RSC view", async () => {
  const host = "x.upstash.io";
  const shown = redactP6View(publicView({
    positions: [
      {
        productId: "BTC-USD",
        id: "A-BTC-USD-1710000000000",
        mfeBid1m: 1.25,
        maeBid1m: 0.5,
        mfeTs: 1_700_000_000_000,
        maeTs: 1_700_000_060_000,
        mfe15: 2,
        mae15: 0.4,
        mfeBasis: "bid1m",
        maeBasis: "mid-half-spread",
        mfe15Basis: "bar15-high",
        mae15Basis: "bar15-low",
        grossR: -0.27,
        netR: -0.31,
      },
      {
        productId: host,
        id: host,
        mfeBid1m: Number.POSITIVE_INFINITY,
        maeBid1m: Number.NaN,
        mfeBasis: host,
        maeBasis: "not-a-basis",
        mfe15Basis: host,
        grossR: Number.POSITIVE_INFINITY,
      },
    ],
    closed: [
      { productId: "ETH-USD", classId: "B", netUsd: 1, mfeR: 0.4, maeR: -0.2, fillSrc: "modelled", execCostBps: 3.5, driftBps: 1.2, delayBps: -0.4, shadowNetUsd: 2, shadowNetR: 0.1, mfeBasis: "bid1m" },
      { productId: host, classId: host, netUsd: host as never, fillSrc: host, execCostBps: Number.NaN, driftBps: Number.POSITIVE_INFINITY, mfeR: host as never, shadowNetUsd: host as never },
    ],
    mark: {
      pnlNow: -21.4,
      label: host as never,
      state: host as never,
      staleText: `stale since ${host}`,
      restLabel: host as never,
      openRGross: -0.27,
      openRNet: Number.NaN,
      grossUsd: -21.4,
      riskUsd: 80,
      quoteFresh: false,
      rows: [
        { productId: "BTC-USD", pnl: -5.35, grossUsd: -5.35, grossR: -0.27, netR: -0.3 },
        { productId: host, pnl: Number.POSITIVE_INFINITY, grossUsd: Number.NaN, grossR: host as never, netR: -1 },
      ],
    },
    fills: [
      { classId: "B", share: 0.25, execCost: "red" },
      { classId: host, share: Number.NaN, execCost: host as never },
    ],
    markInputs: { positions: [], quotes: { [host]: { bid: 1, tsMs: 1 } }, disconnected: true },
  }));
  const rendered = formatP6Public(shown);
  const html = `<section id="mark-now"><p class="${shown.mark?.state === "rest" ? "rest" : shown.mark?.state === "stale" ? "grey" : ""}">${rendered.mark}</p></section>`;
  const flight = JSON.stringify({ html, view: shown, mark: rendered.mark });
  const output = `${html}\n${flight}\n${JSON.stringify(rendered)}`;
  expect(output.includes(host)).toBe(false);
  expect(output.includes("upstash")).toBe(false);
  expect(output.includes("Infinity")).toBe(false);
  expect(output.includes("NaN")).toBe(false);
  expect(rendered.mark).toContain("marked to bid, taker 0.90% exit");
  expect(rendered.mark).toContain("n/a");
  expect(rendered.mark).toContain("B red");
  expect(rendered.mark).toContain("-0.27R");
  expect(rendered.trades[0]?.label).toBe("ETH-USD · B");
  expect(shown.positions[0]?.mfeBasis).toBe("bid1m");
  expect(shown.positions[0]?.maeBasis).toBe("mid-half-spread");
  expect(shown.positions[0]?.mfe15Basis).toBe("bar15-high");
  expect(shown.positions[0]?.mfeBid1m).toBe(1.25);
  expect(shown.positions[1]?.mfeBasis).toBeUndefined();
  expect(shown.positions[1]?.mfeBid1m).toBeUndefined();
  expect(shown.closed[0]?.fillSrc).toBe("modelled");
  expect(shown.closed[1]?.fillSrc).toBeUndefined();
  expect(shown.mark?.state).toBe("na");
  expect(shown.mark?.label).toBe("marked to bid, taker 0.90% exit");
  expect(shown.mark?.staleText).toBeUndefined();
  expect(shown.mark?.restLabel).toBeUndefined();
  expect(shown.mark?.rows[1]?.productId).toBe("redacted");
  expect(shown.mark?.rows[1]?.pnl).toBeNull();
  expect(shown.fills?.[0]?.execCost).toBe("red");
  expect(shown.fills?.[1]?.classId).toBeUndefined();
  expect(shown.fills?.[1]?.execCost).toBe("ok");
  expect(shown.markInputs).toBeUndefined();
  const root = join(import.meta.dir, "..", "..", "..");
  const page = readFileSync(join(root, "web/src/app/p6/page.tsx"), "utf8");
  expect(page.includes("shown.mark")).toBe(true);
  expect(page.includes("formatP6Public(view)")).toBe(true);
  const reactPkg = join(root, "web/node_modules/react/package.json");
  if (!existsSync(reactPkg)) return;
  const { createRequire } = await import("node:module");
  const require = createRequire(join(root, "web/package.json"));
  const { createElement } = require("react") as { createElement: (...args: unknown[]) => unknown };
  const { renderToStaticMarkup } = require("react-dom/server") as { renderToStaticMarkup: (node: unknown) => string };
  const markup = renderToStaticMarkup(createElement("p", { id: "mark-now" }, rendered.mark));
  expect(markup.includes(host)).toBe(false);
  expect(markup).toContain("marked to bid, taker 0.90% exit");
  const { spawnSync } = await import("node:child_process");
  const rsc = spawnSync(
    process.execPath,
    ["--conditions=react-server", "-e", [
      'const { createElement } = require("react");',
      'const { renderToReadableStream } = require("next/dist/compiled/react-server-dom-webpack/server.node");',
      "let mark = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { mark += chunk; });",
      "process.stdin.on('end', async () => {",
      "  const stream = renderToReadableStream(createElement('p', { id: 'mark-now' }, mark));",
      "  const reader = stream.getReader();",
      "  const chunks = [];",
      "  for (;;) {",
      "    const step = await reader.read();",
      "    if (step.done) break;",
      "    chunks.push(Buffer.from(step.value));",
      "  }",
      "  process.stdout.write(Buffer.concat(chunks).toString('utf8'));",
      "});",
    ].join("\n")],
    { cwd: join(root, "web"), input: rendered.mark, encoding: "utf8" },
  );
  expect(rsc.status, rsc.stderr).toBe(0);
  expect(rsc.stdout.includes(host)).toBe(false);
  expect(rsc.stdout).toContain("marked to bid");
});
