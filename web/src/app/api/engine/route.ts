import { handleEngineRequest } from "../../../../../research/src/p6/vercel-live";
import { redisKvFromUrl } from "../../../../../research/src/p6/relay";

export const runtime = "nodejs";
export const maxDuration = 1800;

export async function GET(request: Request): Promise<Response> {
  const url = process.env.REDIS_URL;
  return handleEngineRequest(request, process.env, url ? { kv: redisKvFromUrl(url) } : undefined);
}

export async function POST(request: Request): Promise<Response> {
  return GET(request);
}
