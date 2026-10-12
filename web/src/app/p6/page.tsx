/**
 * Read-only paper dashboard. It has no form, no reset, and no order path.
 * The cron route is the only writer. Live numbers are GET /api/engine?read=1.
 */
export default function P6DashboardPage() {
  return (
    <main>
      <h1>P6 paper</h1>
      <p>Read only. Positions, gates, G0, the lease holder, incidents, and the V6 gap caps are served by GET /api/engine?read=1.</p>
      <p>There is no write and no reset on this page.</p>
    </main>
  );
}
