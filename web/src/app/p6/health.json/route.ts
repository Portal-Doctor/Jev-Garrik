import { openDashboardKv, p6HealthJson, readP6Page, summaryFreshness } from "../../../../../research/src/p6/dashboard-read";
import { classAProductsSnapshot } from "../../../../../research/src/p6/class-a-products";
import { readSystemCostHurdle } from "../../../../../research/src/p6/system-cost";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
};

/** Open GET. Writes stay on the proxy. This handler does not read a dashboard token. */
export async function GET(): Promise<Response> {
  const now = Date.now();
  const url = process.env.REDIS_URL;
  if (!url) {
    return Response.json(
      p6HealthJson(
        {
          lease: null,
          lastRun: null,
          killSwitch: false,
          incidents: [],
          gaps: [],
          positions: [],
          closed: [],
          emitted: [],
          unreadable: false,
          lastUnreadable: false,
          systemCost: readSystemCostHurdle(null, now),
        },
        "Error",
      ),
      { headers: HEADERS },
    );
  }
  try {
    const loaded = await readP6Page(openDashboardKv(url), now);
    const fresh = summaryFreshness({
      hasLastRun: loaded.view.lastRun != null,
      flushMs: loaded.block.lastUpdatedMs,
      nowMs: now,
    });
    return Response.json(p6HealthJson(loaded.view, fresh.health), { headers: HEADERS });
  } catch {
    return Response.json(
      { health: "Error", systemCost: { status: "unavailable", light: "unavailable" }, productsSnapshot: classAProductsSnapshot() },
      { headers: HEADERS },
    );
  }
}
