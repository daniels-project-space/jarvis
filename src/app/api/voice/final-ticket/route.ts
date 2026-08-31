import type { NextRequest } from "next/server";

import { isSameOriginRequest } from "@/lib/control-session";
import { createLocalSttTicket } from "@/lib/local-stt-ticket.server";
import { controlActor, isOwnerActor } from "@/lib/request-auth";
import { STT_PROMPT } from "@/lib/sttvocab";
import { getSecret } from "@/lib/vault";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CACHE_MS = 5 * 60_000;
let cached: { value: { url: string; secret: string } | null; expiresAt: number } | null = null;

function transcriptionEndpoint(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    const local = url.protocol === "http:" && url.hostname === "localhost";
    if (url.protocol !== "https:" && !local) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const path = url.pathname.replace(/\/$/, "");
    url.pathname = path.endsWith("/v1/audio/transcriptions")
      ? path
      : `${path}/v1/audio/transcriptions`.replace(/^([^/])/, "/$1");
    return url.toString();
  } catch {
    return null;
  }
}

async function localSttConfig(): Promise<{ url: string; secret: string } | null> {
  if (process.env.NODE_ENV !== "test" && cached && cached.expiresAt > Date.now()) return cached.value;
  const [configuredUrl, sharedSecret] = await Promise.all([
    process.env.LOCAL_STT_URL?.trim()
      ? Promise.resolve(process.env.LOCAL_STT_URL.trim())
      : getSecret("local-stt", "LOCAL_STT_URL").catch(() => ""),
    process.env.LOCAL_STT_SHARED_SECRET?.trim()
      ? Promise.resolve(process.env.LOCAL_STT_SHARED_SECRET.trim())
      : getSecret("local-stt", "LOCAL_STT_SHARED_SECRET").catch(() => ""),
  ]);
  const url = transcriptionEndpoint(configuredUrl);
  const value = url && sharedSecret ? { url, secret: sharedSecret } : null;
  if (process.env.NODE_ENV !== "test") cached = { value, expiresAt: Date.now() + CACHE_MS };
  return value;
}

/** Owner-only minting for a single direct upload to the private recognizer. */
export async function POST(req: NextRequest) {
  if (!isSameOriginRequest(req)) return Response.json({ error: "cross-origin final speech ticket rejected" }, { status: 403 });
  const actor = await controlActor(req);
  if (!actor) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!isOwnerActor(actor)) return Response.json({ error: "owner enrollment required" }, { status: 403 });
  const config = await localSttConfig();
  if (!config) return Response.json({ error: "direct final speech is unavailable" }, { status: 503 });
  try {
    const created = createLocalSttTicket({ secret: config.secret, origin: new URL(req.url).origin });
    return Response.json({
      url: config.url,
      ticket: created.ticket,
      expiresAt: created.expiresAt,
      prompt: STT_PROMPT,
    }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return Response.json({ error: "direct final speech is unavailable" }, { status: 503 });
  }
}
