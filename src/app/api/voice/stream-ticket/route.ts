import type { NextRequest } from "next/server";

import { isSameOriginRequest } from "@/lib/control-session";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import { createStreamingSttTicket } from "@/lib/streaming-stt-ticket.server";
import { getSecret } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 5 * 60_000;
let cached: { value: { url: string; secret: string } | null; expiresAt: number } | null = null;

function websocketEndpoint(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const local = url.protocol === "ws:" && url.hostname === "localhost";
    if (url.protocol !== "wss:" && !local) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const path = url.pathname.replace(/\/$/, "");
    url.pathname = path.endsWith("/v1/stream") ? path : `${path}/v1/stream`.replace(/^([^/])/, "/$1");
    return url.toString();
  } catch {
    return null;
  }
}

async function streamingConfig(): Promise<{ url: string; secret: string } | null> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const [configuredUrl, ticketSecret] = await Promise.all([
    process.env.STREAMING_STT_PUBLIC_URL?.trim()
      ? Promise.resolve(process.env.STREAMING_STT_PUBLIC_URL.trim())
      : getSecret("streaming-stt", "STREAMING_STT_PUBLIC_URL").catch(() => ""),
    process.env.STREAMING_STT_TICKET_SECRET?.trim()
      ? Promise.resolve(process.env.STREAMING_STT_TICKET_SECRET.trim())
      : getSecret("streaming-stt", "STREAMING_STT_TICKET_SECRET").catch(() => ""),
  ]);
  const url = websocketEndpoint(configuredUrl);
  const value = url && ticketSecret ? { url, secret: ticketSecret } : null;
  if (process.env.NODE_ENV !== "test") cached = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

/** Owner-only, same-origin ticket minting. The browser never receives the host secret. */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "cross-origin stream ticket rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });
  const config = await streamingConfig();
  if (!config) return Response.json({ error: "self-hosted streaming speech is unavailable" }, { status: 503 });
  try {
    const created = createStreamingSttTicket({ secret: config.secret, origin: new URL(req.url).origin });
    return Response.json({ url: config.url, ticket: created.ticket, expiresAt: created.expiresAt, sampleRate: 16_000 }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch {
    return Response.json({ error: "self-hosted streaming speech is unavailable" }, { status: 503 });
  }
}
