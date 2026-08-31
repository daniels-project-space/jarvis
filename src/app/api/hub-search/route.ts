import type { NextRequest } from "next/server";
import { readHubSnapshot } from "@/lib/foreground-context";
import { searchHubSnapshot, type HubSearchSnapshot } from "@/lib/hub-search";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import { isSameOriginRequest } from "@/lib/control-session";

export const runtime = "nodejs";

const PRIVATE_HEADERS = { "cache-control": "private, no-store" };

function response(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: PRIVATE_HEADERS });
}

export async function GET(req: NextRequest): Promise<Response> {
  if (!isSameOriginRequest(req)) return response({ ok: false, results: [] }, 403);
  const actor = await controlActor(req);
  if (!actor) return response({ ok: false, results: [] }, 401);
  if (!isOwnerActor(actor)) return response({ ok: false, results: [] }, 403);

  const query = req.nextUrl.searchParams.get("q")?.trim().slice(0, 120) ?? "";
  if (query.length < 2) return response({ ok: true, results: [] });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("hub search deadline"), 1_200);
  try {
    const snapshot = await readHubSnapshot(controller.signal) as HubSearchSnapshot | null;
    return response({ ok: true, results: searchHubSnapshot(query, snapshot) });
  } catch {
    return response({ ok: false, results: [] }, 503);
  } finally {
    clearTimeout(timeout);
  }
}
