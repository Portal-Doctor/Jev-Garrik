import { NextResponse } from "next/server";
import { dashboardAuthorized } from "../../research/src/p6/dashboard-read";

/** View-only. The cron secret does not open this page. */
export function proxy(request: Request) {
  if (!dashboardAuthorized(request.headers.get("authorization"), process.env.DASHBOARD_TOKEN)) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/p6"] };
