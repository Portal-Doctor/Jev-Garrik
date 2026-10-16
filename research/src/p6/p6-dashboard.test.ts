import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { absoluteDashboardLocation, applyDashboardProxy, dashboardAuthorized, dashboardCookieValue, dashboardSetCookie, openDashboardKv, P6_COOKIE_NAME, readP6Dashboard } from "./dashboard-read";
import { cronAuthorized } from "./relay";
import { applyForward, paperPnl, replayInjected } from "./engine";
import { delayBps } from "./legs";
import { memoryKv } from "./relay";

test("the cron secret does not authorize the dashboard", () => {
  expect(dashboardAuthorized("Bearer cron-secret", "view-token")).toBe(false);
  expect(dashboardAuthorized("Bearer view-token", "view-token")).toBe(true);
  expect(dashboardAuthorized("Bearer view-token", undefined)).toBe(false);
  expect(dashboardAuthorized(null, "view-token")).toBe(false);
});

test("GET /p6 accepts the bearer, the cookie, or a token query", () => {
  const token = "view-token";
  const cookie = `${P6_COOKIE_NAME}=${dashboardCookieValue(token)}`;
  const other = `${P6_COOKIE_NAME}=${dashboardCookieValue("other-token")}`;
  const header = applyDashboardProxy(new Request("https://example.test/p6", { headers: { authorization: "Bearer view-token" } }), token);
  expect(header.status).toBe(200);
  expect(header.headers["Cache-Control"]).toBe("no-store");
  expect(header.headers["Referrer-Policy"]).toBe("no-referrer");

  const fromCookie = applyDashboardProxy(new Request("https://example.test/p6", { method: "GET", headers: { cookie } }), token);
  expect(fromCookie.status).toBe(200);

  const opened = applyDashboardProxy(new Request("https://example.test/p6?token=view-token&panel=spend", { method: "GET" }), token);
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

  const wrong = applyDashboardProxy(new Request("https://example.test/p6?token=nope", { method: "GET", headers: { authorization: "Bearer view-token", cookie } }), token);
  expect(wrong.status).toBe(401);
  expect(wrong.body).toBe("unauthorized");
  const empty = applyDashboardProxy(new Request("https://example.test/p6?token=", { method: "GET", headers: { cookie } }), token);
  expect(empty.status).toBe(401);
  const malformed = applyDashboardProxy(new Request("https://example.test/p6", { headers: { cookie: `${P6_COOKIE_NAME}=not-a-cookie` } }), token);
  expect(malformed.status).toBe(401);
  const tampered = dashboardCookieValue(token).slice(0, -1) + (dashboardCookieValue(token).endsWith("a") ? "b" : "a");
  expect(applyDashboardProxy(new Request("https://example.test/p6", { headers: { cookie: `${P6_COOKIE_NAME}=${tampered}` } }), token).status).toBe(401);
  expect(applyDashboardProxy(new Request("https://example.test/p6", { headers: { cookie: other } }), token).status).toBe(401);

  const allValid = applyDashboardProxy(new Request("https://example.test/p6?token=view-token", { method: "GET", headers: { authorization: "Bearer view-token", cookie } }), token);
  expect(allValid.status).toBe(302);
  expect(allValid.headers.Location).toBe("/p6");
  const bearerWins = applyDashboardProxy(new Request("https://example.test/p6", { headers: { authorization: "Bearer view-token", cookie: other } }), token);
  expect(bearerWins.status).toBe(200);
  const cookieWins = applyDashboardProxy(new Request("https://example.test/p6", { headers: { authorization: "Bearer nope", cookie } }), token);
  expect(cookieWins.status).toBe(200);
  expect(applyDashboardProxy(new Request("https://example.test/p6", { headers: { authorization: "Bearer nope", cookie: other } }), token).status).toBe(401);
  expect(applyDashboardProxy(new Request("https://example.test/p6"), undefined).status).toBe(401);

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

test("GET /p6?token= Location is absolute, drops the token, and keeps the cookie", () => {
  const token = "view-token";
  const requestUrl = "https://dash.example/p6?token=view-token&panel=spend";
  const opened = applyDashboardProxy(new Request(requestUrl, { method: "GET" }), token);
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
    const request = new Request("https://dash.example/p6?token=view-token&panel=spend", { method: "GET" });
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
  expect(page.includes("DASHBOARD_TOKEN")).toBe(true);
  expect(page.includes("dashboardAccess")).toBe(true);
  const proxy = readFileSync(join(root, "web/src/proxy.ts"), "utf8");
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
  expect(page.includes("muted")).toBe(true);
  expect(page.includes("closedNote(tile.closedN)")).toBe(true);
  expect(page.includes("drawdownText(")).toBe(true);
  expect(page.includes("hourly (may understate the intrahour low)")).toBe(true);
  expect(page.includes("trades unknown")).toBe(true);
  expect(page.includes("partial")).toBe(false);
  expect(page.includes("anchorLabel")).toBe(true);
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
  const unrealized = (mark - position.fillPrice) * position.units - exitCost;
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
