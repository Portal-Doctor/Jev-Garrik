import { NextResponse } from "next/server";
import { applyDashboardProxy } from "../../research/src/p6/dashboard-read";

/**
 * Next's middleware adapter parses Location with NextURL and throws on a relative URL.
 * The path stays /p6. The origin comes from the request, never from a query parameter.
 */
function absoluteDashboardLocation(requestUrl: string, location: string): string | null {
  if (!location.startsWith("/p6") || location.startsWith("//")) return null;
  let request: URL;
  let absolute: URL;
  try {
    request = new URL(requestUrl);
    absolute = new URL(location, request);
  } catch {
    return null;
  }
  if (absolute.origin !== request.origin || absolute.pathname !== "/p6") return null;
  return absolute.toString();
}

/** View-only. The cron secret does not open this page. GET /p6 is enough; see dashboardAccess. */
export function proxy(request: Request) {
  const result = applyDashboardProxy(request, process.env.DASHBOARD_TOKEN);
  if (result.status === 200) {
    const next = NextResponse.next();
    for (const [key, value] of Object.entries(result.headers)) next.headers.set(key, value);
    return next;
  }
  const headers = { ...result.headers };
  if (result.status === 302) {
    const absolute = absoluteDashboardLocation(request.url, headers.Location ?? "");
    if (!absolute) {
      return new NextResponse("unauthorized", {
        status: 401,
        headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
      });
    }
    headers.Location = absolute;
  }
  return new NextResponse(result.body, { status: result.status, headers });
}

export const config = { matcher: ["/p6"] };
