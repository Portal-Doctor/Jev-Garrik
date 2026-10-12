import { headers } from "next/headers";
import { loadDashboard } from "../../../../research/src/p6/vercel-live";
import { cronAuthorized, redisKvFromUrl } from "../../../../research/src/p6/relay";

export const dynamic = "force-dynamic";

/** Read-only. There is no form, no reset, and no order path. The cron secret is required. */
export default async function P6DashboardPage() {
  const headerList = await headers();
  if (!cronAuthorized(headerList.get("authorization"), process.env.CRON_SECRET)) {
    return (
      <main>
        <h1>P6 paper</h1>
        <p>Unauthorized. This page requires the cron secret.</p>
      </main>
    );
  }
  const url = process.env.REDIS_URL;
  if (!url) {
    return (
      <main>
        <h1>P6 paper</h1>
        <p>No Redis snapshot on this instance. The live view is GET /api/engine?read=1.</p>
        <p>There is no write and no reset on this page.</p>
      </main>
    );
  }
  const view = await loadDashboard(redisKvFromUrl(url));
  return (
    <main>
      <h1>P6 paper</h1>
      <p>Read only. Positions, gates, G0, the lease holder, incidents, and the V6 gap caps.</p>
      <pre>{JSON.stringify(view, null, 2)}</pre>
    </main>
  );
}
