import { NextResponse } from "next/server";
import { readLoginBody, sameOrigin, sendLoginCode, sendViaResend } from "../../../../../../../research/src/p6/p6-login";
import { loginStoreFromEnv } from "../../../../../../../research/src/p6/p6-login-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const body = await readLoginBody(request);
  await sendLoginCode({
    email: body.email,
    env: process.env,
    store: loginStoreFromEnv(process.env),
    sendEmail: (message) => sendViaResend(message, process.env),
    permit: sameOrigin(request.headers),
  });
  return NextResponse.json({ ok: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
}
