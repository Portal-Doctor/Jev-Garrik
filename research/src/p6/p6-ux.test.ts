import { readFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { expect, test } from "bun:test";
import { openDashboardKv, readP6Page } from "./dashboard-read";
import { drawdownText, signedUsd } from "./pnl-block";
import { formatUsd } from "./positions-view";

const root = join(import.meta.dir, "..", "..", "..");

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

function rule(css: string, selector: string): string {
  const match = new RegExp(`${selector}\\s*\\{([^}]*)\\}`).exec(css);
  return match?.[1] ?? "";
}

function readCommand(buf: string): { parts: string[]; rest: string } | null {
  if (!buf.startsWith("*")) return null;
  const nl = buf.indexOf("\r\n");
  if (nl < 0) return null;
  const count = Number(buf.slice(1, nl));
  let rest = buf.slice(nl + 2);
  const parts: string[] = [];
  for (let i = 0; i < count; i += 1) {
    if (!rest.startsWith("$")) return null;
    const head = rest.indexOf("\r\n");
    if (head < 0) return null;
    const len = Number(rest.slice(1, head));
    const start = head + 2;
    if (rest.length < start + len + 2) return null;
    parts.push(rest.slice(start, start + len));
    rest = rest.slice(start + len + 2);
  }
  return { parts, rest };
}

test("signed dollars group thousands and put the sign before the dollar", () => {
  expect(signedUsd(-34.02)).toBe("-$34.02");
  expect(signedUsd(-34.02).includes("$-")).toBe(false);
  expect(signedUsd(1234.5)).toBe("+$1,234.50");
  expect(signedUsd(-1234.5)).toBe("-$1,234.50");
  expect(signedUsd(0)).toBe("$0.00");
  expect(drawdownText(-1600)).toBe("-$1,600.00");
  expect(drawdownText(36)).toBe("$36.00");
  expect(drawdownText(36).includes("+")).toBe(false);
  expect(formatUsd(480)).toBe("$480.00");
  expect(formatUsd(1600)).toBe("$1,600.00");
  expect(formatUsd(-2121.6).includes("$-")).toBe(false);
});

test("the summary uses one card, one fold, and only bar-width inline styles", () => {
  const page = source("web/src/app/p6/page.tsx");
  const clock = source("web/src/app/p6/countdown.tsx");
  const css = source("web/src/app/p6/p6.module.css");
  const paper = source("web/src/app/paper/paper.module.css");
  const nav = source("web/src/components/BooksNav/BooksNav.tsx");
  expect(css.includes("prefers-color-scheme")).toBe(false);
  expect(page.includes("EXAMPLE")).toBe(false);
  expect((css.match(/^\.card\s*\{/gm) ?? []).length).toBe(1);
  expect((css.match(/^\.fold\s*\{/gm) ?? []).length).toBe(1);
  expect(page.includes("styles.card")).toBe(true);
  expect(page.includes("styles.fold")).toBe(true);
  expect(rule(css, "\\.pos")).toContain("var(--buy-ink)");
  expect(rule(css, "\\.pos")).not.toContain("pnl-pos");
  expect(rule(css, "\\.neg")).toContain("var(--sell-ink)");
  expect(rule(css, "\\.neg")).not.toContain("pnl-neg");
  expect(rule(css, "\\.big\\.pos")).toContain("var(--pnl-pos)");
  expect(rule(css, "\\.big\\.neg")).toContain("var(--pnl-neg)");
  expect(css.includes("var(--muted)")).toBe(false);
  expect(page.includes("var(--muted)")).toBe(false);
  expect(css.includes("#4b5563")).toBe(false);
  expect(paper.includes("#4b5563")).toBe(false);
  expect(paper.includes("pnlTileGrey")).toBe(false);
  expect(paper.includes("pnlStale")).toBe(false);
  const styles = [...`${page}\n${clock}`.matchAll(/style=\{\{([\s\S]*?)\}\}/g)].map((match) => match[1] ?? "");
  expect(styles.length).toBe(3);
  for (const block of styles) expect(block.includes("width:") && block.includes("%")).toBe(true);
  expect(nav.includes('href="/p6"')).toBe(true);
  expect(nav.includes("P6 paper")).toBe(true);
  expect(nav.includes("Coinbase engine")).toBe(true);
  expect(nav.includes('href="/paper/backtest"')).toBe(true);
  expect(nav.includes("Backtest")).toBe(true);
  expect(nav.includes('href="/paper"')).toBe(true);
  expect(nav.includes('href="/paper/report"')).toBe(true);
  expect(nav.includes("Tax")).toBe(true);
  expect(nav.includes('href="/tax"')).toBe(true);
  expect(nav.includes('href="/tax/paper"')).toBe(true);
  expect(nav.includes('aria-current={')).toBe(true);
  for (const banned of ["/p6/positions", "/p6/trades", "/p6/gates", "/p6/jev", "/p6/health"]) {
    expect(nav.includes(`"${banned}"`), banned).toBe(false);
    expect(page.includes(`"${banned}"`), banned).toBe(false);
  }
  expect(page.includes('title={`Breakdown, ${picked.id}`}')).toBe(true);
  expect(page.includes("open={picked.open}")).toBe(true);
});

test("a page load is two AUTH and two MGET and does not read fills", async () => {
  const commands: string[][] = [];
  const server = createServer((socket: Socket) => {
    let buf = "";
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        const cmd = readCommand(buf);
        if (!cmd) break;
        buf = cmd.rest;
        commands.push(cmd.parts);
        const name = cmd.parts[0];
        if (name === "AUTH") socket.write("+OK\r\n");
        else if (name === "MGET") {
          const count = cmd.parts.length - 1;
          socket.write(`*${count}\r\n${"$-1\r\n".repeat(count)}`);
        } else socket.write("-ERR\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await readP6Page(openDashboardKv(`redis://:pw@127.0.0.1:${port}`), Date.UTC(2026, 9, 16, 18, 0, 0));
    const names = commands.map((parts) => parts[0]);
    expect(names.filter((name) => name === "AUTH").length).toBe(2);
    expect(names.filter((name) => name === "MGET").length).toBe(2);
    expect(names.length).toBe(4);
    const keys = commands.filter((parts) => parts[0] === "MGET").flatMap((parts) => parts.slice(1));
    expect(keys.includes("p6:fills")).toBe(false);
    expect(keys.includes("p6:ledger")).toBe(false);
    expect(keys.includes("p6:lastRun")).toBe(true);
    expect(keys.includes("p6:hot")).toBe(true);
    expect(keys.includes("p6:lease")).toBe(true);
    expect(keys.includes("p6:eq:first")).toBe(true);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
