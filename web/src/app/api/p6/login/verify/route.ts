import { NextResponse } from "next/server";
import { readLoginBody, sameOrigin, verifyLoginCode } from "../../../../../../../research/src/p6/p6-login";
import { loginStoreFromEnv } from "../../../../../../../research/src/p6/p6-login-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = await readLoginBody(request);
  const result = await verifyLoginCode({
    email: body.email,
    code: body.code,
    env: process.env,
    store: loginStoreFromEnv(process.env),
    permit: sameOrigin(request.headers),
  });
  if (!result.ok) {
    return NextResponse.json({ ok: false }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  const response = NextResponse.json({ ok: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
  response.headers.append("Set-Cookie", result.setCookie);
  return response;
}
