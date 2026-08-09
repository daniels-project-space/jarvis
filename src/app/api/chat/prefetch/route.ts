import type { NextRequest } from "next/server";
import { isSameOriginRequest } from "@/lib/control-session";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import { prepareSpeculativeResearchRequest } from "@/lib/speculative-research";
import { issueSpeculativeResearchReceipt } from "@/lib/speculative-research-receipt.server";
import { searchWeb } from "@/lib/search";
import { buildResearchLanes, rankResearchSources } from "@/lib/research-fabric";

export const runtime = "nodejs";
export const maxDuration = 8;

const REQUEST_BODY_MAX_BYTES = 12_000;
const SEARCH_DEADLINE_MS = 6_000;
const NO_STORE_HEADERS = { "cache-control": "no-store, max-age=0" } as const;

function json(payload: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  return Response.json(payload, { status, headers: { ...NO_STORE_HEADERS, ...extraHeaders } });
}

export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return json({ error: "cross-origin prefetch rejected" }, 403);
  const actor = await controlActor(req);
  if (!actor) return json({ error: "unauthorized" }, 401);
  if (!isOwnerActor(actor)) return json({ error: "owner enrollment required" }, 403);

  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > REQUEST_BODY_MAX_BYTES) {
    return json({ error: "request body too large" }, 413);
  }
  const body = await req.json().catch(() => null);
  const prepared = prepareSpeculativeResearchRequest(body);
  if (!prepared) return json({ error: "ineligible or malformed research prefetch" }, 400);

  try {
    // Fixed read-only fan-out: three keyless lanes overlap while the user is
    // still speaking. No model, tool router, task, durable mutation, or paid
    // search-provider lookup is permitted on this speculative path.
    const lanes = buildResearchLanes(prepared.query);
    const results = await Promise.all(lanes.map(async (lane) => ({
      lane,
      results: (await searchWeb(lane.query, 4, "us", {
        signal: req.signal,
        timeoutMs: SEARCH_DEADLINE_MS,
        providerOrder: "keyless-first",
        maxPaidAttempts: 0,
        cacheTtlMs: 45_000,
      }))?.results ?? [],
    })));
    const sources = rankResearchSources(results).map(({ title, url, snippet }) => ({ title, url, snippet }));
    if (sources.length === 0) return json({ error: "research prefetch unavailable" }, 503, { "retry-after": "5" });
    const issued = issueSpeculativeResearchReceipt({
      actorAuthHash: actor.authTokenHash,
      threadId: prepared.threadId,
      requestId: prepared.requestId,
      basis: prepared.basis,
      sources,
    });
    return json({
      receipt: issued.receipt,
      query: issued.query,
      sources: issued.sources.map((source) => ({ title: source.title, url: source.url })),
      expiresAt: issued.expiresAt,
    });
  } catch (error) {
    if (req.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      return json({ error: "research prefetch cancelled" }, 499);
    }
    if (error instanceof DOMException && error.name === "TimeoutError") {
      return json({ error: "research prefetch timed out" }, 504);
    }
    return json({ error: "research prefetch unavailable" }, 503, { "retry-after": "5" });
  }
}
