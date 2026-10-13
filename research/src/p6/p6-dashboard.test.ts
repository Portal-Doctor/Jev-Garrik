import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { dashboardAuthorized, openDashboardKv, readP6Dashboard } from "./dashboard-read";
import { memoryKv } from "./relay";

test("the cron secret does not authorize the dashboard", () => {
  expect(dashboardAuthorized("Bearer cron-secret", "view-token")).toBe(false);
  expect(dashboardAuthorized("Bearer view-token", "view-token")).toBe(true);
  expect(dashboardAuthorized("Bearer view-token", undefined)).toBe(false);
  expect(dashboardAuthorized(null, "view-token")).toBe(false);
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
  expect(page.includes("readP6Dashboard")).toBe(true);
});
