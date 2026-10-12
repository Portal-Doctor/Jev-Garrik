import { handleEngineRequest } from "../../../../../research/src/p6/vercel-live";
import { redisKvFromUrl } from "../../../../../research/src/p6/relay";

export const runtime = "nodejs";
export const maxDuration = 1800;

function kv() {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  return redisKvFromUrl(url);
}

export async function GET(request: Request): Promise<Response> {
  const store = kv();
  if (!store) return new Response("REDIS_URL is required", { status: 503 });
  return handleEngineRequest(request, process.env, { kv: store });
}

export async function POST(request: Request): Promise<Response> {
  return GET(request);
}
