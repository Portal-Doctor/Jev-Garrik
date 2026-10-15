import { NextResponse } from "next/server";
import { p6ViewAuthorized } from "../../research/src/p6/p6-login";

/** View-only. The cron secret does not open this page. */
export function proxy(request: Request) {
  const ok = p6ViewAuthorized({
    authorization: request.headers.get("authorization"),
    cookie: request.headers.get("cookie"),
    dashboardToken: process.env.DASHBOARD_TOKEN,
    sessionSecret: process.env.P6_SESSION_SECRET,
    now: Date.now(),
  });
  if (!ok) return new NextResponse("unauthorized", { status: 401 });
  return NextResponse.next();
}

export const config = { matcher: ["/p6"] };
