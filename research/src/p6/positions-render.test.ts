import { expect, mock, test } from "bun:test";

mock.module("/workspace/web/src/app/paper/paper.module.css", () => ({
  default: new Proxy({}, { get: (_target, key) => String(key) }),
}));

const SAT = Date.parse("2026-10-17T12:00:00.000Z");

async function markup(last: Record<string, unknown> | null, nowMs = SAT): Promise<string> {
  const react = await import(new URL("../../../web/node_modules/react/index.js", import.meta.url).href);
  const server = await import(new URL("../../../web/node_modules/react-dom/server.js", import.meta.url).href);
  const page = await import(new URL("../../../web/src/app/p6/page.tsx", import.meta.url).href);
  return server.renderToStaticMarkup(react.createElement(page.PositionsSection, { last, nowMs, openUnrealized: 0 }));
}

function snap(id: string, fill: number, mark: number): Record<string, unknown> {
  return {
    id,
    p: "ETH-USD",
    c: "C",
    t: SAT,
    u: 1,
    f: fill,
    m: mark,
    n: mark,
    s: 90,
    ur: 0,
    x: 0,
    e: 0,
    r: 20,
    k: "ETH-USD",
  };
}

test("cash renders a leading minus and thousands separators", async () => {
  const negative = await markup({
    end: SAT,
    pnl: { equityUsd: 8000, realizedUsd: 0, startingUsd: 8000 },
    positions: [snap("neg", 10121.6, 10121.6)],
  });
  expect(negative).toContain("-$2,121.60");
  expect(negative).not.toContain("$-");
  const positive = await markup({
    end: SAT,
    pnl: { equityUsd: 2121.6, realizedUsd: 0, startingUsd: 2121.6 },
    positions: [],
  });
  expect(positive).toContain("$2,121.60");
  expect(positive).not.toContain("-$");
  const zero = await markup({
    end: SAT,
    pnl: { equityUsd: 0, realizedUsd: 0, startingUsd: 0 },
    positions: [],
  });
  expect(zero).toContain("$0.00");
});

test("an absent positions array renders unreported and skipped, and stays grey", async () => {
  const html = await markup({ end: SAT, pnl: { equityUsd: 8050, realizedUsd: 50, startingUsd: 8000 } });
  expect(html).toContain("positions not yet reported");
  expect(html).not.toContain("No open positions");
  expect(html).toContain("checks skipped");
  expect(html).not.toContain("reconciled");
  expect(html).toContain("cash balance USD (paper, derived) —");
  expect(html).toContain("= equity —");
  expect(html).toContain("pnlStale");
  const empty = await markup({
    end: SAT,
    pnl: { equityUsd: 8050, realizedUsd: 50, startingUsd: 8000 },
    positions: [],
  });
  expect(empty).toContain("No open positions");
  expect(empty).not.toContain("positions not yet reported");
  expect(empty).toContain("reconciled");
  expect(empty).toContain("$8,050.00");
  expect(empty).not.toContain("pnlStale");
});

test("a capped book says how many rows were cut and does not say reconciled", async () => {
  const longCluster = `CLUSTER-${"X".repeat(40)}`;
  const rows = Array.from({ length: 65 }, (_, index) => ({
    ...snap(`id-${index}`, 100, 100),
    id: `${"i".repeat(40)}${index}`,
    k: longCluster,
    p: "P".repeat(40),
  }));
  const html = await markup({
    end: SAT,
    pnl: { equityUsd: 0, realizedUsd: 0, startingUsd: 8000 },
    positions: rows,
  });
  expect(html).toContain("1 positions not shown");
  expect(html).toContain("checks incomplete");
  expect(html).not.toContain("reconciled");
  expect(html).toContain("P".repeat(32));
  expect(html).not.toContain("P".repeat(33));
  expect(html).toContain(longCluster.slice(0, 32));
  expect(html).not.toContain(longCluster);
});
