import { NextResponse } from "next/server";

/** The read-only dashboard uses the same bearer as the cron route. */
export function proxy(request: Request) {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (!secret || header !== `Bearer ${secret}`) {
    return new NextResponse("unauthorized", { status: 401 });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/p6"] };
